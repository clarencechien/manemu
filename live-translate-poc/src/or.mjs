// OpenRouter 小客戶端:chat + 盡力 JSON。key 只從 env 讀。
export const OR_KEY = process.env.openrouter_key || process.env.OPENROUTER_API_KEY;
if (!OR_KEY) { console.error("缺 openrouter_key"); process.exit(1); }

export async function orChat(model, prompt, { json = false, timeoutMs = 90000, maxTokens = 2000 } = {}) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", authorization: `Bearer ${OR_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${model} HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  if (d.error) throw new Error(`${model} ${JSON.stringify(d.error).slice(0, 200)}`);
  let text = d.choices?.[0]?.message?.content ?? "";
  if (!json) return text;
  // 各模型 JSON 服從度不一:剝 code fence、抓第一個 {...}
  text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${model} no JSON in response: ${text.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

// 泛用併發 map(輕量,不依賴外部套件)
export async function pmap(items, fn, concurrency = 6) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (err) { out[i] = { __error: String(err.message).slice(0, 200) }; }
    }
  }));
  return out;
}
