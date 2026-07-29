// 集中設定:金鑰只從環境變數讀,絕不寫入 repo / log / 報告。
export const API_KEY =
  process.env.gemini_key || process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("缺少金鑰:請設定環境變數 gemini_key(或 GEMINI_API_KEY)");
  process.exit(1);
}

export const TRANSLATE_MODEL = "models/gemini-3.5-live-translate-preview";
// 3.1-flash-tts-preview 實測 2026-07-29 會逾時掛住(>3 分鐘無回應),改用 2.5(~3.4s/句)。
export const TTS_MODEL = "models/gemini-2.5-flash-preview-tts";
// 評審模型:使用者拍板全面棄用 pro 級(Tier 1 postpay 按量計費);
// Gemini 端一律 flash 級,異家重評用 OpenAI mini 級(見 docs/run2-plan.md)。
export const JUDGE_MODEL = process.env.JUDGE_MODEL || "models/gemini-3.5-flash";
export const OPENAI_API_KEY = process.env.gpt_key || process.env.OPENAI_API_KEY;
export const OPENAI_JUDGE_MODEL = process.env.OPENAI_JUDGE_MODEL || "gpt-5-mini";
export const OPENAI_REALTIME_MODEL = "gpt-realtime-translate";

export const REST_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const INPUT_SAMPLE_RATE = 16000;   // Live API 輸入:16kHz PCM16 mono LE
export const OUTPUT_SAMPLE_RATE = 24000;  // Live API 輸出:24kHz PCM16 mono LE
export const FRAME_MS = 100;              // 每 100ms 送一框(官方建議)
