# 即時口語翻譯 PoC 計劃

**目標**:在 Cloudflare 上做一個 RWD + PWA 的即時口語翻譯原型,後端串接 Google `gemini-3.5-live-translate-preview`,並設計一套「自舉(self-bootstrapping)」測試 harness,用 50 句旅行例句自動化評測 **中→日** 與 **中→英** 兩個方向,且**特別量測延遲(latency)**——因為旅行即時翻譯裡,延遲往往就是「可用 vs 不可用」的分水嶺。

- 更新日期:2026-07-23(v2:harness 改為全 Cloudflare 自動化 + 新增延遲量測章節)
- 模型:`gemini-3.5-live-translate-preview`(speech-to-speech,含原文 STT / 譯文字幕 / 譯音 TTS 一條 pipeline)
- 平台:Cloudflare Workers + R2 + Queues/Workflows(harness)、Cloudflare Pages(之後的 PWA 前端)
- 交付定位:**計劃文件為主**,含關鍵程式片段與可照做的自動化流程

---

## 0. 一句話結論

先做「全自動 harness」再做 PWA。harness 直接跑在 Cloudflare Worker 上、資料與結果都放 R2、GitHub 連動自動部署;使用者只要**設一次 secret key、按一次 trigger**,任務就自己跑完、把量化報告(品質 + 延遲)寫回 R2。真正的不確定性在 preview 模型的**品質與延遲**,所以先用便宜的自動化把這兩個數字量清楚,再決定要不要投前端工程。

---

## 0.5 給接手者(HANDOFF — 先讀這節)

**目前狀態**:只有這份計劃,**尚無 repo、尚無任何程式**。你(接手的 agent)要從零建 harness。

**你的第一目標(Gate 之前)**:做出「自動化 harness」,能對 `gemini-3.5-live-translate-preview` 跑 50 句 × 中→日/中→英,自動產出**品質 + 延遲**報告到 R2。**先不要做 PWA 前端**(§6,Gate 通過後才做)。

**建置順序**:M0 語料 → M1a 部署鏈打通(先 5 句) → M1b Phase A 合成 → M2 全量跑測 → 停在 Gate,把報告交回使用者判斷。詳見 §7。

**Definition of Done(harness PoC)**:
1. `git push` 會自動部署(Workers Builds);使用者只需 `wrangler secret put` 設一次金鑰。
2. 觸發 `POST /run`(或 Cron)後,無需人工介入即可跑完並在 `r2://reports/{runId}/` 產出 `report.html` + `results.csv`。
3. 報告含:每句 adequacy/fluency/flags、規則檢測結果、以及 §4.2 的延遲指標(`ttfa_from_end`、`completion_lag`)的 **p50/p90/p95**,並可按類別/句長分組。
4. 輸入音檔來自 R2 預合成(Phase A),**可重現**:同一 `corpus.json` 重跑,除模型本身漂移外結果一致。

**先驗證再寫碼(這些用假設一定會錯,務必先查官方文件 → 見附錄 F)**:
- Gemini Live **WebSocket 端點 URL** 與**認證方式**(API key vs ephemeral token),以及 preview 對 ephemeral token 的支援程度。
- live-translate 的 **setup 訊息確切欄位名**(本文 §3/§6 的 `translateConfig` / `targetLanguage` 為示意,以官方 reference 為準)。
- 原文/譯文逐字稿的**事件欄位名**(`inputTranscription` / `outputTranscription` 的實際 JSON 路徑)。
- **輸出音訊格式**(是否 24kHz PCM16)、輸入是否確為 16kHz PCM16、送框節奏建議值。
- **TTS 供應商**與參數(Phase A 用哪個;§附錄 D 待定)。
- 目前**計價**(§9 數字會漂,跑測前再確認)。

**已定案(不用再問)**:全 Cloudflare 自動化架構、R2 存語料/結果/報告、fan-out 派工、延遲以「講完那一刻」為基準、評審用另一家模型。

**待使用者拍板的開放決策**:TTS 供應商、評審模型(預設 OpenAI)、每句重複次數 N(預設 10)、Gate 門檻(§4.4 為建議值)、是否同時並測 OpenAI `gpt-realtime-translate`。接手時若使用者不在,採預設值並在報告開頭標註假設。

**三個最容易踩的雷(細節在對應節)**:Worker 計時器只在 I/O 後前進、解析度不適合 sub-100ms、以 production 為準(§4.3);Cron/Queue 單次牆鐘 15 分鐘上限 → 必須 fan-out(§5);live-translate 不吃 system prompt,「場域」只能走 UI/術語表(§6)。

---

## 1. 自動化 Harness 架構(第一版就上 Cloudflare)

### 1.1 一鍵化的核心流程

設計目標:**把手工作業降到「設 secret + 觸發」兩步**,其餘全自動。

```text
GitHub repo ──(push)──► Cloudflare Workers Builds 自動部署
                                   │
   使用者一次性:wrangler secret put GEMINI_API_KEY / JUDGE_API_KEY
                                   │
        觸發(Cron 排程 或 POST /run 帶 token)
                                   ▼
                        ┌──────────────────────┐
                        │  Orchestrator Worker  │
                        │  讀 corpus、派工       │
                        └──────────┬───────────┘
                                   │ enqueue 每個 (phrase × 方向 × 重複n)
                                   ▼
                    ┌───────────────────────────────┐
                    │  Queue / Workflow consumer     │
                    │  1. 從 R2 取預合成音檔          │
                    │  2. 開 Gemini Live WS,100ms 送 │
                    │  3. 收 STT/譯文/譯音 + 打時間戳 │
                    │  4. 規則檢測(數字/否定/覆蓋率)│
                    │  5. 寫「單筆結果」到 R2         │
                    └───────────────┬───────────────┘
                                    ▼
                        ┌──────────────────────┐
                        │  Finalizer Worker      │
                        │  彙整 R2 單筆 → LLM 評審 │
                        │  → 算 p50/p90 延遲     │
                        │  → 產 report.html/csv  │
                        │  → 寫回 R2(可公開連結)│
                        └──────────────────────┘
```

### 1.2 各元件與 Cloudflare 服務對應

- **GitHub 連動部署**:用 Cloudflare Workers Builds(Git 整合),`git push` 即自動部署,不用手動 `wrangler deploy`。`wrangler.toml` 內宣告 R2 bindings、Queue、Cron、secrets 名稱。
- **Secrets(使用者唯一手動步驟)**:`GEMINI_API_KEY`(翻譯)、`JUDGE_API_KEY`(評審,建議用另一家如 OpenAI 以降低自評偏誤)。用 `wrangler secret put` 或 Dashboard 設一次即可,不進 repo。
- **R2 三個用途**:
  - `r2://corpus/` — 50 句語料 JSON + **預先合成好的測試音檔(PCM)**。
  - `r2://runs/{runId}/` — 每筆(phrase×方向×重複)的原始結果 JSON。
  - `r2://reports/{runId}/` — 彙整後的 `report.html` / `results.csv`,可掛一個 Worker route 或 Pages 直接看。
- **觸發方式(兩選一或都要)**:
  - **Cron Trigger**:排程定期重跑(例如每次改語料或想追蹤 preview 漂移時)。
  - **HTTP `POST /run`**:帶一組 shared-secret token 手動觸發,回傳 `runId`。
- **派工引擎**:優先用 **Cloudflare Workflows**(durable、可重試、每步驟不受 CPU 以外時間限制)或 **Queues** 做 fan-out。**不要**把 50×2×n 全塞進單一 Worker 呼叫(見 §5 限制)。

### 1.3 兩階段設計(省錢又解耦)

- **Phase A｜合成(語料變更時才跑一次)**:把 50 句中文用 TTS 合成 16kHz PCM → 存 R2 `corpus/audio/`。之後的每次評測都**重用**這批音檔,不重複付 TTS 費、也保證輸入完全一致(可重現)。
- **Phase B｜評測(每次 trigger 跑)**:只做「取音檔 → Gemini live-translate → 評分/量延遲 → 出報告」。

> 這樣「trigger 一次 = 一份可重現的報告」,語料固定時結果差異只反映模型本身變化(適合追蹤 preview 漂移)。

---

## 2. 語料設計(50 句,含埋雷)

不是隨機 50 句,而是刻意覆蓋類別 + **埋雷**(對準 preview 已知弱點):

- 旅行類別:問路、交通/購票、點餐、購物議價、住宿 check-in、緊急求助、時間預約、客套寒暄。
- **陷阱句**(每類至少幾句):
  - **數字/金額/百分比**:測 Mandarin 後置語意造成的事實倒置(實測「成長了 15%」被翻成「目標成長 15%」)。
  - **否定詞**:「這個不要辣」「我沒有訂位」——測否定被翻反。
  - **句尾決定語意**:關鍵動詞/否定放句尾,測串流模型會不會太早吐錯(也直接影響延遲,見 §4)。
  - **夾雜外語(code-switch)**:句中已含日文/英文詞,測 preview 已知的「切到目標語言後輸出靜默中斷、內容被吞」。
  - **專有名詞**:地名、店名、車站名(日文漢字讀音)。
  - **敬語情境(中→日)**:測 keigo 層級是否合宜。

每句欄位:

```json
{
  "id": "T017",
  "category": "purchase-negotiation",
  "traps": ["number", "negation"],
  "zh": "這個不要辣，然後幫我算便宜一點，兩百塊可以嗎？",
  "ref_ja": "これは辛くしないでください。それと少し安くして、200円でいいですか？",
  "ref_en": "No spicy for this one, and can you make it cheaper — is 200 dollars OK?",
  "expect": { "numbers": ["200"], "negation": true, "min_len_ratio": 0.6 }
}
```

**Gold 參考譯文可信度**:LLM 產的參考不是絕對真值。50 句量小,建議用強力文字模型先產、**再人工快速校對這 50 句**(半小時),報告中標註是否經人工校對。

---

## 3. 評分:規則檢測 + LLM 評審

**(a) 規則檢測(便宜、確定性高,consumer 內就地跑)**

- 數字完整性:抽取 source 數字集合 vs output 數字集合,缺漏/變動即 flag。
- 否定一致性:偵測 source 否定,檢查 output 是否保留否定極性。
- 覆蓋率 / 靜默丟失:`len(outputTranscript_tokens) / expected_tokens`,低於門檻(如 0.6)flag 為 code-switch 吞字。
- STT 正確率:`inputTranscript` vs 原文,字元錯誤率(CER),先確認「有沒有聽對」。

**(b) LLM 評審(語意/流暢/敬語,用另一家模型降低自評偏誤)**

- 翻譯用 Gemini,評審**改用 GPT**(反之亦然)。
- 每句輸出:adequacy(1–5)、fluency(1–5)、error flags(number_wrong / negation_flipped / honorific_off / name_mangled / omission / hallucination)、一句中文理由。

**評審 prompt(示意)**

```text
你是專業口譯評審。以下為中文原文、機器譯文、參考譯文。只輸出 JSON:
{
  "adequacy": 1-5, "fluency": 1-5,
  "flags": { "number_wrong": bool, "negation_flipped": bool,
             "honorific_off": bool, "name_mangled": bool,
             "omission": bool, "hallucination": bool },
  "reason": "一句中文說明扣分原因"
}
原文(zh): {{zh}}
機器譯文({{dir}}): {{output}}
參考譯文: {{reference}}
```

---

## 4. 延遲量測(旅行情境的關鍵,harness 的重點能力)

### 4.1 harness 量得到哪一段?先誠實拆解

端到端「體感延遲」= 手機擷取緩衝 + 上行網路 + **模型處理/首音** + 下行網路 + 播放 buffer + **譯音播放時長**。harness 在 Cloudflare 上跑,**量得最準的是「模型那一段」**(也正是決定 preview 值不值得做的核心);手機緩衝、真實行動網路、播放 buffer 要留到真機(M4)量。**所以 harness 的延遲數字是「樂觀下界」**——與 TTS 音源過乾淨、方向一致,解讀時要記得往上加真實網路預算。

| 環節 | harness 量得到? | 備註 |
| --- | --- | --- |
| 手機麥克風擷取 + 100ms 緩衝 | ❌ | 真機才有 |
| 上行/下行網路 | ⚠️ 部分 | Worker 在邊緣,網路比手機 4G/飯店 wifi 好 |
| **模型處理 + 首音吐出** | ✅ 最準 | 模型固有延遲 |
| 播放 jitter buffer | ❌ | 真機才有 |
| **譯音「播完」時間** | ✅ | 一句 3 秒譯文,光播出去就 3 秒 |

### 4.2 要量的指標(旅行 PTT 以「講完那一刻」為基準)

打點:`t_first_frame_sent`、`t_last_frame_sent(=講完)`、`t_first_out_audio`、`t_first_out_text`、`t_last_out`。推導:

- **`ttfa_from_end` = t_first_out_audio − t_last_frame_sent**:放開按鈕 → 第一段譯音出來,也就是「死氣時間(dead air)」,體感最敏感。同步口譯下**可能為負**(還沒講完就開始翻,是好事)。
- **`completion_lag` = t_last_out − t_last_frame_sent**:放開 → 譯文完整播完,才是「對方真的聽懂」,含譯音本身播放長度。
- **`ttfa_from_start` = t_first_out_audio − t_first_frame_sent**:對照官方公布的「首音」定義用。
- **streaming lag 曲線**:同步翻譯時,量譯音落後說話者多少秒隨句子推進的變化。

### 4.3 量得準的實作要點(含 Cloudflare 專屬眉角)

1. **即時節奏送**:每 100ms 送一框,**嚴禁 burst 灌**,否則延遲數字失真、模型行為也不同。
2. **量分布,不是平均**:每句重跑 N 次(如 10),看 **p50 / p90 / p95**。旅行現場「這什麼鬼」來自尾端(p90/p95),平均會騙人。
3. **Worker 計時器眉角(重要)**:Cloudflare Workers 為防 Spectre,`Date.now()` / `performance.now()` **只在 I/O 發生後才前進**(純 CPU 期間時鐘凍結)。好消息是我們的延遲事件(每個 WS 訊息到達)本身就是 I/O,所以在**收到訊息的邊界**時鐘會前進,量「送出→收到」是有效的;但解析度綁在 I/O 事件節奏,適合我們 100ms–數秒的尺度,**不適合量 sub-100ms**。本機 `wrangler dev` 的時鐘行為不同(會自由前進),所以延遲數字**以部署後的 production 執行為準**。
4. **注入合成網路延遲**:在送/收兩端各加 50 / 150 / 300ms,模擬行動網路,看延遲怎麼劣化——沒做手機 app 前就能逼近真實。
5. **地理位置的限制**:Worker/Cron 跑在哪個 colo 不由你精準指定,**無法保證「從台灣/東京」量**;harness 的網路段只能當參考,真正的端到端要 M4 用真手機在真網路量,再對照 harness 看落差。
6. **延遲 × 語料類別**:這模型「會等動詞再翻」,**句子越長/語意越後置,延遲越高**。把延遲按類別/句長分組,會挖到「短問路句很快、複雜議價句拖很久」——直接影響 UX(要不要引導使用者講短句)。

### 4.4 可用門檻參考(可自行調)

旅行 PTT 使用者本來就在等,容忍度比即時對談高。粗估:`ttfa_from_end` 的 **p90 ≤ ~1.5 秒算順、~3 秒可接受、> 5–6 秒才吐第一個字就會覺得壞掉**。對照 Gemini 實測首音中位數 ~3 秒(還是從**開始**說算起、機房乾淨網路),延遲很可能就是這個 preview 的分水嶺——**所以更該先用 harness 量清楚再決定要不要做前端**。

---

## 5. Cloudflare 執行限制與對策(直接影響 harness 怎麼切)

- **CPU 時間 ≠ 牆鐘時間**:`fetch()`/WS 等待不計入 CPU。付費版單次 HTTP 請求 CPU 上限可到 5 分鐘,但我們每筆幾乎都在等 I/O、CPU 近乎 0,不是瓶頸。
- **牆鐘上限**:Cron Trigger / Queue consumer / DO Alarm 單次最長 15 分鐘;**Workflows 每步驟不受牆鐘限制(仍受 CPU 限制)**。所以:
  - 用 **fan-out**(每筆一個 consumer 呼叫),而非一個 Worker 跑完 100 筆。100 筆 × 每筆數秒即時串流,序列跑會逼近 15 分鐘;分散到 Queue/Workflow 才安全且可平行。
- **同時連線上限**:單次呼叫同時「等 response header」的連線上限 6;WS 建立後不佔此額度。fan-out 天然規避。
- **子請求數**:付費版單次上限高(萬級),足夠。
- **費用**:見 §7,對 PoC 規模趨近於零;真正花錢的是模型推論。

---

## 6. PWA 前端(Gate 通過後才做,M3)

- **金鑰**:瀏覽器不放 API key。Worker 出 `GET /token` 換 Gemini ephemeral token,瀏覽器**直連** Gemini Live WSS(備援:Durable Object 當 WS relay)。
- **音訊**:`getUserMedia` → `AudioWorklet` 降 16kHz/PCM16、100ms 送;收 24kHz PCM 播放並維護 jitter buffer。
- **UI**:兩顆大按鈕固定方向(左「我說中文」→ 目標 `ja`/`en`;右「對方回話」→ 目標 `zh-Hant`),避免自動偵測誤判;播放時 mute 麥克風 + echo gate 防迴圈。
- **場域(旅行/工作/日常)**:live-translate 不吃 system prompt,此版只能做 UI 層語言對/術語表切換;要 prompt 客製得改一般 Gemini Live Agent 模式(換品質風險)。
- **PWA**:manifest + Service Worker 只快取 app shell(即時翻譯需連網);iOS Safari 的 AudioWorklet 坑列為相容性測試項。

---

## 7. 里程碑與時程(估)

| 階段 | 產出 | 估時 |
| --- | --- | --- |
| **M0 語料** | 50 句 + JA/EN gold 參考(含埋雷),人工校對 | 0.5 天 |
| **M1a 骨架 + 部署鏈** | GitHub↔Workers Builds、R2 bindings、Queue/Workflow、Cron/`POST /run`、secrets;先 5 句打通全鏈 | 1 天 |
| **M1b Phase A 合成** | TTS 合成 50 句 PCM 存 R2(可重現輸入) | 0.5 天 |
| **M2 全量跑測** | 50×2 方向 ×N 重複(+ 網路注入),出品質 + **延遲 p50/p90** 報告 | 0.5 天 |
| **決策 Gate** | 依 §4.4 門檻與品質數字決定是否做前端 | — |
| **M3 PWA 前端** | Cloudflare Pages + /token Worker,麥克風/PTT/逐字稿/播放 | 1.5–2 天 |
| **M4 真人 dogfood** | 真手機真網路量端到端,對照 harness 落差;列 iOS 相容性 | 0.5 天 |

---

## 8. 風險與對策

- **preview 不穩/改名/配額**:provider 包成單一介面,Gemini↔OpenAI 可互換;模型名進設定檔。
- **中文事實倒置(數字/句尾)**:串流架構性問題,規則檢測專門抓;金額/醫療/法務場景比例高則警示或加人工。
- **code-switch 靜默吞字**:覆蓋率檢測抓;UI 提示「請說單一語言」緩解。
- **Worker 計時器解析度**:綁 I/O 事件,適合 ~100ms–秒級;sub-100ms 不可信;以 production 數字為準(§4.3)。
- **地理量測不可控**:harness 網路段僅參考,端到端留 M4 真機(§4.3)。
- **牆鐘 15 分鐘上限**:用 Queue/Workflow fan-out,勿單呼叫跑完全量(§5)。
- **自評偏誤 / TTS 過乾淨**:異家模型評審 + hard mode(疊噪音/變速)+ 抽樣人工複核。
- **ephemeral token 在 preview 支援不全**:退 Worker WS relay。
- **回音迴圈**:PTT + 播放時 mute 麥克風 + echo gate。

---

## 9. 費用面(都很便宜,決策關鍵是複雜度不是錢)

| 項目 | 價格 | 對 PoC |
| --- | --- | --- |
| Cloudflare Workers / Workers Builds | 免費層 + 付費約 $5/月起 | ✅ harness 主體 |
| Cloudflare R2 | 儲存極小、**egress 免費** | ✅ 語料/音檔/報告 |
| Queues / Workflows | 免費層對 PoC 規模足夠 | ✅ fan-out 派工 |
| Workers AI Whisper(選配 QA) | ~$0.00051/音訊分鐘 | 🔸 交叉驗證 STT |
| TTS 合成(Phase A 一次) | 依供應商,50 句極少 | 🔸 一次性 |
| **Gemini live-translate(成本主體)** | **~US$0.037/分鐘** | 50×2×N 短句總量仍很小 |
| LLM 評審(GPT) | 依 token,50×2 句很少 | — |
| Cloudflare Pages(M3 前端) | 免費層足夠 | ✅ 之後才用 |

上面 Cloudflare 那些**加起來遠小於模型推論成本**,「便宜」不是採用理由;會拖你的是複雜度。PoC 的 harness 只需 Workers + R2 + Queue 這幾個(近乎免費件)。

---

## 10. 下一步(可直接動工的順序)

1. 我先幫你把 **50 句旅行語料(含 JA/EN 參考 + 埋雷標註)** 產成 `corpus.json`,直接可放進 R2。
2. 再給 **harness 骨架**:`wrangler.toml`(R2/Queue/Cron/secret 宣告)+ orchestrator/consumer/finalizer 三個 Worker 的雛形 + §3 規則檢測與 §4 延遲打點程式。
3. 兩家並測時,provider 介面、語料、報告格式全部重用,直接產出 Gemini vs OpenAI 的品質 + 延遲對照表。

---

## 附錄 A｜建議 repo 結構

```text
live-translate-poc/
├─ wrangler.toml                # bindings / cron / queue 宣告(見附錄 B)
├─ package.json
├─ src/
│  ├─ orchestrator.ts           # POST /run + Cron:讀 corpus、派工到 Queue、回 runId
│  ├─ consumer.ts               # Queue consumer:取音檔→Gemini WS→打點→規則檢測→寫 R2
│  ├─ finalizer.ts              # 彙整 R2 單筆→LLM 評審→算 p50/p90→產 report
│  ├─ providers/
│  │  ├─ gemini.ts              # openLive({targetLang}) / 送框 / 收事件(唯一碰 Gemini 之處)
│  │  └─ openai.ts              # 之後並測 gpt-realtime-translate 用,同介面
│  ├─ scoring/
│  │  ├─ rules.ts               # 數字/否定/覆蓋率/CER(§3a)
│  │  └─ judge.ts               # LLM 評審 prompt + 呼叫(§3b)
│  ├─ latency.ts                # 打點與指標推導(§4.2)
│  └─ report.ts                 # report.html / results.csv 產生器
├─ scripts/
│  └─ synth.ts                  # Phase A:TTS 合成 50 句→R2(一次性/語料變更時)
└─ data/
   └─ corpus.json               # 50 句語料(附錄 C 格式),部署時上傳到 r2://corpus/
```

**Provider 介面(讓 Gemini/OpenAI 可換)**:

```ts
interface TranslateProvider {
  openSession(opts: { targetLang: "ja" | "en" | "zh-Hant" }): Promise<Session>;
}
interface Session {
  sendAudioFrame(pcm16: ArrayBuffer): void;      // 每 100ms 呼叫一次
  onInputTranscript(cb: (text: string, t: number) => void): void;
  onOutputTranscript(cb: (text: string, t: number) => void): void;
  onOutputAudio(cb: (pcm: ArrayBuffer, t: number) => void): void;
  endInput(): Promise<void>;                       // 標記講完(§4.2 的 t_last_frame_sent)
  close(): Promise<void>;
}
```

## 附錄 B｜`wrangler.toml` 骨架(示意,binding 名以此為準)

```toml
name = "live-translate-harness"
main = "src/orchestrator.ts"
compatibility_date = "2026-07-01"

[[r2_buckets]]
binding = "CORPUS"
bucket_name = "lt-corpus"

[[r2_buckets]]
binding = "RESULTS"
bucket_name = "lt-results"

[[queues.producers]]
binding = "RUN_QUEUE"
queue = "lt-run-queue"

[[queues.consumers]]
queue = "lt-run-queue"
max_batch_size = 1        # 一筆一 consumer 呼叫,避開 15 分鐘牆鐘(§5)
max_retries = 2

[triggers]
crons = ["0 3 * * *"]     # 可選:排程重跑;手動觸發走 POST /run

# secrets(不進 repo,見附錄 D):GEMINI_API_KEY / JUDGE_API_KEY / RUN_TOKEN
```

> 若改用 Cloudflare Workflows 取代 Queues 做派工(更適合長流程/重試),把 consumer 換成 workflow step;每步驟不受牆鐘限制(§5)。

## 附錄 C｜資料契約(Data Contracts)

**`corpus.json` 單筆**(§2 已列,重申為契約):

```json
{ "id": "T017", "category": "purchase-negotiation",
  "traps": ["number","negation"],
  "zh": "…", "ref_ja": "…", "ref_en": "…",
  "expect": { "numbers": ["200"], "negation": true, "min_len_ratio": 0.6 } }
```

**Queue 訊息**:

```json
{ "runId": "2026-07-23T00:00Z-ab12", "phraseId": "T017",
  "dir": "ja", "repeat": 3 }
```

**單筆結果 `r2://runs/{runId}/{phraseId}-{dir}-{repeat}.json`**:

```json
{ "runId":"…","phraseId":"T017","dir":"ja","repeat":3,
  "inputTranscript":"…","outputTranscript":"…",
  "latency": { "ttfa_from_end_ms": 820, "completion_lag_ms": 3900,
               "ttfa_from_start_ms": 2600 },
  "rules": { "number_ok": true, "negation_ok": false,
             "coverage_ratio": 0.94, "cer": 0.03 },
  "judge": { "adequacy":4,"fluency":5,
             "flags": { "negation_flipped": true },
             "reason":"否定被翻反" },
  "netInject_ms": 150, "colo": "NRT", "modelVersion": "…", "ts": "…" }
```

**報告彙整欄位**:每方向 × 每類別的 adequacy/fluency 平均、各 flag 比例、覆蓋率、以及三個延遲指標的 p50/p90/p95;外加「延遲 × 句長」散點資料。

## 附錄 D｜Secrets 與環境

| 名稱 | 用途 | 設定方式 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 呼叫 live-translate(或換 ephemeral token) | `wrangler secret put GEMINI_API_KEY` |
| `JUDGE_API_KEY` | LLM 評審(預設 OpenAI,異家降偏誤) | `wrangler secret put JUDGE_API_KEY` |
| `RUN_TOKEN` | 保護 `POST /run` 的 shared secret | `wrangler secret put RUN_TOKEN` |
| `TTS_API_KEY` | Phase A 合成(供應商待定) | 同上 |

> 使用者的唯一手動步驟就是設這幾個 secret,設完即可觸發。TTS 供應商未定前,`scripts/synth.ts` 先留 provider 介面。

## 附錄 E｜常用指令

```bash
# 一次性:建 R2 bucket / queue
wrangler r2 bucket create lt-corpus
wrangler r2 bucket create lt-results
wrangler queues create lt-run-queue

# 上傳語料與(Phase A 產出的)音檔
wrangler r2 object put lt-corpus/corpus.json --file data/corpus.json

# 部署(或直接 git push 由 Workers Builds 自動部署)
wrangler deploy

# 手動觸發一次評測
curl -X POST https://<worker-host>/run -H "authorization: Bearer $RUN_TOKEN"
# → { "runId": "…" };完成後看 r2://reports/{runId}/report.html
```

## 附錄 F｜寫碼前要重新核對的來源(preview 會變,務必查最新)

- Gemini Live API WebSocket 入門:https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
- Gemini Live API WebSocket reference(setup / 事件欄位):https://ai.google.dev/api/live
- Gemini Live Translate(模式與語言、`targetLanguage`/`echoTargetLanguage`):https://ai.google.dev/gemini-api/docs/live-api/live-translate
- Gemini 3.5 Live Translate 模型頁:https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview
- Gemini Live 模型卡(已知限制:語音不穩/語言偵測/噪音):https://deepmind.google/models/model-cards/gemini-3-5-audio/
- Gemini API 計價:https://ai.google.dev/gemini-api/docs/pricing
- Cloudflare Workers 計時器行為(I/O 才前進):https://developers.cloudflare.com/workers/runtime-apis/performance/
- Cloudflare Workers 限制(CPU/牆鐘/子請求/連線):https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers WebSockets:https://developers.cloudflare.com/workers/runtime-apis/websockets/
- Cloudflare Workflows / Queues(派工):https://developers.cloudflare.com/workflows/ · https://developers.cloudflare.com/queues/
- (並測用)OpenAI Realtime translation:https://developers.openai.com/api/docs/guides/realtime-translation

**已知關鍵事實(供接手判斷,仍請以上面來源覆核)**:Gemini live-translate 首音延遲實測中位數約 3 秒(機房乾淨網路,從開始說算起);Cloudflare RealtimeKit audio-only 約 $0.0005/分鐘、Workers AI Whisper 約 $0.00051/音訊分鐘、Gemini live-translate 約 $0.037/分鐘;live-translate 模式不支援 system prompt/instructions。
