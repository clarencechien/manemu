# live-translate-poc — 即時口語翻譯評測 harness(CC web 可攜版)

對 `gemini-3.5-live-translate-preview` 跑 50 句旅行語料 × 中→日/中→英,自動產出**品質 + 延遲**報告。
這是計劃(`docs/plan.md`)的「先在 CC web 拿數字」版本:同一套 harness 核心之後可包進 Cloudflare Worker(provider 介面見 `src/providers/`),先不蓋 Worker + R2 + Queue 那套。

## 跑法(唯一手動步驟:設金鑰)

```bash
export gemini_key=...        # 或 GEMINI_API_KEY;絕不進 repo/log
npm run synth                # Phase A:TTS 合成 50 句 → data/audio/*.wav(已合成過會跳過)
npm run run -- --repeats 3 --concurrency 3          # Phase B:評測,寫 out/runs/{runId}/
npm run judge -- <runId>     # LLM 評審(adequacy/fluency/flags)
npm run report -- <runId>    # 產 out/reports/{runId}/{report.html,results.csv,summary.json}
```

`run` 常用參數:`--dirs ja,en`、`--only T001,T014`、`--limit 5`、`--net-inject 150`(模擬行動網路,ms)、`--save-audio`(存譯音 wav)。

需求:Node ≥22、網路。在 Claude Code web 沙箱跑需 `NODE_USE_ENV_PROXY=1`(npm scripts 已內建;其他環境無害)。

## 目錄

- `data/corpus.json` — 50 句語料(8 類別,含 number/negation/sentence-final/code-switch/proper-noun/honorific 埋雷),格式見 `docs/plan.md` 附錄 C
- `data/audio/` — Phase A 預合成 16kHz PCM WAV(進 git,保證輸入可重現)
- `src/providers/gemini-live.mjs` — **唯一碰 Gemini Live WS 之處**(TranslateProvider;之後換 Cloudflare/OpenAI 只動這層)
- `src/rules.mjs` — 規則檢測:數字完整性/否定極性/覆蓋率/CER(含簡繁正規化)
- `src/judge.mjs` — LLM 評審(目前以 Gemini 文字模型代打,見下方注意事項)
- `src/report.mjs` — p50/p90/p95 延遲 + 品質彙整報告
- `docs/plan.md` — 原始 PoC 計劃;`docs/findings.md` — **實測驗證過的 API 事實與計劃修正(先讀這份再寫碼)**

## 解讀數字前必讀

1. 延遲是**樂觀下界**:雲端沙箱到 Gemini 的網路 ≠ 台灣/日本手機用戶路徑,TTS 音源乾淨無噪音。端到端結論留給 M4 真機。
2. 評審目前用同家 Gemini 模型(此環境只有一把金鑰),有自評偏誤;有 OpenAI 金鑰後換 `src/judge.mjs` 的 provider。
3. gold 參考譯文由 LLM 產生,尚未人工校對。
