import {
  q,
  ex,
  ensureUser,
  balanceDeductSafe,
  balanceAdd,
  logEvent,
} from "../utils/db.js";
import { nowMs, safeInt } from "../utils/helpers.js";
import { createRemoteAccount, workerAsNode } from "./node.js";

export async function listPlans(db) {
  return q(
    db,
    "SELECT * FROM plans WHERE is_active=1 ORDER BY sort, price, id"
  );
}

export async function getPlan(db, id) {
  return q(db, "SELECT * FROM plans WHERE id=? AND is_active=1", [id], true);
}

export async function applyCoupon(db, code, userId, price) {
  code = String(code || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "کد خالی است" };
  const c = await q(
    db,
    "SELECT * FROM coupons WHERE code=? AND is_active=1",
    [code],
    true
  );
  if (!c) return { ok: false, error: "کد تخفیف نامعتبر است" };
  if (c.expires_at && c.expires_at < nowMs())
    return { ok: false, error: "کد منقضی شده" };
  if (c.max_uses > 0 && c.used >= c.max_uses)
    return { ok: false, error: "ظرفیت کد تمام شده" };
  const used = await q(
    db,
    "SELECT 1 FROM coupon_uses WHERE coupon_id=? AND user_id=?",
    [c.id, userId],
    true
  );
  if (used) return { ok: false, error: "قبلاً از این کد استفاده کرده‌اید" };
  let discount = 0;
  if (c.percent) discount = Math.floor((price * c.percent) / 100);
  if (c.amount_off) discount = Math.max(discount, c.amount_off);
  discount = Math.min(Math.max(0, discount), price);
  return {
    ok: true,
    discount,
    final: price - discount,
    code: c.code,
    coupon_id: c.id,
  };
}

export async function commitCoupon(db, couponId, userId) {
  await ex(db, "UPDATE coupons SET used = used + 1 WHERE id=?", [couponId]);
  try {
    await ex(
      db,
      "INSERT INTO coupon_uses(coupon_id,user_id,ts) VALUES(?,?,?)",
      [couponId, userId, nowMs()]
    );
  } catch {}
}

async function pickNode(db, plan, env) {
  if (plan?.node_id) {
    const n = await q(
      db,
      "SELECT * FROM nodes WHERE id=? AND enable=1",
      [plan.node_id],
      true
    );
    if (n) return n;
  }
  const n = await q(
    db,
    "SELECT * FROM nodes WHERE enable=1 ORDER BY sort, id LIMIT 1",
    [],
    true
  );
  if (n) return n;
  // Default: this Cloudflare Worker as proxy (BPB-style)
  if (env && env.PUBLIC_DOMAIN) return workerAsNode(env);
  return null;
}

export async function purchasePlan(db, env, tgId, planId, couponCode) {
  const plan = await getPlan(db, planId);
  if (!plan) return { ok: false, error: "پلن یافت نشد" };

  const u = await ensureUser(db, tgId);
  if (u.is_blocked) return { ok: false, error: "حساب مسدود است" };

  let final = plan.price;
  let discount = 0;
  let couponId = null;
  if (couponCode) {
    const c = await applyCoupon(db, couponCode, tgId, plan.price);
    if (!c.ok) return c;
    final = c.final;
    discount = c.discount;
    couponId = c.coupon_id;
  }

  const ok = await balanceDeductSafe(
    db,
    tgId,
    final,
    "purchase",
    "پلن " + plan.title
  );
  if (!ok)
    return {
      ok: false,
      error: "موجودی کافی نیست",
      need: final - (u.balance || 0),
    };

  const node = await pickNode(db, plan, env);
  if (!node || !node.public_host) {
    await balanceAdd(db, tgId, final, "refund", "نود فعال نیست");
    return { ok: false, error: "PUBLIC_DOMAIN تنظیم نشده یا نود فعال ندارید." };
  }

  const email = `shop${tgId}-${Date.now().toString(36)}`;
  let acc;
  try {
    acc = await createRemoteAccount(node, {
      email,
      days: plan.days,
      limitGb: plan.limit_gb,
      tgId,
    });
  } catch (e) {
    await balanceAdd(db, tgId, final, "refund", "خطا ساخت اکانت");
    return { ok: false, error: "خطا در ساخت اکانت: " + e.message };
  }

  if (couponId) await commitCoupon(db, couponId, tgId);
  await ex(db, "UPDATE users SET buys_count = buys_count + 1 WHERE tg_id=?", [
    tgId,
  ]);
  await ex(
    db,
    `INSERT INTO accounts(user_id,plan_id,node_id,email,uuid,sub_id,remote_id,limit_bytes,expiry,enable,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tgId,
      plan.id,
      node.id,
      acc.email,
      acc.uuid,
      acc.sub_id,
      acc.remote_id || "",
      acc.limit_bytes,
      acc.expiry,
      1,
      nowMs(),
    ]
  );

  try {
    if (u.ref_by) {
      const pct = safeInt(env.REF_PERCENT, 20);
      const reward = Math.floor((final * pct) / 100);
      if (reward > 0) {
        await balanceAdd(
          db,
          u.ref_by,
          reward,
          "referral",
          "خرید زیرمجموعه " + tgId
        );
        await ex(
          db,
          "UPDATE users SET ref_earnings = ref_earnings + ? WHERE tg_id=?",
          [reward, u.ref_by]
        );
      }
    }
  } catch {}

  await logEvent(db, `خرید tg=${tgId} plan=${plan.title} final=${final}`, "ok");

  const domain = (env.PUBLIC_DOMAIN || "").replace(/\/$/, "");
  const subUrl = domain ? `https://${domain}/sub/${acc.sub_id}` : "";

  return {
    ok: true,
    account: acc,
    plan,
    final,
    discount,
    sub_url: subUrl,
    links: acc.links || [],
    warning: acc.warning || null,
  };
}

export async function giveTrial(db, env, tgId) {
  const u = await ensureUser(db, tgId);
  if (u.is_blocked) return { ok: false, error: "حساب مسدود است" };
  const cool =
    safeInt(env.TRIAL_COOLDOWN_DAYS, 7) * 86400000;
  if (u.trial_last && nowMs() - u.trial_last < cool) {
    return { ok: false, error: "قبلاً تست گرفته‌اید. بعداً تلاش کنید." };
  }
  const days = safeInt(env.TRIAL_DAYS, 1);
  const gb = safeInt(env.TRIAL_GB, 1);
  const node = await pickNode(db, null, env);
  if (!node || !node.public_host) {
    return { ok: false, error: "نود فعال نیست" };
  }
  const email = `trial${tgId}-${Date.now().toString(36)}`;
  const acc = await createRemoteAccount(node, {
    email,
    days,
    limitGb: gb,
    tgId,
  });
  await ex(db, "UPDATE users SET trial_last=? WHERE tg_id=?", [nowMs(), tgId]);
  await ex(
    db,
    `INSERT INTO accounts(user_id,plan_id,node_id,email,uuid,sub_id,remote_id,limit_bytes,expiry,enable,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      tgId,
      null,
      node.id,
      acc.email,
      acc.uuid,
      acc.sub_id,
      acc.remote_id || "",
      acc.limit_bytes,
      acc.expiry,
      1,
      nowMs(),
    ]
  );
  const domain = (env.PUBLIC_DOMAIN || "").replace(/\/$/, "");
  return {
    ok: true,
    account: acc,
    sub_url: domain ? `https://${domain}/sub/${acc.sub_id}` : "",
    links: acc.links || [],
  };
}
