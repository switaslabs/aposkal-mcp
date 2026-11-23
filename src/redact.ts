/**
 * Gizli bilgi maskeleme ve stderr loglama.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * stdout MCP protokolüne ayrılmıştır; bu yüzden tüm loglar stderr'e yazılır.
 * Süreçten çıkan her metin (loglar, araç sonuçları, hatalar) `redact()`
 * fonksiyonundan geçer.
 */

const secrets = new Set<string>();

/** Çıktıda asla görünmemesi gereken bir değeri kaydeder. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

const GENERIC_PATTERNS: RegExp[] = [
  /\bak_[0-9a-f]{32}\b/gi, // Aposkal API anahtarı biçimi
  /(x-api-(?:key|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  /(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',}]+/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("[GİZLENDİ]");
  }
  for (const re of GENERIC_PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}[GİZLENDİ]` : "[GİZLENDİ]",
    );
  }
  return out;
}

type Level = "error" | "warn" | "info" | "debug";
const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const LABELS: Record<Level, string> = { error: "HATA", warn: "UYARI", info: "BİLGİ", debug: "AYIKLAMA" };
let current: Level = "warn";

export function setLogLevel(level: Level): void {
  current = level;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] > ORDER[current]) return;
  let line = `[aposkal-mcp] ${LABELS[level]} ${msg}`;
  if (extra !== undefined) {
    try {
      line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
    } catch {
      /* serileştirilemeyen ek bilgiyi yok say */
    }
  }
  process.stderr.write(redact(line) + "\n");
}

export const log = {
  error: (m: string, e?: unknown) => write("error", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  debug: (m: string, e?: unknown) => write("debug", m, e),
};
