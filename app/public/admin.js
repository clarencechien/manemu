"use strict";
const $ = (id) => document.getElementById(id);
let DATA = null;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mins = (sec) => (Number(sec) === 0 ? "無上限" : `${Math.round(Number(sec) / 60)} 分/日`);

function tierLabel(value) {
  const isNum = /^\d+$/.test(String(value));
  const cls = isNum ? "custom" : (value === "admin" ? "admin" : "");
  const limit = isNum ? Number(value) : DATA.tiers[value];
  const detail = limit === undefined ? "級別未定義" : mins(limit);
  return `<span class="tier ${cls}">${esc(isNum ? "自訂" : value)}</span> <span class="ts">${detail}</span>`;
}

function tierOptions(selected) {
  return Object.keys(DATA.tiers).map((t) =>
    `<option value="${esc(t)}"${t === selected ? " selected" : ""}>${esc(t)} · ${mins(DATA.tiers[t])}</option>`).join("");
}

function render() {
  // 等候名單
  $("waitCount").textContent = DATA.waitlist.length ? `(${DATA.waitlist.length})` : "";
  $("waitBox").innerHTML = DATA.waitlist.length === 0
    ? `<p class="empty">目前沒有人在等候。有人用不在名單內的 Google 帳號登入,就會自動出現在這裡。</p>`
    : `<table><thead><tr><th>EMAIL</th><th>申請時間</th><th>動作</th></tr></thead><tbody>${
        DATA.waitlist.map((w) => `<tr>
          <td class="email">${esc(w.email)}</td>
          <td class="ts">${esc(String(w.ts).replace("T", " ").slice(0, 16))}</td>
          <td><div class="row-actions">
            <select data-approve-tier="${esc(w.email)}">${tierOptions(DATA.defaultTier)}</select>
            <button class="primary" data-approve="${esc(w.email)}">核准</button>
            <button class="danger" data-wait-remove="${esc(w.email)}">忽略</button>
          </div></td></tr>`).join("")}</tbody></table>`;

  // 已核准
  const entries = Object.entries(DATA.allowlist).sort((a, b) => a[0].localeCompare(b[0]));
  $("allowCount").textContent = entries.length ? `(${entries.length})` : "";
  $("allowBox").innerHTML = entries.length === 0
    ? `<p class="empty">名單是空的。</p>`
    : `<table><thead><tr><th>EMAIL</th><th>額度</th><th>動作</th></tr></thead><tbody>${
        entries.map(([email, tier]) => {
          const isAdminVar = DATA.admins.includes(email);
          return `<tr>
            <td class="email">${esc(email)}${isAdminVar ? ' <span class="tier admin">ADMIN_EMAILS</span>' : ""}</td>
            <td>${tierLabel(tier)}</td>
            <td><div class="row-actions">
              <select data-change-tier="${esc(email)}">${tierOptions(String(tier))}</select>
              <button data-change="${esc(email)}">改額度</button>
              ${isAdminVar ? "" : `<button class="danger" data-remove="${esc(email)}">移除</button>`}
            </div></td></tr>`;
        }).join("")}</tbody></table>`;

  $("addTier").innerHTML = tierOptions(DATA.defaultTier);
  $("tierHint").textContent = `級別定義在 QUOTA_TIERS 變數:` +
    Object.entries(DATA.tiers).map(([t, s]) => `${t}=${mins(s)}`).join("、") +
    `。填「自訂秒數」會覆蓋級別選單(例:3600 = 60 分/日)。名單改動立即生效,不用重部署。`;
}

async function reload() { DATA = await api("/api/admin/data"); render(); }

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.approve) {
      const tier = document.querySelector(`[data-approve-tier="${CSS.escape(b.dataset.approve)}"]`).value;
      await api("/api/admin/allow", { email: b.dataset.approve, tier });
      toast(`已核准 ${b.dataset.approve}(${tier})`);
      await reload();
    } else if (b.dataset.waitRemove) {
      await api("/api/admin/waitlist-remove", { email: b.dataset.waitRemove });
      toast("已從等候名單移除"); await reload();
    } else if (b.dataset.change) {
      const tier = document.querySelector(`[data-change-tier="${CSS.escape(b.dataset.change)}"]`).value;
      await api("/api/admin/allow", { email: b.dataset.change, tier });
      toast(`${b.dataset.change} → ${tier}`); await reload();
    } else if (b.dataset.remove) {
      if (!confirm(`確定把 ${b.dataset.remove} 移出名單?他下一次操作就會被擋下。`)) return;
      await api("/api/admin/remove", { email: b.dataset.remove });
      toast("已移除"); await reload();
    }
  } catch (err) { toast("失敗:" + err.message); }
});

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("addEmail").value.trim();
  const custom = $("addCustom").value.trim();
  const tier = custom || $("addTier").value;
  try {
    await api("/api/admin/allow", { email, tier });
    toast(`已加入 ${email}`);
    $("addEmail").value = ""; $("addCustom").value = "";
    await reload();
  } catch (err) { toast("失敗:" + err.message); }
});

(async function boot() {
  let me = null;
  try { const r = await fetch("/api/me"); if (r.ok) me = await r.json(); } catch {}
  if (!me) { $("gate").innerHTML = `請先 <a href="/auth/login">登入</a>。`; return; }
  if (!me.isAdmin) { $("gate").textContent = `${me.email} 沒有管理權限。`; return; }
  $("whoami").textContent = me.email;
  try {
    await reload();
    $("gate").hidden = true; $("main").hidden = false;
  } catch (err) { $("gate").textContent = "讀取失敗:" + err.message; }
})();
