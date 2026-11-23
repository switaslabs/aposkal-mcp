/**
 * Her Aposkal API operasyonunun risk sınıflandırması.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 *
 *  read        – durum değiştirmez (tüm GET'ler + aşağıda listelenen arama türü POST'lar)
 *  write       – Aposkal içinde kayıt oluşturur/günceller (geri alınabilir)
 *  destructive – Aposkal içinde kayıt siler ya da geri dönüşsüz biçimde değiştirir
 *  external    – Aposkal DIŞINA bir şey gönderir: GİB (resmileştirme, iptal,
 *                e-fatura yanıtı, DBS), SGK bildirgeleri, müşteriye e-posta/link,
 *                destek talepleri. Hukuken bağlayıcı / geri alınamaz.
 *  sensitive   – güvenlik açısından önemli: SSO bileti, webhook (veri çıkışı),
 *                entegrasyon/kimlik bilgileri, firma ayarları, profil, toplu veri
 *                silme, ödeme, bayi firması oluşturma.
 *
 * İleride eklenecek bilinmeyen operasyonlar HTTP metoduna göre varsayılan
 * seviyeyi alır (GET → read, DELETE → destructive, diğerleri → write);
 * aşağıdaki açık listeler varsayılanların önüne geçer.
 */
export type Risk = "read" | "write" | "destructive" | "external" | "sensitive";

/** Yalnızca okuma/arama/önizleme yapan POST uçları. */
const READ_OPS = new Set([
  "find-accounts-from-vkn-list",
  "get-rules-by-rule-keys",
  "get-accounting-code-account-mapping-bulk",
  "search-bank-documents",
  "list-draft-bank-accounts",
  "get-bank-pos-commission-context",
  "transferable-documents",
  "search-dbs-documents",
  "export-document-detailed-pdf-report-by-ids",
  "predict-next-document-no",
  "predictBankDocuments",
  "get-document-inbox-paths",
  "preflight-sgk-tescil",
  "get-sgk-tescil-exit-period",
]);

/** Aposkal dışına çıkan işlemler: GİB, SGK, e-posta/SMS/link, destek. */
const EXTERNAL_OPS = new Set([
  // GİB / e-belge
  "formalizeDocument",
  "cancelDocument",
  "cancelUndoDocument",
  "matbu",
  "create-pending-invoice-response",
  "reject-pending-invoice",
  "partially-accept-invoice",
  // Dijital Beyan Sistemi (GİB)
  "transferToDBS",
  "deleteFromDBS",
  // SGK
  "submit-sgk-tescil-declarations",
  "cancel-sgk-tescil-declaration",
  "resend-sgk-tescil-declaration",
  "create-sgk-vizite-notification",
  "cancel-sgk-vizite-notification",
  "query-sgk-work-accidents-by-person",
  "test-sgk-workplace-connection",
  // Müşterilere / üçüncü taraflara giden mesajlar
  "send-sales-offer",
  "share-document",
  "request-payment",
  "generate-document-verification-code",
  "create-support-ticket-json",
  "add-reply-to-support-ticket-json",
]);

/** Güvenlik açısından önemli işlemler; APOSKAL_ALLOW_SENSITIVE=true olmadıkça kapalı. */
const SENSITIVE_OPS = new Set([
  "issue-sso-ticket",
  "create-webhook",
  "update-webhook",
  "delete-webhook",
  "save-settings-integration",
  "kt-oauth-callback",
  "get-kt-auth-url",
  "update-profile",
  "update-company-config",
  "update-company-config-key",
  "update-company-settings",
  "upload-e-invoice-attachment",
  "delete-e-invoice-attachment",
  "start-data-purge",
  "add-dealer-customer",
  "initiate-payment",
  "save-company-client-data-value",
  "delete-company-client-data-value",
]);

/** DELETE olmayan ama veriyi geri dönüşsüz silen ya da değiştiren işlemler. */
const DESTRUCTIVE_OPS = new Set([
  "forget-rule-keys",
  "reCreateAllDraft",
  "batchRevert",
  "revert-accounting-record",
  "cancel-order",
  "cancel-sales-offer",
  "reject-sales-offer",
  "cancel-sgk-tescil-sync",
  "apply-sgk-tescil-sync",
  "mark-sgk-tescil-declaration-voided",
  "inbox-import-all",
  "approve-all-acc-rec-ready",
]);

export function classify(method: string, operationId: string): Risk {
  if (SENSITIVE_OPS.has(operationId)) return "sensitive";
  if (EXTERNAL_OPS.has(operationId)) return "external";
  if (DESTRUCTIVE_OPS.has(operationId)) return "destructive";
  if (READ_OPS.has(operationId)) return "read";
  switch (method.toUpperCase()) {
    case "GET":
      return "read";
    case "DELETE":
      return "destructive";
    default:
      return "write";
  }
}

export const RISK_DESCRIPTIONS: Record<Risk, string> = {
  read: "Salt-okuma.",
  write: "Aposkal'da kayıt oluşturur veya günceller.",
  destructive: "Aposkal'da kayıt siler veya geri dönüşsüz biçimde değiştirir.",
  external:
    "Aposkal DIŞINA veri gönderir (GİB, SGK, müşteriye e-posta, destek). Hukuken bağlayıcıdır ve çoğunlukla geri alınamaz.",
  sensitive: "Güvenlik açısından hassas (kimlik bilgileri, webhook, SSO, firma ayarları, toplu silme, ödeme).",
};

/** Hata mesajlarında kullanılan Türkçe risk adları. */
export const RISK_LABELS: Record<Risk, string> = {
  read: "salt-okuma",
  write: "yazma",
  destructive: "silme/geri dönüşsüz",
  external: "dış (GİB/SGK/üçüncü taraf)",
  sensitive: "hassas",
};

/** Tüm açık listeler — testler için dışa aktarılır. */
export const RISK_LISTS = { READ_OPS, EXTERNAL_OPS, SENSITIVE_OPS, DESTRUCTIVE_OPS };
