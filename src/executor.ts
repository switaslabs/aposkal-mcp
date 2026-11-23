/**
 * Doğrulanmış araç argümanlarını Aposkal API isteğine dönüştürür ve sonucu biçimlendirir.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 */
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";
import { type ApiRequest, type ApiResponse, type AposkalClient, type MultipartFile, type QueryValue } from "./http.js";
import { assertAllowed, PolicyError, resolveCompanyId } from "./policy.js";
import { redact } from "./redact.js";
import type { Operation } from "./spec.js";

export interface ExecContext {
  cfg: Config;
  client: AposkalClient;
}

/** Yol parçası: harf, rakam ve birkaç güvenli noktalama işareti; asla "." ya da ".." olamaz. */
const SAFE_SEGMENT = /^[\p{L}\p{N}_.:@~\-]{1,200}$/u;

function pathValue(name: string, v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string" || !SAFE_SEGMENT.test(v) || v === "." || v === "..") {
    throw new PolicyError(`"${name}" yol parametresi için geçersiz değer`);
  }
  return encodeURIComponent(v);
}

function queryValue(name: string, v: unknown): QueryValue {
  const prim = (x: unknown) => {
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return x;
    throw new PolicyError(`"${name}" sorgu parametresi metin, sayı, boolean ya da bunlardan oluşan bir dizi olmalıdır`);
  };
  return Array.isArray(v) ? v.map(prim) : prim(v);
}

/** Yükleme yolunu çözümler ve APOSKAL_UPLOAD_DIR içinde kaldığını doğrular (sembolik bağlantılar çözülür). */
async function uploadPath(cfg: Config, field: string, p: unknown): Promise<string> {
  if (!cfg.uploadDir) throw new PolicyError("Dosya yükleme kapalı (APOSKAL_UPLOAD_DIR ayarlayın).");
  if (typeof p !== "string" || !p) throw new PolicyError(`"${field}" bir dosya yolu olmalıdır`);
  const root = await realpath(cfg.uploadDir);
  const candidate = isAbsolute(p) ? p : join(root, p);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new PolicyError(`Dosya bulunamadı: ${p}`);
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PolicyError(`"${p}" APOSKAL_UPLOAD_DIR dışında`);
  if (!(await stat(real)).isFile()) throw new PolicyError(`"${p}" bir dosya değil`);
  return real;
}

export async function buildRequest(op: Operation, args: Record<string, unknown>, cfg: Config): Promise<ApiRequest> {
  const known = new Set(["companyId", "confirm", "body", ...op.params.map((p) => p.name)]);
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new PolicyError(`${op.toolName} için bilinmeyen argüman(lar): ${unknown.join(", ")}. aposkal_describe_endpoint ile parametreleri kontrol edin.`);
  }

  let path = op.path;
  if (op.hasCompanyId) path = path.replace("{companyId}", resolveCompanyId(args.companyId, cfg));

  const query: Record<string, QueryValue> = {};
  for (const p of op.params) {
    const v = args[p.name];
    if (v === undefined || v === null) {
      if (p.required) throw new PolicyError(`Zorunlu parametre eksik: "${p.name}"`);
      continue;
    }
    if (p.in === "path") path = path.replace(`{${p.apiName}}`, pathValue(p.name, v));
    else query[p.apiName] = queryValue(p.name, v);
  }
  if (/\{[^}]+\}/.test(path)) throw new PolicyError(`Yolda doldurulmamış parametre var: ${path}`);

  const req: ApiRequest = { method: op.method, path, query };
  const body = args.body;
  if (op.body) {
    if (body === undefined || body === null) {
      if (op.body.required && op.body.contentType === "json") throw new PolicyError(`${op.toolName} için "body" zorunludur`);
    } else if (op.body.contentType === "json") {
      if (typeof body !== "object") throw new PolicyError(`"body" bir JSON nesnesi ya da dizisi olmalıdır`);
      if (JSON.stringify(body).length > 2_000_000) throw new PolicyError(`"body" çok büyük`);
      req.json = body;
    } else {
      if (typeof body !== "object" || Array.isArray(body)) throw new PolicyError(`"body" form alanlarından oluşan bir nesne olmalıdır`);
      const fields: Record<string, string> = {};
      const files: MultipartFile[] = [];
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (op.body.fileFields.includes(k)) {
          for (const item of Array.isArray(v) ? v : [v]) files.push({ field: k, path: await uploadPath(cfg, k, item) });
        } else if (v !== undefined && v !== null) {
          fields[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
      }
      req.multipart = { fields, files };
    }
  } else if (body !== undefined) {
    throw new PolicyError(`${op.toolName} gövde (body) kabul etmez`);
  }
  return req;
}

export async function execute(op: Operation, args: Record<string, unknown>, ctx: ExecContext): Promise<string> {
  assertAllowed(op.risk, op.method, args.confirm, ctx.cfg, op.toolName);
  const req = await buildRequest(op, args, ctx.cfg);
  const res = await ctx.client.request(req);
  return formatResponse(res, ctx.cfg, op.operationId);
}

export async function formatResponse(res: ApiResponse, cfg: Config, label: string): Promise<string> {
  switch (res.kind) {
    case "empty":
      return `Tamam (HTTP ${res.status}, boş yanıt)`;
    case "redirect":
      return JSON.stringify(
        {
          status: res.status,
          downloadUrl: res.location,
          note: "Aposkal CDN üzerindeki dosyaya geçici, imzalı bağlantı. Yalnızca kullanıcıyla paylaşın; süresi dolabilir.",
        },
        null,
        2,
      );
    case "binary": {
      if (!cfg.saveBinaries) {
        return JSON.stringify(
          {
            status: res.status,
            contentType: res.contentType,
            bytes: res.bytes.byteLength,
            not: "Bu sunucu HTTP (uzak) modunda çalıştığı için ikili dosyalar kaydedilmez. Belgeler için aposkal_get_document_download_link aracıyla imzalı bağlantı alın.",
          },
          null,
          2,
        );
      }
      await mkdir(cfg.downloadDir, { recursive: true, mode: 0o700 });
      const ext = res.contentType.includes("pdf") ? "pdf" : res.contentType.includes("zip") ? "zip" : res.contentType.includes("sheet") || res.contentType.includes("excel") ? "xlsx" : "bin";
      const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
      const file = resolve(cfg.downloadDir, `${safeLabel}-${Date.now()}.${ext}`);
      if (!file.startsWith(resolve(cfg.downloadDir) + sep)) throw new Error("Geçersiz indirme yolu");
      await writeFile(file, res.bytes, { mode: 0o600 });
      return JSON.stringify({ status: res.status, savedTo: file, contentType: res.contentType, bytes: res.bytes.byteLength }, null, 2);
    }
    case "text":
      return truncate(redact(res.text), cfg.maxResponseChars);
    case "json":
      return truncate(redact(JSON.stringify(res.data, null, 2)), cfg.maxResponseChars, res.data);
  }
}

function truncate(s: string, max: number, data?: unknown): string {
  if (s.length <= max) return s;
  let hint = "";
  if (data && typeof data === "object" && "totalElements" in data) {
    const d = data as { totalElements?: unknown; pageNumber?: unknown; totalPages?: unknown };
    hint = ` (sayfa ${String(d.pageNumber)} / ${String(d.totalPages)}, toplam ${String(d.totalElements)} kayıt — daha küçük bir "size" ya da sonraki "page" değerini isteyin)`;
  }
  return `${s.slice(0, max)}\n\n…[kırpıldı: yanıt ${s.length} karakterdi${hint}]`;
}
