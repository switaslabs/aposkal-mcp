/**
 * Uzak mod için OAuth 2.1 yetkilendirme sunucusu (Claude.ai bağlayıcıları vb. için).
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * MCP yetkilendirme spesifikasyonunu izler:
 * - RFC 9728  korunan kaynak meta verisi   (/.well-known/oauth-protected-resource)
 * - RFC 8414  yetkilendirme sunucusu meta verisi (/.well-known/oauth-authorization-server)
 * - RFC 7591  dinamik istemci kaydı        (/api/oauth/register)
 * - OAuth 2.1 yetkilendirme kodu + PKCE (S256 zorunlu) ve yenileme anahtarı
 *
 * Veritabanı kullanılmaz: istemci kimlikleri, yetkilendirme kodları ve erişim
 * anahtarları HMAC-SHA256 ile imzalanmış, süreli yapılardır. İmza anahtarı
 * MCP_AUTH_TOKEN'dan türetilir; MCP_AUTH_TOKEN değiştirildiğinde verilmiş tüm
 * anahtarlar geçersiz olur.
 *
 * Giriş sayfası, sunucuyu kuran kişinin belirlediği MCP_AUTH_TOKEN değerini
 * (erişim parolası) ister. Yalnızca izin verilen geri dönüş adreslerine
 * (Claude'un resmî adresleri, yerel geri dönüş adresleri ve isteğe bağlı ek
 * adresler) yönlendirme yapılır.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthOptions {
  /** HMAC imza anahtarı (MCP_AUTH_TOKEN'dan türetilir). */
  key: Buffer;
  /** Erişim parolasının (MCP_AUTH_TOKEN) SHA-256 özeti. */
  passwordDigest: Buffer;
  /** Sabit genel adres (MCP_PUBLIC_URL); yoksa isteğin adresi kullanılır. */
  publicUrl?: string;
  /** İzin verilen ek geri dönüş adresleri (MCP_OAUTH_REDIRECT_URIS). */
  extraRedirectUris: string[];
}

/** Claude'un resmî OAuth geri dönüş adresleri. */
export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

const TTL = {
  client: 365 * 24 * 3600,
  code: 120,
  access: 3600,
  refresh: 30 * 24 * 3600,
} as const;

type TokenType = keyof typeof TTL;
const MCP_PATH = "/api/mcp";

// ---------------------------------------------------------------- yardımcılar

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function deriveKey(secret: string): Buffer {
  return createHmac("sha256", "aposkal-mcp/oauth/v1").update(secret, "utf8").digest();
}

function sign(key: Buffer, typ: TokenType, payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, typ, iat: now, exp: now + TTL[typ] }));
  const mac = createHmac("sha256", key).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${mac}`;
}

export function verify<T extends Record<string, unknown>>(key: Buffer, typ: TokenType, token: string | null | undefined): T | undefined {
  if (!token || token.length > 8192) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return undefined;
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2]!, "base64url");
  } catch {
    return undefined;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as T & { typ?: string; exp?: number };
    if (payload.typ !== typ || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function origin(req: Request, opts: Pick<OAuthOptions, "publicUrl">): string {
  if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? u.host;
  return `${proto}://${host}`;
}

export const resourceUrl = (req: Request, opts: Pick<OAuthOptions, "publicUrl">) => `${origin(req, opts)}${MCP_PATH}`;

export function protectedResourceMetadataUrl(req: Request, opts: Pick<OAuthOptions, "publicUrl">): string {
  return `${origin(req, opts)}/.well-known/oauth-protected-resource`;
}

/** Geri dönüş adresi izinli mi? Claude adresleri, yerel geri dönüş (RFC 8252) ve ek liste. */
export function isAllowedRedirect(uri: string, opts: Pick<OAuthOptions, "extraRedirectUris">): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (CLAUDE_REDIRECT_URIS.includes(uri) || opts.extraRedirectUris.includes(uri)) return true;
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return u.protocol === "http:" && loopback;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", ...CORS, ...extra },
  });
}

const oauthError = (status: number, error: string, description: string) => json(status, { error, error_description: description });

function preflight(req: Request): Response | undefined {
  return req.method === "OPTIONS" ? new Response(null, { status: 204, headers: CORS }) : undefined;
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  const text = (await req.text()).slice(0, 64 * 1024);
  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") p.set(k, v);
      return p;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ------------------------------------------------------------- meta veriler

export function protectedResourceMetadata(req: Request, opts: OAuthOptions): Response {
  return (
    preflight(req) ??
    json(200, {
      resource: resourceUrl(req, opts),
      authorization_servers: [origin(req, opts)],
      bearer_methods_supported: ["header"],
      resource_name: "Aposkal MCP — Switas Consultancy",
      resource_documentation: "https://github.com/switaslabs/aposkal-mcp",
    })
  );
}

export function authorizationServerMetadata(req: Request, opts: OAuthOptions): Response {
  const o = origin(req, opts);
  return (
    preflight(req) ??
    json(200, {
      issuer: o,
      authorization_endpoint: `${o}/api/oauth/authorize`,
      token_endpoint: `${o}/api/oauth/token`,
      registration_endpoint: `${o}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
      service_documentation: "https://github.com/switaslabs/aposkal-mcp",
    })
  );
}

// ------------------------------------------------------------- istemci kaydı

interface ClientPayload extends Record<string, unknown> {
  r: string[]; // redirect_uris
  n: string; // client_name
}

export async function register(req: Request, opts: OAuthOptions): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return oauthError(405, "invalid_request", "Yalnızca POST kabul edilir.");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await req.text()).slice(0, 32 * 1024)) as Record<string, unknown>;
  } catch {
    return oauthError(400, "invalid_client_metadata", "Gövde geçerli JSON olmalıdır.");
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (uris.length === 0 || uris.length > 10) return oauthError(400, "invalid_redirect_uri", "1–10 adet redirect_uris gerekli.");
  const bad = uris.filter((u) => !isAllowedRedirect(u, opts));
  if (bad.length) return oauthError(400, "invalid_redirect_uri", `İzin verilmeyen geri dönüş adresi: ${bad.join(", ")}`);
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "MCP istemcisi";
  const clientId = sign(opts.key, "client", { r: uris, n: name } satisfies ClientPayload);
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

// ---------------------------------------------------------- yetkilendirme

interface AuthRequest {
  client: ClientPayload;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
}

/** Yetkilendirme isteğini doğrular. Hata varsa kullanıcıya gösterilecek metni döndürür. */
function validateAuthRequest(p: URLSearchParams, req: Request, opts: OAuthOptions): AuthRequest | string {
  const clientId = p.get("client_id") ?? "";
  const client = verify<ClientPayload>(opts.key, "client", clientId);
  if (!client) return "Geçersiz ya da süresi dolmuş istemci kimliği (client_id). Bağlantıyı istemciden yeniden başlatın.";
  const redirectUri = p.get("redirect_uri") ?? (client.r.length === 1 ? client.r[0]! : "");
  if (!client.r.includes(redirectUri) || !isAllowedRedirect(redirectUri, opts)) return "Geri dönüş adresi bu istemci için kayıtlı değil.";
  if (p.get("response_type") !== "code") return "Yalnızca response_type=code desteklenir.";
  const codeChallenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    return "PKCE zorunludur (code_challenge_method=S256).";
  }
  const expected = resourceUrl(req, opts);
  const resource = p.get("resource") ?? expected;
  if (resource.replace(/\/+$/, "") !== expected) return "İstenen kaynak (resource) bu sunucuya ait değil.";
  return { client, clientId, redirectUri, state: (p.get("state") ?? "").slice(0, 512), codeChallenge, resource: expected };
}

function loginPage(ar: AuthRequest, error?: string): Response {
  const redirectHost = new URL(ar.redirectUri).host;
  const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${escapeHtml(v)}">`;
  const html = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aposkal MCP — Bağlantı izni</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f7f9fb;--fg:#13233a;--muted:#5b6b80;--card:#fff;--line:#e3e8ef;--accent:#00a896;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1722;--fg:#e6edf5;--muted:#9aa9bb;--card:#16212f;--line:#243245;--err:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:48px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:1.3rem;margin:0 0 4px}.muted{color:var(--muted);font-size:.92rem}label{display:block;margin:16px 0 6px;font-weight:600}
input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:600 1rem system-ui;cursor:pointer}
.err{color:var(--err);margin-top:12px}ul{padding-left:18px;margin:12px 0}a{color:inherit}footer{margin-top:20px;text-align:center}
</style></head><body><main><div class="card">
<h1>Aposkal MCP'ye bağlan</h1>
<div class="muted"><strong>${escapeHtml(ar.client.n)}</strong> uygulaması bu sunucuya erişmek istiyor.</div>
<ul class="muted">
<li>Yetki verirseniz uygulama, sunucuya tanımlı Aposkal hesabıyla, sunucunun güvenlik ayarlarının izin verdiği işlemleri yapabilir.</li>
<li>Onaydan sonra <strong>${escapeHtml(redirectHost)}</strong> adresine yönlendirileceksiniz.</li>
</ul>
<form method="post" action="/api/oauth/authorize" autocomplete="off">
${hidden("client_id", ar.clientId)}${hidden("redirect_uri", ar.redirectUri)}${hidden("state", ar.state)}
${hidden("code_challenge", ar.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("response_type", "code")}${hidden("resource", ar.resource)}
<label for="p">Erişim parolası</label>
<input id="p" name="password" type="password" required autofocus>
<div class="muted">Sunucuyu kuran kişinin belirlediği <code>MCP_AUTH_TOKEN</code> değeri.</div>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<button type="submit">İzin ver ve bağlan</button>
</form></div>
<footer class="muted">© <a href="https://switas.com">Switas Consultancy</a> · <a href="https://github.com/switaslabs/aposkal-mcp">aposkal-mcp</a></footer>
</main></body></html>`;
  const formTarget = new URL(ar.redirectUri).origin;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTarget}; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

function errorPage(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Aposkal MCP — Hata</title><body style="font:16px system-ui;max-width:520px;margin:48px auto;padding:0 16px"><h1>Bağlantı kurulamadı</h1><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } },
  );
}

export async function authorize(req: Request, opts: OAuthOptions): Promise<Response> {
  if (req.method === "GET") {
    const ar = validateAuthRequest(new URL(req.url).searchParams, req, opts);
    return typeof ar === "string" ? errorPage(400, ar) : loginPage(ar);
  }
  if (req.method !== "POST") return errorPage(405, "Desteklenmeyen istek.");
  const p = await readParams(req);
  const ar = validateAuthRequest(p, req, opts);
  if (typeof ar === "string") return errorPage(400, ar);

  const password = p.get("password") ?? "";
  if (!timingSafeEqual(sha256(password), opts.passwordDigest)) {
    await new Promise((r) => setTimeout(r, 800)); // kaba kuvvet denemelerini yavaşlat
    return loginPage(ar, "Erişim parolası hatalı.");
  }
  const code = sign(opts.key, "code", {
    c: sha256(ar.clientId).toString("base64url"),
    u: ar.redirectUri,
    ch: ar.codeChallenge,
    res: ar.resource,
  });
  const target = new URL(ar.redirectUri);
  target.searchParams.set("code", code);
  if (ar.state) target.searchParams.set("state", ar.state);
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
}

// -------------------------------------------------------------------- token

interface CodePayload extends Record<string, unknown> {
  c: string;
  u: string;
  ch: string;
  res: string;
}
interface RefreshPayload extends Record<string, unknown> {
  c: string;
  res: string;
}

function issueTokens(opts: OAuthOptions, clientHash: string, resource: string): Response {
  return json(200, {
    access_token: sign(opts.key, "access", { c: clientHash, aud: resource }),
    token_type: "Bearer",
    expires_in: TTL.access,
    refresh_token: sign(opts.key, "refresh", { c: clientHash, res: resource }),
    scope: "mcp",
  });
}

export async function token(req: Request, opts: OAuthOptions): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return oauthError(405, "invalid_request", "Yalnızca POST kabul edilir.");
  const p = await readParams(req);
  const clientId = p.get("client_id") ?? "";
  if (!verify<ClientPayload>(opts.key, "client", clientId)) return oauthError(401, "invalid_client", "Geçersiz istemci kimliği.");
  const clientHash = sha256(clientId).toString("base64url");

  switch (p.get("grant_type")) {
    case "authorization_code": {
      const code = verify<CodePayload>(opts.key, "code", p.get("code"));
      if (!code || code.c !== clientHash) return oauthError(400, "invalid_grant", "Yetkilendirme kodu geçersiz ya da süresi dolmuş.");
      if ((p.get("redirect_uri") ?? code.u) !== code.u) return oauthError(400, "invalid_grant", "redirect_uri eşleşmiyor.");
      const verifier = p.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== code.ch) {
        return oauthError(400, "invalid_grant", "PKCE doğrulaması başarısız.");
      }
      return issueTokens(opts, clientHash, code.res);
    }
    case "refresh_token": {
      const rt = verify<RefreshPayload>(opts.key, "refresh", p.get("refresh_token"));
      if (!rt || rt.c !== clientHash) return oauthError(400, "invalid_grant", "Yenileme anahtarı geçersiz ya da süresi dolmuş.");
      return issueTokens(opts, clientHash, rt.res);
    }
    default:
      return oauthError(400, "unsupported_grant_type", "Desteklenen grant_type değerleri: authorization_code, refresh_token.");
  }
}

/** MCP ucu için OAuth erişim anahtarını doğrular. */
export function verifyAccessToken(req: Request, tokenValue: string, opts: OAuthOptions): boolean {
  const t = verify<{ aud?: string }>(opts.key, "access", tokenValue);
  return Boolean(t && t.aud === resourceUrl(req, opts));
}
