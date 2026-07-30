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

## 配額與分級(UI 出來前的彈性機制)

**計量**:每日翻譯**秒數**(session 牆鐘,含預熱與收斂),不是次數;一句約 10–20 秒。
**失敗不計費**:沒有任何輸出的 session(連不上/沒聽到/逾時)不扣額度。
**重置**:UTC 00:00(台灣早上 08:00)。

**分級表(var `QUOTA_TIERS`,0 = 無上限)**
```json
{"admin":0,"pro":10800,"beta":1800,"trial":600}
```
**指定某人的級別**:R2 `allowlist.json` 兩種格式都吃,**改檔即生效、不用重部署也不用重登入**:
```json
["a@x.com","b@x.com"]                    // 全部套 DEFAULT_TIER(beta)
{"a@x.com":"admin","b@x.com":"trial"}    // 逐人分級
```
**Admin**:var `ADMIN_EMAILS`(逗號分隔)——列在裡面的 email 一律 admin 級(無上限),
不受白名單格式影響,適合自己與內部帳號。

其他:`SESSION_HARD_CAP_S=120`(單句硬上限)、`DAILY_SECONDS_LIMIT`(分級表查不到時的後備值)。

名單值也可以直接是**秒數**(`{"a@x.com": 7200}` = 60 分... 實為 120 分/日),級別名或秒數都吃。

> 日後要接金流:把「付費方案 → tier 名稱」寫進 `QUOTA_TIERS`,付款成功後更新 R2 白名單的 tier 即可;
> 之後有後台再把這份 JSON 換成 KV/D1,Worker 端只有 `resolveUser()` 要改。

## 管理頁 `/admin`(僅 ADMIN_EMAILS)

- 網址:`https://manemu.ai-apps.work/admin`——非 admin 開啟只看到「沒有管理權限」,
  所有 `/api/admin/*` 端點也擋在 session + admin 雙閘門後。
- **等候名單**:有人用不在名單內的 Google 帳號登入 → 自動寫進 `r2://manemu-config/waitlist.json`
  → 管理頁一鍵「核准(可選級別)」或「忽略」。核准後對方**下一次操作立即生效**(無需重登入)。
- **已核准名單**:改級別、填自訂秒數、移除;`ADMIN_EMAILS` 內的帳號不可從 UI 移除(防手滑鎖死自己)。
- 資料就是 R2 的兩個 JSON,想手動改也行(`wrangler r2 object put`),兩邊等價。

## 測試模式 = R1 真人語音收集

登入後點 🧪:逐句照念 T50 語料,每句寫 `r2://manemu-field/field/{email}/{ts}.json`
(16kHz 音檔 b64 + STT + 譯文 + 接話延遲 deadAirMs)。拉回 harness 評測:
音檔可直接轉 wav 丟 `live-translate-poc/data/audio-human/`。

## 部署複驗(2026-07-30 curl 實測)

| 檢查 | 結果 |
| --- | --- |
| `https://manemu.ai-apps.work/` | ✅ 200 |
| `/api/me` 未登入 | ✅ 401 |
| `/api/config` | ✅ 回 Turnstile site key(已啟用) |
| `/auth/login` GET(Turnstile 啟用後) | ✅ 302 回首頁(強制走 POST+驗證) |
| workers.dev `/api/me` | ✅ 403(canonical-host 擋下) |
| workers.dev `/` | ✅ 301 → 正式網域(`run_worker_first` 修正後複驗通過) |
| 安全 headers(CSP/XFO/nosniff/referrer) | ✅ 全數出現(修正前 assets 繞過 worker 導致缺失) |
| 備註 | workers.dev route 仍建議在 dashboard 關閉(縱深) |

## 已知未驗(部署後首測清單)

- [x] OAuth 端點行為、Turnstile 強制、canonical-host(上表)
- [ ] OAuth 全流程真登入一次(白名單 email)
- [ ] 真 PTT 一句:relay → Gemini WS → 譯音播放(手機瀏覽器)
- [ ] iOS Safari:AudioWorklet、`pointerdown` 權限手勢、24k 播放
- [ ] 真機 echo(PTT 播放鎖 + echoCancellation 夠不夠)
- [ ] fast 模式(translate 引擎)在 relay 下的行為
- [ ] 🧪 測試模式一輪 → 確認 R2 `manemu-field` 有 field log
