// PCM16 mono 小工具:WAV 讀寫、重取樣、切框。
export function wavEncode(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavDecode(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
  let offset = 12;
  let sampleRate = null, data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = buf.readUInt32LE(offset + 12);
    if (id === "data") data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!sampleRate || !data) throw new Error("bad WAV");
  return { sampleRate, pcm: data };
}

// 線性內插重取樣(24k→16k 等);PoC 用途足夠,不追求音質。
export function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inSamples = pcm.length / 2;
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = (i * fromRate) / toRate;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

// 切成每框 frameMs 的 PCM 塊(最後一框可較短)。
export function frames(pcm, sampleRate, frameMs) {
  const bytesPerFrame = Math.floor((sampleRate * frameMs) / 1000) * 2;
  const out = [];
  for (let o = 0; o < pcm.length; o += bytesPerFrame) {
    out.push(pcm.subarray(o, Math.min(o + bytesPerFrame, pcm.length)));
  }
  return out;
}

export function silence(sampleRate, ms) {
  return Buffer.alloc(Math.floor((sampleRate * ms) / 1000) * 2);
}

export function durationMs(pcm, sampleRate) {
  return (pcm.length / 2 / sampleRate) * 1000;
}
