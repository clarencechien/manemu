# OpenRouter 消化計劃(or_plan,2026-07-29)

**背景**:OpenRouter 帳戶有 $13.33 額度,2026-07-31 到期,用不完就蒸發 → 不省、全跑。
OpenRouter 是文字模型路由(OpenAI 相容 API),**沒有 realtime 語音/TTS/STT**,所以全部用在本 PoC 的文字端弱點。key 在 env `openrouter_key`。

## 評審面板(P1 的基礎設施,P2 重用)

五家異廠模型,中文能力優先:

| 角色 | 模型 |
| --- | --- |
| judge-anthropic | `anthropic/claude-sonnet-5` |
| judge-openai | `openai/gpt-5.6-terra` |
| judge-qwen | `qwen/qwen3.7-plus`(中文強) |
| judge-deepseek | `deepseek/deepseek-v3.2`(中文強) |
| judge-mistral | `mistralai/mistral-large-2512` |

## 實驗清單(優先序)

- **P1|多模型評審面板**:full-n3(300)+ gpt-n1(100)各 5 評審 → 共識分數(中位數)、inter-rater 相關、災難句共識名單。產出 `out/experiments/panel-{runId}.json`。一次終結單一評審偏誤問題。
- **P2|文字翻譯品質天花板**:50 句**文字直接餵**5 個強模型翻 ja/en(跳過語音)→ 同面板評 → 對照 live-translate 分數,拆解品質損失來自「聽」還是「譯」;亦即 cascade 架構文字段的上界。翻譯模型:`anthropic/claude-sonnet-5`、`openai/gpt-5.6-terra`、`qwen/qwen3.7-max`、`deepseek/deepseek-v3.2`、`google/gemini-3.6-flash`(評分時剔除同廠評審)。
- **P3|回譯引擎選型**:實驗 1 的 150 筆改用 `anthropic/claude-haiku-4.5`、`openai/gpt-4.1-nano`、`qwen/qwen3.7-flash` 回譯,量偵測率/誤報率/延遲,選 UI 引擎。
- **P4|Gold 參考交叉校對**:3 強模型獨立產 50 句參考譯文 → 互評找分歧 → 「參考可疑」句清單,縮小人工校對範圍。
- **P5|語氣保留偵測**:450 筆結果全量檢查「原文疑問 → 譯文是否仍疑問」,量 T022 型災難的廣度;同時測便宜分類器準確率(UI 提示用)。

## 產出位置

全部進 `out/experiments/`,總結寫回 `docs/findings.md` §3.7。預算估 $5–8;若有剩,P1 面板對 gpt-n1 也全跑 + P2 加模型。
