/**
 * 🔴 **マニュアルが「描ける」と言っている図に、全部 fixture が在る**(#528、2026-08-29)。
 *
 * ## なぜ要るか
 *
 * `docs/manual.md` の表は **22 行**あるのに、焼けることを見ていた smoke は
 * **5 種だけ**だった ── ⚠ 残り 17 種は 1 つ壊れても誰も気づかない。
 * mermaid の版が上がった日に、**マニュアルが静かに嘘になる**。
 *
 * 🔑 ここは**速い側**(PR gate)で「**名前が揃っているか**」だけを見る。
 * 実際に焼けるかは `tests/smoke/mermaid-all.smoke.spec.ts`(nightly のみ)。
 *
 * ⚠ **集合で見る。件数では見ない**(2026-08-24 #225 の教訓)──
 * 同じ数だけ取り違えても件数は合う。
 * ⚠ **両方向を見る**:マニュアルに在って fixture に無い(= 測っていない)/
 * fixture に在ってマニュアルに無い(= 周知していない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { manualDiagramNames, MERMAID_FORMS } from '../fixtures/mermaid-forms';

const manual = (): string => readFileSync('docs/manual.md', 'utf-8');

describe('図の記法 ── マニュアルと fixture(#528)', () => {
  it('⚠ 空振り防止 ── マニュアルの表を読めている', () => {
    const names = manualDiagramNames(manual());
    expect(names.length, '表を 1 行も読めていない(節の切り方が壊れた)').toBeGreaterThan(15);
    // 🔑 節を切れていないと、本文の別の表に満たされて**増える**
    expect(names.length, '節を切れていない(別の表まで拾っている)').toBeLessThan(40);
    expect(names, '代表の綴りが読めていない').toContain('graph TD');
  });

  it('🔴 マニュアルに在る図は、全部 fixture を持っている(測っていない次元を作らない)', () => {
    const have = new Set(MERMAID_FORMS.map((f) => f.name));
    const missing = manualDiagramNames(manual()).filter((n) => !have.has(n));
    expect(missing, 'マニュアルは描けると言っているのに、確かめる材料が無い').toEqual([]);
  });

  it('🔴 fixture に在る図は、全部マニュアルに載っている(周知していない物を測らない)', () => {
    const listed = new Set(manualDiagramNames(manual()));
    const extra = MERMAID_FORMS.map((f) => f.name).filter((n) => !listed.has(n));
    expect(extra, '確かめているのに、user には知らせていない').toEqual([]);
  });

  it('⚠ 中身が空でない(名前だけ揃えて素通りさせない)', () => {
    for (const f of MERMAID_FORMS) {
      // 🔑 1 行目は**必ず種類の名前で始まる**(mermaid はそこで種類を決める)
      expect(f.src.split('\n')[0], `${f.name} の 1 行目が種類で始まっていない`).toContain(
        f.name.split(' ')[0]!,
      );
      expect(f.src.length, `${f.name} の中身が短すぎる`).toBeGreaterThan(10);
    }
  });

  it('⚠ 名前が重複していない', () => {
    const names = MERMAID_FORMS.map((f) => f.name);
    expect(new Set(names).size, '同じ名前が 2 つある').toBe(names.length);
  });
});
