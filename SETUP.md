# إعداد البوت في Termux

## الخطوات

```bash
# 1. استنساخ المشروع
git clone https://github.com/YOUR_USERNAME/Telegram-bot.git
cd Telegram-bot

# 2. تثبيت المكتبات
npm install

# 3. إنشاء ملف البيئة
cp .env.example .env

# 4. تعديل ملف .env
nano .env
```

## قيم ملف .env

```
BOT_TOKEN=        ← من @BotFather بعد /revoke وإنشاء توكن جديد
API_ID=           ← من my.telegram.org
API_HASH=         ← من my.telegram.org
ENCRYPTION_KEY=   ← أي نص عشوائي طوله 32 حرف على الأقل
```

## التخزين الدائم للحسابات والجلسات

حسابات تيليجرام والجلسات المشفرة تُحفظ في SQLite وداخل مجلد الجلسات. في بيئة محلية يكفي ترك القيم الافتراضية، أما في Railway أو أي منصة تستخدم نظام ملفات مؤقتاً فيجب إنشاء **Volume دائم** وربطه بالخدمة، ثم ضبط المتغيرات التالية على مسار الـ Volume. مثال Railway:

```env
PERSISTENT_DATA_DIR=/data
DB_PATH=/data/accounts.db
SESSIONS_DIR=/data/sessions
```

لا تعتمد على GitHub لحفظ الحسابات؛ مجلدات `data/` و`sessions/` مستبعدة من Git لأسباب أمنية. إذا لم يكن هناك Volume دائم، فقد تختفي قاعدة البيانات والجلسات بعد إعادة النشر حتى لو كان الكود سليماً.

## تشغيل البوت

```bash
node src/index.js
```
