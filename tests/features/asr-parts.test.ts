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
  ASR_WORKER_IDLE_MS,
  ASR_RUNTIME_FILES,
  ASR_RUNTIME_BYTES,
  asrAssetUrl,
  asrDownloadBytes,
  asrModelFloorBytes,
  asrMemoryNote,
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
  it('2 択で、id と名前が重ならない', () => {
    expect(ASR_PARTS).toHaveLength(2);
    expect(new Set(ASR_PARTS.map((p) => p.id)).size).toBe(2);
    expect(new Set(ASR_PARTS.map((p) => p.modelId)).size).toBe(2);
    expect(asrPartOf('light')?.label).toBe('軽い');
    expect(asrPartOf('accurate')?.label).toBe('正確');
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
    for (const p of ASR_PARTS) {
      const label = asrPartLabel(p);
      expect(label.startsWith(p.label)).toBe(true);
      expect(label).toContain(humanBytes(p.modelBytes + ASR_RUNTIME_BYTES));
      expect(label).toContain(`1 分の音に約 ${p.secondsPerMinute} 秒`);
      expect(asrDownloadBytes(p)).toBe(p.modelBytes + ASR_RUNTIME_BYTES);
      expect(asrModelFloorBytes(p)).toBe(Math.floor(p.modelBytes / 2));
    }
  });

  it('2 択の字が互いに違う(同じ字の 2 ボタンを作らない)', () => {
    const [a, b] = ASR_PARTS.map(asrPartLabel);
    expect(a).not.toBe(b);
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
