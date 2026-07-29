# Run 2 計劃(2026-07-29)

full-n3 之後的三個實驗。使用者拍板的前提:

- **全面棄用 pro 級模型**(Tier 1 postpay,pro 按量計費會失控):評審/回譯一律 flash 級或 GPT mini 級。`config.mjs` 的 `JUDGE_MODEL` 預設改為 `gemini-3.5-flash`。
- OpenAI 金鑰已入 env(`gpt_key`),重評與並測都用非旗艦級模型。
- 文件隨做隨更新進 repo。

## 實驗 1|回譯確認通道可行性(+ 每次回譯延遲)

**問題**:UI 給不懂日文的使用者一條「日文輸出 → 回譯中文」的確認通道,抓得到災難級錯譯嗎?會不會誤報到狼來了?

**方法**(資料已在 `out/runs/full-n3/`,不需新錄音):

1. 取 150 筆 zh→ja 的 `outputTranscript`,用 `gemini-3.5-flash`(temperature 0)回譯繁中,**逐筆量 wall-clock 延遲**(決定 UI 即時顯示或延遲一拍)。
2. 分組:Gemini 評審 adequacy ≤2 的「災難組」 vs adequacy ≥4 的「正常組」。
3. 用 flash 對「原話 vs 回譯」打語意等價分(1–5)+「使用者讀了會不會察覺意思不同」bool。
4. 指標:災難組偵測率、正常組誤報率、延遲 p50/p90。

**預期限制**:抓「錯誤已固化進輸出」的問題;敬語失當、STT 聽錯但譯文自洽的細節抓不到 → 是 input 逐字稿的補充,不是替代。

## 實驗 2|gpt-5-mini 異家重評(消自評偏誤 confound)

1. `judge.mjs` 加 OpenAI provider(`JUDGE_PROVIDER=openai`,chat completions + JSON schema,模型 `gpt-5-mini`)。
2. 重評 full-n3 全部 300 筆,寫入**新欄位 `judge_x`**(保留原 Gemini `judge` 不覆蓋)。
3. 一致性分析:adequacy 相關/平均差、各 flag 的 agreement,災難組(≤2)兩家是否指認同一批句子。
4. 結論寫進 findings:若兩家分數一致 → full-n3 的品質數字可信;不一致 → 以異家為準重新解讀。

## 實驗 3|gpt-realtime-translate 並測(harness 可攜性驗證)

**已驗證的 API 形狀**(與 Gemini 差異大,正好測 provider 介面):

| | Gemini live-translate | OpenAI gpt-realtime-translate |
| --- | --- | --- |
| 端點 | `wss://…/BidiGenerateContent?key=` | `wss://api.openai.com/v1/realtime/translations?model=…` + Bearer header |
| 輸入音訊 | 16kHz PCM16 | **24kHz** PCM16(送框前重取樣) |
| 目標語 | `translationConfig.targetLanguageCode` | `session.update` → `session.audio.output.language` |
| 送框 | `realtimeInput.audio` | `session.input_audio_buffer.append` |
| 講完訊號 | `audioStreamEnd`(之後**無限靜音串流**,要自己靜音收斂) | `session.close` → flush 後回 `session.closed`(乾淨收尾) |
| 事件 | `serverContent.*` | `session.{input_transcript,output_transcript,output_audio}.delta` |

**步驟**:

1. `src/providers/openai-realtime.mjs` 實作同一個 Session 介面;`run.mjs` 加 `--provider` 參數。
2. 先 50×2×**1**(100 sessions)控制費用,run id `gpt-n1`;確認品質/成本後再決定是否加 repeats。
3. `src/compare.mjs`:兩個 run 的 summary 併表(延遲三指標 + 品質),寫進 findings。
4. 評審同樣走實驗 2 的雙評審(Gemini flash + gpt-5-mini),兩個 run 才可比。

## 執行順序與風險

1(不依賴新東西)→ 2(判 full-n3 可信度)→ 3(最大未知:realtime-translate 是新 API,欄位名可能與文件有出入,邊做邊修)。

風險:OpenAI realtime 計價按音訊 token,100 短句 session 估 <$5,先跑 N=1;`session.input_audio_buffer.append` 等事件名以實測為準;兩家 STT 弱點不同,對照時 rules/judge 同一套才公平。
