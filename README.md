# SF-Panel CF v2

پنل فروش + ربات تلگرام روی **Cloudflare Workers + D1 + KV**

## معماری

| لایه | کجا |
|------|-----|
| پنل وب، API، ربات، دیتابیس | Cloudflare Worker |
| ترافیک VPN / Xray | نود خارجی (VPS یا SF-Panel اصلی) |

نودها شامل **SNI، Host Header، Path، Port، Fingerprint، ALPN، Security** هستند.

## امنیت v2

- هش رمز با salt + چند هزار دور SHA-256
- JWT با انقضا
- Rate limit روی API و وبهوک
- قفل ورود بعد از تلاش‌های ناموفق
- Secret برای وبهوک تلگرام
- هدرهای امنیتی (CSP، nosniff، DENY frame)
- اعتبارسنجی ورودی‌ها

## دیپلوی

```bash
npm i
wrangler login
wrangler d1 create sf-panel-db
wrangler kv namespace create SF_KV
# IDها را در wrangler.toml بگذار
npm run db:migrate
wrangler secret put JWT_SECRET
wrangler secret put TG_BOT_TOKEN
wrangler secret put TG_ADMIN_IDS
wrangler secret put TG_WEBHOOK_SECRET   # اختیاری
npm run deploy
```

وبهوک:
```
https://api.telegram.org/botTOKEN/setWebhook?url=https://DOMAIN/tg/webhook
```

## بعد از دیپلوی

1. باز کردن دامنه → نصب ادمین (رمز ≥ ۸ کاراکتر)
2. **نودها / SNI** → host + path + sni
3. **پلن‌ها** → افزودن
4. ربات `/start`

## ساختار

```
src/index.js
src/routes/api.js
src/services/node.js   # لینک VLESS + SNI
src/services/shop.js
src/telegram/bot.js
src/middleware/security.js
src/utils/*
web/index.html + style.css + app.js
migrations/0001_init.sql
```
