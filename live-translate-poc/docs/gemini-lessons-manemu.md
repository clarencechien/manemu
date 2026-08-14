# Gemini API 教訓 — manemu 摘要版

> 跨專案通用版:同目錄 `gemini-api-lessons.md`(canonical 在
> [ytplayer/docs/gemini-api-lessons.md](https://github.com/clarencechien/ytplayer/blob/main/docs/gemini-api-lessons.md),2026-08-13 v2 已對官方文件核實)。
>
> **本 repo 處置狀態(2026-08-14 盤點後修正,見文末「待辦清單」逐條註記)**——
> 原建議放 repo 根目錄的 `GEMINI-LESSONS.md`;實際收在 `live-translate-poc/docs/`
> 與其他文件同層,root README 已連。原文提到的 `voice-pipeline-decision-map.md`
> **在 manemu 不存在**(全 repo find 零筆),該項應屬其他 repo,不適用。

---

## 通用教訓 TL;DR（完整論證見 canonical）

1. **Thinking 稅**：generateContent 系模型預設開推理，thinking token 以輸出價計費（官方明載）。
   機械性任務（翻譯/抽取/分類）用 `thinkingLevel: "minimal"` 或 `thinkingBudget: 128` 關掉，
   備 400 fallback（拿掉 thinkingConfig 重試）；budget 與 level 永不同時給。
   **好消息：Live API 路徑 thoughts=0（kikemu 114 次實測），本 repo 主力的 Live 口譯不在災區。**
2. **換模型先同料 A/B**：3.6-flash 有公開社群 regressions 回報 + ytplayer 實測 batch id 對滑；
   便宜（輸出 $7.50 < $9.00）不等於可用。
3. **牌價**（2026-08-14 官方核實）：3.5-flash $1.50/$9.00、3.5-flash-lite $0.30/$2.50；
   3.6-flash 與新出的 3.7-flash 促銷 **$0.75/$3.75（至 2026-12-31，之後 $1.50/$7.50）**；
   `gemini-3.6-flash-lite`/3.7-lite 不存在；模型 ID 先 `GET /v1beta/models` 驗證。
   3.7-flash **不支援 Live API** — 本 repo 主力路徑不受影響、也換不過去；
   且 3.7 沒有 minimal 思考檔，機械任務（backtranslate）別遷。
4. **wrangler.jsonc `vars` 蓋 dashboard 明文變數**（本 repo 已守規矩：模型 ID 全在 vars）；
   HKG colo → "User location is not supported" 400，重試有效只因換 colo — 更穩是查 `request.cf.colo` 改路由。
5. **保險絲計量單位要對齊計費單位**（本 repo 最大缺口，見下）。
   供應商端旋鈕已到位：AI Studio Spend 頁每專案花費上限 + prepaid，開工先設。

## 本 repo 專屬 findings（這次盤點發現）

- ~~**本 repo 沒有任何地方設 thinkingConfig**~~(已修,見待辦 3)。Live 路徑本來就不需要;
  `/api/backtranslate` 與 harness 現在都明確要求 `thinkingLevel: "minimal"`。
- **findings.md §3.6 的「thinking off → ~0.8s」是無法重現的數字**:當時 repo 裡沒有任何
  code path 關過 thinking。**已在 findings 就地標註為未驗證**;現在 harness 會印
  `thoughtsTokenCount`,想要真數字就重跑 `npm run backtranslate` 量一次。
- **manemu 首創的兩個好招值得寫進所有專案**：計費單位套利（自己按牆鐘秒計量、供應商按 token/音訊計費
  → 結構性安全邊際）＋「沒有輸出就不計費」（relay.ts 只在 gotOutput 才扣配額）。
- **Live setup 的 config 放錯位置 → WS 1007 無聲斷線**（findings.md §2 實測）—
  別把 generateContent 的 thinkingConfig 直接複製進 Live setup。
- `turnComplete` 在 live-translate 不會來，audioStreamEnd 後模型無限吐靜音 —
  **RMS 偵測強制收斂就是計費停損**，不只是 UX。

## 待辦清單(依風險排序)——**2026-08-14 全數處置**

1. ~~**全域日預算未實作**~~ → **已做**:var `GLOBAL_DAILY_SECONDS`(預設 36000 秒 = 10 小時/日
   ≈ US$14/日 天花板)+ 固定名稱的全域計數 DO(`__global__`);relay 扣款時同步累加,
   `/ws` 超標回 503、`/api/me` 回 `globalPaused` 讓前端顯示公告,admin 頁有全站用量進度條。
   查不到全域計數時**放行**(保險絲壞掉不該鎖死整站,每人配額仍在)。
2. ~~**synth.mjs 的靜默成本升級**~~ → **已做(保留 fallback,但不再靜默)**:pro 級呼叫計數,
   結尾印 `[cost] TTS 呼叫 N 次,其中 pro 級 M 次`,M>0 時警示並建議改寫語料(T011 Suica → IC卡 的做法)
   而不是長期靠 fallback。行為保留是因為 flash 對個別句子會伺服器端死掛(§synth 註解有實測記錄)。
3. ~~**backtranslate 未關 thinking**~~ → **已做**:產品端 `/api/backtranslate` 與 harness
   `backtranslate.mjs` 同步加 `thinkingConfig.thinkingLevel: "minimal"` + 400 fallback(拿掉重試);
   harness 額外累計 `usageMetadata.thoughtsTokenCount`,結尾印出來驗「稅是否真的關掉」(關成功應為 0)。
4. ~~**harness 重試迴圈沒有成本計數器**~~ → **已做**:`run.mjs`/`judge.mjs` 結尾印呼叫次數與
   **重試放大倍率**(`呼叫數 / 工作數`),故障時一眼看出浪費;`synth.mjs` 同上(第 2 點)。
5. **所有配額仍以秒計**(未修,設計如此):Live 路徑按秒計量是刻意的計費單位套利(見上)。
   **但這條的警告仍然有效**——未來若加任何 token 計價的批次功能(逐字稿摘要之類),
   秒數保險絲對它等於不存在,**上線前必須先補 token 計量**。已列為長期守則。
