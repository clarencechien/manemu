# Run 對照:`full-n3` vs `prompt-full-n3`

| | full-n3 | prompt-full-n3 |
|---|---|---|
| model | models/gemini-3.5-live-translate-preview | models/gemini-3.1-flash-live-preview |
| judge | models/gemini-3.1-pro-preview + models/gemini-3.5-flash | models/gemini-3.5-flash |
| n(筆) | 300 | 300 |

## zh → en

| 指標 | full-n3 | prompt-full-n3 |
|---|---|---|
| ttfa_from_end p50 (ms) | -839 | 958 |
| ttfa_from_end p90 (ms) | 339 | 1035 |
| ttfa_from_end p95 (ms) | 486 | 1077 |
| completion_lag p50 (ms) | 2572 | 1824 |
| completion_lag p90 (ms) | 2994 | 2436 |
| ttfa_from_start p50 (ms) | 3153 | 4929 |
| adequacy 平均 | 4.62 | 4.91 |
| fluency 平均 | 4.86 | 4.96 |
| 數字保留率 | 96.0% | 98.7% |
| 否定保留率 | 98.0% | 96.0% |
| 覆蓋率 | 0.97 | 1.00 |
| STT CER | 0.092 | 0.071 |
| omission 旗標 | 10.7% | 2.0% |

## zh → ja

| 指標 | full-n3 | prompt-full-n3 |
|---|---|---|
| ttfa_from_end p50 (ms) | -794 | 964 |
| ttfa_from_end p90 (ms) | 401 | 1053 |
| ttfa_from_end p95 (ms) | 532 | 1087 |
| completion_lag p50 (ms) | 2726 | 1991 |
| completion_lag p90 (ms) | 3368 | 2885 |
| ttfa_from_start p50 (ms) | 3126 | 4938 |
| adequacy 平均 | 4.59 | 4.90 |
| fluency 平均 | 4.87 | 4.94 |
| 數字保留率 | 98.0% | 99.3% |
| 否定保留率 | 98.7% | 98.0% |
| 覆蓋率 | 0.87 | 1.00 |
| STT CER | 0.094 | 0.071 |
| omission 旗標 | 7.3% | 2.7% |

> 注意:completion_lag 是「最後有聲 chunk 到達」;OpenAI 以快於即時的 burst 回音訊,Gemini 近即時串流,所以兩家的 completion_lag 語意不同。跨家比較「對方聽完」請用 ttfa_from_end + 譯音長度(playback-bound 下界)。
