# Değişiklik Günlüğü

**aposkal-mcp** ([Switas Consultancy](https://switas.com)) projesindeki önemli değişiklikler bu dosyada listelenir.

## [0.1.0] - 2026-11-23

### Eklenenler

- İlk sürüm. Geliştiren: Switas Consultancy (https://switas.com).
- Aposkal API V1'in 430 operasyonunun tamamını kapsayan stdio MCP sunucusu (paketle gelen OpenAPI 3.1 tanımından).
- Tamamen Türkçe arayüz:
  - 430 operasyonun Türkçe özet ve açıklamaları (`i18n/aposkal-tr.json`)
  - Türkçe grup adları
  - Türkçe araç açıklamaları, hata mesajları ve loglar
- Keşif araçları: `aposkal_search_endpoints` (Türkçe arama), `aposkal_describe_endpoint`, `aposkal_call_endpoint`, `aposkal_list_toolsets`, `aposkal_server_info`.
- İş akışı araçları: firma listesi, e-Fatura/e-İrsaliye mükellef sorgusu, KDV oranları, cari arama, belge indirme bağlantısı, satış faturası taslağı, tahsilat.
- `APOSKAL_TOOLSETS` ile her operasyon için isteğe bağlı ayrı araç.
- Beş seviyeli risk politikası (read / write / destructive / external / sensitive) ve ek korumalar:
  - `confirm` onayı
  - firma izin listesi
  - yönlendirme izin listesi
  - sır maskeleme
  - sınırlı dosya yükleme
- Sunucu ikonu ve web sitesi bilgisi (`icons`, `websiteUrl`).
- Vercel'de uzak çalışma modu:
  - token korumalı, durumsuz Streamable HTTP (`api/mcp.js`)
  - `vercel.json` ve Türkçe açılış sayfası
  - "Vercel'e kur" düğmesi
- Claude.ai bağlayıcıları için OAuth 2.1 desteği:
  - korunan kaynak ve yetkilendirme sunucusu meta verisi
  - dinamik istemci kaydı
  - PKCE zorunlu, Türkçe giriş sayfası
  - imzalı ve süreli erişim/yenileme anahtarları (veritabanı gerektirmez)
- Commit öncesi kanca (pre-commit hook) ve CI'da gizli bilgi taraması (gitleaks), Dependabot.
