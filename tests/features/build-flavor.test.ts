/** @vitest-environment node */
/**
 * どの版のビルドか(`__PKC_PORTABLE__`。#674 / #949)── 1 枚にまとめた版では音源分離を使えないことを、押す前の字と押した後の理由で言う。
 *
 * 守りたい主張:
 *  ① 通常の版(定義 false / 定義なし)では何も変わらない
 *  ② 🔴 1 枚にまとめた版(true)では、項目の字と説明が「使えません」になり、道具は何もせず理由を返す
 *  ③ ビルドの設定: 通常の版が false、1 枚の版が true で焼く(取り違えると、通常の版で使えなくなる / 1 枚の版に 14.5MB が畳まれる)
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load(portable: boolean | undefined) {
  vi.resetModules();
  if (portable === undefined) vi.unstubAllGlobals();
  else vi.stubGlobal('__PKC_PORTABLE__', portable);
  const flavor = await import('../../src/features/build-flavor');
  const proc = await import('../../src/features/capture/capture-process');
  return { flavor, proc };
}

describe('版の判定', () => {
  it('① 通常の版(false / 定義なし)', async () => {
    for (const v of [false, undefined] as const) {
      const { flavor, proc } = await load(v);
      expect(flavor.IS_PORTABLE_BUILD).toBe(false);
      const spec = proc.processToolOf('separate-stems')!;
      expect(spec.label).toBe('歌声と楽器に分ける(試験的)');
      expect(spec.title).not.toContain('使えません');
    }
  });

  it('② 1 枚にまとめた版: 項目の字・説明が使えない旨になる', async () => {
    const { flavor, proc } = await load(true);
    expect(flavor.IS_PORTABLE_BUILD).toBe(true);
    const spec = proc.processToolOf('separate-stems')!;
    expect(spec.label).toContain('このビルドでは使えません');
    expect(spec.title).toBe(flavor.STEM_PORTABLE_UNAVAILABLE);
  });

  it('② 1 枚にまとめた版: 道具は取得も復号もワーカーも始めず、理由を返す', async () => {
    vi.resetModules();
    vi.stubGlobal('__PKC_PORTABLE__', true);
    const { createCaptureTools } = await import('../../src/adapter/ui/actions/capture-tools');
    const { STEM_PORTABLE_UNAVAILABLE } = await import('../../src/features/build-flavor');
    const never = vi.fn();
    const tools = createCaptureTools({
      obtainStemModel: never,
      probeStems: never,
      decodeStereo44k: never,
      stems: never,
      scenes: never,
    } as never);
    const out = await tools['separate-stems']!({
      item: { kind: 'audio' } as never,
      blob: new Blob([]),
      progress: () => {},
      readBody: async () => null,
    });
    expect(out).toEqual({ kind: 'refused', text: STEM_PORTABLE_UNAVAILABLE });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('③ ビルドの設定', () => {
  it('通常の版は false、1 枚の版は true で焼く', () => {
    expect(readFileSync('vite.config.ts', 'utf-8')).toMatch(/__PKC_PORTABLE__:\s*'false'/);
    expect(readFileSync('build/portable.config.ts', 'utf-8')).toMatch(/__PKC_PORTABLE__:\s*'true'/);
  });
  it('fold は ONNX Runtime の参照が残ったら落ちる(門が在る)', () => {
    const fold = readFileSync('build/portable/fold.mjs', 'utf-8');
    expect(fold).toContain('ort-wasm-simd-threaded');
    expect(fold).toContain('ONNX Runtime の参照が残っている');
  });
});
