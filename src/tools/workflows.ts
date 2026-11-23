/**
 * En sık yapılan muhasebe işleri için elle yazılmış iş akışı araçları.
 * Aposkal dokümanındaki kolay yanlış yapılan kuralları kodda uygular
 * (senaryo seçimi, kesirli oranlar, zorunlu belge düzeyi vergi, …).
 *
 * Bu araçların hiçbiri resmileştirme yapmaz ve GİB'e bir şey göndermez.
 * Taslaklar SAVED durumunda oluşturulur; resmileştirme ayrı ve açıkça onay
 * gerektiren bir "external" (dış) işlem olarak kalır.
 *
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 */
import type { ExecContext } from "../executor.js";
import { formatResponse } from "../executor.js";
import type { ApiResponse } from "../http.js";
import { assertAllowed, PolicyError, resolveCompanyId } from "../policy.js";
import type { Risk } from "../risk.js";
import type { JsonSchema, ToolDef } from "./types.js";

interface TaxRate {
  id: string;
  label: string;
  value: number;
  code: string;
  description?: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function str(a: Record<string, unknown>, k: string, re?: RegExp, required = true): string | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new PolicyError(`"${k}" zorunludur`);
    return undefined;
  }
  if (typeof v !== "string" && typeof v !== "number") throw new PolicyError(`"${k}" metin olmalıdır`);
  const s = String(v).trim();
  if (re && !re.test(s)) throw new PolicyError(`"${k}" geçersiz biçimde`);
  return s;
}

function num(v: unknown, k: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new PolicyError(`"${k}" ${min} ile ${max} arasında bir sayı olmalıdır`);
  return v;
}

const today = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 8);

const companyProp = (ctx: ExecContext): JsonSchema => ({
  type: "integer",
  description: "Aposkal firma ID'si (bkz. aposkal_list_companies)." + (ctx.cfg.defaultCompanyId ? ` Varsayılan: ${ctx.cfg.defaultCompanyId}.` : ""),
});
const companyReq = (ctx: ExecContext) => (ctx.cfg.defaultCompanyId ? [] : ["companyId"]);

async function getJson(ctx: ExecContext, path: string, query?: Record<string, string | number>): Promise<unknown> {
  const res = await ctx.client.request({ method: "GET", path, query });
  return res.kind === "json" ? res.data : res.kind === "empty" ? null : (res as Extract<ApiResponse, { kind: "text" }>).text;
}

export async function fetchVatRates(ctx: ExecContext): Promise<TaxRate[]> {
  const data = (await getJson(ctx, "/api/definitions/tax", { category: "VAT" })) as { taxRates?: Array<Partial<TaxRate>> } | null;
  return (data?.taxRates ?? [])
    .filter((r): r is TaxRate => typeof r.id === "string" && typeof r.value === "number")
    .map((r) => ({ id: r.id, label: r.label ?? "", value: r.value, code: r.code ?? "", description: r.description }));
}

export interface DraftLineInput {
  productId?: string;
  productName: string;
  description?: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discountRate?: number;
  vatRate: number;
}

/** Saf hesaplama; testler için dışa aktarılır. Oranlar kesirdir (0.2 = %20). */
export function buildInvoiceBody(input: {
  accountId: string;
  scenario: "EARSIVFATURA" | "TEMELFATURA" | "TICARIFATURA";
  date: string;
  time: string;
  dueDate: string;
  currency: string;
  exchangeRate: number;
  note?: string;
  lines: DraftLineInput[];
  vatRates: TaxRate[];
}) {
  const findRate = (v: number) => {
    const r = input.vatRates.find((x) => Math.abs(x.value - v) < 1e-9);
    if (!r) throw new PolicyError(`${v} oranı için Aposkal'da KDV tanımı yok (mevcut oranlar: ${input.vatRates.map((x) => x.value).join(", ")})`);
    return r;
  };
  const docTax = new Map<string, { rate: TaxRate; base: number; amount: number }>();
  let total = 0;
  const lines = input.lines.map((l) => {
    const rate = findRate(l.vatRate);
    const discount = l.discountRate ?? 0;
    const base = round2(l.quantity * l.unitPrice * (1 - discount));
    const amount = round2(base * rate.value);
    total += base + amount;
    const agg = docTax.get(rate.id) ?? { rate, base: 0, amount: 0 };
    agg.base = round2(agg.base + base);
    agg.amount = round2(agg.amount + amount);
    docTax.set(rate.id, agg);
    return {
      ...(l.productId ? { productId: l.productId } : {}),
      productName: l.productName,
      ...(l.description ? { description: l.description } : {}),
      unit: l.unit ?? "C62",
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountRate: discount,
      tax: [taxObj(rate, base, amount)],
    };
  });
  return {
    accountId: input.accountId,
    scenario: input.scenario,
    documentType: "NORMAL",
    direction: "OUTGOING",
    status: "SAVED",
    date: input.date,
    time: input.time,
    dueDate: input.dueDate,
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    discountRate: 0,
    total: round2(total),
    ...(input.note ? { note: input.note } : {}),
    lines,
    tax: [...docTax.values()].map((t) => taxObj(t.rate, t.base, t.amount)),
    payments: [],
    isOut: true,
    isIn: false,
    isEArchive: input.scenario === "EARSIVFATURA",
    isReturn: false,
    isExport: false,
    isImport: false,
    isTahsilat: false,
    isOdeme: false,
    isStock: false,
    isOther: false,
    isZReport: false,
    isOKC: false,
    isExpenseNote: false,
    isWithholdingDocumentType: false,
    isYatirimTesvik: false,
    isYtbType: false,
  };
}

function taxObj(rate: TaxRate, base: number, amount: number) {
  return {
    taxId: rate.id,
    category: "VAT",
    label: rate.label,
    code: rate.code,
    description: rate.description || "KDV",
    base,
    rate: rate.value,
    amount,
    remainingAmount: amount,
  };
}

export function workflowTools(ctx: ExecContext): ToolDef[] {
  const { cfg } = ctx;
  const tool = (t: Omit<ToolDef, "handler"> & { handler: ToolDef["handler"] }): ToolDef => ({
    ...t,
    handler: async (args) => {
      assertAllowed(t.risk, t.method, args.confirm, cfg, t.name);
      return t.handler(args);
    },
  });

  const read = (name: string, title: string, description: string, properties: Record<string, JsonSchema>, required: string[], handler: ToolDef["handler"]) =>
    tool({ name, title, description, risk: "read" as Risk, method: "GET", inputSchema: { type: "object", properties, required, additionalProperties: false }, handler });

  return [
    read(
      "aposkal_list_companies",
      "Firmalarımı listele",
      "API anahtarının erişebildiği firmaları companyId, VKN/TCKN, unvan, durum ve anahtarın kullanıcı rolü (userRole) ile listeler. companyId'yi bulmak için buradan başlayın.",
      {},
      [],
      async () => {
        const data = await getJson(ctx, "/profile/company");
        const list = Array.isArray(data) ? data : [];
        const allowed = cfg.companyIds;
        return JSON.stringify(
          list.map((c: Record<string, unknown>) => ({
            companyId: c.id,
            title: c.title,
            vknTckn: c.vknTckn,
            status: c.status,
            userRole: c.userRole,
            companyType: c.companyType,
            ...(allowed.length ? { buSunucuErisebilir: allowed.includes(String(c.id)) } : {}),
          })),
          null,
          2,
        );
      },
    ),

    read(
      "aposkal_check_einvoice_recipient",
      "e-Fatura / e-İrsaliye mükellef sorgusu",
      "Bir karşı tarafın (VKN/TCKN ya da accountId ile) GİB'e kayıtlı e-Fatura (veya e-İrsaliye) mükellefi olup olmadığını sorgular ve kullanılacak senaryoyu döndürür: kayıtlı değilse EARSIVFATURA, kayıtlıysa TEMELFATURA/TICARIFATURA ve GİB alias'ı. Salt-okuma sorgusudur.",
      {
        companyId: companyProp(ctx),
        vkn: { type: "string", description: "VKN (10 hane) ya da TCKN (11 hane)." },
        accountId: { type: "string", description: "Aposkal cari ID'si; carinin VKN'si kullanılır." },
        dispatch: { type: "boolean", default: false, description: "true = e-Fatura yerine e-İrsaliye etiketlerini sorgula." },
      },
      companyReq(ctx),
      async (a) => {
        const companyId = resolveCompanyId(a.companyId, cfg);
        const vkn = str(a, "vkn", /^\d{10,11}$/, false);
        const accountId = str(a, "accountId", ID, false);
        if (!vkn && !accountId) throw new PolicyError(`"vkn" ya da "accountId" verin`);
        const path = `/${companyId}/gibUser/${a.dispatch === true ? "checkDispatchUser" : "checkUser"}`;
        const data = await getJson(ctx, path, { ...(vkn ? { vkn } : {}), ...(accountId ? { accountId } : {}) });
        const aliases = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
        const registered = aliases.length > 0;
        return JSON.stringify(
          {
            kayitli: registered,
            tur: a.dispatch === true ? "e-İrsaliye" : "e-Fatura",
            onerilenSenaryo: a.dispatch === true ? (registered ? "TEMELIRSALIYE" : null) : registered ? "TEMELFATURA ya da TICARIFATURA" : "EARSIVFATURA",
            aliases: aliases.map((x) => ({ alias: x.alias, title: x.title, type: x.type, unit: x.unit, registertime: x.registertime })),
            not: registered
              ? "Resmileştirirken bu alias'lardan birini kullanın. Belge tarihi registertime değerinden önce olamaz."
              : a.dispatch === true
                ? "e-İrsaliye mükellefi değil."
                : "e-Fatura mükellefi değil — e-Arşiv fatura düzenlenmelidir.",
          },
          null,
          2,
        );
      },
    ),

    read(
      "aposkal_get_vat_rates",
      "KDV oranlarını getir",
      "Aposkal'daki KDV oran tanımlarını döndürür. `id`, fatura satırlarında kullanılacak taxId değeridir; `value` kesirdir (0.2 = %20).",
      {},
      [],
      async () => JSON.stringify(await fetchVatRates(ctx), null, 2),
    ),

    read(
      "aposkal_find_account",
      "Cari / hesap ara",
      "Müşteri/tedarikçi carilerini ve kasa/banka hesaplarını ad, VKN/TCKN ya da anahtar kelimeyle arar. Sayfalı sonuç döndürür.",
      {
        companyId: companyProp(ctx),
        searchQuery: { type: "string", description: "Ad, unvan, VKN/TCKN…" },
        type: {
          type: "array",
          items: { type: "string", enum: ["BANKA", "KASA", "CARI", "POS", "KREDIKARTI", "PERSONEL", "FIRMACEKI", "MUSTERICEKI", "ALINANSENET", "VERILENSENET", "ORTAK", "KREDI", "YATIRIM", "RESMIKURUM"] },
          description: "İsteğe bağlı hesap türleri, ör. [\"CARI\"] ya da [\"KASA\",\"BANKA\"].",
        },
        page: { type: "integer", minimum: 0, default: 0, description: "Sayfa numarası (0'dan başlar)." },
        size: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Sayfadaki kayıt sayısı." },
      },
      companyReq(ctx),
      async (a) => {
        const companyId = resolveCompanyId(a.companyId, cfg);
        const query: Record<string, string | number | string[]> = {
          page: typeof a.page === "number" ? Math.max(0, Math.trunc(a.page)) : 0,
          size: typeof a.size === "number" ? Math.min(100, Math.max(1, Math.trunc(a.size))) : 20,
        };
        if (typeof a.searchQuery === "string" && a.searchQuery.trim()) query.searchQuery = a.searchQuery.trim().slice(0, 200);
        if (Array.isArray(a.type)) query.type = a.type.filter((t): t is string => typeof t === "string" && /^[A-Z]+$/.test(t));
        const res = await ctx.client.request({ method: "GET", path: `/${companyId}/account`, query });
        return formatResponse(res, cfg, "find-account");
      },
    ),

    read(
      "aposkal_get_document_download_link",
      "Belge dosyası bağlantısı al",
      "Belgenin PDF, XML ya da HTML dosyası için geçici, imzalı bir CDN bağlantısı döndürür.",
      {
        companyId: companyProp(ctx),
        documentId: { type: "string", description: "Aposkal belge ID'si." },
        format: { type: "string", enum: ["pdf", "xml", "html"], default: "pdf", description: "Dosya biçimi." },
      },
      [...companyReq(ctx), "documentId"],
      async (a) => {
        const companyId = resolveCompanyId(a.companyId, cfg);
        const documentId = str(a, "documentId", ID)!;
        const format = ["pdf", "xml", "html"].includes(String(a.format)) ? String(a.format) : "pdf";
        const res = await ctx.client.request({ method: "GET", path: `/${companyId}/document/${encodeURIComponent(documentId)}/download`, query: { format } });
        return formatResponse(res, cfg, "download-document");
      },
    ),

    tool({
      name: "aposkal_create_sales_invoice_draft",
      title: "Satış faturası taslağı oluştur (resmileştirmez)",
      description:
        "Giden (OUTGOING) bir satış faturasını taslak olarak (SAVED durumunda) oluşturur. Faturayı resmileştirmez ve GİB'e hiçbir şey göndermez. " +
        "GİB mükellef sorgusuyla senaryoyu otomatik seçer (e-Arşiv / e-Fatura), KDV taxId değerlerini bulur, satır ve belge düzeyi vergiyi ve toplamı hesaplar. " +
        "Oranlar kesirdir: vatRate 0.2 = %20, discountRate 0.1 = %10. Oluşturulan belgeyi döndürür (id değerini saklayın).",
      risk: "write",
      method: "POST",
      inputSchema: {
        type: "object",
        properties: {
          companyId: companyProp(ctx),
          accountId: { type: "string", description: "Müşteri cari ID'si — bkz. aposkal_find_account." },
          scenario: {
            type: "string",
            enum: ["AUTO", "EARSIVFATURA", "TEMELFATURA", "TICARIFATURA"],
            default: "AUTO",
            description: "AUTO = müşteri e-Fatura mükellefi değilse EARSIVFATURA, mükellefse TEMELFATURA.",
          },
          date: { type: "string", description: "yyyy-MM-dd (varsayılan: bugün)" },
          time: { type: "string", description: "HH:mm:ss (varsayılan: şu an)" },
          dueDate: { type: "string", description: "Vade tarihi, yyyy-MM-dd (varsayılan: belge tarihi)" },
          currency: { type: "string", default: "TRY", description: "Para birimi (ISO kodu)." },
          exchangeRate: { type: "number", default: 1, description: "Döviz kuru." },
          note: { type: "string", description: "Belge notu." },
          lines: {
            description: "Fatura satırları.",
            type: "array",
            minItems: 1,
            maxItems: 200,
            items: {
              type: "object",
              properties: {
                productId: { type: "string", description: "İsteğe bağlı Aposkal ürün ID'si." },
                productName: { type: "string", description: "Ürün/hizmet adı." },
                description: { type: "string", description: "Satır açıklaması." },
                unit: { type: "string", default: "C62", description: "UN/ECE birim kodu (C62 = adet, KGM = kg, HUR = saat…)" },
                quantity: { type: "number", exclusiveMinimum: 0, description: "Miktar." },
                unitPrice: { type: "number", minimum: 0, description: "KDV hariç birim fiyat." },
                discountRate: { type: "number", minimum: 0, maximum: 1, default: 0, description: "İndirim oranı, kesir olarak (0.1 = %10)." },
                vatRate: { type: "number", minimum: 0, maximum: 1, description: "0.2 = %20, 0.1 = %10, 0.01 = %1, 0 = %0" },
              },
              required: ["productName", "quantity", "unitPrice", "vatRate"],
              additionalProperties: false,
            },
          },
          dryRun: { type: "boolean", default: false, description: "true = yalnızca hesaplanan istek gövdesini döndür, hiçbir şey oluşturma." },
        },
        required: [...companyReq(ctx), "accountId", "lines"],
        additionalProperties: false,
      },
      handler: async (a) => {
        const companyId = resolveCompanyId(a.companyId, cfg);
        const accountId = str(a, "accountId", ID)!;
        const date = str(a, "date", DATE, false) ?? today();
        const time = str(a, "time", TIME, false) ?? nowTime();
        const dueDate = str(a, "dueDate", DATE, false) ?? date;
        const currency = (str(a, "currency", /^[A-Z]{3}$/, false) ?? "TRY").toUpperCase();
        const exchangeRate = a.exchangeRate === undefined ? 1 : num(a.exchangeRate, "exchangeRate", 0.000001, 1e6);
        if (!Array.isArray(a.lines) || a.lines.length === 0 || a.lines.length > 200) throw new PolicyError(`"lines" 1–200 satır içermelidir`);
        const lines: DraftLineInput[] = a.lines.map((raw, i) => {
          const l = (raw ?? {}) as Record<string, unknown>;
          return {
            productId: str(l, "productId", ID, false),
            productName: str(l, "productName")!.slice(0, 500),
            description: str(l, "description", undefined, false)?.slice(0, 1000),
            unit: str(l, "unit", /^[A-Z0-9]{1,5}$/, false),
            quantity: num(l.quantity, `lines[${i}].quantity`, 0.00001),
            unitPrice: num(l.unitPrice, `lines[${i}].unitPrice`, 0),
            discountRate: l.discountRate === undefined ? 0 : num(l.discountRate, `lines[${i}].discountRate`, 0, 1),
            vatRate: num(l.vatRate, `lines[${i}].vatRate`, 0, 1),
          };
        });

        let scenario = typeof a.scenario === "string" ? a.scenario : "AUTO";
        let recipient: unknown = undefined;
        if (scenario === "AUTO") {
          const aliases = await getJson(ctx, `/${companyId}/gibUser/checkUser`, { accountId });
          const registered = Array.isArray(aliases) && aliases.length > 0;
          scenario = registered ? "TEMELFATURA" : "EARSIVFATURA";
          recipient = { eFaturaMukellefi: registered, aliases: Array.isArray(aliases) ? aliases.map((x: Record<string, unknown>) => x.alias) : [] };
        } else if (!["EARSIVFATURA", "TEMELFATURA", "TICARIFATURA"].includes(scenario)) {
          throw new PolicyError(`Desteklenmeyen senaryo: "${scenario}"`);
        }

        const body = buildInvoiceBody({
          accountId,
          scenario: scenario as "EARSIVFATURA",
          date,
          time,
          dueDate,
          currency,
          exchangeRate,
          note: str(a, "note", undefined, false)?.slice(0, 2000),
          lines,
          vatRates: await fetchVatRates(ctx),
        });

        if (a.dryRun === true) return JSON.stringify({ dryRun: true, aliciSorgusu: recipient, istekGovdesi: body }, null, 2);

        const res = await ctx.client.request({ method: "POST", path: `/${companyId}/document`, json: body });
        const formatted = await formatResponse(res, cfg, "create-document");
        return (
          `Fatura taslağı oluşturuldu (senaryo ${scenario}, durum SAVED). Resmileştirilmedi ve GİB'e GÖNDERİLMEDİ.\n` +
          (recipient ? `Alıcı sorgusu: ${JSON.stringify(recipient)}\n` : "") +
          formatted
        );
      },
    }),

    tool({
      name: "aposkal_create_collection",
      title: "Tahsilat kaydet",
      description:
        "Müşteriden alınan ödemeyi (TAHSILAT belgesi) bir kasa (KASA) ya da banka (BANKA) hesabına kaydeder. Tahsilat belgeleri resmileştirilmez; SAVED durumu nihaidir. Yalnızca Aposkal içinde kalır — GİB'e hiçbir şey gönderilmez.",
      risk: "write",
      method: "POST",
      inputSchema: {
        type: "object",
        properties: {
          companyId: companyProp(ctx),
          accountId: { type: "string", description: "Ödemeyi yapan müşterinin cari ID'si." },
          paymentAccountId: { type: "string", description: "Paranın girdiği kasa ya da banka hesabının ID'si." },
          paymentType: { type: "string", enum: ["KASA", "BANKA", "POS", "KREDIKARTI"], default: "KASA", description: "Tahsilat hesabının türü." },
          amount: { type: "number", exclusiveMinimum: 0, description: "Tutar." },
          date: { type: "string", description: "yyyy-MM-dd (varsayılan: bugün)" },
          time: { type: "string", description: "HH:mm:ss (varsayılan: şu an)" },
          currency: { type: "string", default: "TRY", description: "Para birimi (ISO kodu)." },
          exchangeRate: { type: "number", default: 1, description: "Döviz kuru." },
          note: { type: "string", description: "Belge notu." },
        },
        required: [...companyReq(ctx), "accountId", "paymentAccountId", "amount"],
        additionalProperties: false,
      },
      handler: async (a) => {
        const companyId = resolveCompanyId(a.companyId, cfg);
        const amount = round2(num(a.amount, "amount", 0.01, 1e12));
        const date = str(a, "date", DATE, false) ?? today();
        const paymentType = ["KASA", "BANKA", "POS", "KREDIKARTI"].includes(String(a.paymentType)) ? String(a.paymentType) : "KASA";
        const body = {
          accountId: str(a, "accountId", ID)!,
          scenario: "TAHSILAT",
          documentType: "NORMAL",
          direction: "OUTGOING", // Aposkal dokümanına göre TAHSILAT yönü OUTGOING olmalıdır
          status: "SAVED",
          date,
          time: str(a, "time", TIME, false) ?? nowTime(),
          dueDate: date,
          currency: (str(a, "currency", /^[A-Z]{3}$/, false) ?? "TRY").toUpperCase(),
          exchangeRate: a.exchangeRate === undefined ? 1 : num(a.exchangeRate, "exchangeRate", 0.000001, 1e6),
          discountRate: 0,
          total: amount,
          ...(typeof a.note === "string" && a.note ? { note: a.note.slice(0, 2000) } : {}),
          lines: [],
          tax: [],
          payments: [{ accountId: str(a, "paymentAccountId", ID)!, amount, type: paymentType }],
          isTahsilat: true,
          isOut: false,
          isIn: false,
          isOdeme: false,
          isEArchive: false,
          isReturn: false,
          isExport: false,
          isImport: false,
          isStock: false,
          isOther: false,
          isZReport: false,
          isOKC: false,
          isExpenseNote: false,
          isWithholdingDocumentType: false,
          isYatirimTesvik: false,
          isYtbType: false,
        };
        const res = await ctx.client.request({ method: "POST", path: `/${companyId}/document`, json: body });
        return formatResponse(res, cfg, "create-collection");
      },
    }),
  ];
}
