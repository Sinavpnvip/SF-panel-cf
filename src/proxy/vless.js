/**
 * Production VLESS over WebSocket for Cloudflare Workers
 * Pattern aligned with BPB/Zeus-style CF proxies.
 */
import { connect } from "cloudflare:sockets";

function base64ToUint8Array(b64) {
  if (!b64) return null;
  try {
    const s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(s + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function uuidBytesToString(bytes, offset = 0) {
  const hex = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[offset + i].toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 12).join("") +
    "-" +
    hex.slice(12, 14).join("") +
    "-" +
    hex.slice(14, 16).join("")
  ).toLowerCase();
}

/**
 * Parse VLESS header from buffer.
 * Returns { uuid, address, port, payload: Uint8Array } or null
 */
function parseVlessHeader(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.byteLength < 24) return null;

  let offset = 0;
  const version = u8[offset++]; // 1 byte (usually 0)
  const uuid = uuidBytesToString(u8, offset);
  offset += 16;

  const addonLen = u8[offset++];
  offset += addonLen; // skip addon
  if (offset + 3 > u8.byteLength) return null;

  const cmd = u8[offset++]; // 1 = TCP, 2 = UDP
  const port = (u8[offset] << 8) | u8[offset + 1];
  offset += 2;

  const atyp = u8[offset++];
  let address = "";

  if (atyp === 1) {
    // IPv4
    if (offset + 4 > u8.byteLength) return null;
    address = `${u8[offset]}.${u8[offset + 1]}.${u8[offset + 2]}.${u8[offset + 3]}`;
    offset += 4;
  } else if (atyp === 2) {
    // Domain
    const len = u8[offset++];
    if (offset + len > u8.byteLength) return null;
    address = new TextDecoder().decode(u8.subarray(offset, offset + len));
    offset += len;
  } else if (atyp === 3) {
    // IPv6
    if (offset + 16 > u8.byteLength) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(((u8[offset] << 8) | u8[offset + 1]).toString(16));
      offset += 2;
    }
    address = parts.join(":");
  } else {
    return null;
  }

  if (!address || !port) return null;

  return {
    version,
    uuid,
    cmd,
    address,
    port,
    payload: u8.subarray(offset),
  };
}

async function isUuidAllowed(env, uuid) {
  if (String(env.PROXY_OPEN || "") === "1") return true;
  const id = String(uuid || "").toLowerCase();
  const master = String(env.PROXY_MASTER_UUID || "").toLowerCase();
  if (master && master === id) return true;
  if (!env.DB) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT enable, expiry FROM accounts WHERE uuid = ? LIMIT 1"
    )
      .bind(id)
      .first();
    if (row) {
      if (!row.enable) return false;
      if (row.expiry && Number(row.expiry) > 0 && Number(row.expiry) < Date.now()) {
        return false;
      }
      return true;
    }
    const all = await env.DB.prepare(
      "SELECT uuid, enable, expiry FROM accounts WHERE enable = 1 LIMIT 500"
    ).all();
    const hit = (all.results || []).find(
      (r) => String(r.uuid || "").toLowerCase() === id
    );
    if (!hit) return false;
    if (hit.expiry && Number(hit.expiry) > 0 && Number(hit.expiry) < Date.now()) {
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

/**
 * Main entry — WebSocket upgrade request on proxy path
 */
export async function handleVlessWebSocket(request, env) {
  const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
  if (upgrade !== "websocket") {
    return new Response("sf-proxy-ok", { status: 200 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  // Early data (first VLESS chunk) from sec-websocket-protocol
  const protoHeader = request.headers.get("sec-websocket-protocol") || "";
  const earlyToken = protoHeader.split(",")[0].trim();
  const earlyData = base64ToUint8Array(earlyToken);

  // Run session without blocking the 101 response
  handleSession(server, env, earlyData).catch(() => {
    try {
      server.close(1011, "error");
    } catch {}
  });

  const headers = new Headers();
  if (earlyToken) {
    headers.set("Sec-WebSocket-Protocol", earlyToken);
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers,
  });
}

// Alias expected by some index imports
export const handleVless = handleVlessWebSocket;

async function handleSession(ws, env, earlyData) {
  /** @type {import("cloudflare:sockets").Socket | null} */
  let remoteSocket = null;
  let headerDone = false;
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close();
    } catch {}
    try {
      remoteSocket?.close();
    } catch {}
  };

  /**
   * Process the first buffer containing VLESS header (+ optional payload)
   */
  const processFirstChunk = async (chunk) => {
    if (headerDone || closed) return;
    const parsed = parseVlessHeader(chunk);
    if (!parsed) {
      closeAll();
      return;
    }

    // Still parse UUID even when PROXY_OPEN=1 (required to advance buffer)
    const allowed = await isUuidAllowed(env, parsed.uuid);
    if (!allowed) {
      closeAll();
      return;
    }

    // Only TCP for stable browsing/ping
    if (parsed.cmd !== 1) {
      closeAll();
      return;
    }

    try {
      remoteSocket = connect({
        hostname: parsed.address,
        port: Number(parsed.port),
      });
    } catch {
      closeAll();
      return;
    }

    headerDone = true;

    // Immediate VLESS response BEFORE any piping (version 0, addon 0)
    try {
      ws.send(new Uint8Array([0, 0]));
    } catch {
      closeAll();
      return;
    }

    // If header chunk had leftover payload, write it first
    const writer = remoteSocket.writable.getWriter();
    try {
      if (parsed.payload && parsed.payload.byteLength > 0) {
        await writer.write(parsed.payload);
      }
    } catch {
      try {
        writer.releaseLock();
      } catch {}
      closeAll();
      return;
    }
    try {
      writer.releaseLock();
    } catch {}

    // Safe bidirectional piping
    await pipeBoth(ws, remoteSocket, closeAll);
  };

  // Queue for messages arriving before/during init
  const pending = [];
  let processing = false;

  const pumpQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      while (pending.length && !closed) {
        const buf = pending.shift();
        if (!headerDone) {
          await processFirstChunk(buf);
        } else if (remoteSocket) {
          try {
            const w = remoteSocket.writable.getWriter();
            await w.write(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
            w.releaseLock();
          } catch {
            closeAll();
          }
        }
      }
    } finally {
      processing = false;
    }
  };

  ws.addEventListener("message", (event) => {
    if (closed) return;
    const data = event.data;
    const toBuf =
      data instanceof ArrayBuffer
        ? Promise.resolve(new Uint8Array(data))
        : data?.arrayBuffer
          ? data.arrayBuffer().then((b) => new Uint8Array(b))
          : Promise.resolve(null);

    toBuf
      .then((u8) => {
        if (!u8 || closed) return;
        pending.push(u8);
        return pumpQueue();
      })
      .catch(() => closeAll());
  });

  ws.addEventListener("close", closeAll);
  ws.addEventListener("error", closeAll);

  // Process early data FIRST if present (do not wait for message event)
  if (earlyData && earlyData.byteLength > 0) {
    pending.push(earlyData);
    await pumpQueue();
  }
}

/**
 * Bidirectional pipe with try/catch to avoid silent worker crashes
 */
async function pipeBoth(ws, remoteSocket, closeAll) {
  // ws (client) is already reading via message events for client→remote
  // Here we only need remote → client, plus ensure remote writable stays open
  // Actually client→remote is handled in message handler after headerDone.
  // remote → ws:
  try {
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          try {
            if (ws.readyState === 1) {
              ws.send(chunk);
            }
          } catch {
            throw new Error("ws send failed");
          }
        },
        close() {
          closeAll();
        },
        abort() {
          closeAll();
        },
      }),
      { preventClose: false }
    );
  } catch {
    closeAll();
  }
}
