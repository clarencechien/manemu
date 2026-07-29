# Run 對照:`full-n3` vs `gpt-n1`

| | full-n3 | gpt-n1 |
|---|---|---|
| model | models/gemini-3.5-live-translate-preview | gpt-realtime-translate |
| judge | models/gemini-3.1-pro-preview + models/gemini-3.5-flash | models/gemini-3.5-flash |
| n(筆) | 300 | 100 |

## zh → en

| 指標 | full-n3 | gpt-n1 |
|---|---|---|
| ttfa_from_end p50 (ms) | -839 | -1589 |
| ttfa_from_end p90 (ms) | 339 | -614 |
| ttfa_from_end p95 (ms) | 486 | -386 |
| completion_lag p50 (ms) | 2572 | 647 |
| completion_lag p90 (ms) | 2994 | 881 |
| ttfa_from_start p50 (ms) | 3153 | 2173 |
| adequacy 平均 | 4.62 | 4.24 |
| fluency 平均 | 4.86 | 4.60 |
| 數字保留率 | 96.0% | 100.0% |
| 否定保留率 | 98.0% | 96.0% |
| 覆蓋率 | 0.97 | 1.05 |
| STT CER | 0.092 | 0.127 |
| omission 旗標 | 10.7% | 10.0% |

## zh → ja

| 指標 | full-n3 | gpt-n1 |
|---|---|---|
| ttfa_from_end p50 (ms) | -794 | -1139 |
| ttfa_from_end p90 (ms) | 401 | -162 |
| ttfa_from_end p95 (ms) | 532 | 72 |
| completion_lag p50 (ms) | 2726 | 710 |
| completion_lag p90 (ms) | 3368 | 1085 |
| ttfa_from_start p50 (ms) | 3126 | 2537 |
| adequacy 平均 | 4.59 | 4.04 |
| fluency 平均 | 4.87 | 4.32 |
| 數字保留率 | 98.0% | 98.0% |
| 否定保留率 | 98.7% | 98.0% |
| 覆蓋率 | 0.87 | 0.90 |
| STT CER | 0.094 | 0.123 |
| omission 旗標 | 7.3% | 12.0% |

> 注意:completion_lag 是「最後有聲 chunk 到達」;OpenAI 以快於即時的 burst 回音訊,Gemini 近即時串流,所以兩家的 completion_lag 語意不同。跨家比較「對方聽完」請用 ttfa_from_end + 譯音長度(playback-bound 下界)。
