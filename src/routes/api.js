import {
  q,
  ex,
  getSetting,
  setSetting,
  logEvent,
  balanceAdd,
} from "../utils/db.js";
import {
  json,
  hashPassword,
  signJwt,
  verifyJwt,
  nowMs,
  parseCookies,
  clientIp,
  randomHex,
  safeInt,
} from "../utils/helpers.js";
import {
  rateLimit,
  checkLoginLock,
  recordLoginFail,
} from "../middleware/security.js";
import { buildVlessLink, buildSubBody } from "../services/node.js";

async function authAdmin(req, env) {
  const h = req.headers.get("authorization") || "";
  let token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) token = parseCookies(req).sf_token || "";
  if (!token) return null;
  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

export async function handleApi(req, env, path) {
  const db = env.DB;
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") return json({ ok: true });

  const rl = await rateLimit(
    env,
    req,
    "api",
    safeInt(env.RATE_LIMIT_PER_MIN, 60)
  );
  if (!rl.ok) return rl.response;

  // ---- Subscription (public) ----
  if (path.startsWith("/sub/")) {
    const sid = path.slice(5).split(/[/?#]/)[0];
    if (!/^[a-f0-9]{8,32}$/i.test(sid)) {
      return new Response("not found", { status: 404 });
    }
    const acc = await q(
      db,
      "SELECT * FROM accounts WHERE sub_id=? AND enable=1",
      [sid],
      true
    );
    if (!acc) return new Response("not found", { status: 404 });
    if (acc.expiry && acc.expiry < nowMs()) {
      return new Response("expired", { status: 410 });
    }
    const node = acc.node_id
      ? await q(db, "SELECT * FROM nodes WHERE id=?", [acc.node_id], true)
      : null;
    const host = (env.PUBLIC_DOMAIN || node?.public_host || "example.com")
      .replace(/^https?:\/\//, "")
      .split("/")[0];
    const link = buildVlessLink(
      node || {
        public_host: host,
        path_prefix: env.PROXY_PATH || "/sf-vpn",
        sni: host,
        host_header: host,
        security: "tls",
        port: 443,
        transport: "ws",
      },
      acc.uuid,
      acc.email
    );
    const body = buildSubBody([link], env.SUB_TITLE || "SF");
    return new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "profile-title": env.SUB_TITLE || "SF VPN",
        "cache-control": "no-store",
      },
    });
  }

  // ---- Status / Setup / Login ----
  if (path === "/api/status" && method === "GET") {
    const hasAdmin = await q(db, "SELECT id FROM admins LIMIT 1", [], true);
    return json({
      installed: !!hasAdmin,
      app: env.APP_NAME || "SF-Panel",
      version: env.APP_VERSION || "2.0.0",
      domain: env.PUBLIC_DOMAIN || "",
    });
  }

  if (path === "/api/setup" && method === "POST") {
    const existing = await q(db, "SELECT id FROM admins LIMIT 1", [], true);
    if (existing) return json({ error: "already_installed" }, 400);
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
      return json({ error: "JWT_SECRET_not_configured" }, 500);
    }
    const body = await req.json().catch(() => ({}));
    const user = String(body.username || "admin")
      .trim()
      .slice(0, 32);
    const pass = String(body.password || "");
    if (user.length < 3 || pass.length < 8) {
      return json({ error: "weak_credentials" }, 400);
    }
    const salt = randomHex(16);
    const ph = await hashPassword(pass, salt, env.JWT_SECRET);
    await ex(
      db,
      "INSERT INTO admins(username,pass_hash,pass_salt,created_at) VALUES(?,?,?,?)",
      [user, ph, salt, nowMs()]
    );
    await logEvent(db, "admin installed: " + user, "ok");
    const days = safeInt(env.SESSION_DAYS, 7);
    const token = await signJwt(
      { role: "admin", user },
      env.JWT_SECRET,
      days * 86400
    );
    return json({ ok: true, token });
  }

  if (path === "/api/login" && method === "POST") {
    const ip = clientIp(req);
    const lock = await checkLoginLock(db, env, ip);
    if (!lock.ok) return lock.response;
    if (!env.JWT_SECRET) return json({ error: "server_misconfigured" }, 500);

    const body = await req.json().catch(() => ({}));
    const user = String(body.username || "").trim();
    const pass = String(body.password || "");
    const row = await q(
      db,
      "SELECT * FROM admins WHERE username=?",
      [user],
      true
    );
    if (!row) {
      await recordLoginFail(db, ip);
      return json({ error: "invalid" }, 401);
    }
    const ph = await hashPassword(pass, row.pass_salt || "", env.JWT_SECRET);
    if (ph !== row.pass_hash) {
      await recordLoginFail(db, ip);
      await logEvent(db, "login fail user=" + user + " ip=" + ip, "warn");
      return json({ error: "invalid" }, 401);
    }
    await ex(db, "UPDATE admins SET last_login=? WHERE id=?", [nowMs(), row.id]);
    const days = safeInt(env.SESSION_DAYS, 7);
    const token = await signJwt(
      { role: "admin", user },
      env.JWT_SECRET,
      days * 86400
    );
    return json({ ok: true, token });
  }

  // ---- Admin APIs ----
  const admin = await authAdmin(req, env);
  const needAdmin = path.startsWith("/api/") && path !== "/api/status";

  if (
    needAdmin &&
    !["/api/setup", "/api/login", "/api/status"].includes(path) &&
    !admin
  ) {
    return json({ error: "unauthorized" }, 401);
  }

  if (path === "/api/dashboard" && method === "GET") {
    const users = await q(db, "SELECT COUNT(*) n FROM users", [], true);
    const accounts = await q(db, "SELECT COUNT(*) n FROM accounts", [], true);
    const pending = await q(
      db,
      "SELECT COUNT(*) n FROM receipts WHERE status='pending'",
      [],
      true
    );
    const plans = await q(
      db,
      "SELECT COUNT(*) n FROM plans WHERE is_active=1",
      [],
      true
    );
    const nodes = await q(
      db,
      "SELECT COUNT(*) n FROM nodes WHERE enable=1",
      [],
      true
    );
    const events = await q(
      db,
      "SELECT * FROM events ORDER BY id DESC LIMIT 30"
    );
    return json({
      users: users?.n || 0,
      accounts: accounts?.n || 0,
      pending_receipts: pending?.n || 0,
      plans: plans?.n || 0,
      nodes: nodes?.n || 0,
      events,
    });
  }

  // Plans
  if (path === "/api/plans" && method === "GET") {
    return json({ plans: await q(db, "SELECT * FROM plans ORDER BY sort, id") });
  }
  if (path === "/api/plans" && method === "POST") {
    const b = await req.json();
    await ex(
      db,
      `INSERT INTO plans(title,days,limit_gb,price,node_id,is_active,sort,description,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        String(b.title || "Plan").slice(0, 80),
        safeInt(b.days, 30),
        safeInt(b.limit_gb, 50),
        safeInt(b.price, 0),
        b.node_id || null,
        b.is_active === 0 ? 0 : 1,
        safeInt(b.sort, 0),
        String(b.description || "").slice(0, 200),
        nowMs(),
      ]
    );
    return json({ ok: true });
  }
  if (path.startsWith("/api/plans/") && method === "DELETE") {
    const id = safeInt(path.split("/")[3]);
    await ex(db, "UPDATE plans SET is_active=0 WHERE id=?", [id]);
    return json({ ok: true });
  }

  // Nodes — with SNI / proxy fields
  if (path === "/api/nodes" && method === "GET") {
    return json({ nodes: await q(db, "SELECT * FROM nodes ORDER BY sort, id") });
  }
  if (path === "/api/nodes" && method === "POST") {
    const b = await req.json();
    const host = String(b.public_host || "")
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .trim();
    if (!host) return json({ error: "public_host_required" }, 400);
    await ex(
      db,
      `INSERT INTO nodes(name,api_url,api_token,public_host,port,transport,path_prefix,sni,host_header,security,fingerprint,alpn,allow_insecure,enable,sort,note,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(b.name || "node").slice(0, 64),
        String(b.api_url || "").slice(0, 300),
        String(b.api_token || "").slice(0, 200),
        host,
        safeInt(b.port, 443),
        String(b.transport || "ws").slice(0, 20),
        String(b.path_prefix || "/sf-vpn").slice(0, 80),
        String(b.sni || host).slice(0, 120),
        String(b.host_header || host).slice(0, 120),
        String(b.security || "tls").slice(0, 20),
        String(b.fingerprint || "chrome").slice(0, 20),
        String(b.alpn || "http/1.1").slice(0, 40),
        b.allow_insecure ? 1 : 0,
        1,
        safeInt(b.sort, 0),
        String(b.note || "").slice(0, 200),
        nowMs(),
      ]
    );
    await logEvent(db, "node added: " + host, "ok");
    return json({ ok: true });
  }
  if (path.startsWith("/api/nodes/") && method === "DELETE") {
    const id = safeInt(path.split("/")[3]);
    await ex(db, "UPDATE nodes SET enable=0 WHERE id=?", [id]);
    return json({ ok: true });
  }

  if (path === "/api/users" && method === "GET") {
    return json({
      users: await q(
        db,
        "SELECT * FROM users ORDER BY joined_at DESC LIMIT 200"
      ),
    });
  }
  if (path.startsWith("/api/users/") && method === "POST") {
    const id = safeInt(path.split("/")[3]);
    const b = await req.json();
    if (b.action === "block") {
      await ex(db, "UPDATE users SET is_blocked=1 WHERE tg_id=?", [id]);
    } else if (b.action === "unblock") {
      await ex(db, "UPDATE users SET is_blocked=0 WHERE tg_id=?", [id]);
    } else if (b.action === "balance" && typeof b.amount === "number") {
      await balanceAdd(db, id, b.amount, "admin", b.note || "admin adjust");
    }
    return json({ ok: true });
  }

  if (path === "/api/receipts" && method === "GET") {
    return json({
      receipts: await q(
        db,
        "SELECT * FROM receipts ORDER BY id DESC LIMIT 100"
      ),
    });
  }
  if (path.startsWith("/api/receipts/") && method === "POST") {
    const id = safeInt(path.split("/")[3]);
    const b = await req.json();
    const r = await q(db, "SELECT * FROM receipts WHERE id=?", [id], true);
    if (!r || r.status !== "pending")
      return json({ error: "not_pending" }, 400);
    if (b.action === "approve") {
      await ex(db, "UPDATE receipts SET status='approved' WHERE id=?", [id]);
      await balanceAdd(db, r.user_id, r.amount, "deposit", "رسید #" + id);
    } else {
      await ex(db, "UPDATE receipts SET status='rejected' WHERE id=?", [id]);
    }
    return json({ ok: true });
  }

  if (path === "/api/coupons" && method === "GET") {
    return json({
      coupons: await q(db, "SELECT * FROM coupons ORDER BY id DESC"),
    });
  }
  if (path === "/api/coupons" && method === "POST") {
    const b = await req.json();
    const code = String(b.code || "")
      .trim()
      .toUpperCase();
    if (!code) return json({ error: "code_required" }, 400);
    await ex(
      db,
      `INSERT INTO coupons(code,percent,amount_off,max_uses,used,expires_at,is_active,created_at)
       VALUES(?,?,?,?,0,?,?,?)`,
      [
        code.slice(0, 32),
        safeInt(b.percent, 0),
        safeInt(b.amount_off, 0),
        safeInt(b.max_uses, 0),
        b.expires_at || 0,
        1,
        nowMs(),
      ]
    );
    return json({ ok: true });
  }

  if (path === "/api/accounts" && method === "GET") {
    return json({
      accounts: await q(
        db,
        "SELECT * FROM accounts ORDER BY id DESC LIMIT 200"
      ),
    });
  }

  if (path === "/api/settings" && method === "GET") {
    return json({
      public_domain:
        env.PUBLIC_DOMAIN || (await getSetting(db, "public_domain")),
      app_name: env.APP_NAME,
      version: env.APP_VERSION,
      card_number: await getSetting(db, "card_number"),
      card_name: await getSetting(db, "card_name"),
      min_deposit: await getSetting(db, "min_deposit", env.MIN_DEPOSIT || "10000"),
      support_text: await getSetting(db, "support_text"),
    });
  }
  if (path === "/api/settings" && method === "POST") {
    const b = await req.json();
    if (b.public_domain != null)
      await setSetting(db, "public_domain", String(b.public_domain).slice(0, 120));
    if (b.card_number != null)
      await setSetting(db, "card_number", String(b.card_number).slice(0, 32));
    if (b.card_name != null)
      await setSetting(db, "card_name", String(b.card_name).slice(0, 64));
    if (b.min_deposit != null)
      await setSetting(db, "min_deposit", String(safeInt(b.min_deposit, 10000)));
    if (b.support_text != null)
      await setSetting(db, "support_text", String(b.support_text).slice(0, 500));
    return json({ ok: true });
  }

  return json({ error: "not_found", path }, 404);
}
