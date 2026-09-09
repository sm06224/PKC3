/**
 * 🔴 **触った物から smoke を引く規則**(#820)。
 *
 * ⚠ この道具が守るのは**時間**であって正しさではない。だから検査するのは
 * 「速いこと」ではなく「**読めない物を見たら必ずフルへ倒れること**」である
 * ── 外したときの害は「確かめていないものを確かめたと言うこと」なので、
 * **倒れ損なう向きの誤りだけが本当の欠陥**である(CLAUDE.md「回さなすぎのほうが害が大きい」)。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 引く規則は素の .mjs(ビルド対象外の CI script 群)
import { pickSmoke } from '../scripts/pick-smoke.mjs';

type Map = {
  src?: string[];
  specs?: Record<string, number[]>;
  always?: string[];
};
type Result = { mode: 'full' | 'pick'; specs: string[]; why: string };
const pick = pickSmoke as (changed: readonly string[], map: Map | null) => Result;

const MAP: Map = {
  src: ['src/a.ts', 'src/b.ts', 'src/lonely.ts'],
  specs: { 'x.smoke.spec.ts': [0], 'y.smoke.spec.ts': [0, 1] },
  always: [],
};

describe('引ける場合', () => {
  it('その file を動かした spec だけを引く', () => {
    expect(pick(['src/b.ts'], MAP)).toMatchObject({
      mode: 'pick',
      specs: ['tests/smoke/y.smoke.spec.ts'],
    });
  });

  it('2 本が動かしていれば 2 本とも引く', () => {
    expect(pick(['src/a.ts'], MAP).specs).toEqual([
      'tests/smoke/x.smoke.spec.ts',
      'tests/smoke/y.smoke.spec.ts',
    ]);
  });

  it('spec そのものを触ったら、その spec を引く', () => {
    expect(pick(['tests/smoke/z.smoke.spec.ts'], MAP).specs).toEqual([
      'tests/smoke/z.smoke.spec.ts',
    ]);
  });

  /**
   * ⚠ **smoke が 1 度も動かしていない file** ── 走らせても何も変わらないので
   * 引かないが、**黙って 0 本にしない**(理由を残す)。
   */
  it('smoke が動かしていない file は、引かないが名前を残す', () => {
    const r = pick(['src/lonely.ts'], MAP);
    expect(r.mode).toBe('pick');
    expect(r.specs).toEqual([]);
    expect(r.why).toContain('src/lonely.ts');
  });

  /** 🔴 被覆を取れなかった spec は「分からない」なので、毎回走らせる。 */
  it('記録が取れなかった spec は、何を触っても必ず入る', () => {
    const r = pick(['src/b.ts'], { ...MAP, always: ['w.smoke.spec.ts'] });
    expect(r.specs).toContain('tests/smoke/w.smoke.spec.ts');
  });
});

describe('🔴 フルへ倒れる場合(倒れ損なうのが唯一の本当の欠陥)', () => {
  it('表に無い file(新しく足した)→ フル', () => {
    expect(pick(['src/new.ts'], MAP).mode).toBe('full');
  });

  /**
   * 🔴 **この 1 本だけは、門を 1 つずつ分けて見る**(CLAUDE.md §1「救い手が
   * 変わっただけ」)。⚠ `.css` を表に**載せない**まま試すと、`.css` の門を
   * 丸ごと消しても「表に無い」の門が救って**フルのまま**になる ──
   * それでは `.css` の門が生きているか 1 度も見ていない。
   * 🔑 だから**表に載っていて、しかも spec が動かしている** `.css` で試す。
   */
  it('見た目は、表に載っていてもフル(被覆に映らないため)', () => {
    const withCss: Map = {
      src: ['src/a.ts', 'src/styles/app.css'],
      specs: { 'x.smoke.spec.ts': [0, 1] },
      always: [],
    };
    // ⚠ 対照群 ── 同じ表で `.ts` を触れば引ける(表そのものが生きている)
    expect(pick(['src/a.ts'], withCss).mode).toBe('pick');
    expect(pick(['src/styles/app.css'], withCss).mode).toBe('full');
  });

  /**
   * ⚠ 土台と「src の外」は**どちらもフル**なので、結果だけ見ると区別できない。
   * 🔑 **理由の字**まで見る ── フルになった理由が読めないと、次に読む人は
   * 「なぜ 13 分待つのか」が分からず、規律ごと信じなくなる。
   */
  it.each([
    ['tests/smoke/helpers.ts', '土台'],
    ['tests/smoke/plain-server.mjs', '土台'],
    ['tests/smoke/playwright.config.ts', '土台'],
    ['docs/manual.md', 'src の外'],
    ['vite.config.ts', 'src の外'],
    ['build/sw-plugin.ts', 'src の外'],
  ])('%s → フル(理由に「%s」が出る)', (path, word) => {
    const r = pick([path], MAP);
    expect(r.mode).toBe('full');
    expect(r.why).toContain(word);
  });

  it.each([
    ['対応表が無い', null],
    ['対応表が空', { src: [], specs: {} }],
  ])('%s → フル', (_name, map) => {
    expect(pick(['src/a.ts'], map as Map | null).mode).toBe('full');
  });

  /**
   * ⚠ **表そのものを触ってもフルにしない** ── 作り直せば必ず差分に出るので、
   * 土台と数えると「作り直した PR は最後までフル」になり、道具が死ぬ。
   */
  it('対応表そのものを触っても、引ける物は引ける', () => {
    const r = pick(['tests/smoke/smoke-map.json', 'src/b.ts'], MAP);
    expect(r.mode).toBe('pick');
    expect(r.specs).toEqual(['tests/smoke/y.smoke.spec.ts']);
  });

  /** ⚠ 1 件でも読めない物が混じったら、他が引けてもフルである。 */
  it('引ける物と読めない物が混じったら、混ざった時点でフル', () => {
    expect(pick(['src/a.ts', 'src/new.ts'], MAP).mode).toBe('full');
  });
});
