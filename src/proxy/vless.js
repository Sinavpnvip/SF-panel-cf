/**
 * VLESS + WS on Cloudflare Worker — hardened for common clients
 */
import { connect } from "cloudflare:sockets";

function uuidFromBytes(arr, offset) {
  const h = [];
  for (let i = 0; i < 16; i++) {
    h.push(arr[offset + i].toString(16).padStart(2, "0"));
  }
  return (
    h.slice(0, 8).join("") +
    "-" +
    h.slice(8, 10).join("") +
    "-" +
    h.slice(10, 12).join("") +
    "-" +
    h.slice(12, 14).join("") +
    "-" +
    h.slice(14, 16).join("")
  ).toLowerCase();
}

function b64ToBuf(s) {
  if (!s) return null;
  try {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s + pad);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  } catch {
    return null;
  }
}

function parseHeader(u8) {
  if (!u8 || u8.length < 24) return null;
  const version = u8[0];
  const uuid = uuidFromBytes(u8, 1);
  const optLen = u8[17];
  let p = 18 + optLen;
  if (u8.length < p + 3) return null;
  const cmd = u8[p++];
  const port = (u8[p] << 8) | u8[p + 1];
  p += 2;
  const atyp = u8[p++];
  let host = "";
  if (atyp === 1) {
    if (u8.length < p + 4) return null;
    host = `${u8[p++]}.${u8[p++]}.${u8[p++]}.${u8[p++]}`;
  } else if (atyp === 2) {
    const l = u8[p++];
    if (u8.length < p + l) return null;
    host = new TextDecoder().decode(u8.subarray(p, p + l));
    p += l;
  } else if (atyp === 3) {
    if (u8.length < p + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(((u8[p] << 8) | u8[p + 1]).toString(16));
      p += 2;
    }
    host = parts.join(":");
  } else return null;
  return { version, uuid, cmd, port, host, headerLen: p };
}

async function allowUuid(env, uuid) {
  if (String(env.PROXY_OPEN || "") === "1") return true;
  const id = String(uuid || "").toLowerCase();
  if (String(env.PROXY_MASTER_UUID || "").toLowerCase() === id) return true;
  if (!env.DB) return String(env.PROXY_OPEN || "") === "1";
  try {
    const r = await env.DB.prepare(
      "SELECT enable, expiry FROM accounts WHERE uuid = ? LIMIT 1"
    )
      .bind(id)
      .first();
    if (!r) {
      // try any case via scan small table
      const all = await env.DB.prepare(
        "SELECT uuid, enable, expiry FROM accounts WHERE enable = 1 LIMIT 500"
      ).all();
      const hit = (all.results || []).find(
        (x) => String(x.uuid).toLowerCase() === id
      );
      if (!hit) return false;
      if (hit.expiry && Number(hit.expiry) < Date.now()) return false;
      return true;
    }
    if (!r.enable) return false;
    if (r.expiry && Number(r.expiry) > 0 && Number(r.expiry) < Date.now())
      return false;
    return true;
  } catch {
    return String(env.PROXY_OPEN || "") === "1";
  }
}

export function isProxyPath(pathname, env) {
  let p = (env.PROXY_PATH || "/sf-vpn").trim() || "/sf-vpn";
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/$/, "") || "/sf-vpn";
  const path = (pathname || "/").replace(/\/$/, "") || "/";
  return path === p || path.startsWith(p + "/");
}

export async function handleVlessWebSocket(request, env) {
  const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
  if (upgrade !== "websocket") {
    return new Response("sf-proxy-ws", { status: 200 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const proto = request.headers.get("sec-websocket-protocol") || "";
  const early = b64ToBuf(proto.split(",")[0].trim());

  pipe(server, env, early).catch(() => {
    try {
      server.close();
    } catch {}
  });

  const headers = new Headers();
  if (proto) headers.set("Sec-WebSocket-Protocol", proto.split(",")[0].trim());

  return new Response(null, { status: 101, webSocket: client, headers });
}

async function pipe(ws, env, early) {
  let remoteWriter = null;
  let remote = null;
  let inited = false;
  let closed = false;

  const shutdown = () => {
    if (closed) return;
    closed = true;
    try {
      remoteWriter?.releaseLock();
    } catch {}
    try {
      remote?.close();
    } catch {}
    try {
      ws.close();
    } catch {}
  };

  const onChunk = async (buf) => {
    if (closed || !buf || !buf.byteLength) return;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

    if (!inited) {
      const h = parseHeader(u8);
      if (!h || h.cmd !== 1) {
        shutdown();
        return;
      }
      if (!(await allowUuid(env, h.uuid))) {
        shutdown();
        return;
      }
      inited = true;
      try {
        remote = connect({ hostname: h.host, port: h.port });
        remoteWriter = remote.writable.getWriter();
      } catch {
        shutdown();
        return;
      }
      // VLESS response
      try {
        ws.send(new Uint8Array([h.version, 0x00]));
      } catch {
        shutdown();
        return;
      }
      const rest = u8.subarray(h.headerLen);
      if (rest.length) {
        try {
          await remoteWriter.write(rest);
        } catch {
          shutdown();
          return;
        }
      }
      // remote -> ws
      (async () => {
        try {
          const reader = remote.readable.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && ws.readyState === 1) ws.send(value);
          }
        } catch {
        } finally {
          shutdown();
        }
      })();
      return;
    }

    try {
      await remoteWriter.write(u8);
    } catch {
      shutdown();
    }
  };

  ws.addEventListener("message", (ev) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) onChunk(data);
    else if (data && data.arrayBuffer)
      data.arrayBuffer().then(onChunk).catch(shutdown);
  });
  ws.addEventListener("close", shutdown);
  ws.addEventListener("error", shutdown);

  if (early && early.length) await onChunk(early);
}
