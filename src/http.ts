/**
 * Aposkal API için küçük ve sıkılaştırılmış HTTP istemcisi.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * - Temel adres APOSKAL_ENV ile sabittir (çağıran sunucu seçemez → SSRF yok).
 * - Yönlendirmeler otomatik takip edilmez. Yalnızca https *.aposkal.com
 *   adresine giden yönlendirme raporlanır ve oraya kimlik bilgisi gönderilmez.
 * - Yalnızca idempotent GET istekleri tekrar denenir (429/502/503/504).
 *   POST/PUT/PATCH/DELETE asla tekrar denenmez; böylece zaman aşımı mükerrer
 *   fatura oluşturamaz.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Config } from "./config.js";
import { log, redact } from "./redact.js";
import { VERSION } from "./version.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | Array<string | number | boolean>;

export interface MultipartFile {
  field: string;
  /** APOSKAL_UPLOAD_DIR içinde olduğu doğrulanmış mutlak yol. */
  path: string;
}

export interface ApiRequest {
  method: HttpMethod;
  /** "/" ile başlayan, encode edilmiş yol. */
  path: string;
  query?: Record<string, QueryValue | undefined>;
  json?: unknown;
  multipart?: { fields: Record<string, string>; files: MultipartFile[] };
}

export type ApiResponse =
  | { kind: "json"; status: number; data: unknown }
  | { kind: "text"; status: number; text: string }
  | { kind: "binary"; status: number; contentType: string; bytes: Uint8Array; filename?: string }
  | { kind: "redirect"; status: number; location: string }
  | { kind: "empty"; status: number };

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function isAllowedRedirect(location: string): boolean {
  try {
    const u = new URL(location);
    return u.protocol === "https:" && (u.hostname === "aposkal.com" || u.hostname.endsWith(".aposkal.com"));
  } catch {
    return false;
  }
}

export function buildQuery(query: ApiRequest["query"]): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class AposkalClient {
  private readonly userAgent = `aposkal-mcp/${VERSION} (+https://github.com/switaslabs/aposkal-mcp; Switas Consultancy, https://switas.com)`;

  constructor(
    private readonly cfg: Pick<Config, "apiKey" | "apiSecret" | "baseUrl" | "timeoutMs">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(req: ApiRequest): Promise<ApiResponse> {
    if (!req.path.startsWith("/") || req.path.includes("//") || /\/\.\.?(\/|$)/.test(req.path)) {
      throw new Error("Güvenli olmayan bir yola istek gönderilmedi");
    }
    const url = this.cfg.baseUrl + req.path + buildQuery(req.query);
    const maxAttempts = req.method === "GET" ? 3 : 1;

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const res = await this.fetchOnce(url, req);
      log.debug(`${req.method} ${req.path} -> ${res.status} (${Date.now() - started}ms)`);

      if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 500 * 2 ** (attempt - 1);
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return this.parse(res);
    }
  }

  private async fetchOnce(url: string, req: ApiRequest): Promise<Response> {
    const headers: Record<string, string> = {
      "X-API-Key": this.cfg.apiKey,
      "X-API-Secret": this.cfg.apiSecret,
      Accept: "application/json, */*;q=0.8",
      "User-Agent": this.userAgent,
    };
    let body: BodyInit | undefined;
    if (req.multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries(req.multipart.fields)) form.append(k, v);
      for (const f of req.multipart.files) {
        const bytes = await readFile(f.path);
        form.append(f.field, new Blob([bytes]), basename(f.path));
      }
      body = form;
    } else if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    try {
      return await this.fetchImpl(url, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new ApiError(0, `İstek ${this.cfg.timeoutMs} ms sonunda zaman aşımına uğradı` +
          (req.method !== "GET" ? " — işlem uygulanmış da olabilir, uygulanmamış da; tekrar denemeden önce kontrol edin." : ""));
      }
      throw new ApiError(0, `Ağ hatası: ${redact(e.message)}`);
    }
  }

  private async parse(res: Response): Promise<ApiResponse> {
    const status = res.status;

    if (status >= 300 && status < 400) {
      const location = res.headers.get("location") ?? "";
      await res.body?.cancel().catch(() => undefined);
      if (!isAllowedRedirect(location)) {
        throw new ApiError(status, "API, Aposkal dışı bir adrese yönlendirme döndürdü; takip edilmedi.");
      }
      return { kind: "redirect", status, location };
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError(status, `Yanıt çok büyük (${declared} bayt)`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) throw new ApiError(status, "Yanıt çok büyük");
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();

    if (status >= 400) {
      const text = new TextDecoder().decode(buf);
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* metin olarak bırak */
      }
      const apiMsg =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : text.slice(0, 500);
      throw new ApiError(status, `${status} ${statusLabel(status)}${apiMsg ? ` — ${apiMsg}` : ""}`, parsed);
    }

    if (buf.byteLength === 0) return { kind: "empty", status };

    const isText = ct.includes("json") || ct.startsWith("text/") || ct.includes("xml") || ct === "" || ct.includes("*/*");
    if (isText) {
      const text = new TextDecoder().decode(buf);
      if (ct.includes("json") || ct === "" || ct.includes("*/*")) {
        try {
          return { kind: "json", status, data: JSON.parse(text) };
        } catch {
          /* metin olarak devam et */
        }
      }
      return { kind: "text", status, text };
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    return { kind: "binary", status, contentType: ct, bytes: buf, filename: m?.[1] };
  }
}

function statusLabel(status: number): string {
  switch (status) {
    case 400: return "Hatalı istek";
    case 401: return "Yetkisiz (APOSKAL_API_KEY / APOSKAL_API_SECRET ve APOSKAL_ENV değerlerini kontrol edin)";
    case 403: return "Erişim reddedildi (API anahtarının kullanıcı rolü bu işleme izin vermiyor)";
    case 404: return "Bulunamadı";
    case 409: return "Çakışma";
    case 413: return "İstek gövdesi çok büyük";
    case 422: return "İşlenemeyen istek";
    case 429: return "Çok fazla istek";
    default: return status >= 500 ? "Aposkal sunucu hatası" : "Hata";
  }
}
