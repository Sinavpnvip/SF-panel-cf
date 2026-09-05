export function nowMs() {
  return Date.now();
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-requested-with",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      ...extraHeaders,
    },
  });
}

export function text(body, status = 200, type = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "content-type": type,
      "x-content-type-options": "nosniff",
    },
  });
}

export function randomHex(n = 16) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function uuid() {
  return crypto.randomUUID();
}

export function refCode() {
  return "r" + randomHex(3);
}

export function clientIp(req) {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

export function b64url(input) {
  let s;
  if (typeof input === "string") {
    s = btoa(unescape(encodeURIComponent(input)));
  } else {
    s = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

export async function sha256(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** PBKDF2-like stretch via multiple SHA-256 rounds + salt */
export async function hashPassword(password, salt, secret) {
  const base = `${secret || "sf"}:${salt}:${password}`;
  let h = await sha256(base);
  for (let i = 0; i < 5000; i++) {
    h = await sha256(h + salt + (secret || ""));
  }
  return h;
}

export async function signJwt(payload, secret, ttlSec = 604800) {
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET too weak");
  }
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSec,
    })
  );
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return `${data}.${b64url(sig)}`;
}

export async function verifyJwt(token, secret) {
  try {
    if (!secret || !token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigStr = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const pad = sigStr + "===".slice((sigStr.length + 3) % 4);
    const sig = Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      new TextEncoder().encode(data)
    );
    if (!ok) return null;
    const payload = JSON.parse(fromB64url(parts[1]));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const h = req.headers.get("cookie") || "";
  const out = {};
  for (const p of h.split(";")) {
    const i = p.indexOf("=");
    if (i > 0) {
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    }
  }
  return out;
}

export function toman(n) {
  return `${Number(n || 0).toLocaleString("en-US")} تومان`;
}

export function trimTg(text, max = 3900) {
  text = String(text || "");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function safeInt(v, def = 0) {
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : def;
}
