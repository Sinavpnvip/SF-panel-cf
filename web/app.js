const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("sf_token") || "";

async function api(path, opts = {}) {
  const headers = {
    "content-type": "application/json",
    ...(opts.headers || {}),
  };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "error");
  return data;
}

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

async function boot() {
  try {
    const st = await api("/api/status");
    $("authHint").textContent = st.installed
      ? "ورود مدیر — " + (st.version || "")
      : "نصب اولیه پنل";
    if (st.installed) {
      show($("loginBox"), true);
      if (token) {
        try {
          await api("/api/dashboard");
          showApp();
          return;
        } catch {
          token = "";
          localStorage.removeItem("sf_token");
        }
      }
    } else {
      show($("setupBox"), true);
    }
  } catch (e) {
    $("authHint").textContent = "خطا در ارتباط: " + e.message;
  }
}

function showApp() {
  show($("auth"), false);
  show($("app"), true);
  loadDash();
}

$("btnLogin").onclick = async () => {
  $("loginErr").textContent = "";
  try {
    const r = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("user").value.trim(),
        password: $("pass").value,
      }),
    });
    token = r.token;
    localStorage.setItem("sf_token", token);
    showApp();
  } catch (e) {
    $("loginErr").textContent =
      e.message === "invalid" ? "نام کاربری یا رمز اشتباه است" : e.message;
  }
};

$("btnSetup").onclick = async () => {
  $("setupErr").textContent = "";
  if ($("spass").value !== $("spass2").value) {
    $("setupErr").textContent = "رمز و تکرار یکی نیست";
    return;
  }
  try {
    const r = await api("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        username: $("suser").value.trim(),
        password: $("spass").value,
      }),
    });
    token = r.token;
    localStorage.setItem("sf_token", token);
    showApp();
  } catch (e) {
    $("setupErr").textContent = e.message;
  }
};

$("btnOut").onclick = () => {
  token = "";
  localStorage.removeItem("sf_token");
  location.reload();
};

document.querySelectorAll(".nav").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".nav").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("v-" + btn.dataset.v).classList.remove("hidden");
    ({
      dash: loadDash,
      nodes: loadNodes,
      plans: loadPlans,
      users: loadUsers,
      receipts: loadReceipts,
      coupons: loadCoupons,
      accounts: loadAccounts,
      settings: loadSettings,
    })[btn.dataset.v]?.();
  };
});

async function loadDash() {
  const d = await api("/api/dashboard");
  $("stats").innerHTML = [
    ["کاربران", d.users],
    ["اکانت‌ها", d.accounts],
    ["رسید معلق", d.pending_receipts],
    ["نود فعال", d.nodes],
  ]
    .map(
      ([k, v]) =>
        `<div class="stat"><span>${k}</span><b>${v ?? 0}</b></div>`
    )
    .join("");
  $("events").innerHTML = (d.events || [])
    .map((e) => `<li>[${e.level}] ${escapeHtml(e.msg)}</li>`)
    .join("") || "<li>رویدادی نیست</li>";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadNodes() {
  const { nodes } = await api("/api/nodes");
  $("nodesTb").innerHTML = nodes
    .map(
      (n) => `<tr>
      <td>${n.id}</td><td>${escapeHtml(n.name)}</td>
      <td dir="ltr">${escapeHtml(n.public_host)}</td>
      <td dir="ltr">${escapeHtml(n.path_prefix || "")}</td>
      <td dir="ltr">${escapeHtml(n.sni || "—")}</td>
      <td>${escapeHtml(n.security || "tls")}</td>
      <td>${
        n.enable
          ? `<button class="btn sm ghost" onclick="delNode(${n.id})">خاموش</button>`
          : "⛔"
      }</td></tr>`
    )
    .join("");
}

window.delNode = async (id) => {
  await api("/api/nodes/" + id, { method: "DELETE" });
  loadNodes();
};

$("btnAddNode").onclick = async () => {
  await api("/api/nodes", {
    method: "POST",
    body: JSON.stringify({
      name: $("nName").value,
      public_host: $("nHost").value,
      port: $("nPort").value,
      transport: $("nTransport").value,
      path_prefix: $("nPath").value,
      sni: $("nSni").value || $("nHost").value,
      host_header: $("nHH").value || $("nHost").value,
      security: $("nSec").value,
      fingerprint: $("nFp").value,
      alpn: $("nAlpn").value,
      api_url: $("nApi").value,
      api_token: $("nTok").value,
    }),
  });
  loadNodes();
};

async function loadPlans() {
  const { plans } = await api("/api/plans");
  $("plansTb").innerHTML = plans
    .map(
      (p) => `<tr>
      <td>${p.id}</td><td>${escapeHtml(p.title)}</td>
      <td>${p.days}</td><td>${p.limit_gb}</td><td>${p.price}</td>
      <td>${
        p.is_active
          ? `<button class="btn sm ghost" onclick="delPlan(${p.id})">حذف</button>`
          : "⛔"
      }</td></tr>`
    )
    .join("");
}
window.delPlan = async (id) => {
  await api("/api/plans/" + id, { method: "DELETE" });
  loadPlans();
};
$("btnAddPlan").onclick = async () => {
  await api("/api/plans", {
    method: "POST",
    body: JSON.stringify({
      title: $("pTitle").value,
      days: $("pDays").value,
      limit_gb: $("pGb").value,
      price: $("pPrice").value,
    }),
  });
  loadPlans();
};

async function loadUsers() {
  const { users } = await api("/api/users");
  $("usersTb").innerHTML = users
    .map(
      (u) => `<tr>
      <td>${u.tg_id}</td><td>@${escapeHtml(u.username || "")}</td>
      <td>${u.balance}</td><td>${u.buys_count}</td>
      <td>${
        u.is_blocked
          ? '<span class="badge err">مسدود</span>'
          : '<span class="badge ok">فعال</span>'
      }</td>
      <td>${
        u.is_blocked
          ? `<button class="btn sm" onclick="userAct(${u.tg_id},'unblock')">رفع</button>`
          : `<button class="btn sm danger" onclick="userAct(${u.tg_id},'block')">مسدود</button>`
      }</td></tr>`
    )
    .join("");
}
window.userAct = async (id, action) => {
  await api("/api/users/" + id, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  loadUsers();
};

async function loadReceipts() {
  const { receipts } = await api("/api/receipts");
  $("rcpsTb").innerHTML = receipts
    .map((r) => {
      const act =
        r.status === "pending"
          ? `<button class="btn sm" onclick="rcp(${r.id},'approve')">تایید</button>
             <button class="btn sm ghost" onclick="rcp(${r.id},'reject')">رد</button>`
          : `<span class="badge ${
              r.status === "approved" ? "ok" : "err"
            }">${r.status}</span>`;
      return `<tr><td>${r.id}</td><td>${r.user_id}</td><td>${r.amount}</td><td>${r.status}</td><td>${act}</td></tr>`;
    })
    .join("");
}
window.rcp = async (id, action) => {
  await api("/api/receipts/" + id, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
  loadReceipts();
};

async function loadCoupons() {
  const { coupons } = await api("/api/coupons");
  $("couponsTb").innerHTML = coupons
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.code)}</td><td>${c.percent}</td><td>${c.used}/${
          c.max_uses || "∞"
        }</td></tr>`
    )
    .join("");
}
$("btnAddCoupon").onclick = async () => {
  await api("/api/coupons", {
    method: "POST",
    body: JSON.stringify({
      code: $("cCode").value,
      percent: $("cPct").value,
      max_uses: $("cMax").value,
    }),
  });
  loadCoupons();
};

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  $("accTb").innerHTML = accounts
    .map(
      (a) => `<tr>
      <td>${a.id}</td><td>${a.user_id}</td>
      <td>${escapeHtml(a.email)}</td><td dir="ltr">${escapeHtml(a.sub_id)}</td>
      <td>${a.expiry ? new Date(a.expiry).toLocaleDateString("fa-IR") : "—"}</td>
    </tr>`
    )
    .join("");
}

async function loadSettings() {
  const s = await api("/api/settings");
  $("setDomain").value = s.public_domain || "";
  $("setCard").value = s.card_number || "";
  $("setCardName").value = s.card_name || "";
  $("setMinDep").value = s.min_deposit || "10000";
  $("setSupport").value = s.support_text || "";
}
$("btnSaveSet").onclick = async () => {
  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      public_domain: $("setDomain").value.trim(),
      card_number: $("setCard").value.trim(),
      card_name: $("setCardName").value.trim(),
      min_deposit: $("setMinDep").value,
      support_text: $("setSupport").value.trim(),
    }),
  });
  $("setMsg").textContent = "✅ ذخیره شد — در ربات کارت به خریدار نشان داده می‌شود";
};

boot();
