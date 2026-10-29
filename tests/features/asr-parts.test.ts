/** @vitest-environment node */
/**
 * 音声認識の部品の定数と目録の検め(#772 段②)。
 *
 * 守りたい主張:
 *  ① 🔴 **数と取り先は `asr-parts.ts` の 1 か所**(2 択の中身を実機の結果で差し替える日に、
 *     直す場所が 1 つで済む)── 画面の字は全部そこから引く
 *  ② ボタンの字は**大きさと 1 行の説明つき**で、数は定数から出る(手で書かない)
 *  ③ 🔴 **メモリの案内は押す前に出る**(`deviceMemory` が読める端末だけ。読めなければ何も出さない)
 *  ④ 目録を**信じずに検める**(404 の HTML / 欠けた物 / 小さすぎる物 / 外へ出る path)
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../helpers/code-only';
import {
  ASR_PACK_BASE,
  ASR_PARTS,
  ASR_UNAVAILABLE_TEXT,
  asrUnavailableParts,
  asrPackFacts,
  hasFp16Weights,
  ASR_WORKER_IDLE_MS,
  ASR_RUNTIME_FILES,
  ASR_RUNTIME_BYTES,
  asrAssetUrl,
  asrDownloadBytes,
  asrModelFloorBytes,
  asrMemoryNote,
  asrRecommendNote,
  asrModelDir,
  asrPartLabel,
  asrPartOf,
  isSafePackPath,
  readAsrPack,
  type AsrPackFile,
} from '../../src/features/asr/asr-parts';
import { mixToMono } from '../../src/features/asr/asr-pcm';
import { humanBytes } from '../../src/features/human-bytes';
import {
  ASR_SECTION_LABEL,
  transcriptHeading,
  transcriptLines,
  transcriptText,
} from '../../src/features/asr/asr-text';
import { elapsedText } from '../../src/features/elapsed-text';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const sha = 'a'.repeat(64);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const file = (path: string, bytes: number): Mutable<AsrPackFile> => ({ path, bytes, sha256: sha });

/** 目録として通る最小の物。⚠ 名前と大きさは定数から引く(手で並べない)。 */
function manifest(over: Partial<{ runtime: unknown; models: unknown; version: unknown }> = {}): string {
  const models: Record<string, AsrPackFile[]> = {};
  for (const p of ASR_PARTS) {
    models[p.id] = [
      file(`${asrModelDir(p)}config.json`, 800),
      file(`${asrModelDir(p)}onnx/model_quantized.onnx`, p.modelBytes),
    ];
  }
  return JSON.stringify({
    version: 'v1',
    runtime: ASR_RUNTIME_FILES.map((n) => file(n, n.endsWith('.wasm') ? 14_000_000 : 600_000)),
    models,
    ...over,
  });
}

describe('定数は 1 か所(#772 段②)', () => {
  it('3 択で、id と名前が重ならない', () => {
    expect(ASR_PARTS).toHaveLength(3);
    expect(new Set(ASR_PARTS.map((p) => p.id)).size).toBe(3);
    expect(new Set(ASR_PARTS.map((p) => p.modelId)).size).toBe(3);
    expect(new Set(ASR_PARTS.map((p) => p.label)).size).toBe(3);
    expect(asrPartOf('light')?.label).toBe('軽い');
    expect(asrPartOf('accurate')?.label).toBe('正確');
    expect(asrPartOf('turbo')?.modelId).toBe('openai/whisper-large-v3-turbo');
    expect(asrPartOf('nope')).toBeUndefined();
  });

  /**
   * 🔴 **取り先と model の名前は、`src` のどこにも 2 つ目が無い**。
   * ⚠ 見るのは**実行する行**(注釈を落としてから ── 自分の解説に満たされない)。
   */
  it('🔴 取り先 / model の綴りは asr-parts.ts にしか無い', () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (n.endsWith('.ts')) out.push(f);
      }
      return out;
    };
    const files = walk('src');
    expect(files.length, '空振り防止').toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of files) {
      if (f.split('\\').join('/') === 'src/features/asr/asr-parts.ts') continue;
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const needle of [ASR_PACK_BASE, ...ASR_PARTS.map((p) => p.modelId)]) {
        if (code.includes(needle)) hits.push(`${f}: ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('🔴 アイドルで畳むまでの時間は短い(推論の常駐は 1.65〜3.6GB ── 長く置くほど他の作業を圧迫する)', () => {
    // ⚠ 定数を使う側の test は「その定数どおり」にしか見られないので、**定数そのもの**をここで押さえる
    expect(ASR_WORKER_IDLE_MS).toBeGreaterThan(1_000);
    expect(ASR_WORKER_IDLE_MS, '長すぎる(既定の貸し出しの 30 秒を超えている)').toBeLessThanOrEqual(30_000);
  });

  it('取り先は同一オリジンの絶対 path(別 origin は取れない)', () => {
    expect(ASR_PACK_BASE.startsWith('/')).toBe(true);
    expect(ASR_PACK_BASE.endsWith('/')).toBe(true);
    expect(ASR_PACK_BASE).not.toMatch(/^[a-z]+:/i);
  });
});

describe('ボタンの字(大きさと 1 行の説明つき)', () => {
  it('🔴 数は定数から出る ── 手で書いた数に満たされない', () => {
    for (const p of ASR_PARTS.filter((x) => x.estimated !== true)) {
      const label = asrPartLabel(p);
      expect(label.startsWith(p.label)).toBe(true);
      expect(label).toContain(humanBytes(p.modelBytes + ASR_RUNTIME_BYTES));
      expect(label).toContain(`1 分の音に約 ${p.secondsPerMinute} 秒`);
      expect(asrDownloadBytes(p)).toBe(p.modelBytes + ASR_RUNTIME_BYTES);
      expect(asrModelFloorBytes(p)).toBe(p.floorBytes ?? Math.floor(p.modelBytes / 2));
    }
  });

  it('🔴 未測定の見積もりの部品(高精度)は、数字を出さず「未測定」と言う', () => {
    const turbo = asrPartOf('turbo')!;
    expect(turbo.estimated).toBe(true);
    const label = asrPartLabel(turbo);
    expect(label).toContain('未測定');
    expect(label, '見積もりの数字を事実のように出した').not.toMatch(/[0-9]/);
    // 対照群: 測った部品は数字つき
    expect(asrPartLabel(asrPartOf('light')!)).toMatch(/約 \d/);
  });

  it('2 択の字が互いに違う(同じ字の 2 ボタンを作らない)', () => {
    const labels = ASR_PARTS.map(asrPartLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('メモリの案内(押す前に出る)', () => {
  const [light, accurate] = ASR_PARTS as [(typeof ASR_PARTS)[0], (typeof ASR_PARTS)[1]];

  it('🔴 読めない端末では何も出さない(「大丈夫」とも「無理」とも言えない)', () => {
    for (const p of ASR_PARTS) {
      expect(asrMemoryNote(p, undefined)).toBeNull();
      expect(asrMemoryNote(p, Number.NaN)).toBeNull();
      expect(asrMemoryNote(p, 0)).toBeNull();
    }
  });

  it('足りない端末には、メモリの大きさつきで「動かない見込み」と出す', () => {
    const note = asrMemoryNote(light, light.needMemoryGb / 2);
    expect(note).toBe(`この端末のメモリ(${humanBytes((light.needMemoryGb / 2) * 1024 ** 3)})では動かない見込みです`);
    // 🔑 大きさは普段の綴り(`humanBytes`)で出る ── 0.5 GB の端末は MB で言う
    expect(asrMemoryNote(light, 0.5)).toContain('512.0 MB');
  });

  it('足りる端末には出さない(境目は「以上」)', () => {
    expect(asrMemoryNote(light, light.needMemoryGb)).toBeNull();
    expect(asrMemoryNote(accurate, accurate.needMemoryGb)).toBeNull();
    expect(asrMemoryNote(accurate, accurate.needMemoryGb - 1)).not.toBeNull();
  });

  it('重いほうは軽いほうより要るメモリが多い(2 択の意味)', () => {
    expect(accurate.needMemoryGb).toBeGreaterThan(light.needMemoryGb);
  });

  it('⚠ 評価語・脅し語を使わない(事実を述べる)', () => {
    const note = asrMemoryNote(light, 1) ?? '';
    for (const w of ['危険', '壊れ', '破損']) expect(note).not.toContain(w);
  });
});

describe('目録の検め', () => {
  it('通る形は通り、版と 2 択が読める', () => {
    const r = readAsrPack(manifest());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.version).toBe('v1');
    expect(Object.keys(r.pack.models).sort()).toEqual(ASR_PARTS.map((p) => p.id).sort());
  });

  it('🔴 404 の HTML を目録と読まない', () => {
    expect(readAsrPack('<!doctype html><title>404</title>').ok).toBe(false);
    expect(readAsrPack('null').ok).toBe(false);
    expect(readAsrPack('[]').ok).toBe(false);
  });

  it('版が無い / 実行の部品が欠けている・小さすぎる物は断る', () => {
    expect(readAsrPack(manifest({ version: '' })).ok).toBe(false);
    const missing = JSON.parse(manifest()) as { runtime: AsrPackFile[] };
    missing.runtime = missing.runtime.slice(1);
    const r = readAsrPack(JSON.stringify(missing));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain(ASR_RUNTIME_FILES[0]!);
    const tiny = JSON.parse(manifest()) as { runtime: Mutable<AsrPackFile>[] };
    const wasm = tiny.runtime.find((f) => f.path.endsWith('.wasm'))!;
    wasm.bytes = 10;
    expect(readAsrPack(JSON.stringify(tiny)).ok, '切れた wasm を通した').toBe(false);
  });

  it('🔴 重みが小さすぎる(別の model / 途中で切れた)・無い物は断る', () => {
    const m = JSON.parse(manifest()) as { models: Record<string, Mutable<AsrPackFile>[]> };
    const light = m.models['light']!;
    light.find((f) => f.path.endsWith('.onnx'))!.bytes = 1_000_000;
    expect(readAsrPack(JSON.stringify(m)).ok).toBe(false);
    const none = JSON.parse(manifest()) as { models: Record<string, AsrPackFile[]> };
    none.models['light'] = none.models['light']!.filter((f) => !f.path.endsWith('.onnx'));
    expect(readAsrPack(JSON.stringify(none)).ok).toBe(false);
  });

  it('一方だけ配る日があってよい(配っていない 2 択は無い扱い)', () => {
    const m = JSON.parse(manifest()) as { models: Record<string, AsrPackFile[]> };
    delete m.models['accurate'];
    const r = readAsrPack(JSON.stringify(m));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.models.accurate).toBeUndefined();
  });

  it('🔴 外へ出る path・他の model の置き場の file を断る', () => {
    for (const bad of ['../x', '/abs', 'models/../../x', 'a\\b', '', 'a//b']) {
      expect(isSafePackPath(bad), bad).toBe(false);
    }
    expect(isSafePackPath('models/openai/whisper-base/config.json')).toBe(true);
    const m = JSON.parse(manifest()) as { models: Record<string, AsrPackFile[]> };
    m.models['light']!.push(file(`${asrModelDir(ASR_PARTS[1]!)}config.json`, 100));
    expect(readAsrPack(JSON.stringify(m)).ok, '別の model の置き場の file を通した').toBe(false);
  });

  it('sha256 が 64 桁の小文字 hex でなければ断る', () => {
    const m = JSON.parse(manifest()) as { runtime: AsrPackFile[] };
    m.runtime[0] = { ...m.runtime[0]!, sha256: 'xyz' };
    expect(readAsrPack(JSON.stringify(m)).ok).toBe(false);
  });

  it('取り先の URL は path を区切りごとに符号化する', () => {
    expect(asrAssetUrl('https://h/asr-pack/', 'models/Xenova/a b/c.json')).toBe(
      'https://h/asr-pack/models/Xenova/a%20b/c.json',
    );
  });
});

describe('PCM と本文へ足す字', () => {
  it('チャンネルは平均して 1 本にし、1 本のときは写す(transfer で渡せる)', () => {
    const a = new Float32Array([1, 0, -1]);
    const b = new Float32Array([0, 1, -1]);
    expect(Array.from(mixToMono([a, b]))).toEqual([0.5, 0.5, -1]);
    const solo = mixToMono([a]);
    expect(solo).not.toBe(a);
    expect(solo.buffer).not.toBe(a.buffer);
    expect(Array.from(solo)).toEqual([1, 0, -1]);
    expect(mixToMono([])).toHaveLength(0);
    // 長さが違うときは短いほうに合わせる(範囲外で NaN を作らない)
    expect(mixToMono([new Float32Array([1, 1, 1]), new Float32Array([1])])).toHaveLength(1);
  });

  it('見出しは端末の現地時刻で、秒を持たない', () => {
    expect(transcriptHeading(new Date(2026, 9, 2, 9, 5, 30))).toBe('## 文字起こし 2026-10-02 09:05');
  });

  it('字は 1 続きにまとめ、空なら足さない(null)', () => {
    expect(transcriptText('  こんにちは。\n\n  今日は  晴れです。 ')).toBe('こんにちは。 今日は 晴れです。');
    expect(transcriptText('  \n ')).toBeNull();
    expect(transcriptText('')).toBeNull();
  });

  it('🔴 #1232 段 a: 時刻つきの行は「elapsedText の綴り + 空白 + 字」で 1 行ずつ(0 埋めしない)', () => {
    const lines = transcriptLines([
      { startMs: 0, text: ' こんにちは。' },
      { startMs: 15_400, text: '今日は\n  晴れです' },
      { startMs: 754_000, text: '   ' },
      { startMs: 3_723_900, text: 'さようなら' },
    ]);
    expect(lines).toBe(['0:00 こんにちは。', '0:15 今日は 晴れです', '1:02:03 さようなら'].join('\n'));
    // 綴りの正本は 1 本(割り算を新しく書かない)
    expect(lines!.split('\n').map((l) => l.split(' ')[0])).toEqual([0, 15_400, 3_723_900].map(elapsedText));
  });

  it('🔴 #1447: 終わりの時刻があれば「0:07 〜0:12 字」で持つ。終わりが無い・同じ秒・以前なら従来の形', () => {
    const lines = transcriptLines([
      { startMs: 7_000, endMs: 12_400, text: 'こんにちは' },
      { startMs: 20_000, endMs: null, text: '終わり無し' },
      { startMs: 30_000, endMs: 30_900, text: '同じ秒' },
      { startMs: 40_000, endMs: 39_000, text: '以前' },
    ]);
    expect(lines).toBe(['0:07 〜0:12 こんにちは', '0:20 終わり無し', '0:30 同じ秒', '0:40 以前'].join('\n'));
  });

  it('#1232: 使える行が無ければ null(呼び側は今の 1 段落へ倒す)', () => {
    expect(transcriptLines(undefined)).toBeNull();
    expect(transcriptLines([])).toBeNull();
    expect(transcriptLines([{ startMs: 0, text: ' \n ' }])).toBeNull();
  });

  it('#1232: 行は markdown の 1 段落の中で <br> に割れ、時刻は既存の記法に当たらない', () => {
    const html = renderMarkdown('0:15 こんにちは\n0:20 今日は\n1:02:03 おわり');
    expect(html).toContain('0:15 こんにちは<br>');
    expect(html).toContain('0:20 今日は<br>');
    expect(html).toContain('1:02:03 おわり');
    expect((html.match(/<p>/g) ?? []).length, '1 段落のはずが割れた').toBe(1);
  });

  it('入口の名前は「音声認識」(節の見出しと案内が同じ字を引く)', () => {
    expect(ASR_SECTION_LABEL).toBe('音声認識');
  });
});

describe('🔴 #1446 端末ごとの推奨', () => {
  it('必要量の境目で軽い→正確が替わり、読めない値には言わない', () => {
    expect(asrRecommendNote(1)).toContain('「軽い」');
    expect(asrRecommendNote(4)).toContain('「軽い」');
    expect(asrRecommendNote(7.9)).toContain('「軽い」');
    expect(asrRecommendNote(8)).toContain('「正確」');
    for (const v of [undefined, 0, -1, Number.NaN]) expect(asrRecommendNote(v)).toBeNull();
  });

  const FP16 = { unavailable: {}, fp16: { turbo: true } } as const;

  it('🔴 WebGPU が使えると測れ、目録に fp16 の重みがある端末だけに「高精度」を勧める', () => {
    expect(asrRecommendNote(8, true, FP16)).toContain('「高精度」');
    expect(asrRecommendNote(8, true, FP16)).toContain('WebGPU が使えます');
    expect(asrRecommendNote(8, false, FP16), 'WebGPU が無いのに勧めた').toContain('「正確」');
    expect(asrRecommendNote(8, false, FP16)).toContain('WebGPU は使えません');
    expect(asrRecommendNote(8, null, FP16), '測っていないのに勧めた').toContain('「正確」');
    expect(asrRecommendNote(8, null, FP16)).not.toContain('WebGPU');
    // メモリが足りなければ WebGPU があっても勧めない
    expect(asrRecommendNote(4, true, FP16)).toContain('「軽い」');
  });

  it('🔴 目録が未取得 / 失敗(null)・fp16 が無い・配布元に無い、のどれでも高精度は勧めない。WebGPU の字も出さない', () => {
    for (const facts of [null, { unavailable: {}, fp16: { turbo: false } }, { unavailable: { turbo: ASR_UNAVAILABLE_TEXT }, fp16: {} }] as const) {
      const t = asrRecommendNote(8, true, facts)!;
      expect(t).toContain('「正確」');
      expect(t).not.toContain('WebGPU');
    }
  });
});

describe('🔴 fp16 の重みの判定(WebGPU で動かす条件)', () => {
  it('_fp16.onnx で終わる path があるときだけ true(量子化の q8 や名前が似ただけの物は違う)', () => {
    expect(hasFp16Weights(['onnx/encoder_model_fp16.onnx', 'config.json'])).toBe(true);
    expect(hasFp16Weights(['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_q4f16.onnx'])).toBe(false);
    expect(hasFp16Weights(['fp16/readme.txt'])).toBe(false);
    expect(hasFp16Weights([])).toBe(false);
  });
  it('目録から事実を引く: 載っていない部品 / fp16 の有無', () => {
    const turbo = asrPartOf('turbo')!;
    const raw = JSON.parse(manifest()) as { models: Record<string, AsrPackFile[]> };
    raw.models['turbo'] = [file(`${asrModelDir(turbo)}onnx/encoder_model_fp16.onnx`, turbo.floorBytes! + 1)];
    const r = readAsrPack(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asrPackFacts(r.pack)).toEqual({ unavailable: {}, fp16: { light: false, accurate: false, turbo: true } });
    delete raw.models['turbo'];
    const r2 = readAsrPack(JSON.stringify(raw));
    if (r2.ok) expect(asrPackFacts(r2.pack).unavailable).toEqual({ turbo: ASR_UNAVAILABLE_TEXT });
  });
});

describe('🔴 #1446 配布元が置いていない部品', () => {
  it('目録に高精度が無くても、軽い・正確は読め、選べない理由が高精度にだけ付く', () => {
    const raw = JSON.parse(manifest()) as { models: Record<string, unknown> };
    delete raw.models['turbo'];
    const r = readAsrPack(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.pack.models).sort()).toEqual(['accurate', 'light']);
    expect(asrUnavailableParts(r.pack)).toEqual({ turbo: ASR_UNAVAILABLE_TEXT });
  });

  it('対照群:3 つとも載っていれば理由は付かない', () => {
    const r = readAsrPack(manifest());
    expect(r.ok).toBe(true);
    if (r.ok) expect(asrUnavailableParts(r.pack)).toEqual({});
  });

  it('🔴 高精度の目録が壊れていても(小さすぎる)、他の部品の取り込みは壊さない。対照群:軽いが壊れていれば全体が断られる', () => {
    const turbo = asrPartOf('turbo')!;
    const raw = JSON.parse(manifest()) as { models: Record<string, AsrPackFile[]> };
    raw.models['turbo'] = [file(`${asrModelDir(turbo)}onnx/model.onnx`, 1000)];
    const r = readAsrPack(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pack.models.turbo).toBeUndefined();

    raw.models['light'] = [file(`${asrModelDir(asrPartOf('light')!)}onnx/model.onnx`, 1000)];
    expect(readAsrPack(JSON.stringify(raw)).ok).toBe(false);
  });

  it('見積もりより小さい実物(下限以上)の高精度は通る', () => {
    const turbo = asrPartOf('turbo')!;
    const raw = JSON.parse(manifest()) as { models: Record<string, AsrPackFile[]> };
    raw.models['turbo'] = [file(`${asrModelDir(turbo)}onnx/model.onnx`, turbo.floorBytes! + 1)];
    const r = readAsrPack(JSON.stringify(raw));
    expect(r.ok && r.pack.models.turbo !== undefined).toBe(true);
  });
});
