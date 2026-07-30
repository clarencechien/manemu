# M3 PWA 規格書(上 Cloudflare 前的定案,2026-07-29)

依據:findings §3.5–3.9 全部實測數據。此文件 = 工程規格,拿著就能蓋。

## 0. 上 CF 前 readiness 結論

| 決策 | 定案 | 依據 |
| --- | --- | --- |
| 預設引擎 | 一般 Live(`gemini-3.1-flash-live-preview`)+ 語域鎖定口譯 systemInstruction | 面板 4.88/4.85、災難 0.7%、死氣 p90 1.05s、$0.023/min |
| 快速模式 | `gemini-3.5-live-translate-preview`(同步搶跑) | 死氣 p90 0.4s 但災難 8% → UI 強制帶回譯顯示 |
| **金鑰架構** | **Worker WS relay(Durable Object)** | ephemeral token 實測不可用:token 建立 OK 但 Live WS 一律 1008 拒收(v1beta/v1alpha × access_token/key/header × 有無約束全試過)|
| session 開啟 | **touch-start 預熱** | 實測冷 1.15s / 暖 0.4–0.66s;按下才開會把死氣拉到 ~2s |

## 1. 架構

```text
Pages(PWA 前端)
  └─ WSS ─► Worker + Durable Object(WS relay,每 session 一個 DO)
              ├─ 持有 GEMINI_API_KEY(秘密不出 server)
              ├─ 注入 systemInstruction(語域鎖定 + 使用者行程 glossary)
              ├─ 靜音收斂(RMS<500 × 2.5s)→ 主動關上游(計費保險絲)
              └─ 每用戶配額/費用上限(relay 天然具備的控制點)
  └─ HTTPS ─► Worker /backtranslate(flash-lite,~0.4s)
```

relay 取代 ephemeral token 的代價是音訊多一跳(edge 延遲 +~10–50ms,可忽略);
好處:prompt/glossary 不暴露、可控費用、之後換模型不用改前端。

## 2. 對談 UI(layout 定案)

- **雙大鍵 PTT**:左「我說中文」(→ja/en)、右「對方回話」(→zh-Hant)。**方向手動固定,不做自動偵測**(code-switch 是實測弱點,自動偵測會災難)。
- **touch-start**:開 relay session(預熱);**touch-end**:audioStreamEnd。按住期間顯示波形。
- **對話氣泡流**(像通訊 app):
  - 我方氣泡:上=中文 STT 逐字稿(**繁體顯示,T2S 正規化表反向**)、下=譯文文字;播放譯音。
  - 對方氣泡:上=對方原文、下=中文譯文。
  - 氣泡角落「信心徽章」:回譯確認結果(✓一致 / ⚠意思可能跑掉,tap 展開回譯全文)。0.7% 災難率下降為 advisory,不打斷流程。
- **重講捷徑**:長按自己的氣泡 = 刪除該句並重新 PTT(對應「發現聽錯→重講」迴圈)。
- **行程 glossary 頁**:貼地名/店名/航班清單 → 進 systemInstruction(原生支援,實測殘餘專名災難 2.7% 的解法)。

## 3. 快速/精準模式

| | 精準(預設) | 快速 |
| --- | --- | --- |
| 引擎 | 3.1-flash-live + prompt | live-translate |
| 體感 | 講完 ~1s 出譯音,穩定 | 講到一半就開始翻 |
| 品質 | 災難 0.7% | 災難 8% |
| UI 差異 | 回譯徽章 advisory | **回譯全文強制展開顯示** |
| 適用 | 預設全部場景 | 使用者自選(長獨白/趕時間) |

切換 = relay 換上游 model + setup,前端無感。設定頁一顆開關,附一句白話說明(「快速模式反應更快,但更容易翻錯,請盯著確認文字」)。

## 4. Echo 與播放

- PTT 半雙工天生防 echo 第一層:**播放譯音期間兩顆 PTT 禁用**(灰化 + 播放中動畫)。
- 第二層:`getUserMedia` 開 `echoCancellation: true`;播放走 `AudioContext`,播放期間不開 mic stream(不只 mute,是不收音)。
- 24kHz 播放 jitter buffer:先蓄 300ms 再播(prompt 模式音訊是 burst 到達,buffer 需求低)。
- 真實 echo 場景(外放+吵雜街頭)只能 M4 真機驗——**此項是規格,不是已驗證**。

## 5. session 生命週期(計費規則,全部實測過)

1. touch-start:開 relay→上游 session(暖機 0.4–1.2s,藏在按住說話期間)。
2. touch-end:`audioStreamEnd` → 收譯音。
3. 收斂:最後有聲 chunk 後 2.5s 無新輸出 → relay 關上游。**絕不掛 session**(live-translate 會無限串流靜音計費;flash-live 同樣原則)。
4. 使用者 10s 內再按:開新 session(無 context 繼承;v1 接受此限制)。
5. DO 端硬上限:單 session 120s、單用戶每日 X 分鐘(env 可調)——費用保險絲。

## 5.5 登入與白名單(封測 gate)

- **Google SSO**(OAuth code flow 在 Worker 端完成,session cookie httpOnly):登入前只有介紹頁+預錄示範(不開 mic、不 call 翻譯 API)。
- **白名單**:`r2://config/allowlist.json`(email 陣列);登入 callback 時比對,不在名單 → 「等待受邀」頁。名單更新 = 改 R2 物件,不用重部署。
- **測試模式**(白名單用戶,頂列 🧪):逐句出 T50 語料照念,每句寫 `r2://field-tests/{email}/{ts}-{id}.json`(音檔+STT+譯文+延遲)→ 產品化收集真人語音,直接餵回 harness 評測(R1 的長期版)。
- 費用保險絲掛在 email 維度:每人每日翻譯分鐘上限(R2/DO 計數)。

## 5.6 安全設計(SSO 防盜用——後面綁著 Gemini key,這是錢包門)

**認證鏈(DIY Google OIDC,全部 server-side)**:
1. `/auth/login`:302 到 Google,帶 `state`(隨機值,HMAC 簽章後放短效 cookie)+ `nonce` + PKCE。
2. `/auth/callback`:驗 state → code 換 token(client_secret 只在 Worker)→ **驗 id_token 簽章**(Google JWKS,RS256,WebCrypto)+ iss/aud/exp/nonce + `email_verified`。
3. 白名單:R2 `config/allowlist.json` 比對 email,**每次登入都查**(名單熱更新)。
4. Session:HMAC 簽章 cookie(`HttpOnly; Secure; SameSite=Lax; Path=/`,TTL 7 天),payload 只有 email+exp。**沒有任何 token 落在前端 JS 可讀處**。

**每一道 API/WS 的防線**:
- WS upgrade 與所有 `/api/*`:驗 session cookie + **Origin 檢查**(擋跨站 WS 劫持)。
- Relay DO **以 email 命名**(`idFromName(email)`)→ 同一用戶天然序列化,配額計數無競態:
  每日翻譯秒數上限(env 可調,預設 30 分鐘)、單 session 硬上限 120s、逾時強制關上游。
- `/api/backtranslate`、`/api/field-log`:長度/大小上限、同樣走 DO 配額。
- 金鑰:`GEMINI_API_KEY`/`GOOGLE_CLIENT_SECRET`/`SESSION_SECRET` 全在 Worker Secrets,repo 零秘密。

**Cloudflare 平台安全(能開就開)**:
- 靜態回應一律帶:CSP(`default-src 'self'; connect-src 'self' wss:`)、`X-Frame-Options: DENY`、`Referrer-Policy`、`nosniff`。
- **Turnstile 是登入頁的挑戰方案(已實作)**:免費、不限次數、與 zone plan 無關,
  比付費的 WAF Managed Challenge 更可控(自己的 widget、自己的失敗文案)。
  `TURNSTILE_SITE_KEY`(var)+ `TURNSTILE_SECRET`(secret)設好即強制生效;未設則略過。
- **⚠ workers.dev 會繞過 zone WAF**:`*.workers.dev` 不屬於你的 zone,WAF/Rate Limiting/Bot Fight 全部失效。
  必須關掉該 route;程式端另以 `CANONICAL_HOST` 擋(非正式 host → GET 301、API/WS 403)。
- Free plan 的取捨:自訂 WAF 規則 ~5 條、Rate Limiting 1 條 → **Rate Limiting 花在 `/auth/*`**
  (`/ws` 已有 session 驗證 + DO 配額);Bot Fight Mode、Always Use HTTPS、Min TLS 1.2 全開。
- **不需為安全升 Pro**:真正的錢包防線是白名單 + DO 每人每日配額 + 靜音收斂,都在程式內;WAF 是第二層噪音過濾。
- 升級路徑:改用 **Cloudflare Access**(Google IdP + email 白名單在 Access policy)可整段取代 DIY OIDC——條件是有 zone;先 DIY,介面切齊。
- R2 bucket 全私有(僅 binding 存取);field-test 錄音含個資,bucket 不開公開網址。
- 異常保險絲:DO 全域日花費估算超標(env `GLOBAL_DAILY_SECONDS`)→ 全站暫停翻譯、登入頁顯示公告。

## 5.7 部署連動(push 即上版)

- repo 根目錄 `app/` = Workers 專案;Cloudflare dashboard 連 GitHub repo,**Workers Builds** 指到 `app/`,push `claude/*`→preview、main→production。
- `wrangler.jsonc` 宣告:DO(RelaySession, migration)、R2 bindings(CONFIG/FIELD)、assets(`public/`)、vars;**secrets 只宣告名字**,值用 `wrangler secret put` 或 dashboard 設一次。
- 一次性手動步驟(README 列表):建兩個 R2 bucket、上傳 `allowlist.json`、設 4 個 secret、綁 Google OAuth redirect URI。
- 測試模式即 R1 收集管道:每句寫 `r2://field/{email}/{ts}-{id}.json`(音檔 b64+STT+譯文+延遲),harness 可直接拉下來評。

## 6. 工程清單(M3 需要寫的東西)

- [ ] `workers/relay.ts`(DO):WS 雙向轉發 + setup 注入 + 靜音收斂 + 限額
- [ ] `workers/backtranslate.ts`:flash-lite 回譯端點
- [ ] 前端:AudioWorklet 16kHz PCM16 擷取(100ms 框)、24kHz 播放 + buffer
- [ ] 對談 UI(§2)+ 模式開關(§3)+ glossary 頁
- [ ] PWA manifest + SW(app shell only)
- [ ] `wrangler.toml` + Workers Builds 部署鏈(附錄 B 沿用)
- [ ] harness 的 T2S 表、SYS_PROMPTS、RMS 收斂邏輯搬共用(已有實作可抄)

## 7. 已知未驗(M4 才能關的項)

真機 echo/外放、iOS Safari AudioWorklet、行動網路下的 relay 延遲(預估 +0.3–1s)、真人聲品質(R1)。
