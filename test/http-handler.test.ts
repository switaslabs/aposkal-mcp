import { afterEach, describe, expect, it } from "vitest";
import { handleMcpRequest, initHttp, resetHttpState } from "../src/http-handler.js";
import { FAKE_KEY, FAKE_SECRET } from "./helpers.js";

// Sahte token (testlere özel, gerçek bir değer değildir).
const TOKEN = "t".repeat(40);
const ENV = { APOSKAL_API_KEY: FAKE_KEY, APOSKAL_API_SECRET: FAKE_SECRET, APOSKAL_ENV: "test", MCP_AUTH_TOKEN: TOKEN, APOSKAL_LOG_LEVEL: "error" };

function rpc(body: unknown, token: string | null = TOKEN, method = "POST") {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://ornek.vercel.app/api/mcp", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

describe("HTTP (Vercel) modu", () => {
  afterEach(() => resetHttpState());

  it("MCP_AUTH_TOKEN yoksa ya da kısaysa hiçbir isteğe hizmet vermez", async () => {
    resetHttpState();
    expect(initHttp({ ...ENV, MCP_AUTH_TOKEN: "kisa" })).toBeUndefined();
    const res = await handleMcpRequest(rpc(INIT));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("kisa");
  });

  it("token olmadan ya da yanlış token ile 401 döner", async () => {
    initHttp(ENV);
    expect((await handleMcpRequest(rpc(INIT, null))).status).toBe(401);
    const wrong = await handleMcpRequest(rpc(INIT, "y".repeat(40)));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("yalnızca POST kabul eder", async () => {
    initHttp(ENV);
    const res = await handleMcpRequest(rpc(null, TOKEN, "GET"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("doğru token ile initialize, araç listesi ve politika çalışır", async () => {
    initHttp(ENV);
    const init = await handleMcpRequest(rpc(INIT));
    expect(init.status).toBe(200);
    const initBody = await init.json();
    expect(initBody.result.serverInfo.title).toContain("Switas Consultancy");
    expect(initBody.result.serverInfo.title).toContain("Resmî Olmayan");
    expect(initBody.result.instructions).toContain("resmî ürünü değildir");

    const list = await (await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("aposkal_list_companies");
    expect(names).not.toContain("aposkal_create_sales_invoice_draft"); // salt-okuma varsayılanı

    const call = await (
      await handleMcpRequest(
        rpc({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "aposkal_call_endpoint", arguments: { operation: "formalizeDocument", args: { companyId: 1, documentId: "x", body: {} }, confirm: true } },
        }),
      )
    ).json();
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/engellendi/);
  });

  it("yanıtlarda gizli bilgi bulunmaz", async () => {
    initHttp(ENV);
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "aposkal_server_info", arguments: {} } }),
    );
    const text = await res.text();
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(FAKE_KEY);
  });
});
