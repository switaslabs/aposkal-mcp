import { describe, expect, it } from "vitest";
import { buildTools } from "../src/server.js";
import { Spec } from "../src/spec.js";
import { buildInvoiceBody } from "../src/tools/workflows.js";
import { cfg, client, fakeFetch, json } from "./helpers.js";

const spec = Spec.loadBundled();
const VAT = [
  { id: "vat20", label: "%20", value: 0.2, code: "0015", description: "KDV" },
  { id: "vat10", label: "%10", value: 0.1, code: "0015", description: "KDV" },
];

describe("araç kaydı", () => {
  it("salt-okuma modunda tüm gruplar açık olsa bile yazma aracı göstermez", () => {
    const tools = buildTools(cfg({ toolsets: ["all"] }), spec, client(cfg(), fakeFetch([]).impl));
    const names = tools.map((t) => t.name);
    expect(names).toContain("aposkal_list_companies");
    expect(names).toContain("aposkal_call_endpoint");
    expect(names).not.toContain("aposkal_create_sales_invoice_draft");
    expect(names).not.toContain("aposkal_formalize_document");
    expect(names).not.toContain("aposkal_delete_account");
    for (const t of tools) if (t.name !== "aposkal_call_endpoint") expect(t.risk).toBe("read");
  });

  it("yazma modu yazma araçlarını ekler ama dış işlemleri asla eklemez", () => {
    const names = buildTools(cfg({ mode: "write", toolsets: ["document"] }), spec, client(cfg(), fakeFetch([]).impl)).map((t) => t.name);
    expect(names).toContain("aposkal_create_document");
    expect(names).toContain("aposkal_create_sales_invoice_draft");
    expect(names).not.toContain("aposkal_formalize_document");
    expect(names).not.toContain("aposkal_cancel_document");
  });

  it("dış işlem araçlarının şeması confirm ister", () => {
    const c = cfg({ mode: "write", allowExternal: true, toolsets: ["document"] });
    const t = buildTools(c, spec, client(c, fakeFetch([]).impl)).find((x) => x.name === "aposkal_formalize_document")!;
    expect(t).toBeTruthy();
    expect(t.inputSchema.required).toContain("confirm");
  });

  it("call_endpoint asla salt-okuma olarak işaretlenmez ve politikayı uygular", async () => {
    const f = fakeFetch([]);
    const c = cfg({ defaultCompanyId: "1" });
    const t = buildTools(c, spec, client(c, f.impl)).find((x) => x.name === "aposkal_call_endpoint")!;
    expect(t.hints?.readOnlyHint).toBe(false);
    await expect(t.handler({ operation: "deleteDocument", args: { documentId: "x" }, confirm: true })).rejects.toThrow(/APOSKAL_MODE=full/);
    expect(f.calls).toHaveLength(0);
  });

  it("arama Türkçe anahtar kelimelerle operasyon bulur", async () => {
    const c = cfg();
    const t = buildTools(c, spec, client(c, fakeFetch([]).impl)).find((x) => x.name === "aposkal_search_endpoints")!;
    const out = JSON.parse(await t.handler({ query: "mizan" }));
    expect(out.count).toBeGreaterThan(0);
    const dl = JSON.parse(await t.handler({ query: "fatura indir" }));
    expect(dl.results.map((r: { operation: string }) => r.operation)).toContain("download-document");
  });

  it("list_companies profil yanıtını dönüştürür", async () => {
    const f = fakeFetch([json([{ id: 12, title: "Örnek A.Ş.", vknTckn: "1234567890", status: "ACTIVE", userRole: "OWNER", companyType: "X", taxOffice: "Y" }])]);
    const c = cfg();
    const t = buildTools(c, spec, client(c, f.impl)).find((x) => x.name === "aposkal_list_companies")!;
    const out = JSON.parse(await t.handler({}));
    expect(out[0]).toMatchObject({ companyId: 12, userRole: "OWNER" });
    expect(f.calls[0]!.url).toMatch(/\/profile\/company$/);
  });
});

describe("fatura taslağı oluşturucu", () => {
  it("kesirli oranlarla satır vergisini, belge vergisini ve toplamı hesaplar", () => {
    const body = buildInvoiceBody({
      accountId: "acc1",
      scenario: "EARSIVFATURA",
      date: "2026-11-20",
      time: "10:00:00",
      dueDate: "2026-12-20",
      currency: "TRY",
      exchangeRate: 1,
      vatRates: VAT,
      lines: [
        { productName: "Danışmanlık", quantity: 10, unitPrice: 100, vatRate: 0.2 },
        { productName: "Kitap", quantity: 2, unitPrice: 50, discountRate: 0.1, vatRate: 0.1 },
        { productName: "Destek", quantity: 1, unitPrice: 500, vatRate: 0.2 },
      ],
    });
    expect(body.status).toBe("SAVED");
    expect(body.direction).toBe("OUTGOING");
    expect(body.isEArchive).toBe(true);
    expect(body.lines[1]!.tax[0]).toMatchObject({ taxId: "vat10", base: 90, amount: 9, rate: 0.1 });
    expect(body.tax).toHaveLength(2);
    expect(body.tax.find((t) => t.taxId === "vat20")).toMatchObject({ base: 1500, amount: 300 });
    expect(body.total).toBe(1500 + 300 + 90 + 9);
  });

  it("Aposkal'da tanımlı olmayan KDV oranlarını reddeder", () => {
    expect(() =>
      buildInvoiceBody({
        accountId: "a", scenario: "EARSIVFATURA", date: "2026-11-20", time: "10:00:00", dueDate: "2026-11-20",
        currency: "TRY", exchangeRate: 1, vatRates: VAT, lines: [{ productName: "x", quantity: 1, unitPrice: 1, vatRate: 20 }],
      }),
    ).toThrow(/KDV tanımı yok/);
  });

  it("taslak oluştururken asla resmileştirme çağırmaz", async () => {
    const f = fakeFetch((url) => {
      if (url.includes("/gibUser/checkUser")) return json([]);
      if (url.includes("/api/definitions/tax")) return json({ taxList: [], taxRates: VAT });
      if (url.endsWith("/1/document")) return json({ id: "doc-1", status: "SAVED" });
      return new Response("unexpected", { status: 500 });
    });
    const c = cfg({ mode: "write", defaultCompanyId: "1" });
    const t = buildTools(c, spec, client(c, f.impl)).find((x) => x.name === "aposkal_create_sales_invoice_draft")!;
    const out = await t.handler({ accountId: "acc1", lines: [{ productName: "x", quantity: 1, unitPrice: 100, vatRate: 0.2 }] });
    expect(out).toContain("GİB'e GÖNDERİLMEDİ");
    expect(f.calls.some((c) => c.url.includes("formalize"))).toBe(false);
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.body!)).toMatchObject({ scenario: "EARSIVFATURA", status: "SAVED", total: 120 });
  });
});
