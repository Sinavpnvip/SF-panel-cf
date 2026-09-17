#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SF-Panel — نقطه ورود
--------------------
حالت PaaS : روتر L4 روی PORT عمومی ← پنل + اینباند‌های پروکسی (یک پورت)
حالت VPS  : پنل مستقیم روی پورت خودش، Xray روی پورت‌های واقعی

اجرا:  python app.py

مدیر اولیه: فقط از طریق /api/setup در اولین اجرا یا متغیرهای ADMIN_USER / ADMIN_PASS
(هیچ اعتبار پیش‌فرض سختی وجود ندارد — رفع SF-001)
"""

import importlib
import os
import subprocess
import sys
import threading
import time


# ---------------- نصب خودکار پیش‌نیازها ----------------

def _bootstrap() -> None:
    if os.environ.get("SF_NO_AUTOINSTALL"):
        return
    needed = []
    for mod, pip in {"aiohttp": "aiohttp", "grpc": "grpcio",
                     "requests": "requests", "qrcode": "qrcode"}.items():
        try:
            importlib.import_module(mod)
        except ImportError:
            needed.append(pip)
    if not needed:
        return
    print("[SF-Panel] نصب پیش‌نیازها: " + ", ".join(needed), flush=True)
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install",
                               "--quiet", *needed])
        print("[SF-Panel] نصب شد؛ راه‌اندازی مجدد ...", flush=True)
        os.execv(sys.executable,
                 [sys.executable, os.path.abspath(__file__)] + sys.argv[1:])
    except Exception as e:
        print(f"[SF-Panel] نصب خودکار ناموفق: {e}", flush=True)
        print("دستی نصب کنید:  pip install " + " ".join(needed), flush=True)
        sys.exit(1)


_bootstrap()

import asyncio  # noqa: E402

from aiohttp import web  # noqa: E402

from core import config as cfg          # noqa: E402
from core import database as db         # noqa: E402
from core import scheduler              # noqa: E402
from core.security import hash_password  # noqa: E402
from core.xray import xray, watchdog_loop  # noqa: E402
from core.router import router          # noqa: E402
from api import (handlers_auth, handlers_inbounds, handlers_clients,  # noqa: E402
                 handlers_settings, handlers_system)
from api.subscription import sub_handler  # noqa: E402

WEB_DIR = os.path.join(cfg.BASE_DIR, "web")
_ASSET_RE = None


def _asset_re():
    global _ASSET_RE
    if _ASSET_RE is None:
        import re
        _ASSET_RE = re.compile(r"^[A-Za-z0-9._\-]+$")
    return _ASSET_RE


FAVICON = ("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
           "<rect width='64' height='64' rx='14' fill='#6366f1'/>"
           "<text x='32' y='43' font-size='24' font-family='monospace' "
           "font-weight='bold' fill='#fff' text-anchor='middle'>SF</text>"
           "</svg>")


# ---------------- فایل‌های ایستا ----------------

async def index(request):
    path = os.path.join(WEB_DIR, "index.html")
    if os.path.isfile(path):
        return web.FileResponse(path,
                                headers={"Cache-Control": "no-cache",
                                         "X-Content-Type-Options": "nosniff"})
    return web.Response(status=500,
                        text="SF-Panel: web/index.html یافت نشد")


async def asset(request):
    name = request.match_info.get("name", "")
    if not _asset_re().match(name) or name.startswith("."):
        raise web.HTTPNotFound()
    path = os.path.join(WEB_DIR, name)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "no-cache",
                                           "X-Content-Type-Options": "nosniff"})


async def favicon(request):
    return web.Response(text=FAVICON, content_type="image/svg+xml",
                        headers={"Cache-Control": "max-age=86400"})


async def healthz(request):
    return web.json_response({"ok": True, "app": cfg.APP_NAME,
                              "version": cfg.APP_VERSION})


async def _cleanup(app):
    try:
        xray.stop()
    except Exception:
        pass


# ---------------- ساخت اپلیکیشن ----------------

def create_app() -> web.Application:
    app = web.Application(client_max_size=16 * 1024 * 1024)
    r = app.router

    # ---- عمومی ----
    r.add_get("/", index)
    r.add_get("/favicon.ico", favicon)
    r.add_get("/assets/{name}", asset)
    r.add_get("/healthz", healthz)
    r.add_get("/api/status", handlers_auth.api_status)
    r.add_post("/api/setup", handlers_auth.api_setup)
    r.add_post("/api/login", handlers_auth.api_login)
    r.add_get("/sub/{token}", sub_handler)

    # ---- احراز هویت‌شده ----
    r.add_get("/api/me", handlers_auth.api_me)
    r.add_get("/api/dashboard", handlers_system.api_dashboard)
    r.add_get("/api/info", handlers_system.api_info)
    r.add_get("/api/logs", handlers_system.api_logs)
    r.add_get("/api/qr", handlers_system.api_qr)
    r.add_post("/api/xray/restart", handlers_system.api_xray_restart)
    r.add_post("/api/xray/x25519", handlers_system.api_xray_keys)
    r.add_post("/api/xray/cert", handlers_system.api_xray_cert)
    r.add_post("/api/xray/update", handlers_system.api_xray_update)

    r.add_get("/api/inbounds", handlers_inbounds.api_list)
    r.add_post("/api/inbounds", handlers_inbounds.api_create)
    r.add_put("/api/inbounds/{id}", handlers_inbounds.api_update)
    r.add_delete("/api/inbounds/{id}", handlers_inbounds.api_delete)
    r.add_post("/api/inbounds/{id}/toggle", handlers_inbounds.api_toggle)

    r.add_get("/api/clients", handlers_clients.api_list)
    r.add_post("/api/clients", handlers_clients.api_create)
    r.add_put("/api/clients/{id}", handlers_clients.api_update)
    r.add_delete("/api/clients/{id}", handlers_clients.api_delete)
    r.add_post("/api/clients/{id}/toggle", handlers_clients.api_toggle)
    r.add_post("/api/clients/{id}/reset", handlers_clients.api_reset)
    r.add_get("/api/clients/{id}/links", handlers_clients.api_links)
    r.add_get("/api/clients/{id}/traffic", handlers_clients.api_traffic)

    r.add_get("/api/settings", handlers_settings.api_get)
    r.add_put("/api/settings", handlers_settings.api_set)
    r.add_post("/api/settings/password", handlers_settings.api_password)
    r.add_post("/api/settings/totp/setup", handlers_settings.api_totp_setup)
    r.add_post("/api/settings/totp/enable", handlers_settings.api_totp_enable)
    r.add_post("/api/settings/totp/disable", handlers_settings.api_totp_disable)
    r.add_post("/api/settings/tg-test", handlers_settings.api_tg_test)
    r.add_get("/api/backup", handlers_settings.api_backup)
    r.add_post("/api/restore", handlers_settings.api_restore)

    @web.middleware
    async def security_headers(request, handler):
        resp = await handler(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        if not cfg.PAAS:
            resp.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self' 'unsafe-inline'; "
                "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                "connect-src 'self'; frame-ancestors 'none'")
        return resp

    app.middlewares.append(security_headers)
    app.on_cleanup.append(_cleanup)
    return app


# ---------------- راه‌اندازی ----------------

def seed_from_env() -> None:
    """ایجاد مدیر فقط اگر ADMIN_USER و ADMIN_PASS هر دو ست شده باشند.
    هیچ مقدار پیش‌فرض ناامنی وجود ندارد (رفع SF-001).
    """
    if db.get_setting("admin_pass"):
        return
    u = (os.environ.get("ADMIN_USER") or "").strip()
    p = os.environ.get("ADMIN_PASS") or ""
    if u and p:
        if len(u) < 3 or len(p) < 8:
            db.log_event(
                "ADMIN_USER/ADMIN_PASS نامعتبر (حداقل ۳ و ۸ کاراکتر) — "
                "نصب از طریق /api/setup انجام شود", "warn")
            return
        db.set_setting("admin_user", u)
        db.set_setting("admin_pass", hash_password(p))
        handlers_auth.seed_first_data()
        db.log_event(f"مدیر «{u}» از متغیر محیطی ایجاد شد", "ok")
    else:
        db.log_event(
            "هیچ مدیری تعریف نشده — اولین ورود از طریق صفحه نصب (/api/setup)",
            "info")

    for env, key in (("TG_BOT_TOKEN", "tg_token"),
                     ("TG_ADMIN_IDS", "tg_admins"),
                     ("PUBLIC_DOMAIN", "public_domain")):
        if os.environ.get(env) and not db.get_setting(key):
            db.set_setting(key, os.environ[env].strip())


def start_background() -> None:
    def _xray_thread():
        time.sleep(0.5)
        try:
            xray.start()
        except Exception as e:
            db.log_event(f"شروع هسته: {e}", "err")

    def _tg_thread():
        time.sleep(2)
        try:
            from telegram.bot import start_bot
            start_bot()
        except Exception as e:
            db.log_event(f"ربات تلگرام: {e}", "err")

    threading.Thread(target=_xray_thread, name="sf-xray",
                     daemon=True).start()
    threading.Thread(target=watchdog_loop, name="sf-watchdog",
                     daemon=True).start()
    scheduler.start()
    threading.Thread(target=_tg_thread, name="sf-telegram",
                     daemon=True).start()


def _banner() -> None:
    line = "=" * 58
    mode = "PaaS — روتر L4 تک‌پورت" if cfg.PAAS else "VPS — پورت مستقیم"
    print(f"\n{line}\n"
          f"  ⚡ SF-Panel  v{cfg.APP_VERSION}\n"
          f"  حالت        : {mode}\n"
          f"  پورت عمومی  : {cfg.PUBLIC_PORT}\n"
          f"{line}", flush=True)
    if db.get_setting("admin_user"):
        print(f"  ➜ ورود: {db.get_setting('admin_user')}\n", flush=True)
    else:
        print("  ➜ نصب اولیه لازم است (صفحه وب یا /api/setup)\n", flush=True)


async def _run_paas(app) -> None:
    """حالت ابری: پنل روی پورت داخلی + روتر L4 روی پورت عمومی."""
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", cfg.PANEL_INTERNAL_PORT)
    await site.start()
    db.log_event(f"پنل داخلی: 127.0.0.1:{cfg.PANEL_INTERNAL_PORT}", "ok")

    router_task = asyncio.create_task(
        router.serve("0.0.0.0", cfg.PUBLIC_PORT))

    import signal
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(
                sig, lambda: stop.done() or stop.set_result(None))
        except (NotImplementedError, RuntimeError):
            pass

    try:
        await stop
    finally:
        router_task.cancel()
        await runner.cleanup()


def main() -> None:
    cfg.ensure_dirs()
    db.connect()
    # تعمیر رکوردهای seed خراب (SF-002) در صورت وجود
    db.repair_seed_port_bug()
    seed_from_env()
    _banner()
    start_background()
    app = create_app()

    if cfg.PAAS:
        try:
            asyncio.run(_run_paas(app))
        except KeyboardInterrupt:
            pass
    else:
        try:
            web.run_app(app, host="0.0.0.0", port=cfg.PUBLIC_PORT,
                        access_log=None, print=None)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
