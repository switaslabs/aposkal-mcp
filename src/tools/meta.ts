/**
 * Keşif araçları: ~430 Aposkal operasyonunun hepsini ayrı araç olarak
 * kaydetmeden modelin erişimine açar.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 */
import { publicConfig } from "../config.js";
import { execute, type ExecContext } from "../executor.js";
import { decide, PolicyError } from "../policy.js";
import { RISK_DESCRIPTIONS, type Risk } from "../risk.js";
import type { Operation, Spec } from "../spec.js";
import { AUTHOR, AUTHOR_URL, NAME, UNOFFICIAL_NOTE, VERSION } from "../version.js";
import { inputSchemaFor } from "./generated.js";
import type { ToolDef } from "./types.js";

const RISKS: Risk[] = ["read", "write", "destructive", "external", "sensitive"];

function normalise(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i");
}

/** Türkçe → İngilizce ipuçları: Türkçe sorguların operationId ve orijinal özetlerle de eşleşmesi için. Anahtarlar normalize edilmiştir. */
const SYNONYMS: Record<string, string[]> = {
  fatura: ["invoice", "document"], belge: ["document"], indir: ["download", "export", "pdf"], pdf: ["pdf", "download"],
  cari: ["account"], musteri: ["account", "customer"], tedarikci: ["account", "supplier"], hesap: ["account"],
  urun: ["product"], stok: ["stock", "product"], depo: ["warehouse"], banka: ["bank"], kasa: ["account", "cash"],
  bordro: ["payroll"], maas: ["payroll"], calisan: ["employee"], personel: ["employee"], puantaj: ["timesheet"],
  siparis: ["order"], teklif: ["offer"], irsaliye: ["dispatch", "waybill"], tahsilat: ["collect", "payment", "tahsilat"],
  odeme: ["payment"], rapor: ["report"], vergi: ["tax"], kdv: ["vat", "tax"], gelen: ["inbox"], kutusu: ["inbox"],
  etiket: ["tag"], kategori: ["category"], adres: ["address"], not: ["note"], sirket: ["company"], firma: ["company"],
  kullanici: ["user", "profile"], ayar: ["settings", "config"], ayarlar: ["settings", "config"], iptal: ["cancel"],
  sil: ["delete"], olustur: ["create", "save"], ekle: ["create", "add", "save"], guncelle: ["update"], listele: ["list", "get"],
  resmilestir: ["formalize"], arsiv: ["archive"], kopyala: ["copy"], iade: ["return"], muhasebe: ["accounting"],
  fis: ["accounting", "record"], yevmiye: ["accounting", "record"], plan: ["plan"], cek: ["cheque"], doviz: ["currency"],
  kur: ["currency"], entegrasyon: ["integration"], destek: ["support"], kira: ["lease"], gider: ["expense"],
  pusulasi: ["expense"], zrapor: ["zreport", "z-report"], sgk: ["sgk"], sube: ["workplace"], isyeri: ["workplace"],
  departman: ["department"], bakiye: ["balance", "balances"], ekstre: ["statement", "muavin"], kar: ["profit"],
  nakit: ["cash"], akis: ["flow"], vade: ["overdue", "due"], geciken: ["overdue"], ara: ["search"],
};

export function searchOperations(spec: Spec, query: string, opts: { toolset?: string; risk?: Risk; limit?: number } = {}): Operation[] {
  const terms = normalise(query).split(/\s+/).filter(Boolean);
  const scored: Array<{ op: Operation; score: number }> = [];
  for (const op of spec.operations) {
    if (opts.toolset && op.toolset !== opts.toolset) continue;
    if (opts.risk && op.risk !== opts.risk) continue;
    const hay = normalise(`${op.searchText} ${op.summary} ${op.tag} ${op.path} ${op.description.slice(0, 400)}`);
    const head = normalise(`${op.searchText} ${op.summary} ${op.path}`);
    let score = 0;
    for (const t of terms) {
      const alts = [t, ...(SYNONYMS[t] ?? [])];
      if (alts.some((x) => head.includes(x))) score += 3;
      else if (alts.some((x) => hay.includes(x))) score += 1;
      else {
        score = -1;
        break;
      }
    }
    if (terms.length === 0) score = 1;
    if (score > 0) scored.push({ op, score });
  }
  scored.sort((a, b) => b.score - a.score || a.op.path.localeCompare(b.op.path));
  return scored.slice(0, opts.limit ?? 25).map((s) => s.op);
}

export function metaTools(spec: Spec, ctx: ExecContext): ToolDef[] {
  const { cfg } = ctx;

  const resolveOp = (key: unknown): Operation => {
    if (typeof key !== "string" || !key.trim()) throw new PolicyError(`"operation" zorunludur`);
    const op = spec.find(key);
    if (!op) throw new PolicyError(`Bilinmeyen operasyon: "${key}". Önce aposkal_search_endpoints ile arayın.`);
    return op;
  };

  const summary = (op: Operation) => {
    const d = decide(op.risk, op.method, cfg);
    return {
      operation: op.operationId,
      method: op.method,
      path: op.path,
      summary: op.summary,
      toolset: op.toolset,
      risk: op.risk,
      enabled: d.allowed,
      ...(d.allowed ? {} : { kapaliNedeni: d.reason }),
      ...(d.requiresConfirm ? { requiresConfirm: true } : {}),
    };
  };

  return [
    {
      name: "aposkal_server_info",
      title: "Sunucu bilgisi",
      description: `Resmî olmayan ${NAME} sunucusunun sürümünü, ortamını (live/test), güvenlik modunu ve açık grupları gösterir. Kimlik bilgilerini asla göstermez. Geliştiren: ${AUTHOR} (${AUTHOR_URL}).`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      method: "GET",
      handler: async () =>
        JSON.stringify(
          {
            ad: NAME,
            resmiUrun: false,
            not: UNOFFICIAL_NOTE,
            surum: VERSION,
            gelistiren: AUTHOR,
            webSitesi: AUTHOR_URL,
            repo: "https://github.com/switaslabs/aposkal-mcp",
            yapilandirma: publicConfig(cfg),
            operasyonSayisi: spec.operations.length,
            riskSeviyeleri: RISK_DESCRIPTIONS,
          },
          null,
          2,
        ),
    },
    {
      name: "aposkal_list_toolsets",
      title: "API gruplarını listele",
      description:
        "Aposkal API gruplarını (toolset) ve her gruptaki operasyon sayısını risk seviyesine göre listeler. Grup kısaltmasını aposkal_search_endpoints aracında ya da APOSKAL_TOOLSETS ayarında kullanabilirsiniz.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      method: "GET",
      handler: async () => {
        const groups = new Map<string, { toolset: string; tag: string; total: number } & Record<Risk, number>>();
        for (const op of spec.operations) {
          let g = groups.get(op.toolset);
          if (!g) {
            g = { toolset: op.toolset, tag: op.tag, total: 0, read: 0, write: 0, destructive: 0, external: 0, sensitive: 0 };
            groups.set(op.toolset, g);
          }
          g.total++;
          g[op.risk]++;
        }
        return JSON.stringify([...groups.values()].sort((a, b) => b.total - a.total), null, 2);
      },
    },
    {
      name: "aposkal_search_endpoints",
      title: "API operasyonlarında ara",
      description:
        "Tüm Aposkal API operasyonlarında arar (Türkçe anahtar kelime, operationId ya da yol). aposkal_describe_endpoint ve aposkal_call_endpoint ile kullanılacak operasyon kimliklerini ve her birinin mevcut güvenlik ayarlarıyla açık olup olmadığını döndürür.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: 'Anahtar kelimeler, ör. "fatura indir", "mizan", "cari bakiye", "/document".' },
          toolset: { type: "string", description: "İsteğe bağlı grup filtresi (bkz. aposkal_list_toolsets)." },
          risk: { type: "string", enum: RISKS, description: "İsteğe bağlı risk filtresi: read (okuma), write (yazma), destructive (silme), external (GİB/SGK/üçüncü taraf), sensitive (hassas)." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "En fazla kaç sonuç dönsün." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read",
      method: "GET",
      handler: async (a) => {
        const ops = searchOperations(spec, String(a.query ?? ""), {
          toolset: typeof a.toolset === "string" ? a.toolset : undefined,
          risk: RISKS.includes(a.risk as Risk) ? (a.risk as Risk) : undefined,
          limit: typeof a.limit === "number" ? Math.min(Math.max(1, a.limit), 100) : 25,
        });
        return JSON.stringify({ count: ops.length, results: ops.map(summary) }, null, 2);
      },
    },
    {
      name: "aposkal_describe_endpoint",
      title: "API operasyonunu açıkla",
      description:
        "Bir Aposkal API operasyonunun açıklamasını, parametrelerini ve istek gövdesi şemasını döndürür (operationId, araç adı ya da 'METHOD /yol' ile).",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: 'Ör. "create-document" ya da "GET /{companyId}/account"' },
          schemaDepth: { type: "integer", minimum: 1, maximum: 8, default: 4, description: "İç içe şemaların kaç seviye açılacağı." },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      risk: "read",
      method: "GET",
      handler: async (a) => {
        const op = resolveOp(a.operation);
        const depth = typeof a.schemaDepth === "number" ? Math.min(Math.max(1, a.schemaDepth), 8) : 4;
        const out = {
          ...summary(op),
          tag: op.tag,
          description: op.description,
          bearerOnly: op.bearerOnly || undefined,
          deprecated: op.deprecated || undefined,
          arguments: inputSchemaFor(op, spec, cfg).properties,
          bodySchema: op.body ? spec.deref(op.body.rawSchema, depth) : undefined,
          bodyContentType: op.body?.contentType,
          nasilCagrilir: `aposkal_call_endpoint { "operation": "${op.operationId}", "args": { ... } }`,
        };
        const text = JSON.stringify(out, null, 2);
        return text.length > cfg.maxResponseChars
          ? text.slice(0, cfg.maxResponseChars) + `\n…[kırpıldı — daha küçük bir schemaDepth ile tekrar deneyin]`
          : text;
      },
    },
    {
      name: "aposkal_call_endpoint",
      title: "Herhangi bir API operasyonunu çağır",
      description:
        "Herhangi bir Aposkal API operasyonunu operationId ile çağırır. Yol/sorgu parametrelerini, companyId'yi ve gövdeyi `args` içine koyun (bkz. aposkal_describe_endpoint). Özel araçlarla aynı güvenlik politikası uygulanır: yazma için APOSKAL_MODE=write, silme için full, GİB/SGK/üçüncü taraf işlemleri için APOSKAL_ALLOW_EXTERNAL gerekir; riskli çağrılar kullanıcının açık onayından sonra confirm=true ister.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "operationId, araç adı ya da 'METHOD /yol'." },
          args: {
            type: "object",
            description: "Argümanlar: companyId, yol/sorgu parametreleri, body.",
            additionalProperties: true,
          },
          confirm: { type: "boolean", description: "Yalnızca kullanıcı tam olarak bu işlemi açıkça onayladıktan sonra true yapın." },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      // Her modda listelenir; asıl risk denetimi execute() içinde hedef operasyona göre yapılır.
      risk: "read",
      method: "POST",
      hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      handler: async (a) => {
        const op = resolveOp(a.operation);
        const args = a.args && typeof a.args === "object" && !Array.isArray(a.args) ? { ...(a.args as Record<string, unknown>) } : {};
        if (a.confirm !== undefined) args.confirm = a.confirm;
        return execute(op, args, ctx);
      },
    },
  ];
}
