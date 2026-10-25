/**
 * 🔴 **本物の RNNoise(wasm)を unit で回す台**(#952 B1 ほか)。
 *
 * ⚠ 偽物の雑音除去では「雑音が減る」「遅れを揃える」を確かめられない ── 本物の wasm を node で回す。
 *   `@shiguredo/rnnoise-wasm` は `window` か `WorkerGlobalScope` が無いと読み込みを断る作りなので、node では `window` を仮に置く。
 */
import type { EngineHandle } from '../../src/adapter/platform/voice/voice-run';

type Mod = typeof import('@shiguredo/rnnoise-wasm');
let loading: Promise<Awaited<ReturnType<Mod['Rnnoise']['load']>>> | null = null;

/** 本物のエンジンを 1 つ作る(wasm の読み込みはプロセスで 1 度)。 */
export async function realEngine(): Promise<EngineHandle> {
  (globalThis as { window?: unknown }).window ??= globalThis;
  loading ??= import('@shiguredo/rnnoise-wasm').then((m) => m.Rnnoise.load());
  const rn = await loading;
  const state = rn.createDenoiseState();
  return { process: (frame) => state.processFrame(frame), destroy: () => state.destroy() };
}

// ---------------------------------------------------------------------------------------------
// 合成の声(声門パルス列を 3 つの共鳴器に通す)。⚠ 実測:F0 120Hz /a/ は RNNoise が声と判定する(vad 0.97)
// ---------------------------------------------------------------------------------------------

export interface VoiceSpec {
  readonly f0: number;
  readonly formants: ReadonlyArray<readonly [number, number]>;
}

export const VOICE_A: VoiceSpec = { f0: 120, formants: [[700, 90], [1200, 110], [2600, 150]] };

/** 合成の声(48kHz, ±0.5)。`syllableHz` で音節の強弱をつける。 */
export function synthVoice(seconds: number, spec: VoiceSpec = VOICE_A, rate = 48_000, syllableHz = 4): Float32Array {
  const n = Math.floor(rate * seconds);
  const out = new Float32Array(n);
  const res = spec.formants.map(([f, bw]) => {
    const r = Math.exp((-Math.PI * bw) / rate);
    const th = (2 * Math.PI * f) / rate;
    return { a1: -2 * r * Math.cos(th), a2: r * r, y1: 0, y2: 0 };
  });
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    phase += (spec.f0 * (1 + 0.08 * Math.sin(2 * Math.PI * 3 * t))) / rate;
    let y = 0;
    if (phase >= 1) {
      phase -= 1;
      y = 1;
    }
    for (const r of res) {
      const ny = y - r.a1 * r.y1 - r.a2 * r.y2;
      r.y2 = r.y1;
      r.y1 = ny;
      y = ny;
    }
    out[i] = y * (0.5 + 0.5 * Math.sin(2 * Math.PI * syllableHz * t - 1.2));
  }
  let m = 0;
  for (const v of out) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i += 1) out[i] = (out[i]! / m) * 0.5;
  return out;
}

/** 疑似乱数(再現できる白色雑音)。 */
export function whiteNoise(n: number, amp: number, seed = 7): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i += 1) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}
