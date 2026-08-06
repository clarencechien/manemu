// Admin API:名單/等候名單管理(僅 ADMIN_EMAILS 內的帳號可用)。
// 所有資料存 R2:allowlist.json(email→tier|秒數)、waitlist.json(email→{ts})。
const CONFIG_KEYS = { allow: "allowlist.json", wait: "waitlist.json" };

async function readJson(env, key, fallback) {
  try {
    const obj = await env.CONFIG.get(key);
    return obj ? await obj.json() : fallback;
  } catch { return fallback; }
}
const writeJson = (env, key, data) =>
  env.CONFIG.put(key, JSON.stringify(data, null, 2), { httpMetadata: { contentType: "application/json" } });

// 名單統一成物件格式(舊的陣列格式自動升級)
async function readAllow(env) {
  const data = await readJson(env, CONFIG_KEYS.allow, {});
  if (Array.isArray(data)) {
    return Object.fromEntries(data.map((e) => [String(e).toLowerCase(), env.DEFAULT_TIER || "beta"]));
  }
  return Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k.toLowerCase(), v]));
}

// 未通過白名單的登入 → 記進等候名單(登入流程用,非 admin 端點)
export async function addToWaitlist(email, env) {
  const lower = String(email).toLowerCase();
  const wait = await readJson(env, CONFIG_KEYS.wait, {});
  if (!wait[lower]) {
    wait[lower] = { ts: new Date().toISOString() };
    await writeJson(env, CONFIG_KEYS.wait, wait);
  }
}

const bad = (msg, status = 400) => Response.json({ error: msg }, { status });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleAdmin(req, env, path) {
  if (path === "/api/admin/data" && req.method === "GET") {
    const [allow, wait] = await Promise.all([readAllow(env), readJson(env, CONFIG_KEYS.wait, {})]);
    let tiers = {};
    try { tiers = JSON.parse(env.QUOTA_TIERS || "{}"); } catch {}
    const admins = (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    // 每人今日用量(秒):逐一問 DO——名單短(封測),可接受;有量才回傳
    const usage = {};
    await Promise.all([...new Set([...Object.keys(allow), ...admins])].map(async (email) => {
      try {
        const u = await (await env.RELAY.get(env.RELAY.idFromName(email)).fetch("https://do/usage")).json();
        if (u.usedSeconds > 0) usage[email] = { usedSeconds: u.usedSeconds };
      } catch {}
    }));
    return Response.json({
      allowlist: allow,
      waitlist: Object.entries(wait).map(([email, v]) => ({ email, ...v })).sort((a, b) => (a.ts < b.ts ? -1 : 1)),
      tiers, defaultTier: env.DEFAULT_TIER || "beta",
      admins, usage,
    });
  }

  if (path === "/api/admin/allow" && req.method === "POST") {
    const { email, tier } = await req.json();
    const lower = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(lower)) return bad("email 格式不對");
    const value = String(tier || env.DEFAULT_TIER || "beta").trim();
    if (!/^[\w-]+$/.test(value)) return bad("級別只能是英數字或秒數");
    const allow = await readAllow(env);
    allow[lower] = /^\d+$/.test(value) ? Number(value) : value;
    await writeJson(env, CONFIG_KEYS.allow, allow);
    // 核准後從等候名單移除
    const wait = await readJson(env, CONFIG_KEYS.wait, {});
    if (wait[lower]) { delete wait[lower]; await writeJson(env, CONFIG_KEYS.wait, wait); }
    return Response.json({ ok: true, email: lower, tier: allow[lower] });
  }

  if (path === "/api/admin/remove" && req.method === "POST") {
    const { email } = await req.json();
    const lower = String(email || "").trim().toLowerCase();
    const allow = await readAllow(env);
    if (!(lower in allow)) return bad("名單裡沒有這個 email", 404);
    delete allow[lower];
    await writeJson(env, CONFIG_KEYS.allow, allow);
    return Response.json({ ok: true });
  }

  if (path === "/api/admin/waitlist-remove" && req.method === "POST") {
    const { email } = await req.json();
    const lower = String(email || "").trim().toLowerCase();
    const wait = await readJson(env, CONFIG_KEYS.wait, {});
    if (wait[lower]) { delete wait[lower]; await writeJson(env, CONFIG_KEYS.wait, wait); }
    return Response.json({ ok: true });
  }

  // 清空既有的卡死回報(bug 修完就清,不留 email 相關資料)
  if (path === "/api/admin/clientlog-clear" && req.method === "POST") {
    const listed = await env.FIELD.list({ prefix: "clientlog/", limit: 1000 });
    await Promise.all((listed.objects || []).map((o) => env.FIELD.delete(o.key)));
    return Response.json({ ok: true, deleted: (listed.objects || []).length });
  }

  // 最近的前端卡死回報(/api/client-log 寫進 FIELD bucket 的麵包屑)——查 iOS 卡點用
  if (path === "/api/admin/clientlog" && req.method === "GET") {
    const listed = await env.FIELD.list({ prefix: "clientlog/", limit: 1000 });
    const latest = (listed.objects || [])
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
      .slice(0, 10);
    const entries = await Promise.all(latest.map(async (o) => {
      try { return { key: o.key, uploaded: o.uploaded, ...(await (await env.FIELD.get(o.key)).json()) }; }
      catch { return { key: o.key, uploaded: o.uploaded, error: "unreadable" }; }
    }));
    return Response.json({ count: entries.length, entries });
  }

  return bad("not found", 404);
}
