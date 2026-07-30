# manemu まねむ

**まね(模仿)× 夢(む)。** 按住說話,manemu 模仿你的語氣、用對方的語言說出來——旅途即時口譯 PWA。

- 產品:https://manemu.ai-apps.work (封測,Google 登入 + 受邀名單)
- 引擎:Gemini Live(`gemini-3.1-flash-live-preview` + 口譯 systemInstruction;快速模式用 `gemini-3.5-live-translate-preview`)
- 支援方向:中 →(日/英/韓/越/泰)→ 中(五語面板共識 4.85–4.88,災難率 0–2%,跨語言一致)

## Repo 結構

| 目錄 | 內容 |
| --- | --- |
| `app/` | **Cloudflare Workers 產品本體**:OIDC+Turnstile+R2 白名單、Durable Object WS relay(配額/計費保險絲)、真實音訊管線前端。部署 runbook 見 `app/README.md` |
| `live-translate-poc/` | 評測 harness 與全部實驗:語料(v1 50 句+v2)、可攜 Node runner、規則檢測、多評審面板、報告 |
| `live-translate-poc/docs/` | **文件入口**:`findings.md`(所有實測結論)、`m3-spec.md`(產品規格+安全設計)、`design.md`(視覺/互動)、`plan.md` + `run2/run3/or-plan`(歷程) |
| `live-translate-poc/mockup/` | 互動原型(氣泡對談 + 面對面兩種版面) |

## 為什麼是這個引擎(30 秒版)

三引擎 × 三語全量評測(每語言 150–300 句、五廠 LLM 評審面板 + 異家覆核):

| | 一般 Live + 口譯 prompt ★ | translate 專用模式 | gpt-realtime-translate |
| --- | --- | --- | --- |
| 面板共識 adequacy | **4.85–4.88** | 4.55–4.61 | 3.84–4.02 |
| 災難率 | **0.7–2%** | 8% | 22% |
| 問句保留 | **98.6–99.3%** | 91% | 83% |
| 死氣(講完→首音)p90 | 1.05s | 0.4s(搶跑) | -0.6s |

「品質差距在聽不在譯」:24 筆共識災難 23 筆來自 STT(同音/專名)。完整推導、方法學與原始數據都在 `live-translate-poc/docs/findings.md` 與 `out/`。

## 開發

- 評測:`cd live-translate-poc && npm run synth && npm run run && npm run judge -- <runId> && npm run report -- <runId>`(金鑰走 env,見該目錄 README)
- 產品:push 即部署(Workers Builds 指到 `app/`);一次性設定見 `app/README.md`
