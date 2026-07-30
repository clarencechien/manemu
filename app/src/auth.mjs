// Google OIDC + HMAC session cookie(全 server-side,規格見 docs/m3-spec.md §5.6)
const enc = new TextEncoder();

export const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  encStr: (s) => b64u.enc(enc.encode(s)),
  dec: (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
  decStr: (s) => new TextDecoder().decode(b64u.dec(s)),
};

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function sign(payloadObj, secret) {
  const body = b64u.encStr(JSON.stringify(payloadObj));
  const sig = b64u.enc(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}
export async function verify(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64u.dec(sig), enc.encode(body));
  if (!ok) return null;
  try {
    const p = JSON.parse(b64u.decStr(body));
    if (p.exp && Date.now() / 1000 > p.exp) return null;
    return p;
  } catch { return null; }
}

export function cookieGet(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
export const cookieSet = (name, value, maxAge) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

export async function sessionFrom(req, env) {
  const p = await verify(cookieGet(req, "mn_session"), env.SESSION_SECRET);
  return p?.email ? p : null;
}

/* ---- Google id_token 驗證(JWKS,RS256) ---- */
let jwksCache = { keys: null, at: 0 };
async function googleJwks() {
  if (!jwksCache.keys || Date.now() - jwksCache.at > 3600_000) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    jwksCache = { keys: (await r.json()).keys, at: Date.now() };
  }
  return jwksCache.keys;
}
export async function verifyGoogleIdToken(idToken, clientId, expectedNonce) {
  const [h, p, s] = idToken.split(".");
  if (!s) return null;
  const header = JSON.parse(b64u.decStr(h));
  const payload = JSON.parse(b64u.decStr(p));
  const jwk = (await googleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u.dec(s), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (payload.exp < now) return null;
  if (!["https://accounts.google.com", "accounts.google.com"].includes(payload.iss)) return null;
  if (payload.aud !== clientId) return null;
  if (expectedNonce && payload.nonce !== expectedNonce) return null;
  if (!payload.email || payload.email_verified !== true) return null;
  return payload;
}

export async function isAllowlisted(email, env) {
  try {
    const obj = await env.CONFIG.get("allowlist.json");
    if (!obj) return false;
    const list = await obj.json();
    return Array.isArray(list) && list.map((e) => String(e).toLowerCase()).includes(email.toLowerCase());
  } catch { return false; }
}

export const randomHex = (n = 16) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
