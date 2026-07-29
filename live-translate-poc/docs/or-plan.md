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

---

# 第二波(or-plan2):P1–P5 花費僅 ~$5,再消化剩餘 ~$7

原則:不為燒而燒——每個實驗都要回答一個 UI/產品問題,或直接產出下一輪的材料。按價值排:

## Q1|STT 合理性偵測器(無 ground truth 的聽錯偵測)★最高價值

**產品問題**:真實 UI 裡沒有「原話 ground truth」,app 只有 STT 逐字稿。模型能不能光看逐字稿(語境合理性)就標出「這句可能聽錯了」?——「我對**瞎子**過敏」語意詭異,模型應該抓得到。
**方法**:400 筆已標籤資料(known-mishear vs clean),給模型**只看 STT 逐字稿**判「是否疑似聽錯 + 哪個詞」;量偵測率/誤報率。成功的話這是 UI 的**第三層防線**(input 逐字稿、回譯之外),且不需要任何 ground truth。
**成本**:~$1.5(sonnet + 便宜模型各跑一輪,順便選型)

## Q2|專有名詞 glossary 後修復(修最痛的共同弱點)

**產品問題**:新宿→新竹/幻覺路線名是兩家共同最爛的地方,而 live-translate 不吃術語表。測試:譯文出來後,拿「行程 glossary」(車站/地名清單)用便宜模型後修(post-edit)譯文,能救回幾成 proper-noun 災難?
**方法**:對 known proper-noun 錯誤筆(T002/T010/T005/T028 等 × repeats)+ 對照組,給 glossary + 譯文 → 修正;評修復率與誤修率。
**成本**:~$1

## Q3|問句語氣修復(修共同的語氣災難)

**產品問題**:P5 證實兩家都丟問句(9%/17%)。測試:src_is_question(UI 端可從原文逐字稿判)+ 譯文非問句時,便宜模型把譯文改回問句形,正確率多少?
**方法**:P5 抓到的 21 筆 lost-question + 對照組,修復 → 面板抽評。
**成本**:~$0.5

## Q4|災難根因分類(Gate 報告的錯誤分類表)

**方法**:面板共識災難句(~40 筆)由 sonnet 做結構化根因分類(STT 同音/專名/問尾/截斷/翻譯錯/幻覺 × 責任階段),產出報告用的錯誤分類表。
**成本**:~$0.5

## Q5|bt-select 補 en 方向(完成 P3)

**方法**:同 P3,對 150 筆 zh→en 輸出跑 3 引擎回譯選型(en→zh 回譯給不諳英文的使用者)。
**成本**:~$0.5

## Q6|語料 v2 草稿(下一輪的材料)

**方法**:針對本輪暴露的弱點加重埋雷(專名密集、多句連講、更長句、數字+單位混合、閩南語腔詞彙),3 強模型各產 25 句 → 互審 → 合併成 corpus-v2 草稿(含 refs,P4 同款交叉校對)。**這是給「真人錄音版」與 M4 用的材料**。
**成本**:~$1.5

## Q7|評審分歧分析(方法論)

**方法**:面板中 adequacy range ≥3 的高分歧句,sonnet 分析各評審的系統性偏差(誰對敬語嚴、誰對數字嚴),寫進方法論附註。
**成本**:~$0.3

**合計 ~$6**,加上第一波 ~$5.5,總計 ~$11.5/13.3。執行順序 Q1→Q2→Q3→Q4(UI 三層防線+修復)先於 Q5–Q7(補完+材料)。
