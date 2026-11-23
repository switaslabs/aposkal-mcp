import { describe, expect, it } from "vitest";
import { loadConfig, publicConfig } from "../src/config.js";
import { FAKE_KEY, FAKE_SECRET } from "./helpers.js";

const base = { APOSKAL_API_KEY: FAKE_KEY, APOSKAL_API_SECRET: FAKE_SECRET, APOSKAL_ENV: "live" };

describe("yapılandırma", () => {
  it("varsayılan olarak salt-okuma modunda ve tüm riskli işlemler kapalı başlar", () => {
    const c = loadConfig(base);
    expect(c.mode).toBe("readonly");
    expect(c.allowExternal).toBe(false);
    expect(c.allowSensitive).toBe(false);
    expect(c.baseUrl).toBe("https://api.aposkal.com");
    expect(c.toolsets).toEqual([]);
  });

  it("kimlik bilgileri ve açıkça seçilmiş ortam zorunludur", () => {
    expect(() => loadConfig({})).toThrow(/APOSKAL_API_KEY/);
    expect(() => loadConfig({ ...base, APOSKAL_ENV: undefined })).toThrow(/APOSKAL_ENV/);
    expect(() => loadConfig({ ...base, APOSKAL_ENV: "prod" })).toThrow(/APOSKAL_ENV/);
  });

  it("header enjeksiyonuna yol açabilecek kimlik bilgilerini reddeder", () => {
    expect(() => loadConfig({ ...base, APOSKAL_API_SECRET: "abc def ghi jkl" })).toThrow();
    expect(() => loadConfig({ ...base, APOSKAL_API_SECRET: "abcdefgh\r\nX-Evil: 1" })).toThrow();
  });

  it("aynı key ve secret değerini reddeder", () => {
    expect(() => loadConfig({ ...base, APOSKAL_API_SECRET: FAKE_KEY })).toThrow(/farklı/);
  });

  it("firma izin listesini ve varsayılan firmayı doğrular", () => {
    expect(loadConfig({ ...base, APOSKAL_COMPANY_IDS: "1, 22" }).companyIds).toEqual(["1", "22"]);
    expect(() => loadConfig({ ...base, APOSKAL_COMPANY_IDS: "1,abc" })).toThrow();
    expect(() => loadConfig({ ...base, APOSKAL_COMPANY_IDS: "1", APOSKAL_DEFAULT_COMPANY_ID: "2" })).toThrow();
  });

  it("boolean değerleri katı biçimde ayrıştırır", () => {
    expect(loadConfig({ ...base, APOSKAL_ALLOW_EXTERNAL: "true" }).allowExternal).toBe(true);
    expect(() => loadConfig({ ...base, APOSKAL_ALLOW_EXTERNAL: "maybe" })).toThrow();
  });

  it("publicConfig asla gizli bilgi göstermez", () => {
    const text = JSON.stringify(publicConfig(loadConfig(base)));
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_KEY);
  });
});
