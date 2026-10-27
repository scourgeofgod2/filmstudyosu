# Film Stüdyosu

Kısa film ve bölüm planlaması için tek kullanıcıya yönelik yerel uygulama. Video üretimi ve montaj uygulama dışında yapılır. Node.js 20 veya üstü gerekir; bağımlılık kurulumu gerekmez.

## Başlatma

1. `.env.example` dosyasını `.env` olarak kopyalayın. `INWORLD_API_KEY` ve `STUDIO_API_KEY` değerlerini yerel dosyaya yazın; anahtarları sohbetle paylaşmayın. İsterseniz `INWORLD_MODEL` değişkenini değiştirin. Ortam değişkenleri dosya değerlerinden önceliklidir.
2. Proje klasöründe `npm start` çalıştırın ve `http://127.0.0.1:3000` adresini açın. Sunucuyu internete açmayın.

Projeler ve görseller `data/` altında saklanır, şifrelenmez. Bu klasörü yedekleyin. Eski sürüm projeleri ilk açılışta yeni biçime dönüştürülür; mevcut eski dosyanın yedeği saklanır. Uygulamayı aynı veri klasöründe tek sunucu süreciyle çalıştırın; farklı sunucu süreçleri arasındaki eşzamanlı kayıtlar koordine edilmez.

## Çalışma akışı

- Film veya dizi projesi oluşturun; ortak karakter ve mekân kartlarında görünüm, devamlılık ve görsel istemlerini düzenleyin. Görseli Studio ile üretebilir ya da bilgisayardan yükleyebilirsiniz.
- Bölüm hedefini 5–10 dakika olarak belirleyin; bölüm taslağını, sahneleri ve seçtiğiniz sahnenin klip önerilerini aşamalı üretin. Öneriler onaylanmadan mevcut metinlerin yerini almaz. İstediğiniz sahne ve klibi elle de düzenleyebilirsiniz.
- Her klibin süresi en fazla 25 saniyedir. Bölüm toplamı planlanan klip sürelerinden hesaplanır: 5 dakika için 25 saniyelik en az 12, 10 dakika için en az 24 klip gerekir. Daha kısa klipler sayıyı artırır; gerçek montaj süresi kesme ve geçişlerle değişebilir.
- Referans kütüphanesindeki her görseli ilgili karakter veya mekân kartına kendiniz bağlayın; birlikte görünen bir grupsa üyeleri açıkça belirtin. Ana referans tercihini seçebilirsiniz. Eski ve yüklenen görseller otomatik olarak bir kimliğe bağlanmaz.
- Her klipte aktif karakter ve mekânı belirleyin. Uygulamanın referans önerisini, gerekçeleri ve eksikleri inceleyip onaylayın; seçimleri veya promptları onaysız değiştirmez. Referans modunda en fazla 5 görsel kullanılır; daha çok referans gerekiyorsa sahneyi bölmek yaratıcı bir seçimdir.
- Kare modunda yalnızca başlangıç ve isteğe bağlı bitiş karesi kullanılır; referans modu bu modla aynı anda kullanılmaz. Bir önceki videonun gerçek son karesini siz çıkarıp yüklersiniz. Aracınızın etiket biçimini doğrulamadan etiketli kare promptunu kullanmayın. Görselleri kendi aracınıza elle aktarın; süreyi (en fazla 25 saniye) ve 720p ayarını o araçta seçin.
- Karakter/mekân görselleri metinden üretilir: Studio API bu uygulamada referans görselleri girdi olarak almıyor. Görsel sürekliliği otomatik olarak garanti edilmez. Oluşan klipleri dışarıdaki montaj aracınızda birleştirin.

## Hikâye sürekliliği

Hikâye rehberine dünyanın kurallarını, ana hikâyeyi, ilişkileri ve sezon yönünü yazın. Her bölümün amacı ve planlanan olayları, gerçekleşmiş olaylardan ayrı tutulur. Bölüm bitince olayları, karakterlerin son durumunu, ilişkileri, nesneleri ve açık konuları kapanışa kaydedip inceleyerek onaylayın. Kapanışın senaryo planına mı yoksa izlediğiniz gerçek video sonucuna mı dayandığını belirtin.

Sonraki bölüm için güncel ve onaylı kapanışlar üretim bağlamına eklenir. Eksik ya da eski kapanışlar uyarılır; devam kararı sizindir. Kaynaklar değişince daha sonraki kapanışlar inceleme gerektirebilir. Bağlam önizlemesi kullanılan kaynakları ve uyarıları gösterir; model incelemesi bir öneridir, kesin doğrulama değildir.

Uygulama dışarıda üretilen videoyu izlemez: gerçek videodaki kıyafetleri, kişilerin konumunu, nesneleri ve son kareyi siz kontrol edip kapanış ve geçiş notlarını gerektiğinde güncelleyin. Hiçbir prompt veya otomatik inceleme anlatı ya da görüntü tutarlılığını yüzde yüz garanti etmez.

## Seedance skill kapsamı

Projede `sd25-pe` 0.1.1 kuruludur. Uygulama skillin ilgili metinden video ve referans-rol prensiplerini sürümlü uygulama talimatlarına aktarır; skill dosyasını otomatik çalıştırmaz veya bütün kurallarını uyguladığını iddia etmez. Seçilmiş referansların sırası ve rolleri prompt üretimine açıkça verilir; model görselleri görmediğinden görseldeki ayrıntıları doğrulayamaz. Otomatik kontrol etiketlerin bulunmasını denetler; doğru kişiye ve role bağlandığını garanti etmez. Süre, çözünürlük ve en-boy gibi üretim ayarları prompt dışında tutulur. Çıktıları kullanmadan gözden geçirin.

## Güvenlik ve maliyet

LLM ve görsel talepleri ücretli olabilir; her isteği kullanıcı başlatır. Ücretli görsel isteği gönderildiğinde belirsiz bağlantı hatalarında otomatik tekrar yapılmaz. Görsel `starting` durumunda kalırsa sağlayıcıda işlem ve ücreti kontrol edin. Anahtarlar sadece sunucuda kullanılır; proje metinleri ilgili sağlayıcılara gönderilir.

## Kendi kontrolleriniz

Eski projenizi açın ve sahne/görsellerin korunduğunu doğrulayın. İki bölümün aynı karakter ve mekânları paylaşmasını, 5 görsel seçilip altıncının reddedilmesini, sıra değişikliğinin uyarılmasını, klip süresinin 25 saniyeyi geçmemesini ve toplam süre hesabını kontrol edin. Son olarak görselleri belirtilen sırayla harici araca yükleyerek promptunuzu deneyin.
