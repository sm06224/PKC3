/** @vitest-environment happy-dom */
/**
 * 🔴 **markdown の表も、升を押してその場で打てる**(#708 段④)。
 *
 * > user の物語(#708): 表を書いたあとで「これは升を押して打ちたい」と思っても、
 * > 押せる升が在るのは csv の囲みだけで、markdown の表は原文を開くしかなかった。
 *
 * ## ⚠ いちばん静かに壊れる形は「升が 1 つずれる」
 *
 * 読み手(markdown-it)は升の原文から **`\|` の逃がしだけ外して**渡してくる
 * (実測:`a\|b` → `a|b`)。逃がし直さずに書き戻すと、升の中の `|` が
 * **列の区切りとして読まれて表がずれる** ── 画面では気づけない。
 * 🔑 だから往復(焼いた原文 → 書き戻し → 描き直し)を通しで見る。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
import {
  bodyBelowFrontmatter,
  frontmatterLineCount,
} from '../../src/features/markdown/frontmatter';

interface Mark {
  line: number;
  col: number;
  raw: string;
}

/** 描いた面の押せる升(⚠ **実物の描画**から採る ── 手で組んだ表では前提を検めていない)。 */
function marks(body: string, opts: Record<string, unknown> = {}): Mark[] {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, { interactiveCells: true, ...opts } as never);
  return [...host.querySelectorAll('[data-pkc-action="edit-cell"]')].map((c) => ({
    line: Number(c.getAttribute('data-pkc-cell-line')),
    col: Number(c.getAttribute('data-pkc-cell-col')),
    raw: c.getAttribute('data-pkc-cell-raw') ?? '',
  }));
}

/** 描いた表の升(読み手の答えそのもの)。 */
function grid(body: string): string[][] {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, {});
  const t = host.querySelector('table');
  return t === null
    ? []
    : [...t.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((c) => (c.textContent ?? '').trim()),
      );
}

const write = (body: string, line: number, col: number, value: string): string | null =>
  applyBodyRewrite(body, { kind: 'csv-cell', line, col, value } as BodyRewrite);

const MD = '# 覚書\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n| みかん | 12 |\n';

describe('markdown の表の升を打つ(#708 段④)', () => {
  it('🔴 見出しと中身の升に印が焼かれ、区切りの行には焼かれない', () => {
    const m = marks(MD);
    // 空振り防止 ── 表が描かれていない body で「印が正しい」と言わない
    expect(m.length, '印が 1 つも焼かれていない').toBe(6);
    expect(m.map((x) => x.line), '区切りの行(3)に印が焼かれている').toEqual([2, 2, 4, 4, 5, 5]);
    expect(m.map((x) => x.col)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(m.map((x) => x.raw)).toEqual(['品名', '数', 'りんご', '3', 'みかん', '12']);
  });

  it('⚠ 読む面だけに出す(書き出し・印刷には出さない)', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(MD, {});
    expect(
      host.querySelectorAll('[data-pkc-action="edit-cell"]').length,
      '押せない面にも印を焼いた',
    ).toBe(0);
  });

  /**
   * 🔴 **`\|` を含む升の往復**(この段でいちばん静かに壊れる形)。
   * ⚠ 焼いた原文が `a|b` だと、押した欄にそう出て、確定した瞬間に**列が増える**。
   */
  it('🔴 升の中の | は、書き戻すときに逃がされる(欄には画面の字が出る)', () => {
    const body = '| 品名 | 数 |\n|---|---|\n| りんご\\|青 | 3 |\n';
    /**
     * 🔴 **欄に出すのは「画面に出ている字」である**(着地前レビュー・動線 ①)。
     * ⚠ 1 稿目は**逃がした形**(`りんご\\|青`)を焼いており、書き戻す側も同じ規則で
     *   逃がすので、**押して確定するたびに `\\` が 1 本ずつ増えた**
     *   (実測:1 回目 `みかん\\|橙` → 3 回目 `みかん\\\\\\|橙`)。
     * ⚠ そして**その壊れた形を、この検査が pin していた** ── 主張ごと書き直した。
     */
    expect(marks(body)[2]?.raw, '欄に原文の逃がしが見えている').toBe('りんご|青');
    const out = write(body, 2, 0, 'みかん|橙')!;
    expect(out, '書き戻しで | を逃がしていない').toContain('みかん\\|橙');
    // 🔑 観測点は**描いた表**(字面ではなく、user が見る物)── 列が増えていない
    expect(grid(out), '升がずれた').toEqual([
      ['品名', '数'],
      ['みかん|橙', '3'],
    ]);
  });

  /**
   * 🔴 **押して、直さずに確定しても原文が育たない**(着地前レビュー・動線 ①)。
   *
   * ⚠ これが「**2 回目までは画面が正しいので気づけない**」形である ── 3 回目に
   *   `\\` が画面へ出て初めて分かるが、そのときには本文が壊れている。
   * 🔑 観測点は**原文の行そのもの**(画面だけ見ると 2 回目まで緑になる)。
   */
  it('🔴 直さずに確定しても、原文が 1 バイトも育たない(何度でも)', () => {
    let body = '| 品名 | 数 |\n|---|---|\n| みかん\\|橙 | 3 |\n';
    for (let i = 0; i < 3; i += 1) {
      const raw = marks(body)[2]!.raw;
      expect(raw, `${i + 1} 回目の欄に逃がしが見えている`).toBe('みかん|橙');
      expect(write(body, 2, 0, raw), `${i + 1} 回目に同じ字を書いた`).toBeNull();
    }
    expect(body.split('\n')[2], '原文が育った').toBe('| みかん\\|橙 | 3 |');
  });

  /**
   * 🔴 **原文に無い升には印を焼かない**(着地前レビュー・動線 ②)。
   *
   * ⚠ 読み手は**見出しの列数ぶん**升を作るので、`| 1 |` の行にも空の升が並ぶ ──
   *   そこに印を焼くと、押せて、打てて、**「本文が変わっているため反映できません
   *   でした」という起きていない理由**が出る(打った字は消える)。
   * ⚠ 「書き換えない」だけを見ていた 1 稿目では、**押せてしまうこと**を見ていなかった。
   */
  it('🔴 見出しより升が少ない行では、無い升に印を焼かない', () => {
    const body = '| a | b | c |\n|---|---|---|\n| 1 |\n';
    // 前提 ── 読み手は 3 列で描いている(空の升 2 つを足している)
    expect(grid(body)[1], '前提: 読み手が埋めていない').toEqual(['1', '', '']);
    expect(marks(body).map((m) => `${m.line}:${m.col}`), '原文に無い升にも印を焼いた').toEqual([
      '0:0',
      '0:1',
      '0:2',
      '2:0',
    ]);
  });

  /**
   * 🔴 **触る所だけを触る**(`csv-cell` と同じ作法)。
   * ⚠ 同じ行の他の升も、user が書いた余白も 1 バイトも動かさない。
   */
  it('🔴 打った升だけが変わる(余白も他の升も動かない)', () => {
    const body = '前\n\n|  品名  |   数 |\n|---|---|\n|  りんご  |   3 |\n\n後\n';
    const out = write(body, 4, 1, '99')!;
    expect(out, '余白か他の升が動いた').toBe('前\n\n|  品名  |   数 |\n|---|---|\n|  りんご  |   99 |\n\n後\n');
  });

  it('⚠ 同じ字なら書かない(呼び側が「書かない」を選べる)', () => {
    expect(write(MD, 4, 0, 'りんご'), '同じ字なのに書いた').toBeNull();
  });

  /**
   * 🔴 **区切りの行と、表の外は書き換えない**(当てずっぽうで別の行を触らない)。
   * ⚠ 印は焼いていないが、**別の窓が本文を動かした後**に古い依頼が届きうる。
   */
  it.each([
    ['区切りの行', 3],
    ['見出しの段落', 0],
    ['表の下の空行', 6],
    ['存在しない行', 99],
  ])('🔴 %s は書き換えない', (_name, line) => {
    expect(write(MD, line, 0, 'x'), 'その行を書き換えた').toBeNull();
  });

  /**
   * 🔴 **囲みの中の「表に見える字」は打てない**(`csvTableAt` の註記と同じ罠)。
   * ⚠ 描く側はコードとして描くので印は焼かれないが、書く側でも止める。
   */
  it('🔴 ``` の囲みの中の表の形の字は書き換えない', () => {
    const body = '```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n';
    expect(marks(body).length, 'コードの中に印を焼いた').toBe(0);
    for (const line of [1, 2, 3]) {
      expect(write(body, line, 0, 'x'), `${line} 行目を書き換えた`).toBeNull();
    }
  });

  /**
   * 🔴 **`:::` の板の中でも打てる**(#743 の markdown の表ぶん)。
   *
   * ⚠ **形を作り変える口(#708 段②)とは判定が違う** ── あちらは板の中を外している
   *   (作り変えると戻す口が出ない**片道**になるため)。⚠ こちらは升を 1 つ打つだけで
   *   **いつでも打ち直せる**ので、片道にならない。
   * 🔑 だから「板の中だから一律に断る」ではなく、**問いごとに門を分けてある**。
   */
  it('🔴 ::: の板の中の表も、押して打てる', () => {
    const body = ':::note\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n\n:::\n';
    const m = marks(body);
    expect(m.length, '板の中に印が焼かれていない').toBe(4);
    const out = write(body, 4, 1, '7')!;
    expect(out, '板の中の升を書き換えられなかった').toContain('| りんご | 7 |');
    expect(out, '板が壊れた').toContain(':::note');
  });

  /**
   * ⚠ **原文を持たない升は書き換えない**(読み手が空で埋めた分)。
   * 🔑 読み手は見出しより少ない行を**空の升で埋めて**描くので、そこを押しても
   *   書き戻す先が原文に無い ── 無い物を当てずっぽうで作らない。
   */
  it('⚠ 見出しより升が少ない行では、無い升を書き換えない', () => {
    const body = '| a | b | c |\n|---|---|---|\n| 1 |\n';
    // 前提 ── 読み手は 3 列で描いている(空の升 2 つを足している)
    expect(grid(body)[1], '前提: 読み手が埋めていない').toEqual(['1', '', '']);
    expect(write(body, 2, 0, 'x'), '在る升を書き換えられなかった').not.toBeNull();
    expect(write(body, 2, 2, 'x'), '原文に無い升を書き換えた').toBeNull();
  });

  /**
   * ⚠ **台は本物の入口と同じにする** ── 実物(`detail.ts`)は **frontmatter を剥いだ
   *   本文**を描き、剥がした行数を `taskLineOffset` で渡す。丸ごと渡す台で試すと、
   *   足し込みが**当たっているのかずれているのか見えない**。
   */
  it('⚠ frontmatter が在っても、行番号がずれない', () => {
    const body = '---\ntags: [a]\n---\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n';
    const fm = frontmatterLineCount(body);
    // 空振り防止 ── 剥がす行が 0 件なら、この検査は何も見ていない
    expect(fm, '前提: frontmatter を数えていない').toBeGreaterThan(0);
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), {
      interactiveCells: true,
      taskLineOffset: fm,
    } as never);
    const lines = [...host.querySelectorAll('[data-pkc-action="edit-cell"]')].map((c) =>
      Number(c.getAttribute('data-pkc-cell-line')),
    );
    expect(lines, 'frontmatter のぶんがずれている').toEqual([4, 4, 6, 6]);
    // 🔑 焼いた行番号で実際に書けること(番号が合っていても書けなければ意味が無い)
    expect(write(body, lines[2]!, 1, '9'), '焼いた行番号で書けない').toContain('| りんご | 9 |');
  });

  /**
   * 🔴 **前処理で行が消えてもずれない**(`lineMap` で原文へ戻す。変異試験 P5 が
   *   SURVIVED で教えた)。
   *
   * ⚠ `%%%…%%%` は描画で**消える**ので、markdown-it が見る行番号は原文より小さい ──
   *   戻さないと**別の行を書き換える**(静かなデータ破壊)。
   * 🔑 **端どうしが噛み合う**ことまで見る ── 焼いた行がそのまま書き換えに通る。
   */
  it('🔴 前処理で行が消えても、焼いた行が原文を指す', () => {
    const body = '%%%\nメモ\nもう 1 行\n%%%\n\n| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n';
    const m = marks(body);
    expect(m.length, '印が焼かれていない(前提が崩れている)').toBe(4);
    expect(m.map((x) => x.line), '消えた行のぶんずれている').toEqual([5, 5, 7, 7]);
    expect(write(body, m[2]!.line, 1, '9'), '焼いた行番号で書けない').toBe(
      '%%%\nメモ\nもう 1 行\n%%%\n\n| 品名 | 数 |\n|---|---|\n| りんご | 9 |\n',
    );
  });

  it('⚠ csv の囲みの升は、いままでどおり打てる(壊していない)', () => {
    const body = '```csv\n品名,数\nりんご,3\n```\n';
    expect(write(body, 2, 1, '9'), 'csv の升が打てなくなった').toContain('りんご,9');
  });
});
