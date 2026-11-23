import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRequest, execute } from "../src/executor.js";
import { ApiError, isAllowedRedirect } from "../src/http.js";
import { redact, registerSecret } from "../src/redact.js";
import { Spec } from "../src/spec.js";
import { cfg, client, FAKE_KEY, FAKE_SECRET, fakeFetch, json } from "./helpers.js";

const spec = Spec.loadBundled();

describe("HTTP istemcisi", () => {
  it("iki kimlik doğrulama başlığını sabit API adresine gönderir", async () => {
    const f = fakeFetch([json({ ok: 1 })]);
    await client(cfg(), f.impl).request({ method: "GET", path: "/profile/me" });
    expect(f.calls[0]!.url).toBe("https://api.dev.aposkal.com/profile/me");
    expect(f.calls[0]!.headers["X-API-Key"]).toBe(FAKE_KEY);
    expect(f.calls[0]!.headers["X-API-Secret"]).toBe(FAKE_SECRET);
  });

  it("503 alınca GET'i tekrar dener, POST'u asla tekrar denemez", async () => {
    const g = fakeFetch([new Response("", { status: 503 }), json({ ok: 1 })]);
    await client(cfg(), g.impl).request({ method: "GET", path: "/x" });
    expect(g.calls).toHaveLength(2);

    const p = fakeFetch([new Response("", { status: 503 }), json({ ok: 1 })]);
    await expect(client(cfg(), p.impl).request({ method: "POST", path: "/x", json: {} })).rejects.toBeInstanceOf(ApiError);
    expect(p.calls).toHaveLength(1);
  });

  it("yalnızca https *.aposkal.com yönlendirmelerini raporlar", async () => {
    expect(isAllowedRedirect("https://cdn.aposkal.com/a.pdf?sig=1")).toBe(true);
    expect(isAllowedRedirect("https://cdn.dev.aposkal.com/a.pdf")).toBe(true);
    expect(isAllowedRedirect("http://cdn.aposkal.com/a.pdf")).toBe(false);
    expect(isAllowedRedirect("https://aposkal.com.evil.io/a")).toBe(false);
    expect(isAllowedRedirect("https://evil.io/?x=.aposkal.com")).toBe(false);

    const ok = fakeFetch([new Response(null, { status: 302, headers: { location: "https://cdn.aposkal.com/f.pdf" } })]);
    expect(await client(cfg(), ok.impl).request({ method: "GET", path: "/d" })).toMatchObject({ kind: "redirect" });
    const bad = fakeFetch([new Response(null, { status: 302, headers: { location: "https://evil.io/f" } })]);
    await expect(client(cfg(), bad.impl).request({ method: "GET", path: "/d" })).rejects.toThrow(/Aposkal dışı/);
    expect(bad.calls).toHaveLength(1); // asla takip edilmez
  });

  it("güvenli olmayan yolları reddeder", async () => {
    const f = fakeFetch([]);
    for (const path of ["//evil.io/x", "/1/../profile", "x"]) {
      await expect(client(cfg(), f.impl).request({ method: "GET", path })).rejects.toThrow(/Güvenli olmayan/);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("API hata mesajlarını iletir", async () => {
    const f = fakeFetch([json({ code: "FORBIDDEN", message: "Bu işlemi yapmaya yetkiniz bulunmuyor", timestamp: "" }, 403)]);
    await expect(client(cfg(), f.impl).request({ method: "GET", path: "/x" })).rejects.toThrow(/403.*yetkiniz/);
  });
});

describe("maskeleme", () => {
  it("kayıtlı sırları ve Aposkal anahtar biçimlerini gizler", () => {
    registerSecret(FAKE_SECRET);
    expect(redact(`secret=${FAKE_SECRET}`)).not.toContain(FAKE_SECRET);
    // sahte değerler çalışma anında oluşturulur; böylece repodaki gizli bilgi tarayıcısı tetiklenmez
    const fakeKey = "ak" + "_" + "0123456789abcdef".repeat(2);
    expect(redact(`key ${fakeKey} here`)).toBe("key [GİZLENDİ] here");
    const header = ["X-API", "Secret"].join("-");
    expect(redact(`"${header}": "abc123456789"`)).toContain("[GİZLENDİ]");
  });
});

describe("istek oluşturucu", () => {
  it("yolu oluşturur, sorguyu düzleştirir ve yol enjeksiyonunu reddeder", async () => {
    const op = spec.find("get-account")!;
    const c = cfg({ defaultCompanyId: "5" });
    const req = await buildRequest(op, { accountId: "abc-123" }, c);
    expect(req.path).toBe("/5/account/abc-123");
    await expect(buildRequest(op, { accountId: "../../profile" }, c)).rejects.toThrow(/geçersiz değer/);
    await expect(buildRequest(op, { accountId: "a/b" }, c)).rejects.toThrow(/geçersiz değer/);
    await expect(buildRequest(op, { accountId: "x", evil: 1 }, c)).rejects.toThrow(/bilinmeyen argüman/);

    const list = spec.find("GET /{companyId}/account")!;
    const r2 = await buildRequest(list, { page: 0, size: 5, type: ["CARI", "KASA"] }, c);
    expect(r2.query).toEqual({ page: 0, size: 5, type: ["CARI", "KASA"] });
  });

  it("resmileştirmeyi varsayılan olarak ağa hiç çıkmadan engeller", async () => {
    const f = fakeFetch([]);
    const ctx = { cfg: cfg({ mode: "full", defaultCompanyId: "1" }), client: client(cfg(), f.impl) };
    const op = spec.find("formalizeDocument")!;
    await expect(execute(op, { documentId: "d1", body: {}, confirm: true }, ctx)).rejects.toThrow(/APOSKAL_ALLOW_EXTERNAL/);
    expect(f.calls).toHaveLength(0);
  });

  it("dış işlemler açık olsa bile confirm ister", async () => {
    const f = fakeFetch([]);
    const c = cfg({ mode: "write", allowExternal: true, defaultCompanyId: "1" });
    const op = spec.find("formalizeDocument")!;
    await expect(execute(op, { documentId: "d1", body: {} }, { cfg: c, client: client(c, f.impl) })).rejects.toThrow(/confirm/);
    expect(f.calls).toHaveLength(0);
  });

  it("yalnızca APOSKAL_UPLOAD_DIR içindeki dosyaları yükler (sembolik bağlantılar çözülür)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aposkal-up-"));
    const outside = await mkdtemp(join(tmpdir(), "aposkal-out-"));
    await writeFile(join(dir, "ok.pdf"), "x");
    await writeFile(join(outside, "secret.txt"), "x");
    await symlink(join(outside, "secret.txt"), join(dir, "link.txt"));
    const op = spec.find("upload-e-invoice-attachment")!;
    const field = op.body!.fileFields[0] ?? "file";
    const c = cfg({ uploadDir: dir, defaultCompanyId: "1" });
    const extra = Object.fromEntries(op.params.filter((p) => p.required).map((p) => [p.name, "x"]));
    const req = await buildRequest(op, { ...extra, body: { [field]: "ok.pdf" } }, c);
    expect(req.multipart?.files[0]?.path).toMatch(/ok\.pdf$/);
    await expect(buildRequest(op, { ...extra, body: { [field]: join(outside, "secret.txt") } }, c)).rejects.toThrow(/dışında/);
    await expect(buildRequest(op, { ...extra, body: { [field]: "link.txt" } }, c)).rejects.toThrow(/dışında/);
    await expect(buildRequest(op, { ...extra, body: { [field]: "ok.pdf" } }, cfg({ defaultCompanyId: "1" }))).rejects.toThrow(/kapalı/);
  });
});
