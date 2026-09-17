#!/bin/sh
# ═══════════════ SF-Panel — entrypoint ═══════════════
set -e

DATA="${SF_DATA_DIR:-/data}"
mkdir -p "$DATA/xray" "$DATA/certs" 2>/dev/null || true

# هسته پیش‌دانلودشده از ایمیج را در اولین اجرا به volume کپی کن
if [ -f /opt/xray/xray ] && [ ! -f "$DATA/xray/xray" ]; then
    cp -f /opt/xray/xray      "$DATA/xray/xray"
    cp -f /opt/xray/geoip.dat "$DATA/xray/geoip.dat"   2>/dev/null || true
    cp -f /opt/xray/geosite.dat "$DATA/xray/geosite.dat" 2>/dev/null || true
    chmod +x "$DATA/xray/xray"
    echo "[SF-Panel] هسته Xray از ایمیج نصب شد"
fi

# اگر به عنوان root اجرا شدیم، مالکیت data را اصلاح کن
if [ "$(id -u)" = "0" ]; then
    chown -R sfpanel:sfpanel "$DATA" 2>/dev/null || true
    exec su -s /bin/sh sfpanel -c "exec python app.py"
fi

exec python app.py
