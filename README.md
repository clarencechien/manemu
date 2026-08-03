# manemu まねむ

**まね(模仿)× 夢(む)。** 按住說話,manemu 模仿你的語氣、用對方的語言說出來——旅途即時口譯 PWA。

- 產品:https://manemu.ai-apps.work (封測中:Google 登入 + 受邀名單)
- 管理:`/admin`(僅 `ADMIN_EMAILS`)——等候名單一鍵核准、設額度級別或自訂秒數
- 引擎:Gemini Live(`gemini-3.1-flash-live-preview` + 語域鎖定口譯 systemInstruction;快速模式走 `gemini-3.5-live-translate-preview`)
- 語言:中 →(日 / 英 / 韓 / 越 / 泰)→ 中
- 狀態:**真機端到端跑通**——實測放開按鈕後 **0.4 秒接話**(harness 預測 ~1.0s,真機更快);
  **可安裝 PWA**(免商店,Android 有安裝按鈕、iOS 加入主畫面);前端版號 v14(顯示在頂列)

## Repo 結構

| 目錄 | 內容 |
| --- | --- |
| `app/` | **Cloudflare Workers 產品本體**:Google OIDC + Turnstile + R2 白名單/分級、Durable Object WS relay(prompt 注入、靜音收斂、每人每日配額)、真實音訊管線前端(AudioWorklet 16k → 24k 播放)、`/admin` 管理頁。部署 runbook 見 `app/README.md` |
| `live-translate-poc/` | 評測 harness 與全部實驗:語料(v1 50 句 / v2 草稿)、可攜 Node runner、規則檢測、多廠評審面板、報告產生器 |
| `live-translate-poc/docs/` | **文件入口**:`findings.md`(所有實測結論)、`m3-spec.md`(產品規格 + 安全設計)、`design.md`(視覺/互動/用語)、`pricing.md`(定價與單位經濟)、`infra.md`(relay 選型:CF vs GCP/AWS/VPS)、`plan.md`+`run2/run3/or-plan`(決策歷程) |
| `live-translate-poc/mockup/` | 互動原型(氣泡對談 + 面對面 180° 兩種版面、登入前示範) |
| `live-translate-poc/out/` | 原始評測資料:`runs/`(逐筆結果)、`reports/`(report.html / csv / summary)、`experiments/`(19 個機制實驗) |

## 為什麼是這個引擎(30 秒版)

三引擎 × 五語全量評測(每語言 150–300 句、五廠 LLM 評審面板 + 異家覆核):

| | 一般 Live + 口譯 prompt ★ | translate 專用模式 | gpt-realtime-translate |
| --- | --- | --- | --- |
| 面板共識 adequacy | **4.85–4.88** | 4.55–4.61 | 3.84–4.02 |
| 災難率 | **0.7–2%** | 8% | 22% |
| 問句保留 | **98.6–99.3%** | 91% | 83% |
| 接話(講完→首音)p90 | 1.05s | 0.4s(搶跑) | -0.6s |
| 音訊計價 | **~$0.023/分** | ~$0.037/分 | — |

三個帶得走的結論:

1. **品質差距在「聽」不在「譯」**——24 筆共識災難有 23 筆來自 STT(同音字、專有名詞),翻譯內核甚至優於同級純文字翻譯。
2. **信心跨語言一致**——日/英/韓/越/泰的面板共識全部落在 4.85–4.88、接話 ~950–970ms,引擎行為與目標語言解耦;加語言 ≈ 半天 + $3 的 SOP,不是新工程。
3. **語音管線代價約 0.3 分**——同語料文字直翻天花板 4.8–4.9,語音 4.6;剩下的差距就是上面第 1 點。

完整推導、方法學與原始數據:`live-translate-poc/docs/findings.md`(§3.5 全量、§3.6 run2、§3.7 OpenRouter 兩波、§3.8 引擎路線發現、§3.9 最終判定、§3.10–3.11 韓/越泰)。

## 產品現況

**已驗證(真機)**:Google SSO 登入、relay 全鏈(WS/setup/音框/譯音)、PTT 一句到底、譯音重播、
測試模式寫入 R2、正體中文顯示(OpenCC `cn→twp`,部署時自動更新)、每日配額計量。

**安全**:Turnstile(免費,取代付費 Managed Challenge)、嚴格 CSP(零行內腳本)、canonical-host
強制(workers.dev route 已關,WAF 繞過洞封死)、`/auth/*` rate limit、R2 私有、金鑰只在 Worker;
錢包三道保險絲 = 白名單 + 每人每日秒數上限 + 單句 120s 硬上限 + 靜音強制收斂。細節見 `app/README.md`。

**已驗補充**:iOS Safari 對話模式真機通過(v10;修復史與教訓見 `app/README.md`,
面對面模式 v13 修正後待複驗)。PWA 可安裝(零快取 SW,部署即生效)。
**未驗**:面對面模式 iOS 真機複驗、真機回音場景(外放+吵雜)、fast 模式在 relay 下的行為(UI 已暫時下架)。
**隱私**:一般對話零留存;唯一收內容的是使用者主動開啟的 🧪 測試模式(明示記錄)。
細節與 log 落點清單見 `app/README.md`「Log 與隱私」。

**延遲與網路**:死氣的代表值是**台灣行動網路的 ~0.4s**;HiNet 光世代因 Cloudflare 免費方案
路由(colo=SIN)會拉到 ~2s——已知、已接受(場景是旅途不是家用,查法 `/cdn-cgi/trace`)。
港系便宜 eSIM 也能用:AI 呼叫在伺服器端,Google 看不到使用者 IP。
漫遊/eSIM 路徑預測表見 `app/README.md`「網路路徑與死氣」。

**下一步**(`docs/run3-plan.md`):R1 真人語音資料集(測試模式已在自動收集)、M4 真機 dogfood
(劇本見 `docs/m4-scripts.md`)。五語已全部進語言下拉;泰語附「尾詞 ครับ/ค่ะ」設定
(鎖進 systemInstruction,解決每 session 隨機切換的問題),越/泰待真機驗證。

## 開發

```bash
# 評測 harness(金鑰走 env,見 live-translate-poc/README.md)
cd live-translate-poc
npm run synth                       # Phase A:TTS 合成語料音檔(已進 git,通常免跑)
npm run run -- --repeats 3          # 評測;可加 --dirs ja,en,ko --provider openai
npm run judge -- <runId>            # LLM 評審(JUDGE_PROVIDER=openai 走異家)
npm run report -- <runId>           # 產 report.html / results.csv / summary.json

# 產品:push 即部署(Workers Builds 指到 app/),一次性設定見 app/README.md
```

本地測試裝置(推送前跑):Worker 路由煙霧測試(mock env × 16 種路徑/身分組合)+ Playwright UI 測試
(假麥克風 + mock relay,驗 PTT/重播/admin 操作)。兩者都在 scratchpad,細節見 `app/README.md`。
