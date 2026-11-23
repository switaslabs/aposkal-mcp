/**
 * Güvenlik politikası — bir işlemin çalışıp çalışamayacağına karar veren tek yer.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 * Her çağrı yolunda (üretilmiş araçlar, aposkal_call_endpoint ve iş akışı
 * araçları) uygulanır; MCP istemcisinin neyi gösterip gizlediğinden bağımsızdır.
 */
import type { Config } from "./config.js";
import { RISK_LABELS, type Risk } from "./risk.js";

export class PolicyError extends Error {
  override name = "PolicyError";
}

export interface PolicyDecision {
  allowed: boolean;
  requiresConfirm: boolean;
  reason?: string;
}

export function decide(risk: Risk, method: string, cfg: Pick<Config, "mode" | "allowExternal" | "allowSensitive">): PolicyDecision {
  switch (risk) {
    case "read":
      return { allowed: true, requiresConfirm: false };
    case "write":
      return cfg.mode === "readonly"
        ? { allowed: false, requiresConfirm: false, reason: "Sunucu salt-okuma modunda çalışıyor (APOSKAL_MODE=write yapın)." }
        : { allowed: true, requiresConfirm: false };
    case "destructive":
      return cfg.mode !== "full"
        ? { allowed: false, requiresConfirm: true, reason: "Silme/geri alma işlemleri için APOSKAL_MODE=full gerekir." }
        : { allowed: true, requiresConfirm: true };
    case "external":
      if (!cfg.allowExternal)
        return {
          allowed: false,
          requiresConfirm: true,
          reason: "GİB/SGK/üçüncü taraflara veri gönderen işlemler kapalı (açmak için APOSKAL_ALLOW_EXTERNAL=true).",
        };
      if (cfg.mode === "readonly")
        return { allowed: false, requiresConfirm: true, reason: "Sunucu salt-okuma modunda çalışıyor (APOSKAL_MODE=write yapın)." };
      return { allowed: true, requiresConfirm: true };
    case "sensitive": {
      const isRead = method.toUpperCase() === "GET";
      if (!cfg.allowSensitive)
        return {
          allowed: false,
          requiresConfirm: !isRead,
          reason: "Güvenlik açısından hassas işlemler kapalı (açmak için APOSKAL_ALLOW_SENSITIVE=true).",
        };
      if (!isRead && cfg.mode !== "full")
        return { allowed: false, requiresConfirm: true, reason: "Hassas yazma işlemleri için APOSKAL_MODE=full gerekir." };
      return { allowed: true, requiresConfirm: !isRead };
    }
  }
}

export function assertAllowed(
  risk: Risk,
  method: string,
  confirm: unknown,
  cfg: Pick<Config, "mode" | "allowExternal" | "allowSensitive">,
  label: string,
): void {
  const d = decide(risk, method, cfg);
  if (!d.allowed) throw new PolicyError(`"${label}" işlemine izin verilmiyor: ${d.reason}`);
  if (d.requiresConfirm && confirm !== true) {
    throw new PolicyError(
      `"${label}" ${RISK_LABELS[risk]} bir işlemdir. Kullanıcıdan bu işlem için açık onay alın, ardından "confirm": true ile tekrar çağırın.`,
    );
  }
}

/** Çağrının companyId değerini çözümler ve yetkisini denetler. */
export function resolveCompanyId(value: unknown, cfg: Pick<Config, "companyIds" | "defaultCompanyId">): string {
  let id: string | undefined;
  if (value === undefined || value === null || value === "") id = cfg.defaultCompanyId;
  else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) id = String(value);
  else if (typeof value === "string" && /^\d{1,18}$/.test(value.trim())) id = value.trim();
  else throw new PolicyError("companyId pozitif bir tam sayı olmalıdır");

  if (!id) {
    throw new PolicyError("companyId zorunludur (ya da APOSKAL_DEFAULT_COMPANY_ID ayarlayın). Bulmak için aposkal_list_companies aracını kullanın.");
  }
  if (cfg.companyIds.length > 0 && !cfg.companyIds.includes(id)) {
    throw new PolicyError(`companyId ${id}, APOSKAL_COMPANY_IDS listesinde değil; bu sunucunun o firmaya erişim izni yok.`);
  }
  return id;
}
