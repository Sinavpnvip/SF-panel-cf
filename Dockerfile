# ═══════════════ SF-Panel — Dockerfile (hardened) ═══════════════
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SF_DATA_DIR=/data \
    SF_NO_AUTOINSTALL=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip openssl \
    && rm -rf /var/lib/apt/lists/*

# کاربر غیرroot (رفع SF-010)
RUN groupadd -r sfpanel && useradd -r -g sfpanel -d /app -s /sbin/nologin sfpanel

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY core/ core/
COPY api/ api/
COPY telegram/ telegram/
COPY web/ web/
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

# Xray با نسخه پین‌شده + بررسی وجود فایل (بهبود SF-010)
# برای تغییر نسخه: ARG XRAY_VERSION=v25.3.6
ARG XRAY_VERSION=v25.3.6
RUN case "$(dpkg --print-architecture)" in \
        arm64) ASSET=Xray-linux-arm64-v8a.zip ;; \
        *)     ASSET=Xray-linux-64.zip ;; \
    esac && \
    curl -fsSL -o /tmp/x.zip \
        "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/$ASSET" && \
    unzip -o /tmp/x.zip xray geoip.dat geosite.dat -d /opt/xray && \
    rm /tmp/x.zip && chmod +x /opt/xray/xray && \
    test -x /opt/xray/xray

RUN chown -R sfpanel:sfpanel /app /opt/xray
# data volume در runtime با entrypoint تنظیم می‌شود
USER sfpanel

ENTRYPOINT ["./docker-entrypoint.sh"]
