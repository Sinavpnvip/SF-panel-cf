/**
 * Link builder + optional remote node API.
 * Default: links point to THIS Cloudflare Worker (PUBLIC_DOMAIN) for VLESS WS proxy.
 */
import { uuid, randomHex, nowMs } from "../utils/helpers.js";

export function buildVlessLink(node, clientUuid, email) {
  const host = (node?.public_host || "example.com")
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  const port = node?.port || 443;
  let path = node?.path_prefix || "/sf-vpn";
  // BPB/Zeus-style: WS early data greatly improves handshake success on CF
  if (path && !path.includes("ed=")) {
    path += (path.includes("?") ? "&" : "?") + "ed=2560";
  }
  const sni = node?.sni || host;
  const hh = node?.host_header || host;
  const security = node?.security || "tls";
  const fp = node?.fingerprint || "chrome";
  const transport = node?.transport || "ws";
  const name = encodeURIComponent(email || "sf");

  const params = new URLSearchParams();
  params.set("encryption", "none");
  params.set("security", security);
  params.set("type", transport);
  if (transport === "ws" || transport === "httpupgrade") {
    params.set("path", path);
    params.set("host", hh);
  }
  if (security === "tls" || security === "reality") {
    params.set("sni", sni);
    params.set("fp", fp);
    // do NOT force alpn=http/1.1 — many CF setups work better without it
  }
  if (node?.allow_insecure) params.set("allowInsecure", "1");

  return `vless://${clientUuid}@${host}:${port}?${params.toString()}#${name}`;
}

export function buildSubBody(links, title) {
  const raw = `// ${title || "SF VPN"}\n${(links || []).join("\n")}\n`;
  try {
    return btoa(unescape(encodeURIComponent(raw.trim())));
  } catch {
    return raw;
  }
}

/** Auto node = this Worker domain */
export function workerAsNode(env) {
  const host = (env.PUBLIC_DOMAIN || "").replace(/^https?:\/\//, "").split("/")[0];
  const path = env.PROXY_PATH || "/sf-vpn";
  return {
    id: 0,
    name: "cloudflare-worker",
    public_host: host || "example.com",
    port: 443,
    transport: "ws",
    path_prefix: path,
    sni: host || "example.com",
    host_header: host || "example.com",
    security: "tls",
    fingerprint: "chrome",
    alpn: "http/1.1",
    allow_insecure: 0,
    api_url: "",
  };
}

export async function createRemoteAccount(node, { email, days, limitGb, tgId }) {
  const clientUuid = uuid();
  const sub = randomHex(8);
  const limit = (Number(limitGb) || 0) * 1073741824;
  const expiry = days ? nowMs() + Number(days) * 86400000 : 0;
  const links = [buildVlessLink(node, clientUuid, email)];

  if (!node?.api_url) {
    return {
      email,
      uuid: clientUuid,
      sub_id: sub,
      remote_id: "",
      limit_bytes: limit,
      expiry,
      links,
    };
  }

  try {
    const url = String(node.api_url).replace(/\/$/, "") + "/api/shop/create";
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + (node.api_token || ""),
      },
      body: JSON.stringify({
        email,
        days,
        limit_gb: limitGb,
        tg_id: String(tgId || ""),
        uuid: clientUuid,
        sub_id: sub,
      }),
    });
    clearTimeout(t);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`node ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    return {
      email: data.email || email,
      uuid: data.uuid || clientUuid,
      sub_id: data.sub_id || sub,
      remote_id: String(data.id || data.remote_id || ""),
      limit_bytes: data.limit_bytes ?? limit,
      expiry: data.expiry ?? expiry,
      links:
        Array.isArray(data.links) && data.links.length
          ? data.links
          : [buildVlessLink(node, data.uuid || clientUuid, email)],
    };
  } catch (e) {
    return {
      email,
      uuid: clientUuid,
      sub_id: sub,
      remote_id: "",
      limit_bytes: limit,
      expiry,
      links,
      warning: String(e.message || e),
    };
  }
}
