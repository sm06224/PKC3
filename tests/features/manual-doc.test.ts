/**
 * 🔴 **マニュアルの窓の組み立て**(#645)。
 *
 * ここが守るのは 1 つ ── **目次の行を押したら、必ずその見出しへ着く**。
 * ⚠ 「押しても何も起きない行」は、この repo がいちばん嫌う形である。
 */
import { describe, expect, it } from 'vitest';
import {
  buildManualDoc,
  MANUAL_HEADING_ID,
  manualHeadingSlug,
} from '../../src/features/help/manual-doc';
import { manualSections } from '../../src/features/help/manual-find';
import { MANUAL_TEXT } from '../../src/adapter/ui/render/help';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/**
 * 🔑 **実装の綴りを 1 文字も見ない観測**(CLAUDE.md §1)── 出来上がった HTML から
 * `id` を**別に拾い直す**。実装と同じ式で期待値を組むと、同じ盲点を共有する。
 */
function idsIn(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/giu)) out.add(m[1]!);
  return out;
}

describe('マニュアルの窓 — 目次と本文の対応', () => {
  it('🔴 目次の飛び先は、すべて本文に在る(実物のマニュアルで)', () => {
    const sections = manualSections(MANUAL_TEXT);
    const built = buildManualDoc(renderMarkdown(MANUAL_TEXT, {}), sections);
    // ⚠ 空振り防止:節も目次も 0 件でないこと
    expect(sections.length, '節が 0 件').toBeGreaterThan(100);
    expect(built.toc.length, '目次が 0 件').toBeGreaterThan(100);
    const ids = idsIn(built.html);
    const dead = built.toc.filter((t) => !ids.has(t.targetId));
    expect(dead, '押しても何も起きない行がある').toEqual([]);
  });

  it('🔴 源文の節と、描かれた見出しの数が一致する(160 = 160 の対応)', () => {
    const sections = manualSections(MANUAL_TEXT);
    const built = buildManualDoc(renderMarkdown(MANUAL_TEXT, {}), sections);
    // ⚠ 先頭の節(見出しより前)は番号を持たない ── 目次には出ない
    const numbered = sections.filter((s) => s.index >= 0);
    expect(built.headings).toBe(numbered.length);
    expect(built.toc).toHaveLength(numbered.length);
  });

  it('🔴 h4 以下にも飛び先が付く(描画が付けるのは h1〜h3 だけ)', () => {
    const html = renderMarkdown(MANUAL_TEXT, {});
    const withId = (html.match(/<h[1-6][^>]*\sid="/giu) ?? []).length;
    const all = (html.match(/<h[1-6]/giu) ?? []).length;
    // ⚠ 前提:描画は一部にしか id を付けていない(付けていたら、この節は要らない)
    expect(withId, '前提が崩れている(描画が全部に id を付けている)').toBeLessThan(all);
    const built = buildManualDoc(html, manualSections(MANUAL_TEXT));
    expect(idsIn(built.html).size).toBe(all);
    // 深い見出しが目次に出ていること(空振り防止)
    expect(built.toc.some((t) => t.level >= 4), 'h4 以下が目次に出ていない').toBe(true);
  });
});

describe('マニュアルの窓 — 上書きの安全網', () => {
  /**
   * 🔴 **番号の id で slug を上書きしている**ので、マニュアルに文書内リンクを
   * 書くと**この窓だけ**飛び先を失う。
   * ⚠ いまは「書かない」決まりで守られている(`help.ts` 冒頭 ── 面が同一
   *   document に常駐するので `#slug` が本文の面に当たる)。
   * 🔑 **その前提をここでも見る** ── 別々の file の 2 つの pin に頼ると、
   *   片方を外した日に、もう片方の理由が消えたことに誰も気づかない。
   */
  it('🔴 前提:マニュアルに文書内リンクが 1 件も無い', () => {
    const links = (MANUAL_TEXT.match(/\]\(#/gu) ?? []).length;
    expect(links, 'マニュアルに文書内リンクが在る ── 窓では飛び先が消える').toBe(0);
  });
});

describe('マニュアルの窓 — 押せない操作子を残さない', () => {
  /**
   * 🔴 描画はアプリと同じ関数なので「コピー」ボタンが焼き込まれるが、この窓には
   * **binder が居ない** ── 残すと全部が無言の dead click になる。
   */
  it('🔴 コピーのボタンを落とす(この窓に受け手は居ない)', () => {
    const html = renderMarkdown(MANUAL_TEXT, {});
    const before = (html.match(/data-pkc-action="copy-md-block"/gu) ?? []).length;
    // ⚠ 空振り防止:落とす前に本当に在ること(0 件なら、この検査は何も言っていない)
    expect(before, '前提が崩れている(コピーのボタンが 1 つも無い)').toBeGreaterThan(50);
    /**
     * 🔴 **形を選ぶ ▾ も落ちる**(#708 段①)── 表の右上には ⧉ と ▾ の 2 つが
     * 出るので、片方だけ落とすと**この窓に無言の口が残る**。
     * ⚠ 空振り防止:落とす前に ▾ が本当に在ること。
     */
    expect(
      (html.match(/data-pkc-copy-menu/gu) ?? []).length,
      '前提が崩れている(▾ が 1 つも無い)',
    ).toBeGreaterThan(0);
    const built = buildManualDoc(html, manualSections(MANUAL_TEXT));
    expect(built.html).not.toContain('copy-md-block');
    expect(built.html, '形を選ぶ ▾ が残った(押しても何も起きない)').not.toContain(
      'data-pkc-copy-menu',
    );
    // ⚠ **落としすぎていない** ── 本文の中身は残る
    expect(built.html).toContain('<pre');
    expect(built.html).toContain('<table');
  });

  it('⚠ 判定は狭く当てる(別の action は残す)', () => {
    const built = buildManualDoc(
      '<div><button data-pkc-action="copy-md-block">⧉</button>' +
        '<button data-pkc-action="open-entry">開く</button></div><h1>あ</h1>',
      [{ title: 'あ', level: 1, index: 0, line: 0 }],
    );
    expect(built.html).not.toContain('copy-md-block');
    expect(built.html, '無関係な action まで消している').toContain('open-entry');
  });
});

describe('マニュアルの窓 — 組み立ての作法', () => {
  const secs = (levels: number[]) =>
    levels.map((level, index) => ({ title: `見出し${index}`, level, index, line: index }));

  it('元から在る id は、見出しの字から作った id で置き換える(2 つの規則を混ぜない)', () => {
    const built = buildManualDoc('<h2 id="old-slug" class="x">あ</h2>', secs([2]));
    expect(built.html).toBe(`<h2 id="見出し0" class="x">あ</h2>`);
    expect(built.toc[0]!.targetId).toBe('見出し0');
  });

  it('🔴 本文より節が多くても、飛び先の無い行は出さない', () => {
    const built = buildManualDoc('<h1>あ</h1>', secs([1, 2, 3]));
    expect(built.headings).toBe(1);
    expect(built.toc.map((t) => t.targetId)).toEqual(['見出し0']);
  });

  it('見出しより前の節(番号を持たない)は目次に出さない', () => {
    const built = buildManualDoc('<h1>あ</h1>', [
      { title: '(先頭)', level: 0, index: -1, line: 0 },
      { title: 'あ', level: 1, index: 0, line: 1 },
    ]);
    expect(built.toc).toHaveLength(1);
    expect(built.toc[0]!.label).toBe('あ');
  });

  it('目次の字から記法の印を落とす(星がそのまま見えない)', () => {
    const built = buildManualDoc('<h2>x</h2>', [
      { title: '**強調**した`もの`', level: 2, index: 0, line: 0 },
    ]);
    expect(built.toc[0]!.label).toBe('強調したもの');
  });

  it('⚠ 囲みの中の見出しの字は、本文の見出しではない(番号がずれない)', () => {
    // 描画は囲みの中を字として出す(`&lt;h1` でも `# 見出し` でもタグにならない)
    const built = buildManualDoc('<pre><code># 見出しの例\n</code></pre><h1>本物</h1>', secs([1]));
    expect(built.headings).toBe(1);
    expect(built.html).toContain('<h1 id="見出し0">本物</h1>');
  });
});

/**
 * 🔴 **節の印は見出しの字から作る**(2026-09-04、#648 D4)。
 *
 * 段①②は通し番号(`m-12`)だったので、**見出しが 1 本増えた版ではブックマークが隣の節を
 * 指した**。ここが守るのは 3 つ ── ①前に見出しが増えても同じ節を指す ②同じ字の見出しが
 * 2 つ在っても飛び先が取り違えられない ③字が記号だけの見出しでも dead click にならない。
 */
describe('マニュアルの窓 — 節の印は見出しの字から(D4)', () => {
  const sec = (title: string, index: number, level = 2) => ({ title, level, index, line: index });

  it('🔴 前に見出しが増えても、同じ節は同じ印(通し番号ではない)', () => {
    const before = buildManualDoc('<h2>a</h2><h2>b</h2>', [sec('4-4. ヘルプ', 0), sec('4-5. 設定', 1)]);
    const after = buildManualDoc('<h2>x</h2><h2>a</h2><h2>b</h2>', [
      sec('4-3. 新しい節', 0),
      sec('4-4. ヘルプ', 1),
      sec('4-5. 設定', 2),
    ]);
    const idOf = (d: ReturnType<typeof buildManualDoc>, label: string) =>
      d.toc.find((t) => t.label === label)!.targetId;
    expect(idOf(after, '4-4. ヘルプ'), '見出しが増えたら印が動いた(ブックマークが隣を指す)').toBe(
      idOf(before, '4-4. ヘルプ'),
    );
    expect(idOf(after, '4-5. 設定')).toBe(idOf(before, '4-5. 設定'));
    // 空振り防止 ── 印は字から出来ている(番号でも通る形の assert ではない)
    expect(idOf(before, '4-4. ヘルプ')).toBe('4-4-ヘルプ');
    // ⚠ 本文の id も同じ(目次と本文が同じ配列から出ている)
    expect(idsIn(after.html).has('4-4-ヘルプ')).toBe(true);
  });

  it('見出しの字 → 印:記法・空白・記号を畳み、小文字にする(規則は 1 つ)', () => {
    expect(manualHeadingSlug('4-4. ヘルプ')).toBe('4-4-ヘルプ');
    expect(manualHeadingSlug('🔴 マニュアルだけのウィンドウで読む(アプリとして開く)')).toBe(
      'マニュアルだけのウィンドウで読む-アプリとして開く',
    );
    expect(manualHeadingSlug('**強調**した `もの` / Ctrl+F')).toBe('強調した-もの-ctrl-f');
    // 記号だけなら空(呼び側が通し番号へ落とす)
    expect(manualHeadingSlug('🔴 ⚠')).toBe('');
  });

  it('🔴 同じ字の見出しが 2 つ在れば 2 つ目は `-2`(取り違えない / dead click にしない)', () => {
    const built = buildManualDoc('<h2>a</h2><h3>b</h3><h2>c</h2><h3>d</h3>', [
      sec('お知らせ', 0),
      sec('そのほか', 1, 3),
      sec('お知らせ', 2),
      sec('そのほか', 3, 3),
    ]);
    expect(built.toc.map((t) => t.targetId)).toEqual(['お知らせ', 'そのほか', 'お知らせ-2', 'そのほか-2']);
    const ids = idsIn(built.html);
    expect(ids.size, '本文の id が重複して潰れている').toBe(4);
    for (const t of built.toc) expect(ids.has(t.targetId), `${t.targetId} が本文に無い`).toBe(true);
  });

  it('⚠ 字が記号だけの見出しは通し番号へ落ちる(印が空にならない)', () => {
    const built = buildManualDoc('<h2>a</h2><h2>b</h2>', [sec('🔴', 0), sec('注意', 1)]);
    expect(built.toc.map((t) => t.targetId)).toEqual([`${MANUAL_HEADING_ID}0`, '注意']);
    expect(built.html).toContain(`<h2 id="${MANUAL_HEADING_ID}0">a</h2>`);
  });

  it('⚠ 源文に無い番号の見出し(数が食い違ったとき)も通し番号へ落ちる', () => {
    const built = buildManualDoc('<h2>a</h2><h2>b</h2>', [sec('先頭', 0)]);
    expect(idsIn(built.html)).toEqual(new Set(['先頭', `${MANUAL_HEADING_ID}1`]));
  });

  it('🔴 実物のマニュアルで:印は全部一意で、通し番号へ落ちた見出しが無い', () => {
    const built = buildManualDoc(renderMarkdown(MANUAL_TEXT, {}), manualSections(MANUAL_TEXT));
    const ids = built.toc.map((t) => t.targetId);
    expect(new Set(ids).size, '印が重複している').toBe(ids.length);
    expect(ids.filter((id) => id.startsWith(MANUAL_HEADING_ID)), '字から印を作れない見出しが在る').toEqual([]);
    // ⚠ 前提:重複の `-2` が実際に働いている次元がある(実測 2 組 ── 0 なら上の assert は何も言わない)
    expect(ids.filter((id) => /-2$/u.test(id)).length, '重複の解決が 1 度も走っていない(測っていない次元)').toBeGreaterThan(0);
  });
});
