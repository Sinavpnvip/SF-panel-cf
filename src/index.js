import { handleApi } from "./routes/api.js";
import { handleUpdate } from "./telegram/bot.js";
import { json } from "./utils/helpers.js";
import { securityHeaders, rateLimit } from "./middleware/security.js";
import { isProxyPath, handleVlessWebSocket } from "./proxy/vless.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    // ---- VLESS WebSocket proxy (BPB-style) ----
    if (isProxyPath(path, env)) {
      if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
        return handleVlessWebSocket(request, env);
      }
      // health for path
      return new Response("sf-proxy-ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    // Telegram webhook
    if (path === "/tg/webhook" && request.method === "POST") {
      const secret = env.TG_WEBHOOK_SECRET || "";
      if (secret) {
        const q = url.searchParams.get("secret") || "";
        const h =
          request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (q !== secret && h !== secret) {
          return json({ error: "forbidden" }, 403);
        }
      }
      const rl = await rateLimit(env, request, "tg", 120);
      if (!rl.ok) return rl.response;
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(env, env.DB, update));
      } catch (e) {
        console.error("webhook", e);
      }
      return json({ ok: true });
    }

    if (path.startsWith("/api/") || path.startsWith("/sub/")) {
      try {
        const res = await handleApi(request, env, path);
        return securityHeaders(res);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    if (path === "/healthz") {
      return json({
        ok: true,
        app: "sf-panel-cf",
        version: env.APP_VERSION || "2.1.0",
        proxy_path: env.PROXY_PATH || "/sf-vpn",
      });
    }

    if (env.ASSETS) {
      if (path === "/" || path === "") path = "/index.html";
      let res = await env.ASSETS.fetch(new URL(path, url.origin));
      if (res.status === 404 && !path.includes(".")) {
        res = await env.ASSETS.fetch(new URL("/index.html", url.origin));
      }
      return securityHeaders(res);
    }

    return new Response("SF-Panel CF v2.1 + VLESS proxy", { status: 200 });
  },
};
