import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleAuthorizationServerMetadata,
  handleAuthorize,
  handleMcpRequest,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
  initHttp,
  resetHttpState,
} from "../src/http-handler.js";
import { FAKE_KEY, FAKE_SECRET } from "./helpers.js";

// Sahte erişim parolası (testlere özel).
const TOKEN = "p".repeat(48);
const BASE = "https://ornek.vercel.app";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const ENV = { APOSKAL_API_KEY: FAKE_KEY, APOSKAL_API_SECRET: FAKE_SECRET, APOSKAL_ENV: "test", MCP_AUTH_TOKEN: TOKEN, APOSKAL_LOG_LEVEL: "error" };

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function registerClient(redirect = CLAUDE_CB) {
  const res = await handleRegister(
    new Request(`${BASE}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }),
    }),
  );
  return { res, body: await res.json() };
}

function authParams(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "durum-123",
    resource: `${BASE}/api/mcp`,
    ...extra,
  });
}

async function login(clientId: string, password = TOKEN) {
  const p = authParams(clientId);
  p.set("password", password);
  return handleAuthorize(
    new Request(`${BASE}/api/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: p }),
  );
}

async function exchange(params: Record<string, string>) {
  const res = await handleToken(
    new Request(`${BASE}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }),
  );
  return { res, body: await res.json() };
}

const mcpList = (token: string) =>
  handleMcpRequest(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    }),
  );

describe("OAuth (Claude.ai bağlayıcıları)", () => {
  beforeEach(() => {
    resetHttpState();
    initHttp(ENV);
  });
  afterEach(() => resetHttpState());

  it("401 yanıtı korunan kaynak meta veri adresini bildirir", async () => {
    const res = await handleMcpRequest(new Request(`${BASE}/api/mcp`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  });

  it("meta veri uçları doğru adresleri döndürür", async () => {
    const pr = await (await handleProtectedResourceMetadata(new Request(`${BASE}/.well-known/oauth-protected-resource`))).json();
    expect(pr.resource).toBe(`${BASE}/api/mcp`);
    expect(pr.authorization_servers).toEqual([BASE]);
    const as = await (await handleAuthorizationServerMetadata(new Request(`${BASE}/.well-known/oauth-authorization-server`))).json();
    expect(as.issuer).toBe(BASE);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${BASE}/api/oauth/register`);
  });

  it("izin verilmeyen geri dönüş adresiyle kayıt reddedilir", async () => {
    const { res, body } = await registerClient("https://kotu.example.com/callback");
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("tam akış: kayıt → giriş → kod → token → MCP çağrısı → yenileme", async () => {
    const { res: regRes, body: client } = await registerClient();
    expect(regRes.status).toBe(201);

    const page = await handleAuthorize(new Request(`${BASE}/api/oauth/authorize?${authParams(client.client_id)}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Erişim parolası");
    expect(html).toContain("Resmî olmayan");
    expect(html).not.toContain(TOKEN);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const redirect = await login(client.client_id);
    expect(redirect.status).toBe(302);
    const loc = new URL(redirect.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_CB);
    expect(loc.searchParams.get("state")).toBe("durum-123");
    const code = loc.searchParams.get("code")!;

    const { res: tokRes, body: tokens } = await exchange({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CLAUDE_CB,
      code_verifier: verifier,
    });
    expect(tokRes.status).toBe(200);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).not.toBe(TOKEN);

    const mcp = await mcpList(tokens.access_token);
    expect(mcp.status).toBe(200);
    expect((await mcp.json()).result.serverInfo.name).toBe("aposkal-mcp");

    const { res: refRes, body: refreshed } = await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refRes.status).toBe(200);
    expect((await mcpList(refreshed.access_token)).status).toBe(200);
  });

  it("yanlış parola kod vermez", async () => {
    const { body: client } = await registerClient();
    const res = await login(client.client_id, "yanlis-parola");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("hatalı");
  });

  it("PKCE doğrulayıcısı yanlışsa token verilmez", async () => {
    const { body: client } = await registerClient();
    const code = new URL((await login(client.client_id)).headers.get("location")!).searchParams.get("code")!;
    const { res, body } = await exchange({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CLAUDE_CB,
      code_verifier: randomBytes(32).toString("base64url"),
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
  });

  it("başka bir istemcinin kodu kullanılamaz", async () => {
    const { body: a } = await registerClient();
    const { body: b } = await registerClient("http://localhost:33418/callback");
    const code = new URL((await login(a.client_id)).headers.get("location")!).searchParams.get("code")!;
    const { body } = await exchange({ grant_type: "authorization_code", code, client_id: b.client_id, code_verifier: verifier });
    expect(body.error).toBe("invalid_grant");
  });

  it("PKCE olmadan ya da kayıtsız geri dönüş adresiyle giriş sayfası açılmaz", async () => {
    const { body: client } = await registerClient();
    const noPkce = authParams(client.client_id);
    noPkce.delete("code_challenge");
    expect((await handleAuthorize(new Request(`${BASE}/api/oauth/authorize?${noPkce}`))).status).toBe(400);
    const other = authParams(client.client_id, { redirect_uri: "https://claude.com/api/mcp/auth_callback" });
    expect((await handleAuthorize(new Request(`${BASE}/api/oauth/authorize?${other}`))).status).toBe(400);
  });

  it("sahte ya da başka kaynağa ait erişim anahtarı reddedilir", async () => {
    expect((await mcpList("v1.e30.AAAA")).status).toBe(401);
    // farklı MCP_AUTH_TOKEN ile imzalanmış anahtar
    resetHttpState();
    initHttp({ ...ENV, MCP_AUTH_TOKEN: "q".repeat(48) });
    const { body: client } = await registerClient();
    const code = new URL((await login(client.client_id, "q".repeat(48))).headers.get("location")!).searchParams.get("code")!;
    const { body: tokens } = await exchange({ grant_type: "authorization_code", code, client_id: client.client_id, code_verifier: verifier });
    resetHttpState();
    initHttp(ENV);
    expect((await mcpList(tokens.access_token)).status).toBe(401);
  });

  it("sabit token (Claude Code) OAuth açıkken de çalışmaya devam eder", async () => {
    expect((await mcpList(TOKEN)).status).toBe(200);
  });

  it("MCP_OAUTH_ENABLED=false iken OAuth uçları kapalıdır", async () => {
    resetHttpState();
    initHttp({ ...ENV, MCP_OAUTH_ENABLED: "false" });
    expect((await handleAuthorizationServerMetadata(new Request(`${BASE}/.well-known/oauth-authorization-server`))).status).toBe(404);
  });
});
