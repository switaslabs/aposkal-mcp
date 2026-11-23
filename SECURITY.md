# Güvenlik Politikası

**aposkal-mcp**, [Switas Consultancy](https://switas.com) tarafından geliştirilmekte ve sürdürülmektedir.

## Güvenlik açığı bildirimi

Lütfen güvenlik açıklarını **herkese açık issue olarak bildirmeyin**. Bunun yerine GitHub'daki
[gizli güvenlik açığı bildirimi](https://github.com/switaslabs/aposkal-mcp/security/advisories/new)
özelliğini kullanın.

Bildiriminize sorunu yeniden üretme adımlarını ve olası etkisini ekleyin. Bildirimleri en kısa sürede yanıtlamayı hedefliyoruz.

Aposkal API'sinin kendisinde bulunan açıkları doğrudan Aposkal'a (destek@aposkal.com) bildirin.

## Desteklenen sürümler

Yalnızca en son yayımlanan sürüm güvenlik güncellemesi alır.

## Kullanıcılar için öneriler

- **Anahtarları koruyun.** API anahtarlarını asla bir repoya, issue'ya, sohbete veya ekran görüntüsüne koymayın. Sızdığından şüphelendiğiniz anahtarı Aposkal'da hemen iptal edin.
- **Düşük yetki kullanın.** Anahtarı mümkün olan en düşük yetkili kullanıcıyla oluşturun. Anahtar, oluşturan kullanıcının rolünü taşır.
- **Varsayılanları koruyun.** `APOSKAL_MODE=readonly` ayarını değiştirmeyin. `APOSKAL_ALLOW_EXTERNAL` ve `APOSKAL_ALLOW_SENSITIVE` seçeneklerini yalnızca gerektiğinde ve kısa süreliğine açın.
- **Firmaları sınırlayın.** `APOSKAL_COMPANY_IDS` ile sunucunun erişebileceği firmaları kısıtlayın.
- **Onay isteklerini okuyun.** Yapay zekâ asistanı riskli bir işlem için onay istediğinde işlemin ayrıntılarını okuyun. `confirm: true` yalnızca sizin açık onayınızdan sonra gönderilmelidir.
- **Üçüncü taraf içeriğe dikkat edin.** Gelen faturalar gibi içerikler, modeli yönlendirmeye çalışan metinler (prompt injection) içerebilir. Riskli işlemlerin varsayılan olarak kapalı olmasının bir nedeni de budur.
