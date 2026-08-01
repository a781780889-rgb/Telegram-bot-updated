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

## تشغيل البوت

```bash
node src/index.js
```
