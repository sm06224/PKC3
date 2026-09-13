/** @vitest-environment happy-dom */
/**
 * 🔴 **目印の表は「共有の 1 本」**(#857 段② の裁定、2026-09-13)。
 *
 * > user 裁定:「**絵を並べた表にする**(タイルと同じ見た目 + いま付いている絵に枠)」
 *
 * ## なぜこの file が要るか
 *
 * ⚠ 表を出す所が **2 つ**ある:
 *
 * | 出る所 | 押すとどうなるか |
 * |---|---|
 * | 添付の設定(`detail.ts`) | `data-pkc-action="pick-app-icon"` を binder が受ける |
 * | グループの小窓(`app-dialog.ts`) | その場で閉じて、選んだ値が返る |
 *
 * 🔴 **片方だけで見ると、もう片方は渡し忘れても緑になる**
 *   (CLAUDE.md §7「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」)。
 *   だから**両方の呼び側から**見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TILE_ICON_CHOICES } from '../../src/features/icon/tile-icons';
import { ICON_NAME_ATTR, buildIconPalette } from '../../src/adapter/ui/render/icon-palette';

const palette = (current: string): HTMLElement =>
  buildIconPalette({ current, field: 'f', ariaLabel: 'a', each: () => {} });

describe('目印の表(#857 段②)', () => {
  it('🔴 タイルと同じ 49 種 +「なし」が、この順で並ぶ', () => {
    const box = palette('');
    const names = [...box.querySelectorAll('button')].map((b) => b.getAttribute(ICON_NAME_ATTR));
    // ⚠ 空振り防止 ── 正本の一覧が空なら、この検査は何も見ていない
    expect(TILE_ICON_CHOICES.length, '絵の正本が空(空振り)').toBeGreaterThanOrEqual(40);
    expect(names, '先頭が「なし」でない(外す口が先頭に無い)').toEqual([
      '',
      ...TILE_ICON_CHOICES.map((c) => c.name),
    ]);
  });

  it('🔴 いま付いている絵にだけ枠が付く', () => {
    const target = TILE_ICON_CHOICES[3]!.name;
    const box = palette(target);
    const on = [...box.querySelectorAll('button[aria-pressed="true"]')];
    expect(on, '枠が 1 つに決まらない').toHaveLength(1);
    expect(on[0]?.getAttribute(ICON_NAME_ATTR), '別の絵に枠が付いている').toBe(target);
  });

  it('⚠ 何も付いていなければ「なし」に枠が付く', () => {
    const on = [...palette('').querySelectorAll('button[aria-pressed="true"]')];
    expect(on, '枠が 1 つに決まらない').toHaveLength(1);
    expect(on[0]?.getAttribute(ICON_NAME_ATTR), '「なし」に枠が付いていない').toBe('');
  });

  /**
   * 🔴 **表に無い字(絵文字を直に貼った群)には、どこにも枠を付けない。**
   *
   * ⚠ 1 稿目は「**「なし」に落ちる**」と書いて落ちた ── 実装のほうが正しかった。
   * 🔑 その群には**目印が付いている**(🧮)ので、「なし」に枠を付けるのは**嘘**である。
   *   どこにも付かないのが「**この表の中には無い**」という正確な答えになる。
   * ⚠ 実際の経路では `appGroupIconName` が空を返すのでここへは来ないが、
   *   **来たときに嘘をつかない**ことを門にしておく。
   */
  it('🔴 表に無い字が来たら、どこにも枠を付けない(嘘の枠を作らない)', () => {
    const on = [...palette('🧮').querySelectorAll('button[aria-pressed="true"]')];
    expect(on, '表に無い字なのに、どれかに枠が付いた(嘘の枠)').toHaveLength(0);
  });

  it('🔴 押す前に何か分かる道が在る(図案だけのボタンにしているため)', () => {
    const box = palette('');
    for (const b of box.querySelectorAll('button')) {
      expect(b.title, '日本語の呼び名が無い(押す前に何か分からない)').not.toBe('');
    }
  });

  /**
   * 🔴 **両方の呼び側が、この 1 本を通っていること**(§7)。
   * ⚠ どちらかが自前で表を組み直した日に**見た目が割れる**が、
   *   画面を見るまで誰も気づかない ── だから**原文で**見る。
   * ⚠ 弱い形だと自覚して使う(原文 pin)が、**2 本目を書いたら必ず落ちる**。
   */
  it('🔴 表を組む口は 1 つ ── 2 か所とも共有の 1 本を呼んでいる', () => {
    for (const f of [
      'src/adapter/ui/render/detail.ts',
      'src/adapter/ui/render/app-dialog.ts',
    ]) {
      const src = readFileSync(f, 'utf-8');
      expect(src, `${f} が共有の表を呼んでいない(2 本目を書いた)`).toContain('buildIconPalette(');
      expect(src, `${f} が絵の一覧を自前で読んでいる(表が 2 本になる)`).not.toContain(
        'TILE_ICON_CHOICES',
      );
    }
  });

  /**
   * 🔴 **見た目の印は 1 つ**(`data-pkc-palette`)── CSS はこれで当てる。
   * ⚠ `data-pkc-field` の名前で当てると、次に表を足した日に**付け忘れて崩れる**。
   */
  it('🔴 見た目の印が付いていて、CSS もそれで当てている', () => {
    expect(palette('').hasAttribute('data-pkc-palette'), '見た目の印が無い').toBe(true);
    const css = readFileSync('src/styles/app.css', 'utf-8');
    expect(css, 'CSS が印で当てていない').toContain('[data-pkc-palette] button[aria-pressed=');
    expect(css, 'CSS が面の名前で当てたまま(次に足すと崩れる)').not.toContain(
      "[data-pkc-field='app-icon-palette']",
    );
  });
});

/**
 * 🔴 **置き換えで落ちかけた性質**(#857 段②、2026-09-13)。
 *
 * ⚠ グループの小窓は「1 行選ぶ」の器(`pickRowInApp`)から**表へ置き換えた**。
 *   あちらは **`↑` `↓` で行を移れた**が、**その性質は仕様書のどこにも無かった**ので、
 *   表に替えたときに**黙って落ちていた**(CLAUDE.md §10)。
 * ⚠ 落ちると、鍵だけで使う人は **`Tab` を 49 回**押すことになる ── 画面は
 *   1 ドットも変わらないので、**誰も気づかない**。
 * 🔑 だから**原文で**門を置く(happy-dom で `<dialog>` の焦点まで再現するより、
 *   ここは「在ること」を確実に留めるほうが強い)。⚠ 弱い形だと自覚して使う。
 */
describe('置き換えで落とした性質を戻す(§10)', () => {
  it('🔴 表でも矢印で移れる(器を替える前に在った性質)', () => {
    const src = readFileSync('src/adapter/ui/render/app-dialog.ts', 'utf-8');
    const at = src.indexOf('export function pickAppGroupIconInApp(');
    expect(at, '目印の小窓が見つからない(名前が変わった)').toBeGreaterThan(0);
    const body = src.slice(at, at + 4000);
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
      expect(body, `${key} で移れない(鍵だけの人が Tab を 49 回押す)`).toContain(key);
    }
    // ⚠ **外し忘れない** ── 器は使い回すので、次の確認でも矢印が絵を探しにいく
    expect(body, '器に付けた聞き耳を外していない').toContain("removeEventListener('keydown'");
  });
});
