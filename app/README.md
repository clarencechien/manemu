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

## Log 與隱私(誰在寫什麼、寫在哪)

**原則:一般對話零留存。** relay 只轉送音訊與譯文,不落地任何內容;DO 只存「用了幾秒」。
這是隱私設計也是產品賣點,收費後尤其站得住。全部的資料落點只有四個:

| 落點 | 內容 | 有無對話內容 | 開關 |
| --- | --- | --- | --- |
| DO `usage` | 每日用量秒數 | 無 | 恆開(計費必要) |
| DO `lastSession`(`/api/debug`) | 各環節計數器(框數/字數/關閉原因) | 無(`firstMsgSample` 只會是 setup 回應) | `DEBUG_ENDPOINT` |
| R2 `clientlog/`(`/api/client-log`) | 卡死麵包屑:階段名+時間戳+UA,**key 含 email** | 無 | `CLIENT_LOG`(**平時 off**) |
| R2 `field/`(🧪 測試模式) | **完整錄音+STT+譯文**+延遲數據 | **有,且明示** | 使用者主動開 🧪 才寫 |

- 🧪 測試模式是唯一收內容的通道,測試列明寫「你的錄音與翻譯結果會被記錄」——同意內建在動作裡。
- Workers 平台的 observability log(dashboard 可看)只有請求 metadata 與 console 計數,程式不往裡面印內容。
- 追 bug 的正確姿勢:先開 `CLIENT_LOG=on` 部署 → 重現 → `/admin` 的「診斷回報」看麵包屑 →
  修完一鍵清空、關回 off。麵包屑本身無內容,風險只在 email 識別。
- **自動清除**:每日 cron(03:10 UTC)刪除超過 `CLIENTLOG_TTL_DAYS`(預設 30,可改 90)的
  clientlog——admin 忙了沒手動清也不會累積。`field/`(🧪 測試語料)刻意不在清除範圍。
- 日後正式開放(名單外的人進來)再補:clientlog 的 email 改 HMAC 假名化
  (仍可關聯回報、不可反查)。封測階段名單內都是熟人,現制即可。

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

## CSP 與 Cloudflare Bot 注入腳本

CSP 刻意不放 `'unsafe-inline'`(script),所以**頁面內不寫行內腳本**——都放獨立 `.js`。
唯一會被擋的是 **Cloudflare Bot Fight Mode 的 JavaScript Detections(JSD)注入腳本**
(內容含每次變動的 token,無法用 hash/nonce 允許)。

**這不是安全取捨,因為 JSD 現在本來就沒在運作**——CSP 擋掉 bootstrap,`main.js` 從未載入。
三個選項的實際差異只有 console:

| 選項 | JSD 效果 | Console |
| --- | --- | --- |
| 現狀(CSP 擋著) | 不運作 | 有訊息 |
| Dashboard 關掉 JSD | 不運作(同上) | 乾淨 |
| 加 `'unsafe-inline'` | 運作 | 乾淨 |

**第三個才是真取捨,而且不划算**:為換一項 bot 啟發式訊號,要拆掉 CSP 對 XSS 的主要防線
(前端有數處 `innerHTML` 渲染逐字稿/譯文/名單,雖已 escape,CSP 是兜底)。**維持嚴格 CSP。**
Bot Fight Mode 的其他機制(IP 信譽、已知 bot、heuristics)不依賴 JSD,照常生效。

## 已知未驗(部署後首測清單)

- [x] OAuth 端點行為、Turnstile 強制、canonical-host(上表)
- [ ] OAuth 全流程真登入一次(白名單 email)
- [ ] 真 PTT 一句:relay → Gemini WS → 譯音播放(手機瀏覽器)
- [x] iOS Safari:**真機驗證通過(v10)**,連續多句可用。修復史(v7→v10)值得記:
  - v8:mic 全程保留(track.stop 會讓 iOS 收回 audio session)+ iOS 一律 `<audio>`+WAV 播放
    (WebAudio 串流在 session 被收回時「時鐘照走、輸出無聲」)+ 保險絲與麵包屑上報。
  - v9:偵測靜默死掉的 mic(muted / 跨 ctx 重用)並換新;`/api/admin/clientlog` 檢視回報。
  - v10(**破案**,靠麵包屑):按下瞬間 setPtt 把按住中的按鈕 disable → iOS 對互動中被
    disable 的元素 ~100ms 後補發 cancel → 快路徑句子被瞬間放開。修:按住中的按鈕永不
    disable;零音框放開改立即乾淨中止。教訓:**iOS 音訊 bug 猜不到,要靠階段麵包屑**
    (本地模擬測試 `ios-test.mjs` 四情境保住不退化)。
  - 每次「重新整理」都會再要一次麥克風權限是 Safari 政策(同一次載入內不會重複要);
    加到主畫面(PWA)可記住權限。修掉卡死後就不需要重整了。
- [ ] 真機 echo(PTT 播放鎖 + echoCancellation 夠不夠)
- [ ] fast 模式(translate 引擎)在 relay 下的行為
- [ ] 🧪 測試模式一輪 → 確認 R2 `manemu-field` 有 field log
- [ ] 越/泰真機各講一句(泰語切「尾詞」chip 兩種都試,確認 ครับ/ค่ะ 有鎖住)
