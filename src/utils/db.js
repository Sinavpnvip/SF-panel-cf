import { nowMs, refCode } from "./helpers.js";

export async function q(db, sql, params = [], one = false) {
  const stmt = db.prepare(sql).bind(...params);
  if (one) {
    return (await stmt.first()) || null;
  }
  const { results } = await stmt.all();
  return results || [];
}

export async function ex(db, sql, params = []) {
  const r = await db.prepare(sql).bind(...params).run();
  return {
    changes: r.meta?.changes || 0,
    lastRowId: r.meta?.last_row_id || 0,
  };
}

export async function getSetting(db, k, def = "") {
  const r = await q(db, "SELECT v FROM settings WHERE k=?", [k], true);
  return r ? r.v : def;
}

export async function setSetting(db, k, v) {
  await ex(
    db,
    "INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
    [k, String(v)]
  );
}

export async function logEvent(db, msg, level = "info") {
  try {
    await ex(db, "INSERT INTO events(level,msg,ts) VALUES(?,?,?)", [
      level,
      String(msg).slice(0, 2000),
      nowMs(),
    ]);
  } catch {}
}

export async function ensureUser(db, tgId, username = "") {
  tgId = Number(tgId);
  let u = await q(db, "SELECT * FROM users WHERE tg_id=?", [tgId], true);
  if (!u) {
    let code = refCode();
    for (let i = 0; i < 5; i++) {
      const exists = await q(
        db,
        "SELECT tg_id FROM users WHERE ref_code=?",
        [code],
        true
      );
      if (!exists) break;
      code = refCode();
    }
    await ex(
      db,
      "INSERT INTO users(tg_id,username,ref_code,joined_at) VALUES(?,?,?,?)",
      [tgId, String(username || "").slice(0, 64), code, nowMs()]
    );
    u = await q(db, "SELECT * FROM users WHERE tg_id=?", [tgId], true);
  } else if (username && username !== (u.username || "")) {
    await ex(db, "UPDATE users SET username=? WHERE tg_id=?", [
      String(username).slice(0, 64),
      tgId,
    ]);
    u.username = username;
  }
  return u;
}

export async function balanceAdd(db, tgId, amount, kind, note = "") {
  amount = Number(amount) || 0;
  await ex(db, "UPDATE users SET balance = balance + ? WHERE tg_id=?", [
    amount,
    tgId,
  ]);
  await ex(
    db,
    "INSERT INTO transactions(user_id,kind,amount,note,ts) VALUES(?,?,?,?,?)",
    [tgId, kind, amount, String(note).slice(0, 200), nowMs()]
  );
}

export async function balanceDeductSafe(db, tgId, amount, kind, note = "") {
  amount = Number(amount) || 0;
  if (amount <= 0) return true;
  const r = await db
    .prepare(
      "UPDATE users SET balance = balance - ? WHERE tg_id=? AND balance >= ?"
    )
    .bind(amount, tgId, amount)
    .run();
  if (!r.meta?.changes) return false;
  await ex(
    db,
    "INSERT INTO transactions(user_id,kind,amount,note,ts) VALUES(?,?,?,?,?)",
    [tgId, kind, -amount, String(note).slice(0, 200), nowMs()]
  );
  return true;
}
