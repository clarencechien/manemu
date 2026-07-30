// manemu Worker:路由 + Google OIDC + 白名單 + WS relay 轉發 + 回譯 + 測試模式記錄。
// 安全設計見 live-translate-poc/docs/m3-spec.md §5.6。
import { sign, verify, cookieGet, cookieSet, sessionFrom, verifyGoogleIdToken, resolveUser, randomHex, b64u } from "./auth.mjs";
export { RelaySession } from "./relay.mjs";
import { handleAdmin, addToWaitlist } from "./admin.mjs";

const SEC_HEADERS = {
  // Turnstile 需要 challenges.cloudflare.com 的 script 與 iframe
  "content-security-policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' wss: https:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};
const withSec = (res) => {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) r.headers.set(k, v);
  return r;
};
const sameOrigin = (req) => {
  const o = req.headers.get("origin");
  return !o || o === new URL(req.url).origin;
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // 縱深防禦:workers.dev 等非正式 host 不經 zone WAF,一律導回正式網域
    if (env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST) {
      if (req.method === "GET" && !p.startsWith("/api") && p !== "/ws") {
        return Response.redirect(`https://${env.CANONICAL_HOST}${p}${url.search}`, 301);
      }
      return new Response("use canonical host", { status: 403 });
    }

    if (p === "/api/config") {
      return Response.json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
    }

    /* ---------- OAuth ---------- */
    if (p === "/auth/login") {
      // Turnstile:設了 secret 就強制驗(POST + token);沒設則維持 GET 直通
      if (env.TURNSTILE_SECRET) {
        if (req.method !== "POST") return new Response(null, { status: 302, headers: { location: "/" } });
        if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
        const form = await req.formData();
        const token = form.get("cf-turnstile-response");
        if (!token) return new Response("challenge required", { status: 403 });
        const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET, response: String(token),
            remoteip: req.headers.get("cf-connecting-ip") || "",
          }),
        });
        if (!(await vr.json()).success) return new Response("challenge failed", { status: 403 });
      }
      const state = randomHex(), nonce = randomHex();
      const stCookie = cookieSet("mn_oauth", await sign({ state, nonce, exp: Date.now() / 1000 + 600 }, env.SESSION_SECRET), 600);
      const q = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/auth/callback`,
        response_type: "code", scope: "openid email", state, nonce, prompt: "select_account",
      });
      return new Response(null, { status: 302, headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, "set-cookie": stCookie } });
    }
    if (p === "/auth/callback") {
      const st = await verify(cookieGet(req, "mn_oauth"), env.SESSION_SECRET);
      if (!st || st.state !== url.searchParams.get("state")) return new Response("state mismatch", { status: 403 });
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: url.searchParams.get("code"), client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/callback`,
          grant_type: "authorization_code",
        }),
      });
      const tok = await tr.json();
      const claims = tok.id_token && await verifyGoogleIdToken(tok.id_token, env.GOOGLE_CLIENT_ID, st.nonce);
      if (!claims) return new Response("token verification failed", { status: 403 });
      if (!(await resolveUser(claims.email, env)).allowed) {
        await addToWaitlist(claims.email, env).catch(() => {}); // 記進等候名單,admin 可一鍵核准
        return new Response(null, { status: 302, headers: { location: `/?waitlist=1&email=${encodeURIComponent(claims.email)}`, "set-cookie": cookieSet("mn_oauth", "", 0) } });
      }
      const session = await sign({ email: claims.email, exp: Date.now() / 1000 + 7 * 86400 }, env.SESSION_SECRET);
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookieSet("mn_session", session, 7 * 86400) } });
    }
    if (p === "/auth/logout") {
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookieSet("mn_session", "", 0) } });
    }

    /* ---------- 需要登入的部分 ---------- */
    const needAuth = p.startsWith("/api/") || p === "/ws";
    let session = null, user = null;
    if (needAuth) {
      if (!sameOrigin(req)) return new Response("forbidden", { status: 403 });
      session = await sessionFrom(req, env);
      if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
      // 每次請求重算分級 → R2 白名單改了立刻生效(不用重登入、不用重部署)
      user = await resolveUser(session.email, env);
      if (!user.allowed) return Response.json({ error: "not_allowlisted" }, { status: 403 });
    }

    if (p.startsWith("/api/admin/")) {
      if (!user.isAdmin) return Response.json({ error: "admin_only" }, { status: 403 });
      return handleAdmin(req, env, p);
    }

    if (p === "/api/debug") {
      // 已在 session 閘門後、且只回自己 DO 的診斷(無金鑰材料);封測結束把 var 改 off
      if (env.DEBUG_ENDPOINT === "off") return Response.json({ error: "disabled" }, { status: 404 });
      const stub = env.RELAY.get(env.RELAY.idFromName(session.email));
      return stub.fetch("https://do/debug");
    }

    if (p === "/api/me") {
      const stub = env.RELAY.get(env.RELAY.idFromName(session.email));
      const u = await (await stub.fetch(`https://do/usage?limit=${user.limitSeconds}`)).json();
      return Response.json({ email: session.email, tier: user.tier, isAdmin: user.isAdmin, ...u });
    }

    if (p === "/ws") {
      const stub = env.RELAY.get(env.RELAY.idFromName(session.email));
      const wsUrl = new URL(req.url);
      wsUrl.searchParams.set("limit", String(user.limitSeconds)); // 額度由 Worker 決定,DO 只執行
      return stub.fetch(new Request(wsUrl, req));
    }

    if (p === "/api/backtranslate" && req.method === "POST") {
      const { text, from } = await req.json();
      if (!text || text.length > 600) return Response.json({ error: "bad input" }, { status: 400 });
      const langName = { ja: "日文", en: "英文", ko: "韓文", vi: "越南文", th: "泰文" }[from] ?? "外文";
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${env.BACKTX_MODEL}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `把下面這句${langName}翻譯成台灣繁體中文口語。只輸出譯文,不要任何說明。\n\n${text}` }] }],
          generationConfig: { temperature: 0 },
        }),
      });
      const d = await r.json();
      const zh = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      return zh ? Response.json({ zh }) : Response.json({ error: "backtranslate failed" }, { status: 502 });
    }

    // 前端卡死自救時的診斷麵包屑(iOS 真機沒有 console,只能靠這條回報卡點)
    if (p === "/api/client-log" && req.method === "POST") {
      const body = await req.text();
      if (body.length > 20_000) return Response.json({ error: "too large" }, { status: 413 });
      const key = `clientlog/${session.email}/${new Date().toISOString().replaceAll(":", "-")}.json`;
      await env.FIELD.put(key, body, { httpMetadata: { contentType: "application/json" } });
      return Response.json({ ok: true });
    }

    if (p === "/api/field-log" && req.method === "POST") {
      const body = await req.text();
      if (body.length > 2_500_000) return Response.json({ error: "too large" }, { status: 413 });
      const key = `field/${session.email}/${new Date().toISOString().replaceAll(":", "-")}.json`;
      await env.FIELD.put(key, body, { httpMetadata: { contentType: "application/json" } });
      return Response.json({ ok: true, key });
    }

    /* ---------- 靜態 ----------
       不要自己把 /admin 改寫成 /admin.html:assets 的 html_handling 會把 .html
       正規化回 /admin,兩邊互推造成無限重導向(實測 ERR_TOO_MANY_REDIRECTS)。
       直接交給 assets,/admin 本來就會服務 admin.html。 */
    return withSec(await env.ASSETS.fetch(req));
  },
};
