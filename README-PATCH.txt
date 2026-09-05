جایگزینی فایل‌ها — SF-Panel CF (پینگ VLESS + ربات کارت/رسید)

ساختار داخل این ZIP مثل ریپو است. هر فایل را در همان مسیر روی GitHub جایگزین کن:

  src/index.js
  src/proxy/vless.js          ← اگر پوشه proxy نیست، بساز
  src/services/node.js
  src/services/shop.js
  src/telegram/bot.js
  src/routes/api.js
  web/index.html
  web/app.js
  web/style.css

wrangler.toml را کامل عوض نکن. فقط این دو خط را در [vars] اضافه/اصلاح کن:

  PUBLIC_DOMAIN = "آدرس-وورکر-تو.workers.dev"
  PROXY_PATH = "/sf-vpn"

IDهای D1 و KV خودت را دست نزن.

بعد:
1) Deploy
2) پنل وب → تنظیمات → شماره کارت + به نام
3) از ربات اکانت جدید بگیر (تست یا خرید)
4) تست: https://دامنه-تو/sf-vpn  باید sf-proxy-ok بدهد
