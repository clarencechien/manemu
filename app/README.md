# manemu app(Cloudflare Workers)

按住說話的旅途口譯。規格:`../live-translate-poc/docs/m3-spec.md`;設計:`../live-translate-poc/docs/design.md`。

## 架構

```
public/(前端,assets binding)── /ws ──► Worker(src/index.mjs)
  index.html + app.js + pcm-worklet.js      │ Google OIDC + R2 白名單 + session cookie
                                            ▼
                                RelaySession DO(src/relay.mjs,每 email 一個)
                                  ├─ 注入口譯 systemInstruction(+行程 glossary)
                                  ├─ 靜音收斂 2.5s / 單 session 120s / 每日分鐘配額
                                  └─ Gemini Live WS(金鑰只在此)
```

## 一次性部署步驟(之後 push 即上版)

1. **連動 repo**:Cloudflare dashboard → Workers & Pages → Create → 連 GitHub `clarencechien/manemu`,
   build 設定 root directory = `app/`。main → production;其他分支 → preview。
2. **R2**:建 `manemu-config`、`manemu-field` 兩個 bucket(全私有)。
   上傳白名單:`wrangler r2 object put manemu-config/allowlist.json --file allowlist.json`
   (內容:`["you@gmail.com", "friend@gmail.com"]`;熱更新,改檔即生效)。
3. **Google OAuth**:GCP Console → OAuth client(Web),redirect URI 填 `https://<domain>/auth/callback`。
4. **Secrets**(dashboard 或 `wrangler secret put`,共 4 把):
   `GEMINI_API_KEY`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`SESSION_SECRET`(隨機 32+ 字元)。
5. **安全開關**(Free plan 就夠;完整理由見 m3-spec §5.6):
   - **關掉 workers.dev route**(Settings → Domains & Routes → Disable):否則該網址不經 zone,WAF 全繞過。
     程式端也已擋(`CANONICAL_HOST`,非正式 host → 301/403)。
   - **Turnstile(免費、不限次數,取代付費的 Managed Challenge)**:
     Dashboard → Turnstile → 新增 widget(domain 填 `manemu.ai-apps.work`)→
     site key 填進 `wrangler.jsonc` 的 `TURNSTILE_SITE_KEY`、secret 用
     `wrangler secret put TURNSTILE_SECRET`。兩者設好後登入頁自動出現驗證、Worker 端強制驗;
     沒設就自動略過(先跑通用)。
   - **Rate Limiting(Free 1 條)**:花在 `/auth/*`(同 IP 10 req/min)。
   - Bot Fight Mode、Always Use HTTPS、Min TLS 1.2:全部免費,開。
   - **不需要為安全升 Pro**:錢包防線是白名單 + DO 每日配額(程式內),WAF 只是擋噪音的第二層。

## 配額(vars,可在 dashboard 改)

`DAILY_SECONDS_LIMIT=1800`(每人每日 30 分鐘)、`SESSION_HARD_CAP_S=120`(單句上限)。

## 測試模式 = R1 真人語音收集

登入後點 🧪:逐句照念 T50 語料,每句寫 `r2://manemu-field/field/{email}/{ts}.json`
(16kHz 音檔 b64 + STT + 譯文 + 死氣延遲)。拉回 harness 評測:
音檔可直接轉 wav 丟 `live-translate-poc/data/audio-human/`。

## 已知未驗(部署後首測清單)

- [ ] OAuth 全流程(state/nonce/JWKS 驗章)真打一次
- [ ] Worker `fetch` upgrade 到 Gemini WS(DO 內 upstream)——CC web 環境無法起 workerd,僅過語法
- [ ] iOS Safari:AudioWorklet、`pointerdown` 權限手勢、24k 播放
- [ ] 真機 echo(PTT 播放鎖 + echoCancellation 夠不夠)
- [ ] fast 模式(translate 引擎)在 relay 下的行為
