/**
 * Uzak (HTTP) çalışma modu — Vercel gibi sunucusuz ortamlar için.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * Güvenlik:
 * - MCP_AUTH_TOKEN zorunludur (en az 32 karakter). Token yoksa ya da zayıfsa
 *   sunucu hiçbir isteğe hizmet vermez.
 * - Her istek `Authorization: Bearer <token>` taşımalıdır. Karşılaştırma sabit
 *   sürelidir (zamanlama saldırısına karşı).
 * - Durumsuz (stateless) Streamable HTTP: oturum tutulmaz, her istek kendi
 *   sunucu örneğini kullanır. Yalnızca POST kabul edilir.
 * - Tarayıcıdan çapraz kaynak (CORS) erişimi açılmaz.
 * - Güvenlik politikası (salt-okuma varsayılanı, confirm onayı, firma izin
 *   listesi…) stdio moduyla birebir aynıdır.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { log, registerSecret, setLogLevel } from "./redact.js";
import { createServer } from "./server.js";

const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface HttpState {
  cfg: Config;
  tokenDigest: Buffer;
}

let state: HttpState | undefined;
let stateError: string | undefined;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Yapılandırmayı bir kez okur; hata olursa ayrıntıyı loglar, istemciye genel mesaj döner. */
export function initHttp(env: NodeJS.ProcessEnv = process.env): HttpState | undefined {
  if (state || stateError) return state;
  registerSecret(env.APOSKAL_API_KEY?.trim());
  registerSecret(env.APOSKAL_API_SECRET?.trim());
  registerSecret(env.MCP_AUTH_TOKEN?.trim());
  try {
    const token = env.MCP_AUTH_TOKEN?.trim() ?? "";
    if (token.length < MIN_TOKEN_LENGTH || !/^[\x21-\x7E]+$/.test(token)) {
      throw new ConfigError(
        `MCP_AUTH_TOKEN zorunludur ve boşluksuz en az ${MIN_TOKEN_LENGTH} karakter olmalıdır (ör. "openssl rand -hex 32" ile üretin).`,
      );
    }
    const cfg = { ...loadConfig(env), saveBinaries: false };
    setLogLevel(cfg.logLevel);
    state = { cfg, tokenDigest: digest(token) };
    log.info(`HTTP modu hazır · ortam=${cfg.env} mod=${cfg.mode} dış=${cfg.allowExternal} hassas=${cfg.allowSensitive}`);
    return state;
  } catch (err) {
    stateError = err instanceof Error ? err.message : String(err);
    log.error(`HTTP modu başlatılamadı: ${stateError}`);
    return undefined;
  }
}

/** Testler için önbelleği sıfırlar. */
export function resetHttpState(): void {
  state = undefined;
  stateError = undefined;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { jsonrpc: "2.0", error: { code: -32001, message }, id: null }, headers);
}

function authorized(req: Request, s: HttpState): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), s.tokenDigest);
}

/** Vercel Function (Web standardı Request/Response) giriş noktası. */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const s = initHttp();
  if (!s) return rpcError(503, "Sunucu yapılandırılmamış. Yöneticinin sunucu loglarını kontrol etmesi gerekiyor.");

  if (!authorized(req, s)) {
    return rpcError(401, "Yetkisiz: geçerli bir 'Authorization: Bearer <token>' başlığı gerekli.", {
      "www-authenticate": 'Bearer realm="aposkal-mcp"',
    });
  }
  if (req.method !== "POST") {
    return rpcError(405, "Bu sunucu durumsuz çalışır; yalnızca POST kabul edilir.", { allow: "POST" });
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return rpcError(413, "İstek gövdesi çok büyük.");
  }

  const { server } = createServer(s.cfg);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // durumsuz
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    log.error("HTTP isteği işlenemedi", err instanceof Error ? err.stack ?? err.message : String(err));
    return rpcError(500, "İstek işlenirken beklenmeyen bir hata oluştu.");
  } finally {
    // Yanıt JSON modunda tamamen üretildiği için kaynaklar hemen bırakılabilir.
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  }
}
