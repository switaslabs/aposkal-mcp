/**
 * Paketle gelen veri dosyalarının (openapi/, i18n/, assets/) kök klasörünü bulur.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * Yerelde dosyalar src/ ya da dist/ klasörünün bir üstündedir. Vercel gibi
 * sunucusuz ortamlarda fonksiyon paketlenirken çalışma klasörü (process.cwd())
 * proje kökü olabilir; bu yüzden ikisi de denenir.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function projectRoot(): string {
  if (cached) return cached;
  const candidates = [join(dirname(fileURLToPath(import.meta.url)), ".."), process.cwd()];
  cached = candidates.find((c) => existsSync(join(c, "openapi", "aposkal-openapi.json"))) ?? candidates[0]!;
  return cached;
}

export function dataFile(...parts: string[]): string {
  return join(projectRoot(), ...parts);
}
