// §3a 規則檢測:數字完整性 / 否定一致性 / 覆蓋率 / CER。便宜、確定性高。

// 中文/日文漢字數字 → 阿拉伯數字(比對用,涵蓋 0-9999 常見寫法)。
const DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 両: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000, 萬: 10000 };

function cjkNumToInt(str) {
  let total = 0, current = 0, any = false;
  for (const ch of str) {
    if (ch in DIGIT) { current = current * 10 + DIGIT[ch]; any = true; }
    else if (ch in UNIT) { total += (current || 1) * UNIT[ch]; current = 0; any = true; }
    else return null;
  }
  return any ? total + current : null;
}

// 從譯文抽出所有數字(阿拉伯 + 漢字),回傳字串集合。
export function extractNumbers(text) {
  const nums = new Set();
  for (const m of text.matchAll(/\d[\d,]*/g)) nums.add(m[0].replaceAll(",", ""));
  for (const m of text.matchAll(/[零〇一二兩両三四五六七八九十百千万萬]+/g)) {
    const v = cjkNumToInt(m[0]);
    if (v !== null && v > 0) nums.add(String(v));
  }
  // 英文數詞(語料會用到的範圍)
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
    "forty-five": 45, hundred: 100, thousand: 1000,
  };
  const lower = text.toLowerCase();
  for (const [w, v] of Object.entries(words)) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) nums.add(String(v));
  }
  return nums;
}

// 期望的每個數字都要出現(允許 1000↔千 等經 cjk 轉換後匹配)。
export function checkNumbers(expected, outputText) {
  if (!expected?.length) return { ok: true, missing: [] };
  const found = extractNumbers(outputText);
  // 合成數:e.g. 6:30 於英文可能是 "six thirty" → found 有 6 和 30
  const missing = expected.filter((n) => !found.has(String(n)));
  return { ok: missing.length === 0, missing };
}

const NEG_PATTERNS = {
  ja: /(ない|ありません|ません|なし|抜き|いりません|結構です|やめて|やめと|しないで|なくて|なければ|じゃなくて|ではなく|ではありません|無し|禁止|だめ|ダメ|できません|かからない|税抜)/,
  ko: /(안 |않|못 |못해|없|없어|없습니다|말고|마세요|마시|빼 |빼고|빼주|아니|아닙니다|아니에요|금지|말아)/,
  en: /\b(not|no|don't|doesn't|didn't|won't|can't|cannot|isn't|aren't|wasn't|never|without|none|nothing|instead of|rather than|pass on)\b/i,
  "zh-Hant": /(不|沒|別|勿|免|無)/,
};

export function checkNegation(expectNegation, targetLang, outputText) {
  if (!expectNegation) return { ok: true };
  const re = NEG_PATTERNS[targetLang] || NEG_PATTERNS.en;
  return { ok: re.test(outputText) };
}

// 覆蓋率:譯文長度 / 參考譯文長度(抓 code-switch 靜默吞字)。
export function coverageRatio(outputText, referenceText) {
  const norm = (s) => s.replace(/[\s\p{P}]/gu, "");
  const ref = norm(referenceText);
  if (!ref.length) return 1;
  return norm(outputText).length / ref.length;
}

// STT 常輸出簡體、語料為繁體;CER 前先把兩邊都轉成簡體再比,
// 否則簡繁差異會灌高錯誤率(smoke 實測 CER 0.36→其實聽對了)。
// 表僅涵蓋本語料出現的繁體字,新增語料時記得補。
const T2S = {
  丟: "丢", 們: "们", 個: "个", 來: "来", 價: "价", 儲: "储", 兒: "儿", 兩: "两",
  冊: "册", 冰: "冰", 卻: "却", 廁: "厕", 帳: "帐", 幫: "帮", 幾: "几", 張: "张",
  後: "后", 從: "从", 慮: "虑", 應: "应", 房: "房", 掃: "扫", 搭: "搭", 敏: "敏",
  樓: "楼", 機: "机", 橫: "横", 氣: "气", 沒: "没", 淺: "浅", 濱: "滨", 灣: "湾",
  煩: "烦", 熱: "热", 臟: "脏", 藍: "蓝", 號: "号", 蝦: "虾", 裡: "里", 見: "见",
  覺: "觉", 訂: "订", 計: "计", 話: "话", 該: "该", 認: "认", 說: "说", 請: "请",
  謝: "谢", 警: "警", 護: "护", 貴: "贵", 買: "买", 費: "费", 賬: "账", 車: "车",
  較: "较", 辣: "辣", 這: "这", 過: "过", 還: "还", 邊: "边", 錢: "钱", 鐘: "钟",
  開: "开", 間: "间", 陳: "陈", 電: "电", 預: "预", 頭: "头", 飽: "饱", 餐: "餐",
  鮮: "鲜", 麵: "面", 麼: "么", 點: "点", 黴: "霉", 問: "问", 嗎: "吗", 圓: "圆",
  場: "场", 塊: "块", 壞: "坏", 學: "学", 對: "对", 將: "将", 島: "岛", 廳: "厅",
  總: "总", 聯: "联", 絡: "络", 經: "经", 結: "结", 統: "统", 縮: "缩", 縣: "县",
  時: "时", 晚: "晚", 會: "会", 樣: "样", 標: "标", 檢: "检", 歡: "欢", 們: "们",
  興: "兴", 舊: "旧", 藥: "药", 術: "术", 裝: "装", 補: "补", 記: "记", 註: "注",
  證: "证", 讓: "让", 趕: "赶", 銀: "银", 門: "门", 關: "关", 際: "际", 隨: "随",
  雜: "杂", 難: "难", 韓: "韩", 顯: "显", 風: "风", 飛: "飞", 餘: "余", 驗: "验",
  票: "票", 稅: "税", 空: "空", 站: "站", 童: "童", 第: "第", 算: "算", 約: "约",
  素: "素", 級: "级", 給: "给", 網: "网", 緊: "紧", 線: "线", 選: "选", 遲: "迟",
  醫: "医", 鑰: "钥", 長: "长", 項: "项", 願: "愿", 顏: "颜", 類: "类", 飯: "饭",
  館: "馆", 駅: "駅", 驚: "惊", 體: "体", 髮: "发", 鳥: "鸟", 麗: "丽", 齊: "齐",
};
const toSimp = (s) => [...s].map((c) => T2S[c] ?? c).join("");

// 字元錯誤率(CER):inputTranscription vs 原文,先確認「有沒有聽對」。
export function cer(hyp, ref) {
  const norm = (s) => toSimp(s).replace(/[\s\p{P}]/gu, "");
  const a = [...norm(ref)], b = [...norm(hyp)];
  if (!a.length) return b.length ? 1 : 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length] / a.length;
}

export function runRules(phrase, dir, inputTranscript, outputTranscript) {
  const ref = phrase["ref_" + dir] ?? phrase.ref_en;
  const numbers = checkNumbers(phrase.expect.numbers, outputTranscript);
  const negation = checkNegation(phrase.expect.negation, dir, outputTranscript);
  const coverage = coverageRatio(outputTranscript, ref);
  return {
    number_ok: numbers.ok,
    numbers_missing: numbers.missing,
    negation_ok: negation.ok,
    coverage_ratio: Number(coverage.toFixed(3)),
    coverage_ok: coverage >= (phrase.expect.min_len_ratio ?? 0.5),
    cer: Number(cer(inputTranscript, phrase.zh).toFixed(3)),
  };
}
