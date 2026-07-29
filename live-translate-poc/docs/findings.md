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

## 4. 對計劃的修正建議(帶回 plan v3)

1. §3/§6/附錄 F 的 setup 欄位名以本文 §2 實測為準。
2. §4.2 指標定義補「首個**有聲** chunk」與「靜音收斂」;`turnComplete` 不可依賴。
3. Cloudflare 版 consumer 的 15 分鐘牆鐘預算要含「收斂等待 2.5s + 重試」;每筆實測 ~8–12s。
4. Phase A TTS 供應商定案:Gemini `gemini-2.5-flash-preview-tts`(同金鑰、便宜、可重現),不必另接供應商。
5. M3 前端必須實作 session 主動收尾(PTT 放開 → 收斂偵測 → close),否則連續 session 會一直計費。
