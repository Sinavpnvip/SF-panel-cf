/**
 * Node / inbound link builder — SNI, host, path, security, fingerprint
 * Actual proxy traffic runs on external Xray node, not on Worker.
 */
import { uuid, randomHex, nowMs } from "../utils/helpers.js";

export function buildVlessLink(node, clientUuid, email) {
  const host = (node?.public_host || "example.com").replace(/^https?:\/\//, "").split("/")[0];
  const port = node?.port || 443;
  const path = node?.path_prefix || "/sf-vpn";
  const sni = node?.sni || host;
  const hh = node?.host_header || host;
  const security = node?.security || "tls";
  const fp = node?.fingerprint || "chrome";
  const alpn = node?.alpn || "http/1.1";
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
    if (alpn) params.set("alpn", alpn);
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
        sni: node.sni || "",
        path: node.path_prefix || "",
        host: node.public_host || "",
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
      links: Array.isArray(data.links) && data.links.length
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
