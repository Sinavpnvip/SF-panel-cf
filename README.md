# SF-Panel v2.1.0

پنل مدیریت Xray + ربات فروش تلگرام (aiohttp / SQLite)

## ویژگی‌ها
- پنل وب فارسی RTL با داشبورد، کلاینت‌ها، اینباندها، تنظیمات، TOTP
- ربات تلگرام خرید / تمدید / کیف‌پول
- پشتیبانی Reality / VLESS / VMess و …
- حالت VPS و PaaS (روتر L4 تک‌پورت)
- مسیر هیبرید Cloudflare Workers + agent روی VPS (اسکلت)

## نصب سریع (Docker)

```bash
cp .env.example .env
# ADMIN_USER و ADMIN_PASS را تنظیم کنید (حداقل ۸ کاراکتر)
docker compose up -d --build
```

مرورگر: `http://SERVER:2087`

اگر متغیرهای مدیر ست نشده باشند، صفحه نصب اولیه (`/api/setup`) را تکمیل کنید.

## نصب بدون Docker

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ADMIN_USER=admin ADMIN_PASS='StrongPass123'
python app.py
```

## امنیت
- هیچ اعتبار پیش‌فرض سختی وجود ندارد.
- پشتیبان پیش‌فرض اسرار حساس را حذف می‌کند.
- پس از بازیابی یا تغییر رمز، ورود مجدد لازم است.
- جزئیات: [SECURITY.md](SECURITY.md) و [AUDIT.md](AUDIT.md)

## مستندات
| فایل | موضوع |
|------|--------|
| [docs/DEPLOY_VPS.md](docs/DEPLOY_VPS.md) | نصب VPS/Docker |
| [docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md) | مسیر Workers هیبرید |
| [docs/NODE_AGENT.md](docs/NODE_AGENT.md) | agent مدیریت Xray |
| [docs/MIGRATION.md](docs/MIGRATION.md) | مهاجرت و تعمیر seed |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | معماری |
| [AUDIT.md](AUDIT.md) | یافته‌ها و رفع باگ‌ها |
| [CHANGELOG.md](CHANGELOG.md) | تغییرات |

## تست
```bash
python -m pytest tests/ -q
```

## مجوز
مخزن اصلی ادعای مجوز مشخصی در فایل LICENSE نداشت؛ قبل از استفاده تجاری وضعیت حقوقی را بررسی کنید.
