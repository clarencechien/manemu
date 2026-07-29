// 彙整報告:results.csv + report.html + summary.json(p50/p90/p95、分組統計)。
// 用法:node src/report.mjs <runId>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
if (!runId) { console.error("usage: node src/report.mjs <runId>"); process.exit(1); }
const runDir = path.join(root, "out/runs", runId);
const reportDir = path.join(root, "out/reports", runId);
fs.mkdirSync(reportDir, { recursive: true });

const results = fs.readdirSync(runDir)
  .filter((f) => f.endsWith(".json") && !f.includes("error"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")))
  .sort((a, b) => a.phraseId.localeCompare(b.phraseId) || a.dir.localeCompare(b.dir) || a.repeat - b.repeat);
const errors = fs.readdirSync(runDir).filter((f) => f.includes("error")).length;

const pct = (arr, p) => {
  const v = arr.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
};
const mean = (arr) => {
  const v = arr.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const fmt = (x, d = 0) => (x === null || x === undefined ? "—" : Number(x).toFixed(d));

function latencyStats(rs) {
  const stats = {};
  for (const key of ["ttfa_from_end_ms", "ttft_from_end_ms", "completion_lag_ms", "ttfa_from_start_ms"]) {
    const vals = rs.map((r) => r.latency[key]);
    stats[key] = { p50: pct(vals, 50), p90: pct(vals, 90), p95: pct(vals, 95), mean: mean(vals) };
  }
  return stats;
}
function qualityStats(rs) {
  const judged = rs.filter((r) => r.judge);
  const flagRate = (flag) => judged.length
    ? judged.filter((r) => r.judge.flags[flag]).length / judged.length : null;
  return {
    n: rs.length, judged: judged.length,
    adequacy_mean: mean(judged.map((r) => r.judge.adequacy)),
    fluency_mean: mean(judged.map((r) => r.judge.fluency)),
    number_ok_rate: mean(rs.map((r) => (r.rules.number_ok ? 1 : 0))),
    negation_ok_rate: mean(rs.map((r) => (r.rules.negation_ok ? 1 : 0))),
    coverage_mean: mean(rs.map((r) => r.rules.coverage_ratio)),
    cer_mean: mean(rs.map((r) => r.rules.cer)),
    flags: {
      number_wrong: flagRate("number_wrong"), negation_flipped: flagRate("negation_flipped"),
      honorific_off: flagRate("honorific_off"), name_mangled: flagRate("name_mangled"),
      omission: flagRate("omission"), hallucination: flagRate("hallucination"),
    },
  };
}
const groupBy = (rs, fn) => {
  const g = {};
  for (const r of rs) (g[fn(r)] ??= []).push(r);
  return g;
};

const summary = {
  runId, generatedAt: new Date().toISOString(),
  model: results[0]?.model, judgeModel: results[0]?.judgeModel ?? null,
  runtime: "cc-web-node(非 Cloudflare;延遲為機房乾淨網路的樂觀下界)",
  caveats: [
    "評審使用同家 Gemini 文字模型(無 OpenAI 金鑰),存在自評偏誤風險",
    "gold 參考譯文由 LLM 產生,未經人工校對",
    "TTS 合成音源乾淨、無噪音,品質與延遲皆為樂觀值",
    "CC web 沙箱地理位置不可控,網路段延遲僅供參考,端到端以 M4 真機為準",
  ],
  totals: { results: results.length, errors },
  byDir: {},
};
for (const [dir, rs] of Object.entries(groupBy(results, (r) => r.dir))) {
  summary.byDir[dir] = {
    quality: qualityStats(rs), latency: latencyStats(rs),
    byCategory: Object.fromEntries(
      Object.entries(groupBy(rs, (r) => r.category)).map(([c, cr]) => [c, {
        n: cr.length,
        adequacy_mean: mean(cr.filter((r) => r.judge).map((r) => r.judge.adequacy)),
        ttfa_from_end_p50: pct(cr.map((r) => r.latency.ttfa_from_end_ms), 50),
        ttfa_from_end_p90: pct(cr.map((r) => r.latency.ttfa_from_end_ms), 90),
        completion_lag_p90: pct(cr.map((r) => r.latency.completion_lag_ms), 90),
      }])),
  };
}
fs.writeFileSync(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));

// results.csv
const cols = ["phraseId", "dir", "repeat", "category", "traps", "zh", "inputTranscript", "outputTranscript",
  "inputDurationMs", "outputAudioMs", "ttfa_from_end_ms", "ttft_from_end_ms", "completion_lag_ms", "ttfa_from_start_ms",
  "number_ok", "negation_ok", "coverage_ratio", "cer", "adequacy", "fluency", "judge_flags", "judge_reason", "turnCompleted"];
const csvEsc = (s) => `"${String(s ?? "").replaceAll('"', '""')}"`;
const csv = [cols.join(",")].concat(results.map((r) => [
  r.phraseId, r.dir, r.repeat, r.category, r.traps.join("|"), r.zh, r.inputTranscript, r.outputTranscript,
  r.inputDurationMs, r.outputAudioMs, r.latency.ttfa_from_end_ms, r.latency.ttft_from_end_ms,
  r.latency.completion_lag_ms, r.latency.ttfa_from_start_ms,
  r.rules.number_ok, r.rules.negation_ok, r.rules.coverage_ratio, r.rules.cer,
  r.judge?.adequacy ?? "", r.judge?.fluency ?? "",
  r.judge ? Object.entries(r.judge.flags).filter(([, v]) => v).map(([k]) => k).join("|") : "",
  r.judge?.reason ?? "", r.turnCompleted,
].map(csvEsc).join(","))).join("\n");
fs.writeFileSync(path.join(reportDir, "results.csv"), csv);

// report.html(自包含)
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const latRow = (label, s) => `<tr><td>${label}</td><td>${fmt(s.p50)}</td><td>${fmt(s.p90)}</td><td>${fmt(s.p95)}</td><td>${fmt(s.mean)}</td></tr>`;
const dirSection = (dir, d) => `
<h2>方向:zh → ${dir}</h2>
<h3>延遲(ms,基準=講完那一刻;§4.2)</h3>
<table><tr><th>指標</th><th>p50</th><th>p90</th><th>p95</th><th>mean</th></tr>
${latRow("ttfa_from_end(死氣時間)", d.latency.ttfa_from_end_ms)}
${latRow("ttft_from_end(首字)", d.latency.ttft_from_end_ms)}
${latRow("completion_lag(譯音收完)", d.latency.completion_lag_ms)}
${latRow("ttfa_from_start(對照官方)", d.latency.ttfa_from_start_ms)}
</table>
<h3>品質</h3>
<table>
<tr><th>n</th><th>adequacy</th><th>fluency</th><th>數字OK率</th><th>否定OK率</th><th>覆蓋率</th><th>CER</th></tr>
<tr><td>${d.quality.n}</td><td>${fmt(d.quality.adequacy_mean, 2)}</td><td>${fmt(d.quality.fluency_mean, 2)}</td>
<td>${fmt(d.quality.number_ok_rate * 100, 1)}%</td><td>${fmt(d.quality.negation_ok_rate * 100, 1)}%</td>
<td>${fmt(d.quality.coverage_mean, 2)}</td><td>${fmt(d.quality.cer_mean, 3)}</td></tr>
</table>
<p>評審旗標比例:${Object.entries(d.quality.flags).map(([k, v]) => `${k} ${v === null ? "—" : fmt(v * 100, 1) + "%"}`).join(" · ")}</p>
<h3>各類別</h3>
<table><tr><th>類別</th><th>n</th><th>adequacy</th><th>ttfa_end p50</th><th>ttfa_end p90</th><th>completion p90</th></tr>
${Object.entries(d.byCategory).map(([c, s]) => `<tr><td>${c}</td><td>${s.n}</td><td>${fmt(s.adequacy_mean, 2)}</td><td>${fmt(s.ttfa_from_end_p50)}</td><td>${fmt(s.ttfa_from_end_p90)}</td><td>${fmt(s.completion_lag_p90)}</td></tr>`).join("\n")}
</table>`;

const detailRows = results.map((r) => `<tr>
<td>${r.phraseId}<br><small>${r.dir}#${r.repeat}</small></td>
<td class="zh">${esc(r.zh)}<br><small>STT: ${esc(r.inputTranscript)}</small></td>
<td>${esc(r.outputTranscript)}<br><small>ref: ${esc(r.reference)}</small></td>
<td>${fmt(r.latency.ttfa_from_end_ms)} / ${fmt(r.latency.completion_lag_ms)}</td>
<td>${r.rules.number_ok ? "" : "🔢"}${r.rules.negation_ok ? "" : "🚫"}${r.rules.coverage_ok ? "" : "✂️"} cer=${fmt(r.rules.cer, 2)}</td>
<td>${r.judge ? `${r.judge.adequacy}/${r.judge.fluency}<br><small>${esc(r.judge.reason)}</small>` : "—"}</td>
</tr>`).join("\n");

fs.writeFileSync(path.join(reportDir, "report.html"), `<!doctype html><meta charset="utf-8">
<title>live-translate harness ${esc(runId)}</title>
<style>
body{font-family:system-ui,"Noto Sans TC",sans-serif;margin:24px auto;max-width:1100px;padding:0 16px;line-height:1.5}
table{border-collapse:collapse;margin:8px 0;width:100%}
td,th{border:1px solid #ccc;padding:4px 8px;font-size:13px;text-align:left;vertical-align:top}
th{background:#f4f4f4}small{color:#666}.zh{min-width:180px}
.caveat{background:#fff8e1;border:1px solid #e6c200;padding:8px 12px;border-radius:6px}
</style>
<h1>即時口語翻譯 harness 報告</h1>
<p>runId=<code>${esc(runId)}</code> · model=<code>${esc(summary.model)}</code> · judge=<code>${esc(summary.judgeModel)}</code> · runtime=${esc(summary.runtime)} · ${esc(summary.generatedAt)}</p>
<div class="caveat"><b>解讀前先看的假設/限制:</b><ul>${summary.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
結果筆數 ${summary.totals.results},失敗 ${summary.totals.errors}。門檻參考(§4.4):ttfa_from_end p90 ≤1500ms 順、≤3000ms 可接受、>5000ms 視為不可用。</div>
${Object.entries(summary.byDir).map(([dir, d]) => dirSection(dir, d)).join("\n")}
<h2>逐句明細</h2>
<table><tr><th>句</th><th>原文 / STT</th><th>譯文 / 參考</th><th>ttfa_end / completion (ms)</th><th>規則</th><th>評審 a/f</th></tr>
${detailRows}
</table>`);

console.log(`report → out/reports/${runId}/{report.html,results.csv,summary.json}`);
console.log(JSON.stringify(summary.byDir?.ja?.latency ?? {}, null, 1).slice(0, 400));
