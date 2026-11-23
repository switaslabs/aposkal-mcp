import { describe, expect, it } from "vitest";
import { assertAllowed, decide, resolveCompanyId } from "../src/policy.js";
import { cfg } from "./helpers.js";

describe("güvenlik politikası", () => {
  it("mod × risk matrisi", () => {
    const ro = cfg({ mode: "readonly" });
    const w = cfg({ mode: "write" });
    const f = cfg({ mode: "full" });
    expect(decide("read", "GET", ro).allowed).toBe(true);
    expect(decide("write", "POST", ro).allowed).toBe(false);
    expect(decide("write", "POST", w).allowed).toBe(true);
    expect(decide("destructive", "DELETE", w).allowed).toBe(false);
    expect(decide("destructive", "DELETE", f)).toEqual({ allowed: true, requiresConfirm: true });
  });

  it("dış işlemler full modda bile ayrı bayrak ister", () => {
    expect(decide("external", "POST", cfg({ mode: "full" })).allowed).toBe(false);
    expect(decide("external", "POST", cfg({ mode: "full", allowExternal: true }))).toEqual({ allowed: true, requiresConfirm: true });
    expect(decide("external", "POST", cfg({ mode: "readonly", allowExternal: true })).allowed).toBe(false);
  });

  it("hassas işlemler bayrak ister; yazanlar ayrıca full mod ister", () => {
    expect(decide("sensitive", "POST", cfg({ mode: "full" })).allowed).toBe(false);
    expect(decide("sensitive", "POST", cfg({ mode: "write", allowSensitive: true })).allowed).toBe(false);
    expect(decide("sensitive", "POST", cfg({ mode: "full", allowSensitive: true })).requiresConfirm).toBe(true);
    expect(decide("sensitive", "GET", cfg({ allowSensitive: true }))).toEqual({ allowed: true, requiresConfirm: false });
  });

  it("confirm değerinin tam olarak true olmasını ister ('true' metni yetmez)", () => {
    const f = cfg({ mode: "full" });
    expect(() => assertAllowed("destructive", "DELETE", undefined, f, "x")).toThrow(/confirm/);
    expect(() => assertAllowed("destructive", "DELETE", "true", f, "x")).toThrow(/confirm/);
    expect(() => assertAllowed("destructive", "DELETE", true, f, "x")).not.toThrow();
  });

  it("firma izin listesini uygular", () => {
    const c = cfg({ companyIds: ["7"], defaultCompanyId: "7" });
    expect(resolveCompanyId(undefined, c)).toBe("7");
    expect(resolveCompanyId(7, c)).toBe("7");
    expect(() => resolveCompanyId(8, c)).toThrow(/listesinde değil/);
    expect(() => resolveCompanyId("7/../8", c)).toThrow(/pozitif bir tam sayı/);
    expect(() => resolveCompanyId(-1, cfg())).toThrow();
    expect(() => resolveCompanyId(undefined, cfg())).toThrow(/zorunludur/);
  });
});
