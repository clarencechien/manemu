# 實測發現(2026-07-29,CC web 沙箱)

計劃 `docs/plan.md` §0.5 要求「先驗證再寫碼」的項目,全部實測完畢。**與計劃假設不同的地方以本文為準。**

## 1. Runtime 選項:CC web(一次性)vs Cloudflare(排程/常駐)

| 用途 | 結論 |
| --- | --- |
| 一次性/幾次評測拿數字 | ✅ CC web + env 金鑰直接跑,本 repo 即此版本 |
| 計時精度 | CC web 是一般 Node,`performance.now()` 自由前進,**沒有** Cloudflare Workers「時鐘只在 I/O 後前進」的坑(計劃 §4.3-3 的限制在此消失) |
| 排程、無人值守、追蹤 preview 漂移 | ⚠️ 之後再包 Cloudflare Worker/GitHub Actions;harness 核心已隔離在 `TranslateProvider` 介面後,可直接移植 |
| 給真人用的 PWA 前端 | ❌ 必須 hosting(M3,Gate 通過後) |

金鑰衛生:金鑰只存在 env(`gemini_key`),程式不印出、不寫入結果/報告;建議用專用低配額專案的 key,PoC 完輪替。

## 2. 已驗證的 API 事實(vs 計劃附錄 F 的假設)

### Live API(WebSocket)

- 端點:`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY`,API key 直接可用(不需 ephemeral token;瀏覽器端才需要)。
- 模型 `models/gemini-3.5-live-translate-preview` 存在,方法 `bidiGenerateContent`。
- setup 訊息實測結構(**注意:transcription 兩欄在 `setup` 層,不在 `generationConfig` 內,放錯會被 1007 拒絕**;計劃 §3/§6 的 `translateConfig`/`targetLanguage` 示意欄位名皆不對):

```json
{ "setup": {
    "model": "models/gemini-3.5-live-translate-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "translationConfig": { "targetLanguageCode": "ja", "echoTargetLanguage": false }
    },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {} } }
```

- 送音訊:`{"realtimeInput":{"audio":{"data":"<base64>","mimeType":"audio/pcm;rate=16000"}}}`,每 100ms 一框;講完送 `{"realtimeInput":{"audioStreamEnd":true}}`(`mediaChunks` 已 deprecated)。
- 事件:`serverContent.inputTranscription.text` / `serverContent.outputTranscription.text` / `serverContent.modelTurn.parts[].inlineData.data`(base64 24kHz PCM16)。
- 輸入 16kHz PCM16 mono LE、輸出 24kHz PCM16 mono LE,與文件一致。

### ⚠️ 最重要的行為發現:turnComplete 不會來、譯音後面跟著無限靜音串流

live-translate 是**連續 session**:`audioStreamEnd` 後模型翻完仍持續串流靜音音框(smoke 實測:3.2s 輸入 → 45s 音訊,其中 4.2s 後全為靜音),`turnComplete`/`generationComplete` 都不出現。因此:

- 「講完偵測」必須自己做:對輸出 chunk 算 RMS(閾值 500,靜音框 ≈0、語音框數千),連續 2.5s 無有聲 chunk 且無新文字 → 收斂、關 WS。
- **首音(ttfa)也要用第一個「有聲」chunk**,第一個 chunk 可能是靜音框。
- `completion_lag` 以最後有聲 chunk 到達時間計。
- 這對 **PWA 前端(M3)與計費都有影響**:session 不主動收尾,掛著就一直算分鐘數;前端要 PTT 放開後主動關 session 或做同樣的靜音偵測。

### TTS(Phase A 合成)

- `models/gemini-3.1-flash-tts-preview` 實測**會掛住**(>3 分鐘無回應,curl 直打同樣掛)。改用 `models/gemini-2.5-flash-preview-tts`(~3.4s/句),輸出 `audio/L16;codec=pcm;rate=24000` base64,重取樣到 16kHz 後存 WAV。
- voice 固定 `Kore`、temperature 0.2,保證重跑輸入一致。

### 其他

- STT(`inputTranscription`)輸出**簡體中文**,語料是繁體 → CER 計算前要簡繁正規化(`src/rules.mjs`),否則 CER 虛高(0.36 → 正規化後 0.08)。
- 同家評審:環境只有 Gemini 金鑰,評審用 `gemini-3.1-pro-preview` 代打 OpenAI,存在自評偏誤(報告已標註)。
- CC web 沙箱對外一律走 agent proxy;Node 原生 fetch/WebSocket 需 `NODE_USE_ENV_PROXY=1` 才吃 `HTTPS_PROXY`(npm scripts 已內建)。Cloudflare Workers 無此問題。

## 3. Smoke 試跑的早期品質訊號(n=4,僅供方向感)

- `ttfa_from_end` 為**負值**(-100~-440ms):放開按鈕前譯音已開始,同步口譯行為,體感佳。
- `ttfa_from_start` ≈ 3.0–3.3s,與已知「首音中位數 ~3 秒」吻合。
- `completion_lag` ≈ 2.2–3.7s(短句)。
- **T014「這個不要辣」被 STT 聽成「這個不要啦/了」→ 譯成 "I don't want this"**:語意整句翻反方向。原因可能是 TTS 音源的「辣」不夠清楚,也可能是模型聽感偏差 —— 全量跑會看 repeat 間是否穩定重現,M4 真人聲要重點驗這句。這正是埋雷語料要抓的事故型態(否定+句尾)。

## 3.5 全量結果(run `full-n3`:50 句 × ja/en × 3 重複 = 300 筆,零失敗)

報告:`out/reports/full-n3/{report.html,results.csv,summary.json}`。評審:254 筆 `gemini-3.1-pro-preview` + 46 筆 `gemini-3.5-flash`(3.1-pro free tier **每日**配額 ~250 req 在 254 筆時耗盡,`GenerateRequestsPerDayPerProjectPerModel`;3-pro 同池也被鎖)。

### 延遲 — Gate §4.4 在此環境明確通過

| 指標(ms) | zh→ja p50/p90/p95 | zh→en p50/p90/p95 |
| --- | --- | --- |
| `ttfa_from_end`(死氣時間) | **-794 / 401 / 532** | **-839 / 339 / 486** |
| `completion_lag`(譯音收完) | 2726 / 3368 / 3750 | 2572 / 2994 / 3164 |
| `ttfa_from_start`(對照官方) | 3126 / 3400(p90) | 3153 / 3365(p90) |

- p90 死氣時間 ~0.4s,**遠低於「順」門檻 1.5s**;p50 為負(講完前譯音已開始,同步口譯)。
- `ttfa_from_start` 中位數 ~3.1s 與官方已知 ~3s 首音一致 → 量測方法可信。
- 短句(3–5s)的 completion_lag p90 約 3–3.4s,主要就是譯音本身的播放長度。
- **注意:這是機房乾淨網路 + 乾淨 TTS 音源的樂觀下界**;真實 4G/飯店 wifi 要 M4 真機驗證。

### 品質 — 平均高,但特定事故型態集中且危險

| | zh→ja | zh→en |
| --- | --- | --- |
| adequacy / fluency(1–5) | 4.59 / 4.87 | 4.62 / 4.86 |
| 數字保留率 / 否定保留率 | 98% / 99% | 96% / 98% |
| 覆蓋率 / CER | 0.87 / 0.094 | 0.97 / 0.092 |
| 主要旗標 | omission 7.3%、honorific_off 6.7%、hallucination 3.3% | omission 10.7%、name_mangled 4.7% |

**事故都發生在 STT(聽)這一段,翻譯(譯)本身很強**——聽對的句子幾乎都翻得好,聽錯的直接產生「自信的錯譯」:

1. **同音字災難(最危險)**:「蝦子過敏」→「瞎子過敏」→ *"I'm allergic to blind people"*(3/3 重複全錯);「昏倒了」→「婚了」→「友達が結婚した」(緊急句變喜事);「辣」→「啦/了」(T014 6 次裡 5 次丟失「辣」)。
2. **專有名詞替換**:「新宿」→「新竹」(6/6 次 CER 偏高);「Shibuya Sky」→「徐博雅Sky」。code-switch 句(T002/T011/T018/T025)STT 錯誤率最高,與 preview 已知弱點吻合。
3. **句尾疑問詞被吞 → 問句變直述句**:「兩百塊可以嗎?」的「嗎」消失,「算我3000塊可以嗎」變「3000元でいいよ」(議價請求變成同意出價,商務場景致命)。
4. **串流截斷**:T046 一次只聽到半句就翻半句(「你的中文說得真好,」→「中国語がとても」)。
5. 規則檢測的 number/negation 失敗多為規則 pattern 覆蓋不足(如 "tax excluded"、"7 02" 空格),真實錯誤由評審旗標補抓 → 兩層互補的設計有效。

### Gate 判讀建議

- **延遲:通過**(此環境下大幅優於門檻,且同步口譯讓體感更好)。
- **品質:條件性通過**——日常寒暄/問路/住宿類 adequacy 4.7–5.0 可用;但**數字金額、緊急、專名密集**場景有 ~7–10% 的「自信錯譯」率,UI 必須顯示原文逐字稿讓使用者能發現聽錯(設計含義:雙逐字稿不是 nice-to-have,是安全機制)。
- 混評(兩個 judge 模型)與 TTS 音源品質是本輪兩大 confound;建議下一輪:(a) 拿到異家 API key 重評一輪對照,(b) M4 真人語音重點驗 T014/T016/T037/T010/T002。

## 3.6 Run 2 實驗結果(2026-07-29,詳見 docs/run2-plan.md)

### 實驗 1|回譯確認通道:**可行,建議做進 M3 UI**

150 筆 zh→ja 輸出以 `gemini-3.5-flash` 回譯繁中,對照 Gemini 評審分組(`out/experiments/backtranslate-full-n3-ja.json`):

| 指標 | 數字 | 解讀 |
| --- | --- | --- |
| 災難組(adequacy≤2, n=11)偵測率 | **8/11 = 73%** | 瞎子/結婚/新竹全數現形 |
| 漏掉的 3 筆 | 全是 T022「問句變陳述」 | 資訊其實在回譯裡(「三千元就好了」vs 原話「可以嗎」),是自動指標判成「語氣差異不算」;真人細看抓得到 → 73% 是下界 |
| 正常組(adequacy≥4, n=130)誤報率 | **10.8%** | 多為無害 paraphrase(火車站→車站、未稅、阿拉伯數字) |
| 誤報中的意外收穫 | T015「兒童椅→安全座椅」 | 回譯抓到**評審漏判的真錯誤**(ja 輸出真的翻成チャイルドシート=汽座)——通道同時是評審的補網 |
| 回譯延遲(預設 flash) | p50 3.3s | thinking 預設開啟,太慢 |
| **thinking off / flash-lite** | **~0.8s / ~0.4s** | UI 實際配置,「說完後一拍」內可顯示 |

**UI 建議**:input 逐字稿即時顯示(免費、抓聽錯)+ 回譯確認用 flash-lite(~0.4s,抓譯錯);兩層合起來涵蓋「聽錯」與「譯錯」兩類災難。已知盲區:語氣級錯誤(問句→陳述)兩層都可能放過,考慮 UI 上對句尾「嗎/吧」句加問號 icon 提示。

### 實驗 2、3|被 OpenAI 帳戶額度擋住(程式已就緒)

- `gpt_key` 有效但帳戶 `insufficient_quota`(API 額度與 ChatGPT 訂閱分開,要在 platform.openai.com 儲值)。
- 已完成並驗證到能驗的程度:`judge.mjs` 的 `JUDGE_PROVIDER=openai`(gpt-5-mini→`judge_x` 欄位)、`providers/openai-realtime.mjs`(24kHz 重取樣、subprotocol 認證、`session.close` 收尾)、`run.mjs --provider openai`。**WS 握手與認證實測通過**(錯誤發生在應用層 quota,非 401)。
- 儲值後指令:`JUDGE_PROVIDER=openai npm run judge -- full-n3` 與 `npm run run -- --provider openai --repeats 1 --run-id gpt-n1`。

### 配額後記(使用者 dashboard 證實,2026-07-29)

Tier 1 postpay 專案的實際 per-model 限制(dashboard 截圖與 API 實測吻合):

| 模型 | RPM | RPD | 當日用量 | 含義 |
| --- | --- | --- | --- | --- |
| Gemini 3.1 Pro | 25 | **250** | 254(爆) | Tier 1 的 preview/pro 級 RPD 仍很小 → **評審/批次一律 flash 級** |
| 2.5 Flash TTS | **10** | **100** | 75 | 一次全量合成(50 句+重試)吃掉大半日限 |
| 2.5 Pro TTS | 10 | 50 | 12 | fallback 用 |
| 3.5 Flash | 1K | 10K | 352 | 評審/回譯主力,量足 |
| 3.5 Flash Lite | 4K | 150K | 5 | UI 回譯首選 |

**TTS 的操作結論(先記錄、暫不改碼)**:
1. Phase A 音檔已進 git,平常不重合成;語料改版一天最多合成一輪。
2. `synth.mjs` 目前 ~17 req/min 超過 TTS 的 10 RPM——部分「逾時」可能是限流;下次動 synth 時加 ≤10 RPM 節流。
3. 擴語料/hard-mode 的路線:OpenAI `gpt-4o-mini-tts`(配額獨立,且換音源可檢驗「辣→啦」是否為 Gemini TTS artifact)> Batch API(半價、配額另計)> 三模型輪替(每日 ~150 句容量)。

## 3.7 OpenRouter 兩波實驗總結(2026-07-29,詳見 docs/or-plan.md;花費 $7.35)

### 品質數字定案(五廠評審面板,anthropic/openai/qwen/deepseek/mistral)

| | Gemini live-translate(full-n3) | gpt-realtime-translate(gpt-n1) |
| --- | --- | --- |
| 共識 adequacy(en / ja) | **4.61 / 4.55** | 4.02 / 3.84 |
| 共識災難率(≤2) | **8%**(24/300) | 22%(22/100) |
| 問句保留率(P5) | **91%** | 83% |
| 首音 ttfa_from_start p50 | 3.1s | **2.2–2.5s** |

- 面板共識與原 Gemini 單評審(4.62/4.59)幾乎一致 → **自評沒有虛胖,full-n3 全部數字可信**。評審間偏差 ±0.17、高分歧句僅 9/400(Q7)。
- **速度 OpenAI 贏、品質+語氣 Gemini 贏**;雙評審與五廠面板都同向,結論穩固。

### 品質損失拆解(P2 天花板 × Q4 根因)

- 同語料**文字直翻**天花板:四強模型 adequacy **4.8–4.9** → 語音管線代價 ≈ **0.3 分**。
- Q4 根因分類:full-n3 的 24 筆共識災難,**23 筆在 STT 段**(同音 14、專名 8、截斷 1),翻譯段僅 1 筆。**「問題在耳朵,不在嘴巴」正式定案**——live-translate 的翻譯內核甚至優於 gemini-3.6-flash 純文字翻譯(4.05/4.54)。
- 產品含義:M3 的所有防禦/修復投資都應該對準「聽」。

### UI 防禦與修復層的可行性矩陣(exp1 + P3 + Q1/Q2/Q3/Q5)

| 層 | 機制 | 效果 | 建議 |
| --- | --- | --- | --- |
| 第一防線 | **input 逐字稿即時顯示** | 免費;所有 STT 災難的唯一可靠出口 | **必做**(Q1 證明盲測抓不到「合理的聽錯」如新宿→新竹) |
| 第二防線 | 回譯確認 | ja 方向偵測 73–100%、en 方向 **100%**;誤報 11–14% | **必做**;引擎:gemini flash-lite(0.4s)或 claude-haiku(1.4s、en 100%@13%) |
| 第三防線 | STT 合理性偵測(無 ground truth) | sonnet 29%@誤報1%、haiku 45%@7% | 選配:只抓「瞎子過敏」級的荒謬句,當 icon 提示 |
| 修復 A | 專名 glossary 後修 | **模型等級決定成敗**:sonnet 53%、haiku 39%、nano 8%(誤傷 ≤2%) | 值得做;行程 glossary + haiku 起步 |
| 修復 B | 問句語氣修復 | nano 58%@誤動5%、haiku 59%@17% | 值得做;**nano 就夠** |

### 其他

- **P4 gold 交叉校對**:100 筆參考譯文 0 筆多數決 major → 「未經人工校對」星號解除(15 筆單票 major 為風格意見,清單在 `out/experiments/gold-check.json`)。
- **Q6 語料 v2 草稿**:35 句加重埋雷(專名密集/多句連講/問尾/數字混合)在 `data/corpus-v2-draft.json`,供真人錄音與 M4 用。
- **Q7 評審偏差**:qwen 最嚴(-0.17)、deepseek 最鬆(+0.04);deepseek 最愛插 flag(number_wrong 32 vs 其他 1–13)——多評審中位數有效中和了個性。
- 花費:OpenRouter $7.35(P 波 ~$3.4 + Q 波 ~$4);OpenAI ~$3;Gemini API 走 Tier 1 配額。

## 3.75 W 波補完(2026-07-29)

- **W2 數字語意稽核**(強模型逐筆核對,含打折/時間陷阱):full-n3 **99.1%** 語意正確(僅 T017-ja)、gpt-n1 94.1%——金額風險遠低於預期,規則層的粗查(96–98%)反而低估了。購物議價類的「可用」判定成立。
- **W3 問句丟失歸因**:同語料**文字直翻**問句保留 96–100%(五模型)→ 語音模式的 91%/83% 是 **speech pipeline artifact**,非翻譯固有難題。
- **W4 敬語專項**(ja 150 筆,GPT 稽核):失敬方向**全部是「太隨便」**(0 筆太生硬);shopping 67%、smalltalk 78% 最弱,hotel/appointment 100%。修法=語域鎖定(R1.5 的 prompt 已含)或 UI 語氣設定。
- **W1 corpus v2**:`data/corpus-v2.json` 30 句(交叉審通過率 60%,generator 池未滿;夠 R1 真人錄音用,R3 再補)。
- **W5**:`docs/m4-scripts.md` 8 個多輪情境劇本(check-in 糾紛/議價/藥局/報案…),含逐輪埋雷與檢核點。

## 3.8 W6|「另一條路」實測:一般 Live + 口譯 prompt(重大發現)

同 10 句殺手句(zh→ja,n=20 vs full-n3 同句子集 n=30):

| | translate 專用模式 | 一般 Live + systemInstruction(gemini-3.1-flash-live-preview) |
| --- | --- | --- |
| 首音 from start p50 | 3.2s | 5.0s(+1.8s) |
| 死氣(講完→首音)p50 | -0.5s(同步搶跑) | +1.0s(**仍過 1.5s 門檻**) |
| adequacy(殺手句) | 4.07 | **4.80** |
| 災難 | 8/30 | **0/20** |

- 「蝦子/辣/昏倒/可以嗎?」全對——**驗證根因**:災難在「聽」,一般 Live 是完整 LLM 在聽,聽得懂語境;translate 模式管線快但耳朵笨。
- systemInstruction 20/20 守住「只翻譯不回答」;§6「不能放 prompt」的限制在此路線消失,術語表可原生注入。
- 代價:無同步口譯、+1.4–1.8s;風險:語域漂移(出現過一次關西腔,prompt 需鎖定「標準語+です・ます」)。
- ~~待辦:prompt 模式全量驗證~~ → **已完成,見 §3.9,判定通過**。

## 3.9 R1.5 全量判定:M3 預設引擎 = prompt 模式(定案)

`prompt-full-n3`(50×2×3 = 300,零失敗)三引擎終局對照(品質為**五廠面板共識**):

| | **prompt 模式**(3.1-flash-live + 口譯 prompt) | translate 專用模式 | gpt-realtime-translate |
| --- | --- | --- | --- |
| 共識 adequacy(en/ja) | **4.88 / 4.85** | 4.61 / 4.55 | 4.02 / 3.84 |
| 共識災難率 | **0.7%**(2/300) | 8% | 22% |
| 問句保留 | **99.3%** | 91% | 83% |
| 死氣 p90 | 1.05s(p50–p95 僅差 120ms,極穩) | 0.4s(搶跑) | -0.6s |
| 首音 from start p50 | 4.9s | 3.2s | 2.2s |
| 譯音收完 p90 | **2.4–2.9s(最快)** | 3.0–3.4s | — |
| 計價(音訊) | **~$0.023/min(較便宜)** | ~$0.037/min | — |
| 異家評審(gpt-5-mini) | 4.78、災難 2.7%(殘餘=T010 專名) | 4.44 | 3.93 |

**決策規則核對**:adequacy 4.85 ≥4.5 ✓、災難 0.7% ≤5% ✓、死氣 p90 1.05s ≤2s ✓ → **全過**。

**定案**:
1. **M3 預設引擎 = 一般 Live(gemini-3.1-flash-live-preview)+ 語域鎖定口譯 systemInstruction**。translate 專用模式降為「快速模式」選項(需要搶跑同步口譯的場景)。
2. 防禦矩陣重新定價:災難 0.7% 之下,回譯確認從「必做」降為「建議」(信心徽章),glossary 修復與問句修復**不再需要**(殘餘專名問題直接在 systemInstruction 塞行程術語表,原生支援);input 逐字稿仍保留(便宜且是 UX 資訊)。
3. 三檔判定更新:**旅行 PTT 場景升到「能用」**(0.7% 災難 ≈ 10 句對話 93% 全對;1 秒穩定死氣)。剩餘驗證:R1 真人聲(此結論的最後條件)與 M4 真機。
4. systemInstruction 300/300 守住「只翻譯不回答」;語域鎖定後未再出現方言。

## 3.10 Phase 2|韓文全量:證實與中日英同級(2026-07-29)

`ko-full-n3`(50×3=150,零失敗,prompt 模式)完整評測管線與日英同規格:

| 指標 | zh→ko | 對照 zh→ja/en(prompt 模式) |
| --- | --- | --- |
| 五廠面板共識 adequacy | **4.87** | 4.85 / 4.88 |
| 共識災難率 | **2%**(3/150) | 0.7% |
| 異家評審(gpt-5-mini) | 4.77、災難 2.7% | 4.78、災難 2.7% |
| 問句保留 / 語氣忠實 | **98.6% / 99.3%** | 99.3% / 98.7% |
| 존댓말 語域稽核 | **반말 0 筆、acceptable 95–100%**(全類別) | ja keigo:shopping 僅 67% |
| 死氣 p50/p90 | 968 / 1028 ms | ~960 / ~1050 ms |

- **每一路指標都落在日英同一區間**,語域甚至比日語更穩——「引擎行為與目標語言解耦」成立。
- ref_ko 由 sonnet 生成 + terra/qwen 交叉審(0 筆需替換)。
- 注意:規則層數字檢查 86% 是**規則假陰性**(`extractNumbers` 不解析韓語數詞 두/세/일/이),面板 4.87 證明數字實際無恙;上泰/越前要幫 rules.mjs 補該語言數詞。
- **語言擴充 SOP 已定型**(半天、~$3/語言):smoke 5 句 → refs 生成+交叉審 → 50×3 → 面板+問句+語域 → Gate(adequacy ≥4.5、災難 ≤5%、問句 ≥95%、語域 acceptable ≥85%)。韓文四項全過,**進 UI LANGS 清單**。

## 3.11 Phase 3|越/泰全量:五語信心一致性定案(2026-07-30)

vi/th 各 50×3=150(零失敗),與日英韓同規格評測。**回答「不同語言信心是否一樣」:一樣,而且一致到不可思議**:

| zh→ | 五廠面板共識 | 共識災難率 | 異家評審(gpt-5-mini) | Gemini flash 評審 | 死氣 p50 |
| --- | --- | --- | --- | --- | --- |
| ja | 4.85 | 0/150 | 4.78 | 4.90 | ~960ms |
| en | 4.88 | 2/150 | (同上批) | 4.91 | ~960ms |
| ko | 4.87 | 3/150 | 4.77 | 4.94 | ~968ms |
| **vi** | **4.88** | **2/150** | 4.81 | 4.88 | ~950ms |
| **th** | **4.88** | **1/150** | 4.84 | 4.93 | ~960ms |

- 面板共識全部落在 **4.85–4.88**、災難 0–2%、死氣 ~950–970ms——**引擎行為與目標語言完全解耦**,
  「泰/越資料較弱」的預期沒有兌現(至少在旅行域語料上)。
- 各語言 refs 皆 sonnet 生成 + terra/qwen 交叉審(全部 0 替換)。
- **產品級發現(th)**:泰語禮貌詞 ครับ(男)/ค่ะ(女)**每 session 隨機切換**(prompt 只說「一致」不夠,
  無記憶的逐句 session 各自擲骰)→ **UI 需要使用者性別/稱謂設定,把 ครับ 或 ค่ะ 寫死進 systemInstruction**。
  vi 的謙稱(con/em)同理但嚴重度低。
- 語言擴充 SOP 第三次驗證:vi+th 兩語合計約 3 小時、OR 花費 ~$1.9(refs+雙面板)。
- 五語 Gate 全過 → **UI LANGS:日、英、韓、越、泰全開**(th 待性別設定實作後開)。

OR 最終花費 $12.95/15,額度物盡其用。

## 4. 對計劃的修正建議(帶回 plan v3)

1. §3/§6/附錄 F 的 setup 欄位名以本文 §2 實測為準。
2. §4.2 指標定義補「首個**有聲** chunk」與「靜音收斂」;`turnComplete` 不可依賴。
3. Cloudflare 版 consumer 的 15 分鐘牆鐘預算要含「收斂等待 2.5s + 重試」;每筆實測 ~8–12s。
4. Phase A TTS 供應商定案:Gemini `gemini-2.5-flash-preview-tts`(同金鑰、便宜、可重現),不必另接供應商。
5. M3 前端必須實作 session 主動收尾(PTT 放開 → 收斂偵測 → close),否則連續 session 會一直計費。
