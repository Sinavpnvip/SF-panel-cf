import { clientIp, json, nowMs } from "../utils/helpers.js";
import { q, ex } from "../utils/db.js";

/** Sliding window rate limit via KV */
export async function rateLimit(env, req, keyPrefix = "rl", limit = 60) {
  if (!env.KV) return { ok: true };
  const ip = clientIp(req);
  const window = Math.floor(Date.now() / 60000);
  const key = `${keyPrefix}:${ip}:${window}`;
  try {
    const cur = parseInt((await env.KV.get(key)) || "0", 10);
    if (cur >= limit) {
      return { ok: false, response: json({ error: "too_many_requests" }, 429) };
    }
    await env.KV.put(key, String(cur + 1), { expirationTtl: 120 });
  } catch {}
  return { ok: true };
}

/** Login brute-force protection (D1 + optional KV) */
export async function checkLoginLock(db, env, ip) {
  const since = nowMs() - 15 * 60 * 1000;
  try {
    await ex(db, "DELETE FROM login_attempts WHERE ts < ?", [since - 3600000]);
  } catch {}
  const rows = await q(
    db,
    "SELECT COUNT(*) n FROM login_attempts WHERE ip=? AND ts > ?",
    [ip, since],
    true
  );
  if ((rows?.n || 0) >= 10) {
    return { ok: false, response: json({ error: "locked_try_later" }, 429) };
  }
  return { ok: true };
}

export async function recordLoginFail(db, ip) {
  await ex(db, "INSERT INTO login_attempts(ip,ts) VALUES(?,?)", [ip, nowMs()]);
}

export function securityHeaders(res) {
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "no-referrer");
  h.set(
    "permissions-policy",
    "geolocation=(), microphone=(), camera=()"
  );
  h.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
  );
  return new Response(res.body, { status: res.status, headers: h });
}
