# Run 3 計劃(2026-07-29 定稿)

前情:harness 完備、Gate 數字定案(品質 Gemini 4.6/災難 8%、延遲大幅過門檻)、
「問題在耳朵」與 UI 防禦矩陣已驗證(findings §3.5–3.7)。本輪把結論推向**產品**。

## 總覽(依序,R1 不依賴任何人;R2 是主戲)

| # | 項目 | 回答什麼 | 依賴 | 估時 |
| --- | --- | --- | --- | --- |
| R1 | 真人語音驗證 | STT 災難是 TTS 假象還是真風險?(最後一個大 confound) | **使用者錄音** | 錄 15 分鐘 + 跑 0.5h |
| R2 | M3 PWA prototype 上 Cloudflare | 真的能給人用嗎? | 無 | 1.5–2 天 |
| R3 | corpus v2 完備 + 合成 | 下輪評測材料 | R1 順便 | 0.5 天 |
| R4 | Cloudflare 排程 harness(漂移追蹤) | preview 模型會不會悄悄變爛? | R2 的部署鏈 | 0.5 天 |
| R5 | M4 真機 dogfood | 端到端體感、真網路延遲 | R2 | 0.5 天 |

## R1|真人語音驗證(不用寫任何新碼)

**錄音規格**:手機備忘錄 app 即可,安靜環境,一句一檔,正常語速唸 `data/corpus.json` 的句子。
最少錄 **殺手五句 T002/T010/T014/T016/T037**;有 15 分鐘就錄 20 句(加所有 number/negation 句)。
格式不限(m4a/wav 都行),上傳到 session 或 commit 到 `data/audio-human/raw/`。

**流程**:ffmpeg 轉 16kHz mono WAV → 存 `data/audio-human/{id}.wav` → `run.mjs` 加 `--audio-dir` 參數(10 行改動)→ 跑 `human-n3` run → 對照 full-n3 同句。
**判讀**:真人聲下「蝦子→瞎子」「辣→啦」若消失 → TTS 假象,品質數字上修、風險降級;若仍在 → 模型真風險,UI 防禦矩陣升為硬需求。

## R2|M3 PWA prototype(Gate 已過,規格 = 防禦矩陣)

架構(原計劃 §6 + 本輪發現):

1. **Cloudflare Pages(前端)+ Worker(/token + /repair + /backtranslate)**;`wrangler.toml` 沿附錄 B。
2. **金鑰**:瀏覽器不碰 API key。先驗 **ephemeral token**(附錄 F 未驗項);不支援 → Durable Object WS relay 備援。
3. **音訊**:getUserMedia → AudioWorklet 16kHz PCM16、100ms 送框;收 24kHz 播放。PTT 兩顆大鍵(中→日 / 對方→中)。
4. **session 生命週期(計費關鍵,findings §2)**:PTT 放開 → `audioStreamEnd` → 靜音收斂(RMS<500 × 2.5s,provider 已有現成邏輯)→ **主動 close**。絕不掛 session。
5. **防禦層(全部有實測參數)**:
   - input 逐字稿即時上屏(必)
   - 回譯確認:Worker 代理 `gemini-3.5-flash-lite`(~0.4s,必)
   - 專名 glossary 後修:行程頁讓使用者貼地名清單,`claude-haiku` 級後修(Worker 端,選開)
   - 問句修復:原文問句+譯文非問句 → nano 級改寫(選開)
   - 簡繁正規化顯示(rules.mjs 的 T2S 表搬前端)
6. **驗收**:手機瀏覽器實際講 10 句,逐字稿+譯音+回譯全鏈可用;iOS Safari AudioWorklet 列相容性測試。

## R3|corpus v2 完備

`corpus-v2-draft.json`(35 句)→ 補到 50 句(手補或再生成)→ 人工快掃 → Phase A 合成。
合成注意(findings 配額表):**≤10 RPM 節流**;TTS 日限 100,一次跑完;可加 OpenAI `gpt-4o-mini-tts` 當第二音源(順便檢驗 TTS artifact)。

## R4|排程 harness(原計劃的 Cloudflare 化,現在才值得做)

R2 部署鏈打通後,把 runner 包進 Queue consumer(provider 介面不動),Cron 每週跑 v1 語料 50×2×1,報告進 R2 bucket——**追蹤 preview 漂移**(3.5-live-translate 是 preview,品質會變)。門檻:共識 adequacy 掉 >0.3 或災難率 >12% 就告警。

## R5|M4 真機 dogfood

R2 上線後真手機 + 行動網路:量端到端體感延遲(對照 harness 的樂觀下界,預期 +0.5–1.5s)、
iOS 相容性、回音場景。劇本可用 Q6 v2 語料的多句情境。

## 本輪明確不做

- OpenAI realtime 深入並測(結論已足:快但品質差 0.5,備援定位)
- pro 級模型任何用途(配額+費用)
- 更多評審方法學實驗(面板已收斂,r=0.82、偏差 ±0.17,夠了)

## 殘餘資源

- OpenRouter 剩 ~$6(**7/31 過期**):R2 開發期間可拿來當 /repair /backtranslate 的開發測試流量,或不用就算了。
- 貼過對話的 OR key **用完記得 revoke**。
