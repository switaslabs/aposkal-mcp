/**
 * Yapılandırma — yalnızca ortam değişkenlerinden okunur.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * Gizli bilgilerin varsayılan değeri yoktur; asla loglanmaz ve modele geri
 * gönderilmez (bkz. `publicConfig`).
 */
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const ENVIRONMENTS = {
  live: "https://api.aposkal.com",
  test: "https://api.dev.aposkal.com",
} as const;

export type Environment = keyof typeof ENVIRONMENTS;
export type Mode = "readonly" | "write" | "full";

export interface Config {
  apiKey: string;
  apiSecret: string;
  env: Environment;
  baseUrl: string;
  mode: Mode;
  allowExternal: boolean;
  allowSensitive: boolean;
  /** Boş = anahtarın erişebildiği tüm firmalar. */
  companyIds: string[];
  defaultCompanyId?: string;
  /** Ayrı araç olarak açılacak üretilmiş gruplar ("all" ya da grup adları). */
  toolsets: string[];
  downloadDir: string;
  uploadDir?: string;
  timeoutMs: number;
  maxResponseChars: number;
  logLevel: "error" | "warn" | "info" | "debug";
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const bool = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === "") return false;
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    ctx.addIssue({ code: "custom", message: `true/false bekleniyordu, "${v}" geldi` });
    return z.NEVER;
  });

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Header'a güvenle yazılabilecek kimlik bilgisi: yazdırılabilir ASCII, boşluksuz, makul uzunlukta. */
const credential = (name: string) =>
  z
    .string({ error: `${name} zorunludur` })
    .trim()
    .min(1, { error: `${name} zorunludur (değeri boş)`, abort: true })
    .min(8, `${name} çok kısa görünüyor`)
    .max(512, `${name} çok uzun görünüyor`)
    .regex(/^[\x21-\x7E]+$/, `${name} boşluk veya ASCII dışı karakter içermemelidir`);

const companyId = z.string().regex(/^\d{1,18}$/, "companyId pozitif bir tam sayı olmalıdır");

const schema = z.object({
  APOSKAL_API_KEY: credential("APOSKAL_API_KEY"),
  APOSKAL_API_SECRET: credential("APOSKAL_API_SECRET"),
  APOSKAL_ENV: z.enum(["live", "test"], {
    error: 'APOSKAL_ENV zorunludur ve "live" ya da "test" olmalıdır',
  }),
  APOSKAL_MODE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : "readonly"))
    .pipe(z.enum(["readonly", "write", "full"], { error: 'APOSKAL_MODE "readonly", "write" ya da "full" olmalıdır' })),
  APOSKAL_ALLOW_EXTERNAL: bool,
  APOSKAL_ALLOW_SENSITIVE: bool,
  APOSKAL_COMPANY_IDS: list.pipe(z.array(companyId)),
  APOSKAL_DEFAULT_COMPANY_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(companyId.optional()),
  APOSKAL_TOOLSETS: list.transform((a) => a.map((s) => s.toLowerCase())),
  APOSKAL_DOWNLOAD_DIR: z.string().optional(),
  APOSKAL_UPLOAD_DIR: z.string().optional(),
  APOSKAL_TIMEOUT_MS: z.coerce.number({ error: "APOSKAL_TIMEOUT_MS sayı olmalıdır" }).int().min(1000, "en az 1000 olmalıdır").max(300_000, "en fazla 300000 olabilir").optional(),
  APOSKAL_MAX_RESPONSE_CHARS: z.coerce.number({ error: "APOSKAL_MAX_RESPONSE_CHARS sayı olmalıdır" }).int().min(2_000, "en az 2000 olmalıdır").max(2_000_000, "en fazla 2000000 olabilir").optional(),
  APOSKAL_LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : "warn"))
    .pipe(z.enum(["error", "warn", "info", "debug"], { error: 'APOSKAL_LOG_LEVEL "error", "warn", "info" ya da "debug" olmalıdır' })),
});

function absDir(p: string | undefined): string | undefined {
  if (!p || !p.trim()) return undefined;
  const t = p.trim();
  return isAbsolute(t) ? resolve(t) : resolve(process.cwd(), t);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  - ${String(i.path[0] ?? "")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Geçersiz yapılandırma:\n${msg}`);
  }
  const e = parsed.data;

  if (e.APOSKAL_API_KEY === e.APOSKAL_API_SECRET) {
    throw new ConfigError("APOSKAL_API_KEY ve APOSKAL_API_SECRET farklı değerler olmalıdır");
  }
  if (
    e.APOSKAL_DEFAULT_COMPANY_ID &&
    e.APOSKAL_COMPANY_IDS.length > 0 &&
    !e.APOSKAL_COMPANY_IDS.includes(e.APOSKAL_DEFAULT_COMPANY_ID)
  ) {
    throw new ConfigError("APOSKAL_DEFAULT_COMPANY_ID, APOSKAL_COMPANY_IDS listesinde olmalıdır");
  }

  return {
    apiKey: e.APOSKAL_API_KEY,
    apiSecret: e.APOSKAL_API_SECRET,
    env: e.APOSKAL_ENV,
    baseUrl: ENVIRONMENTS[e.APOSKAL_ENV],
    mode: e.APOSKAL_MODE,
    allowExternal: e.APOSKAL_ALLOW_EXTERNAL,
    allowSensitive: e.APOSKAL_ALLOW_SENSITIVE,
    companyIds: e.APOSKAL_COMPANY_IDS,
    defaultCompanyId: e.APOSKAL_DEFAULT_COMPANY_ID,
    toolsets: e.APOSKAL_TOOLSETS,
    downloadDir: absDir(e.APOSKAL_DOWNLOAD_DIR) ?? join(tmpdir(), "aposkal-mcp", "downloads"),
    uploadDir: absDir(e.APOSKAL_UPLOAD_DIR),
    timeoutMs: e.APOSKAL_TIMEOUT_MS ?? 30_000,
    maxResponseChars: e.APOSKAL_MAX_RESPONSE_CHARS ?? 60_000,
    logLevel: e.APOSKAL_LOG_LEVEL,
  };
}

/** Modele/kullanıcıya gösterilmesi güvenli yapılandırma. Asla gizli bilgi içermez. */
export function publicConfig(c: Config) {
  return {
    ortam: c.env,
    apiAdresi: c.baseUrl,
    mod: c.mode,
    disIslemlerAcik: c.allowExternal,
    hassasIslemlerAcik: c.allowSensitive,
    izinliFirmalar: c.companyIds.length ? c.companyIds : "API anahtarının erişebildiği tüm firmalar",
    varsayilanFirma: c.defaultCompanyId ?? null,
    acikGruplar: c.toolsets.length ? c.toolsets : [],
    indirmeKlasoru: c.downloadDir,
    dosyaYuklemeAcik: Boolean(c.uploadDir),
    apiAnahtari: `${c.apiKey.slice(0, 3)}…(gizlendi)`,
  };
}
