#!/usr/bin/env node
// Hafif gizli bilgi tarayıcısı (aposkal-mcp · Switas Consultancy, https://switas.com).
// Commit öncesi kancada, CI'da ve `npm publish` öncesinde çalışır.
// Bir güvenlik ağıdır; CI'da ayrıca çalışan gitleaks'in yerini tutmaz.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  { name: "Aposkal API anahtarı", re: /\bak_[0-9a-f]{32}\b/i },
  { name: "Aposkal API key/secret ataması", re: /APOSKAL_API_(KEY|SECRET)\s*[=:]\s*["']?[A-Za-z0-9_\-]{12,}/ },
  { name: "X-API-Secret başlık değeri", re: /X-API-Secret["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i },
  { name: "Özel anahtar", re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
];
const SKIP = [/^node_modules\//, /^dist\//, /^openapi\//, /^package-lock\.json$/, /^scripts\/check-secrets\.mjs$/];

const staged = process.argv.includes("--staged");
const args = staged ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"] : ["ls-files", "--cached", "--others", "--exclude-standard"];
const files = execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

let findings = 0;
for (const file of files) {
  if (SKIP.some((re) => re.test(file))) continue;
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        findings++;
        console.error(`✖ ${file}:${i + 1}  ${p.name}`);
      }
    }
  });
}
if (findings > 0) {
  console.error(`\n${findings} olası gizli bilgi bulundu. Commit etmeden önce kaldırın (git'e girmeyen .env dosyasını kullanın).`);
  process.exit(1);
}
console.log(`✔ ${files.length} dosyada gizli bilgi bulunamadı.`);
