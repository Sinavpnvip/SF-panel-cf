import { q, ex, ensureUser, balanceAdd, logEvent } from "../utils/db.js";
import { esc, toman, nowMs, trimTg, safeInt } from "../utils/helpers.js";
import {
  listPlans,
  purchasePlan,
  giveTrial,
  applyCoupon,
} from "../services/shop.js";

async function getState(env, tg) {
  try {
    if (!env.KV) return null;
    const raw = await env.KV.get("st:" + tg);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
async function setState(env, tg, st) {
  try {
    if (env.KV)
      await env.KV.put("st:" + tg, JSON.stringify(st), { expirationTtl: 1800 });
  } catch {}
}
async function clearState(env, tg) {
  try {
    if (env.KV) await env.KV.delete("st:" + tg);
  } catch {}
}

export async function tgApi(token, method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return res.json().catch(() => ({}));
}

export async function sendMessage(token, chatId, text, reply_markup) {
  const body = {
    chat_id: chatId,
    text: trimTg(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (reply_markup) body.reply_markup = reply_markup;
  return tgApi(token, "sendMessage", body);
}

export async function sendPhoto(token, chatId, fileId, caption, reply_markup) {
  const body = {
    chat_id: chatId,
    photo: fileId,
    caption: trimTg(caption || "", 1000),
    parse_mode: "HTML",
  };
  if (reply_markup) body.reply_markup = reply_markup;
  return tgApi(token, "sendPhoto", body);
}

export async function sendDocument(token, chatId, fileId, caption, reply_markup) {
  const body = {
    chat_id: chatId,
    document: fileId,
    caption: trimTg(caption || "", 1000),
    parse_mode: "HTML",
  };
  if (reply_markup) body.reply_markup = reply_markup;
  return tgApi(token, "sendDocument", body);
}

async function getPaySettings(db, env) {
  const card =
    (await q(db, "SELECT v FROM settings WHERE k='card_number'", [], true))?.v ||
    "";
  const name =
    (await q(db, "SELECT v FROM settings WHERE k='card_name'", [], true))?.v ||
    "";
  const minD =
    (await q(db, "SELECT v FROM settings WHERE k='min_deposit'", [], true))?.v ||
    env.MIN_DEPOSIT ||
    "10000";
  return { card, name, minD: safeInt(minD, 10000) };
}

function mainKb() {
  return {
    inline_keyboard: [
      [
        { text: "🛒 خرید اشتراک", callback_data: "shop" },
        { text: "📦 اشتراک‌های من", callback_data: "mysubs" },
      ],
      [
        { text: "👤 پروفایل", callback_data: "profile" },
        { text: "💳 کیف پول", callback_data: "wallet" },
      ],
      [
        { text: "🎁 اکانت تست", callback_data: "trial" },
        { text: "🤝 دعوت دوستان", callback_data: "referral" },
      ],
      [
        { text: "💬 پشتیبانی", callback_data: "support" },
        { text: "📖 راهنما", callback_data: "help" },
      ],
    ],
  };
}

function adminIds(env) {
  return String(env.TG_ADMIN_IDS || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => n > 0);
}

function isAdmin(env, tg) {
  return adminIds(env).includes(Number(tg));
}

export async function handleUpdate(env, db, update) {
  const token = env.TG_BOT_TOKEN;
  if (!token) return;

  try {
    if (update.callback_query) {
      await handleCb(env, db, token, update.callback_query);
      return;
    }
    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chat = msg.chat.id;
    const text = (msg.text || "").trim();
    const username = (msg.from && msg.from.username) || "";

    // ignore group noise unless admin command
    if (msg.chat && msg.chat.type && msg.chat.type !== "private") {
      if (!text.startsWith("/")) return;
    }

    if (msg.photo || msg.document) {
      await handleMedia(env, db, token, msg, chat);
      return;
    }
    if (!text) return;

    const first = text.split(/\s+/)[0] || "";
    const low = first.split("@")[0].toLowerCase();
    const parts = text.split(/\s+/);
    const args = parts.slice(1);

    if (low === "/start") {
      let ref = (args[0] || "").trim().toLowerCase();
      if (ref.includes("=")) ref = ref.split("=").pop();
      const u = await ensureUser(db, chat, username);
      if (u.is_blocked) {
        await sendMessage(token, chat, "⛔ حساب شما مسدود است.");
        return;
      }
      if (ref && /^r[0-9a-f]{6}$/i.test(ref) && !u.ref_by) {
        const inv = await q(
          db,
          "SELECT tg_id FROM users WHERE ref_code=?",
          [ref.toLowerCase()],
          true
        );
        if (inv && Number(inv.tg_id) !== Number(chat)) {
          await ex(db, "UPDATE users SET ref_by=? WHERE tg_id=?", [
            inv.tg_id,
            chat,
          ]);
          try {
            await sendMessage(
              token,
              inv.tg_id,
              "🎉 یک نفر با لینک دعوت تو وارد ربات شد!"
            );
          } catch {}
        }
      }
      const title = env.APP_NAME || "SF VPN Shop";
      await sendMessage(
        token,
        chat,
        `👋 به <b>${esc(title)}</b> خوش آمدید\nآیدی شما: <code>${chat}</code>\nاز منوی زیر استفاده کنید.`,
        mainKb()
      );
      return;
    }

    if (low === "/cancel") {
      await clearState(env, chat);
      await sendMessage(token, chat, "لغو شد.", mainKb());
      return;
    }

    if (low === "/panel" || low === "/admin") {
      if (!isAdmin(env, chat)) {
        await sendMessage(token, chat, "⛔ فقط مدیران");
        return;
      }
      await sendAdminPanel(env, db, token, chat);
      return;
    }

    if (low === "/help") {
      await sendMessage(
        token,
        chat,
        "📖 <b>راهنما</b>\n• خرید از منو\n• شارژ با رسید\n• تست رایگان\n• دعوت دوستان = پاداش\n• /start منوی اصلی",
        mainKb()
      );
      return;
    }

    const st = await getState(env, Number(chat));
    if (st) {
      await handleState(env, db, token, chat, text, st);
      return;
    }

    await sendMessage(
      token,
      chat,
      "از منوی زیر استفاده کنید یا /start بزنید.",
      mainKb()
    );
  } catch (e) {
    await logEvent(db, "tg error: " + (e.message || e), "err");
  }
}

async function handleCb(env, db, token, cbq) {
  const chat = cbq.message?.chat?.id;
  if (!chat) return;
  const data = cbq.data || "";
  const tg = Number(chat);
  try {
    await tgApi(token, "answerCallbackQuery", {
      callback_query_id: cbq.id,
    });
  } catch {}

  const u = await ensureUser(db, tg, (cbq.from && cbq.from.username) || "");
  if (u.is_blocked) {
    await sendMessage(token, chat, "⛔ مسدود");
    return;
  }

  if (data === "menu") {
    await sendMessage(token, chat, "منوی اصلی:", mainKb());
    return;
  }
  if (data === "profile") {
    const refs = await q(
      db,
      "SELECT COUNT(*) n FROM users WHERE ref_by=?",
      [tg],
      true
    );
    await sendMessage(
      token,
      chat,
      `👤 <b>پروفایل</b>\nآیدی: <code>${tg}</code>\nموجودی: <b>${toman(
        u.balance
      )}</b>\nخریدها: ${u.buys_count || 0}\nدعوت‌ها: ${refs?.n || 0}`,
      mainKb()
    );
    return;
  }
  if (data === "wallet") {
    const pay = await getPaySettings(db, env);
    await setState(env, tg, { step: "deposit_amount", data: {} });
    await sendMessage(
      token,
      chat,
      `💳 <b>افزایش موجودی</b>\n\nموجودی فعلی: <b>${toman(
        u.balance
      )}</b>\nحداقل واریز: <b>${toman(
        pay.minD
      )}</b>\n\nمبلغ را به تومان بفرستید.\n/cancel انصراف`
    );
    return;
  }
  if (data === "shop") {
    const plans = await listPlans(db);
    if (!plans.length) {
      await sendMessage(token, chat, "پلنی فعال نیست.", mainKb());
      return;
    }
    const rows = plans.map((p) => [
      {
        text: `${p.title} — ${toman(p.price)}`,
        callback_data: "buy:" + p.id,
      },
    ]);
    rows.push([{ text: "🔙 منو", callback_data: "menu" }]);
    await sendMessage(token, chat, "🛒 یک پلن انتخاب کنید:", {
      inline_keyboard: rows,
    });
    return;
  }
  if (data.startsWith("buy:")) {
    const pid = safeInt(data.split(":")[1]);
    const p = await q(db, "SELECT * FROM plans WHERE id=?", [pid], true);
    if (!p || !p.is_active) {
      await sendMessage(token, chat, "پلن یافت نشد");
      return;
    }
    await setState(env, tg, { step: "buy_confirm", data: { plan_id: pid } });
    await sendMessage(
      token,
      chat,
      `پلن: <b>${esc(p.title)}</b>\nمدت: ${p.days} روز · حجم: ${
        p.limit_gb
      } گیگ\nقیمت: ${toman(p.price)}\nموجودی شما: ${toman(
        u.balance
      )}\n\nکد تخفیف دارید؟ بفرستید یا تایید کنید.`,
      {
        inline_keyboard: [
          [{ text: "✅ پرداخت", callback_data: "pay:" + pid }],
          [{ text: "🔙", callback_data: "shop" }],
        ],
      }
    );
    return;
  }
  if (data.startsWith("pay:")) {
    const pid = safeInt(data.split(":")[1]);
    const st = (await getState(env, tg)) || { data: {} };
    const r = await purchasePlan(db, env, tg, pid, st.data?.coupon);
    await clearState(env, tg);
    if (!r.ok) {
      await sendMessage(token, chat, "❌ " + (r.error || "خطا"), mainKb());
      return;
    }
    let msg = `✅ خرید انجام شد\nپلن: ${esc(r.plan.title)}\nمبلغ: ${toman(
      r.final
    )}\n`;
    if (r.sub_url) msg += `\n🔗 ساب:\n<code>${esc(r.sub_url)}</code>\n`;
    if (r.links?.[0])
      msg += `\n📄 کانفیگ:\n<code>${esc(r.links[0])}</code>`;
    if (r.warning) msg += `\n\n⚠️ ${esc(r.warning)}`;
    await sendMessage(token, chat, msg, mainKb());
    return;
  }
  if (data === "mysubs") {
    const rows = await q(
      db,
      "SELECT * FROM accounts WHERE user_id=? ORDER BY id DESC LIMIT 20",
      [tg]
    );
    if (!rows.length) {
      await sendMessage(token, chat, "اشتراکی ندارید.", mainKb());
      return;
    }
    const domain = (env.PUBLIC_DOMAIN || "").replace(/\/$/, "");
    let t = "📦 <b>اشتراک‌های شما</b>\n";
    for (const a of rows) {
      const sub = domain
        ? `https://${domain}/sub/${a.sub_id}`
        : a.sub_id;
      t += `\n• <code>${esc(a.email)}</code>\n  <code>${esc(sub)}</code>\n`;
    }
    await sendMessage(token, chat, t, mainKb());
    return;
  }
  if (data === "trial") {
    const r = await giveTrial(db, env, tg);
    if (!r.ok) {
      await sendMessage(token, chat, "❌ " + r.error, mainKb());
      return;
    }
    let msg = "🎁 اکانت تست آماده شد\n";
    if (r.sub_url) msg += `\n<code>${esc(r.sub_url)}</code>`;
    if (r.links?.[0]) msg += `\n<code>${esc(r.links[0])}</code>`;
    await sendMessage(token, chat, msg, mainKb());
    return;
  }
  if (data === "referral") {
    const me = await q(db, "SELECT * FROM users WHERE tg_id=?", [tg], true);
    const botInfo = await tgApi(token, "getMe", {});
    const bu = botInfo.result?.username || "";
    const link = bu
      ? `https://t.me/${bu}?start=${me.ref_code}`
      : me.ref_code;
    await sendMessage(
      token,
      chat,
      `🤝 لینک دعوت:\n<code>${esc(link)}</code>\n\nبا هر خرید زیرمجموعه ${
        env.REF_PERCENT || 20
      }٪ پاداش می‌گیرید.`,
      mainKb()
    );
    return;
  }
  if (data === "support") {
    await setState(env, tg, { step: "support", data: {} });
    await sendMessage(token, chat, "پیام پشتیبانی را بنویسید:\n/cancel انصراف");
    return;
  }
  if (data === "help") {
    await sendMessage(
      token,
      chat,
      "📖 خرید، کیف پول، تست و دعوت از منوی اصلی.",
      mainKb()
    );
    return;
  }
  if (data.startsWith("adm:")) {
    if (!isAdmin(env, tg)) return;
    await handleAdminCb(env, db, token, chat, data);
  }
}

async function handleState(env, db, token, chat, text, st) {
  const tg = Number(chat);
  if (text === "/cancel") {
    await clearState(env, tg);
    await sendMessage(token, chat, "لغو شد.", mainKb());
    return;
  }
  if (st.step === "deposit_amount") {
    const amount = safeInt(text);
    const pay = await getPaySettings(db, env);
    const min = pay.minD;
    if (!amount || amount < min) {
      await sendMessage(token, chat, "مبلغ نامعتبر. حداقل " + toman(min));
      return;
    }
    if (amount > 500000000) {
      await sendMessage(token, chat, "مبلغ بیش از حد مجاز است.");
      return;
    }
    await setState(env, tg, { step: "deposit_receipt", data: { amount } });
    const cardLine = pay.card
      ? `💳 شماره کارت:\n<code>${esc(pay.card)}</code>\n`
      : "⚠️ کارت هنوز توسط ادمین تنظیم نشده.\n";
    const nameLine = pay.name
      ? `👤 به نام: <b>${esc(pay.name)}</b>\n`
      : "";
    await sendMessage(
      token,
      chat,
      `✅ مبلغ: <b>${toman(amount)}</b>\n\n` +
        cardLine +
        nameLine +
        `\nپس از واریز، <b>عکس یا فایل رسید</b> را همین‌جا بفرست.\n/cancel انصراف`
    );
    return;
  }
  if (st.step === "buy_confirm") {
    const code = text.trim().toUpperCase();
    const p = await q(
      db,
      "SELECT * FROM plans WHERE id=?",
      [st.data.plan_id],
      true
    );
    if (!p) {
      await clearState(env, tg);
      return;
    }
    const c = await applyCoupon(db, code, tg, p.price);
    if (!c.ok) {
      await sendMessage(token, chat, "❌ " + c.error);
      return;
    }
    st.data.coupon = code;
    await setState(env, tg, st);
    await sendMessage(
      token,
      chat,
      `تخفیف: ${toman(c.discount)}\nمبلغ نهایی: <b>${toman(c.final)}</b>`,
      {
        inline_keyboard: [
          [{ text: "✅ پرداخت", callback_data: "pay:" + p.id }],
          [{ text: "🔙", callback_data: "shop" }],
        ],
      }
    );
    return;
  }
  if (st.step === "support") {
    await clearState(env, tg);
    const body = text.slice(0, 2000);
    await ex(
      db,
      "INSERT INTO tickets(user_id,subject,status,created_at) VALUES(?,?,?,?)",
      [tg, body.slice(0, 80), "open", nowMs()]
    );
    const tick = await q(
      db,
      "SELECT id FROM tickets WHERE user_id=? ORDER BY id DESC LIMIT 1",
      [tg],
      true
    );
    if (tick) {
      await ex(
        db,
        "INSERT INTO ticket_msgs(ticket_id,sender,body,ts) VALUES(?,?,?,?)",
        [tick.id, "user", body, nowMs()]
      );
    }
    await sendMessage(token, chat, "✅ پیام ثبت شد.", mainKb());
    for (const aid of adminIds(env)) {
      try {
        await sendMessage(
          token,
          aid,
          `💬 تیکت از <code>${tg}</code>:\n${esc(body)}`
        );
      } catch {}
    }
  }
}

async function handleMedia(env, db, token, msg, chat) {
  const tg = Number(chat);
  const st = await getState(env, tg);
  if (!st || st.step !== "deposit_receipt") {
    await sendMessage(
      token,
      chat,
      "برای شارژ اول از کیف پول مبلغ را وارد کنید.",
      mainKb()
    );
    return;
  }
  const amount = st.data.amount;
  let fileId = "";
  let isPhoto = false;
  if (msg.photo?.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    isPhoto = true;
  } else if (msg.document) {
    fileId = msg.document.file_id;
  }
  if (!fileId) {
    await sendMessage(token, chat, "فایل معتبر نبود. دوباره عکس رسید را بفرست.");
    return;
  }
  await ex(
    db,
    "INSERT INTO receipts(user_id,amount,file_id,status,ts) VALUES(?,?,?,?,?)",
    [tg, amount, fileId, "pending", nowMs()]
  );
  const row = await q(
    db,
    "SELECT id FROM receipts WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1",
    [tg],
    true
  );
  const rid = row?.id || 0;
  await clearState(env, tg);
  await sendMessage(
    token,
    chat,
    "✅ رسید شما ثبت شد و برای ادمین ارسال شد.\nپس از تایید، موجودی اضافه می‌شود.",
    mainKb()
  );
  const uname = (msg.from && msg.from.username) || "—";
  const caption =
    `🧾 <b>رسید #${rid}</b>\n\n` +
    `👤 کاربر: <code>${tg}</code> @${esc(uname)}\n` +
    `💰 مبلغ: <b>${toman(amount)}</b>\n` +
    `⏰ ${new Date().toLocaleString("fa-IR")}`;
  const kb = {
    inline_keyboard: [
      [
        { text: "✅ تایید", callback_data: "adm:rok:" + rid },
        { text: "❌ رد", callback_data: "adm:rno:" + rid },
      ],
    ],
  };
  for (const aid of adminIds(env)) {
    try {
      if (isPhoto) await sendPhoto(token, aid, fileId, caption, kb);
      else await sendDocument(token, aid, fileId, caption, kb);
    } catch (e) {
      try {
        await sendMessage(token, aid, caption + "\n(فایل ارسال نشد)", kb);
      } catch {}
    }
  }
}

async function sendAdminPanel(env, db, token, chat) {
  const pending = await q(
    db,
    "SELECT COUNT(*) n FROM receipts WHERE status='pending'",
    [],
    true
  );
  const users = await q(db, "SELECT COUNT(*) n FROM users", [], true);
  await sendMessage(
    token,
    chat,
    `👑 <b>پنل ادمین</b>\nکاربران: ${users?.n || 0}\nرسید معلق: ${
      pending?.n || 0
    }`,
    {
      inline_keyboard: [
        [
          { text: "🧾 رسیدها", callback_data: "adm:rcps" },
          { text: "📊 آمار", callback_data: "adm:stats" },
        ],
        [
          { text: "👥 کاربران", callback_data: "adm:users" },
          { text: "📦 پلن‌ها", callback_data: "adm:plans" },
        ],
        [
          { text: "🖥 نودها", callback_data: "adm:nodes" },
          { text: "🔙 منو", callback_data: "menu" },
        ],
      ],
    }
  );
}

async function handleAdminCb(env, db, token, chat, data) {
  if (data === "adm:rcps") {
    const rows = await q(
      db,
      "SELECT * FROM receipts WHERE status='pending' ORDER BY id DESC LIMIT 15"
    );
    if (!rows.length) {
      await sendMessage(token, chat, "رسید معلقی نیست.");
      return;
    }
    for (const r of rows) {
      await sendMessage(
        token,
        chat,
        `رسید #${r.id}\nکاربر: <code>${r.user_id}</code>\nمبلغ: ${toman(
          r.amount
        )}`,
        {
          inline_keyboard: [
            [
              { text: "✅ تایید", callback_data: "adm:rok:" + r.id },
              { text: "❌ رد", callback_data: "adm:rno:" + r.id },
            ],
          ],
        }
      );
    }
    return;
  }
  if (data.startsWith("adm:rok:")) {
    const id = safeInt(data.split(":")[2]);
    const r = await q(db, "SELECT * FROM receipts WHERE id=?", [id], true);
    if (!r || r.status !== "pending") return;
    await ex(db, "UPDATE receipts SET status='approved' WHERE id=?", [id]);
    await balanceAdd(db, r.user_id, r.amount, "deposit", "رسید #" + id);
    await sendMessage(token, chat, "✅ تایید شد");
    try {
      await sendMessage(
        token,
        r.user_id,
        `✅ رسید تایید شد. +${toman(r.amount)}`
      );
    } catch {}
    return;
  }
  if (data.startsWith("adm:rno:")) {
    const id = safeInt(data.split(":")[2]);
    await ex(db, "UPDATE receipts SET status='rejected' WHERE id=?", [id]);
    const r = await q(db, "SELECT * FROM receipts WHERE id=?", [id], true);
    await sendMessage(token, chat, "رد شد");
    if (r) {
      try {
        await sendMessage(token, r.user_id, "❌ رسید شما رد شد.");
      } catch {}
    }
    return;
  }
  if (data === "adm:stats") {
    const u = await q(db, "SELECT COUNT(*) n FROM users", [], true);
    const a = await q(db, "SELECT COUNT(*) n FROM accounts", [], true);
    const t = await q(
      db,
      "SELECT COALESCE(SUM(ABS(amount)),0) s FROM transactions WHERE kind='purchase'",
      [],
      true
    );
    await sendMessage(
      token,
      chat,
      `📊 کاربران: ${u?.n || 0}\nاکانت‌ها: ${a?.n || 0}\nحجم فروش: ${toman(
        t?.s || 0
      )}`
    );
    return;
  }
  if (data === "adm:users") {
    const rows = await q(
      db,
      "SELECT * FROM users ORDER BY joined_at DESC LIMIT 25"
    );
    let t = "👥 آخرین کاربران\n";
    for (const r of rows) {
      t += `\n<code>${r.tg_id}</code> ${toman(r.balance)} @${esc(
        r.username || ""
      )}${r.is_blocked ? " ⛔" : ""}`;
    }
    await sendMessage(token, chat, t);
    return;
  }
  if (data === "adm:plans") {
    const rows = await q(db, "SELECT * FROM plans ORDER BY sort, id");
    let t = "📦 پلن‌ها\n";
    for (const p of rows) {
      t += `\n#${p.id} ${esc(p.title)} ${toman(p.price)} ${
        p.is_active ? "✅" : "⛔"
      }`;
    }
    await sendMessage(token, chat, t || "خالی");
    return;
  }
  if (data === "adm:nodes") {
    const rows = await q(db, "SELECT * FROM nodes ORDER BY sort, id");
    let t = "🖥 نودها\n";
    for (const n of rows) {
      t += `\n#${n.id} ${esc(n.name)}\n  host: <code>${esc(
        n.public_host
      )}</code>\n  path: ${esc(n.path_prefix || "")} sni: ${esc(
        n.sni || "—"
      )} ${n.enable ? "✅" : "⛔"}`;
    }
    await sendMessage(token, chat, t || "نودی نیست — از پنل وب اضافه کنید");
  }
}
