/** @vitest-environment happy-dom */
/**
 * 🔴 **押した所から「どのノートの行か」を引く**(#281 検算 2026-08-30)。
 *
 * ⚠ これは #277 段②-b で 1 度直した罠の**再発**である。あのときは
 * 「カンバンの札は別のノートの行なので、押すと**開いているノートの同じ行番号**を
 * 書き換える」を `data-pkc-entry` で塞いだ。🔴 ところが **#505 の「横に留めた枠」は
 * `data-pkc-split-lid` を焼く**ので、`data-pkc-entry` だけを見る `closest` は
 * `null` を返し、**主の枠のノートへ落ちていた**。
 *
 * ## 守る主張
 *
 * 1. 留めた枠の中で押したら、**その枠の lid** になる(再発の本体)
 * 2. 札(`data-pkc-entry`)は今までどおり ── #277 の直しを壊していない
 * 3. **内側が勝つ**(留めた枠の中に札が在る形。外側の印が内側に勝たない)
 * 4. どちらの印も無ければ落とし先へ(本文の面は印を持たない)
 * 5. 🔴 **`openBody` へ落ちる引き方は 1 か所である** ── 一覧の行を引く `closest` は
 *    正しいので禁じない(1 稿目はそこを禁じて**守れない条件**になっていた)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lidOfNode } from '../../src/adapter/ui/actions/lid-of-node';

/** 印を重ねた木を組んで、いちばん内側の葉を返す。 */
function tree(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const leaf = host.querySelector('[data-pkc-leaf]');
  if (leaf === null) throw new Error('前提が崩れている: data-pkc-leaf が組めていない');
  return leaf;
}

describe('押した所から lid を引く(#281 検算)', () => {
  it('🔴 留めた枠の中で押したら、その枠の lid になる(主の枠へ落ちない)', () => {
    const leaf = tree(
      '<section data-pkc-split-lid="pinned"><p><input data-pkc-leaf></p></section>',
    );
    expect(lidOfNode(leaf, 'main')).toBe('pinned');
  });

  it('札(data-pkc-entry)は今までどおり ── #277 の直しを壊していない', () => {
    const leaf = tree('<li data-pkc-entry="card"><input data-pkc-leaf></li>');
    expect(lidOfNode(leaf, 'main')).toBe('card');
  });

  /**
   * 🔴 **内側が勝つ。** ⚠ 片方ずつ 2 回 `closest` すると、探す順で
   * **外側の印が内側に勝つ**場面ができる ── そこが静かなデータ破壊の入口である。
   *
   * ⚠ **内側を保証しているのは `closest` に両方を渡していること**であって、
   *   `??` の並び順ではない ── 変異試験で確かめた(順を入れ替えても **SURVIVED**。
   *   1 つの要素が両方の印を持つ場面が無いので、並び順は no-op である)。
   *   🔑 だから守るべきは**選択子を 1 本にしていること**であり、それは上の M1
   *   (印から `data-pkc-split-lid` を外す)が KILLED で守られている。
   */
  it('🔴 留めた枠の中に札が在れば、札(内側)が勝つ', () => {
    const leaf = tree(
      '<section data-pkc-split-lid="pinned"><li data-pkc-entry="card"><input data-pkc-leaf></li></section>',
    );
    expect(lidOfNode(leaf, 'main')).toBe('card');
  });

  it('対照群: どちらの印も無ければ落とし先(本文の面は印を持たない)', () => {
    const leaf = tree('<article><p><input data-pkc-leaf></p></article>');
    expect(lidOfNode(leaf, 'main')).toBe('main');
    expect(lidOfNode(leaf, null)).toBeNull();
  });

  it('節点が無ければ落とし先', () => {
    expect(lidOfNode(null, 'main')).toBe('main');
  });

  /**
   * 🔴 **「本文へ書く」側の lid の引き方は 1 か所である**(#281 検算 2026-08-30)。
   *
   * ⚠ 1 稿目のこの検査は「`closest('[data-pkc-entry]')` を自前で書かない」と
   *   書いていたが、**守れない条件**だった ── 一覧の行はまさにその印で引くのが
   *   正しく、binder に 18 か所ある(§1「主張そのものが成り立たない」)。
   * 🔑 危ないのは**その印が見つからなかったとき `openBody?.lid` へ落ちる**引き方だけ
   *   である ── 一覧の行は openBody へ落ちない。だからそこを条件にする。
   */
  it('🔴 openBody へ落ちる lid の引き方は、必ず lidOfNode を通る', () => {
    const src = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8');
    const lines = src.split('\n');
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
      if (!line.includes("closest('[data-pkc-entry]')")) continue;
      // ⚠ 引きと落とし先が 2 行に割れている形も拾う(1 稿目がまさにその形だった)
      const near = lines.slice(i, i + 3).join('\n');
      if (near.includes('openBody')) offenders.push(`binder.ts:${i + 1}`);
    }
    expect(offenders, '自前で引いて openBody へ落ちている(lidOfNode へ寄せる)').toEqual([]);
    // 空振り防止 ── ①その印が実在すること ②寄せた先が実際に呼ばれていること
    expect(
      src.split("closest('[data-pkc-entry]')").length - 1,
      '一覧の行を引く closest まで消えている(この検査が何も見ていない)',
    ).toBeGreaterThan(5);
    // ⚠ 2026-09-05(#684 段②): 一覧の行を本文へ落とす `bodyDropAt` が 4 か所目(落とし先の
    //    本文の lid も同じ 1 本で引く ── 自前の closest を生やさない)
    // ⚠ 2026-09-05(#633 段④): 入れ物の「↑ / ↓」(`moveStackLink`)も lidOfNode を通す → 4 → 5
    // ⚠ 2026-09-05(#708 段①、動線レビュー 欠陥 1): 表を `.csv` で保存する名前も
    //    ここから引く ── 直す前は `selectedLid` を直に読んでいたので、**横に留めた枠の
    //    表から保存すると左の枠のノートの題名**が付いた(この file の冒頭の罠の再発)→ 5 → 6
    expect(src.split('lidOfNode(').length - 1, '本文へ書く 6 か所が寄っていない').toBe(6);
    expect(
      readFileSync('src/adapter/ui/render/place-drag.ts', 'utf8'),
      '板の掴みが寄っていない',
    ).toContain('lidOfNode(');
  });
});
