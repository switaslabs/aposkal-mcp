import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../src/policy.js";
import { RISK_LISTS } from "../src/risk.js";
import { Spec } from "../src/spec.js";
import { cfg } from "./helpers.js";

const spec = Spec.loadBundled();

describe("paketlenmiş OpenAPI tanımı", () => {
  it("tüm operasyonları tekil ve geçerli araç adlarıyla yükler", () => {
    expect(spec.operations.length).toBeGreaterThan(400);
    const names = spec.operations.map((o) => o.toolName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it("risk listelerindeki her operationId tanımda vardır (yazım hatalarını yakalar)", () => {
    const ids = new Set(spec.operations.map((o) => o.operationId));
    for (const [list, set] of Object.entries(RISK_LISTS)) {
      for (const id of set) expect(ids.has(id), `${list}: ${id}`).toBe(true);
    }
  });

  it("GİB / SGK işlemlerini dış işlem olarak sınıflandırır", () => {
    for (const id of ["formalizeDocument", "cancelDocument", "reject-pending-invoice", "transferToDBS", "submit-sgk-tescil-declarations", "send-sales-offer"]) {
      expect(spec.find(id)?.risk, id).toBe("external");
    }
  });

  it("güvenlik açısından önemli işlemleri hassas olarak sınıflandırır", () => {
    for (const id of ["issue-sso-ticket", "create-webhook", "start-data-purge", "save-settings-integration", "update-profile"]) {
      expect(spec.find(id)?.risk, id).toBe("sensitive");
    }
  });

  it("DELETE işlemlerini asla okuma ya da yazma olarak sınıflandırmaz", () => {
    for (const op of spec.operations.filter((o) => o.method === "DELETE")) {
      expect(["destructive", "external", "sensitive"]).toContain(op.risk);
    }
  });

  it("yalnızca GET'ler ve açıkça listelenen POST'lar okuma sayılır", () => {
    for (const op of spec.operations.filter((o) => o.risk === "read")) {
      if (op.method !== "GET") expect(RISK_LISTS.READ_OPS.has(op.operationId), op.operationId).toBe(true);
    }
  });

  it("Spring pageable/request sorgu nesnelerini düzleştirir", () => {
    const op = spec.find("GET /{companyId}/account")!;
    const names = op.params.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["searchQuery", "type", "page", "size", "sort"]));
    expect(names).not.toContain("pageable");
  });

  it("operasyonları ID, araç adı ve METHOD /yol ile bulur", () => {
    expect(spec.find("create-document")?.path).toBe("/{companyId}/document");
    expect(spec.find("aposkal_create_document")?.operationId).toBe("create-document");
    expect(spec.find("post /{companyId}/document")?.operationId).toBe("create-document");
  });

  it("her operasyonun Türkçe özeti ve Türkçe grup adı vardır", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "openapi", "aposkal-openapi.json"), "utf8"));
    const original = new Map<string, string>();
    for (const item of Object.values(raw.paths) as Array<Record<string, { operationId: string; summary?: string; tags?: string[] }>>)
      for (const o of Object.values(item)) if (o?.operationId) original.set(o.operationId, o.summary ?? "");
    for (const op of spec.operations) {
      expect(op.summary, op.operationId).not.toBe(original.get(op.operationId));
      expect(op.summary.length, op.operationId).toBeGreaterThan(3);
      expect(op.tag, op.operationId).not.toMatch(/^[A-Z][a-z]+([A-Z][a-z]+)+$/); // ör. "SalesOffer" kalmamalı
    }
    expect(spec.find("formalizeDocument")?.summary).toBe("Belgeyi resmileştir");
  });

  it("varsayılan (salt-okuma) modda yalnızca okuma işlemlerine izin verilir", () => {
    const c = cfg();
    for (const op of spec.operations) {
      const d = decide(op.risk, op.method, c);
      if (d.allowed) expect(op.risk).toBe("read");
    }
  });
});
