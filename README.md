# 🤖 بوت إدارة حسابات تيليجرام

بوت تيليجرام احترافي لإضافة وإدارة حسابات تيليجرام متعددة بأمان كامل.

---

## ✨ الميزات

- ➕ إضافة حسابات عبر رقم الهاتف (OTP)
- 🔐 دعم التحقق بخطوتين (2FA)
- 🔒 تشفير الجلسات (AES-256)
- 📋 عرض قائمة الحسابات مع حالتها
- 🔄 إعادة تسجيل الدخول لأي حساب
- 📊 فحص حالة الاتصال لحظيًا
- 🗑️ حذف الحسابات مع تنظيف الجلسات
- 🛡️ معالجة كاملة لأخطاء تيليجرام API

---

## 🚀 التثبيت

### 1. المتطلبات

- Node.js 18+
- حساب تيليجرام مطور: https://my.telegram.org

### 2. إعداد المشروع

```bash
# نسخ المشروع
git clone <repository-url>
cd telegram-account-bot

# تثبيت المكتبات
npm install

# إعداد متغيرات البيئة
cp .env.example .env
```

### 3. إعداد ملف .env

```env
BOT_TOKEN=        # من @BotFather
API_ID=           # من https://my.telegram.org
API_HASH=         # من https://my.telegram.org
ENCRYPTION_KEY=   # مفتاح عشوائي 32+ حرف
```

### 4. الحصول على API_ID و API_HASH

1. افتح https://my.telegram.org
2. سجّل دخول برقم هاتفك
3. اضغط "API development tools"
4. أنشئ تطبيقًا جديدًا
5. انسخ `api_id` و `api_hash`

### 5. تشغيل البوت

```bash
# للإنتاج
npm start

# للتطوير
npm run dev
```

---

## 📁 هيكل المشروع

```
telegram-account-bot/
├── src/
│   ├── index.js                        # نقطة الدخول
│   ├── handlers/
│   │   ├── menu.js                     # القائمة الرئيسية
│   │   ├── addAccount.js               # تدفق إضافة حساب
│   │   └── manageAccounts.js           # إدارة الحسابات
│   ├── services/
│   │   ├── telegramClient.js           # MTProto client
│   │   └── sessionState.js             # آلة حالة المحادثة
│   ├── database/
│   │   └── db.js                       # SQLite قاعدة البيانات
│   ├── middlewares/
│   │   ├── textRouter.js               # موجّه الرسائل النصية
│   │   └── errorHandler.js             # معالج الأخطاء العام
│   └── utils/
│       ├── logger.js                   # نظام السجلات
│       ├── encryption.js               # تشفير الجلسات
│       ├── validators.js               # التحقق من المدخلات
│       ├── keyboards.js                # أزرار البوت
│       └── messages.js                 # قوالب الرسائل
├── data/                        # قاعدة البيانات (تُنشأ تلقائيًا)
├── sessions/                    # ملفات الجلسات (تُنشأ تلقائيًا)
├── logs/                        # ملفات السجلات (تُنشأ تلقائيًا)
├── .env.example
├── .gitignore
└── package.json
```

---

## 🔒 الأمان

- جميع الجلسات مشفرة بـ AES-256
- كلمات المرور تُحذف فورًا من المحادثة
- لا تُخزَّن بيانات الاعتماد في الكود
- المتغيرات الحساسة في ملف `.env` فقط
- التحقق من جميع المدخلات قبل المعالجة

---

## ⚠️ ملاحظات

- البوت يعمل في المحادثات الخاصة فقط
- تأكد من عدم مشاركة ملف `.env` أو مجلد `sessions/`
- الجلسات صالحة حتى تسجيل الخروج من تيليجرام يدويًا
