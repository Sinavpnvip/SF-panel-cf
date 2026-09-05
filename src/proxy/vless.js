/**
 * VLESS over WebSocket on Cloudflare Workers (BPB-style)
 */
import { connect } from "cloudflare:sockets";

const WS_OPEN = 1;

function uuidBytesToString(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  ).toLowerCase();
}

function parseVlessHeader(buf) {
  if (buf.byteLength < 24) return null;
  const view = new DataView(buf);
  const version = view.getUint8(0);
  if (version !== 0 && version !== 1) return null;
  const uuid = uuidBytesToString(new Uint8Array(buf.slice(1, 17)));
  const addonLen = view.getUint8(17);
  let o = 18 + addonLen;
  if (buf.byteLength < o + 4) return null;
  const cmd = view.getUint8(o);
  o += 1;
  const port = view.getUint16(o);
  o += 2;
  const atyp = view.getUint8(o);
  o += 1;
  let address = "";
  if (atyp === 1) {
    if (buf.byteLength < o + 4) return null;
    address = [...new Uint8Array(buf.slice(o, o + 4))].join(".");
    o += 4;
  } else if (atyp === 2) {
    const len = view.getUint8(o);
    o += 1;
    if (buf.byteLength < o + len) return null;
    address = new TextDecoder().decode(buf.slice(o, o + len));
    o += len;
  } else if (atyp === 3) {
    if (buf.byteLength < o + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(view.getUint16(o + i * 2).toString(16));
    }
    address = parts.join(":");
    o += 16;
  } else {
    return null;
  }
  if (!address || !port) return null;
  return { uuid, cmd, port, address, rawHeaderLen: o, version: version || 0 };
}

async function isAuthorized(env, uuid) {
  const u = String(uuid || "").toLowerCase();
  const master = String(env.PROXY_MASTER_UUID || "").toLowerCase();
  if (master && u === master) return true;
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT expiry, enable FROM accounts WHERE lower(uuid)=? AND enable=1 LIMIT 1"
    )
      .bind(u)
      .first();
    if (!row) return false;
    if (row.expiry && Number(row.expiry) > 0 && Number(row.expiry) < Date.now()) {
      return false;
    }
    return true;
  } catch {
    return false;
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
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  handleSession(server, env).catch(() => {
    try {
      server.close();
    } catch {}
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function handleSession(ws, env) {
  let remote = null;
  let writer = null;
  let headerDone = false;
  let busy = false;
  const queue = [];
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try {
      writer?.releaseLock?.();
    } catch {}
    try {
      remote?.close?.();
    } catch {}
    try {
      if (ws.readyState === WS_OPEN) ws.close();
    } catch {}
  };

  const processMsg = async (data) => {
    if (closed) return;
    if (!headerDone) {
      const parsed = parseVlessHeader(data);
      if (!parsed || parsed.cmd !== 1) {
        closeAll();
        return;
      }
      const ok = await isAuthorized(env, parsed.uuid);
      if (!ok) {
        closeAll();
        return;
      }
      headerDone = true;
      remote = connect({
        hostname: parsed.address,
        port: parsed.port,
      });
      writer = remote.writable.getWriter();
      if (ws.readyState === WS_OPEN) {
        ws.send(new Uint8Array([parsed.version, 0]));
      }
      const payload = data.slice(parsed.rawHeaderLen);
      if (payload.byteLength > 0) {
        await writer.write(new Uint8Array(payload));
      }
      pumpRemoteToWs(remote, ws, closeAll);
      return;
    }
    if (writer && data?.byteLength) {
      await writer.write(new Uint8Array(data));
    }
  };

  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !closed) {
        const item = queue.shift();
        await processMsg(item);
      }
    } catch {
      closeAll();
    } finally {
      busy = false;
      if (queue.length && !closed) drain();
    }
  };

  ws.addEventListener("message", (ev) => {
    const p =
      ev.data instanceof ArrayBuffer
        ? Promise.resolve(ev.data)
        : ev.data?.arrayBuffer?.() || Promise.resolve(null);
    Promise.resolve(p).then((buf) => {
      if (!buf || closed) return;
      queue.push(buf);
      drain();
    });
  });

  ws.addEventListener("close", closeAll);
  ws.addEventListener("error", closeAll);
}

async function pumpRemoteToWs(remote, ws, closeAll) {
  try {
    const reader = remote.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ws.readyState === WS_OPEN && value) ws.send(value);
    }
  } catch {
  } finally {
    closeAll();
  }
}
