import type { Config } from "../src/config.js";
import { AposkalClient } from "../src/http.js";

// Açıkça sahte kimlik bilgileri — testler gerçek API'ye asla bağlanmaz.
export const FAKE_KEY = "test-key-0000000000";
export const FAKE_SECRET = "test-secret-1111111111";

export function cfg(over: Partial<Config> = {}): Config {
  return {
    apiKey: FAKE_KEY,
    apiSecret: FAKE_SECRET,
    env: "test",
    baseUrl: "https://api.dev.aposkal.com",
    mode: "readonly",
    allowExternal: false,
    allowSensitive: false,
    companyIds: [],
    defaultCompanyId: undefined,
    toolsets: [],
    downloadDir: "/tmp/aposkal-mcp-test-downloads",
    saveBinaries: true,
    uploadDir: undefined,
    timeoutMs: 5_000,
    maxResponseChars: 60_000,
    logLevel: "error",
    ...over,
  };
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch stub that records calls and replies from a queue (or a function). */
export function fakeFetch(replies: Array<Response | (() => Response)> | ((url: string, init: RequestInit) => Response)) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : undefined,
    });
    if (typeof replies === "function") return replies(url, init);
    const r = replies.shift();
    if (!r) throw new Error("no more fake replies");
    return typeof r === "function" ? r() : r;
  }) as typeof fetch;
  return { impl, calls };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export function client(c: Config, f: typeof fetch) {
  return new AposkalClient(c, f);
}
