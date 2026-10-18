/** @vitest-environment node */
/**
 * 台帳 #1852 束 N1・O1 の配線(`main.ts`)。
 *
 * ⚠ **原文の検査**である(`main.ts` はどの unit からも実行されない ── 判断は各 module に取り出してあり、
 *   ここが守るのは「配線を落としていないか」だけ。弱い検査だと自覚して使う)。
 *   注釈を落としてから見る(「在る」ことの主張で、解説コメントに満たされない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { codeOnly } from '../helpers/code-only';

const MAIN = codeOnly(readFileSync('src/main.ts', 'utf-8'));

describe('main.ts の配線(束 N1・O1)', () => {
  it('🔴 タイマーは控え(store)を渡し、ノートの一覧が読めてから続きを計る(依頼 240)', () => {
    expect(MAIN).toMatch(/createTimerService\(\{[\s\S]*?store: appTimerRuns,[\s\S]*?\}\);/);
    expect(MAIN).toMatch(/whenPhaseReady\(dispatcher, \(\) => undefined\)\.then\(\(\) => timerService\.resume\(\)\)/);
  });

  it('🔴 録音は、取り込めなかったときにファイルへ保存する口を持つ(依頼 239)', () => {
    expect(MAIN).toMatch(/createCaptureService\(\{[\s\S]*?saveFile: \(name, blob\) => downloadBlob\(name, blob\),[\s\S]*?\}\);/);
  });

  it('🔴 切り出しは、元の録音の置き場(parentOf)を引いて、attach へ置き場を渡す(依頼 355)', () => {
    const at = MAIN.indexOf('createCaptureTrimmer({');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, at + 1800);
    expect(block).toContain('parentOf: (lid) =>');
    expect(block).toContain('resolveCanonicalParents(st.entryMetas, st.relations).get(lid)');
    expect(block).toContain('attachOne(dispatcher, attachDeps, item, undefined, place)');
  });

  it('🔴 パソコン側で変わっていたファイルを押し直したら、聞いて取り込み直す(依頼 97-2)', () => {
    expect(MAIN).toMatch(/const reimport = changedItems\[0\];/);
    expect(MAIN).toMatch(/offerReimport\(/);
    expect(MAIN).toContain("dispatcher.dispatch({ type: 'REIMPORT_BODY', lid, body })");
    // 取り込み直さなかった(断った / 読めなかった)回は、これまでの一行へ進む
    expect(MAIN).toMatch(/if \(reimported\) return;/);
    expect(MAIN).toContain('CHANGED_OUTSIDE_REOPEN_NOTE');
  });
});
