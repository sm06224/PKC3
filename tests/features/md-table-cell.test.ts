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
    const body = '| 品名 | 数 |\n|---|---|\n| みかん\\|橙 | 3 |\n';
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

/**
 * 🔴 **着地後レビューが出した 6 件**(#747。**#746 の test は 6 件とも素通りした**)。
 *
 * ⚠ CLAUDE.md「挙動を変えたのに、test が前も後も通るなら、それは守っていない」──
 *   ここは**直す前の実装に戻すと落ちる**ことを確かめてから書いた(6 件とも実測)。
 */
describe('#747 焼いた升と、書ける升を揃える', () => {
  /**
   * 🔴 **これが本体の不変量である** ── 「**焼いた升は必ず書き換えられる**」。
   *
   * 🔑 期待値を実装の綴りから作らない(CLAUDE.md §1)── 見るのは
   *   ①`applyBodyRewrite` が `null` を返さないこと(= 押した動線が死んでいない)
   *   ②書いた後の**描いた表**で、その升だけが変わっていること(= 別の升を巻き込まない)。
   * ⚠ corpus には**門が別々だと必ず割れる形**を入れてある ── 引用 / 箇条書き /
   *   寄せ・字下げの記号の下 / `:::` の板の中 / 升の数が足りない行。
   */
  const CORPUS: readonly { name: string; body: string }[] = [
    { name: 'ふつうの表', body: MD },
    { name: '引用の中', body: '> | a | b |\n> |---|---|\n> | 1 | 2 |\n' },
    // ⚠ **項目の続きとして字下げした形**にする ── `- | a |` を 3 行並べても
    //   3 つの項目に割れて**表にならない**(空振りの corpus になる)
    { name: '箇条書きの中', body: '- 覚書\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n' },
    { name: '4 字下げ(コード)', body: '文章\n\n    | a | b |\n    |---|---|\n    | 1 | 2 |\n' },
    { name: '字下げの記号の下', body: '文章\n__字下げ\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n' },
    { name: '中央寄せの記号の下', body: '文章\n||中央\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n' },
    { name: '升の数が足りない行', body: '| a | b | c |\n|---|---|---|\n| 1 |\n| 2 | 3 | 4 |\n' },
    { name: ':::の板の中', body: ':::note\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n:::\n' },
    { name: '板の中の囲み', body: ':::note\n\n```psv\na|b\n-|-\n1|2\n```\n\n:::\n' },
    { name: '囲みの中', body: '```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n' },
    { name: 'frontmatter の下', body: '---\ntitle: あ\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' },
  ];

  it.each(CORPUS)('🔴 $name ── 焼いた升は必ず書き換えられる', ({ body }) => {
    const m = marks(body);
    const before = grid(body);
    for (const cell of m) {
      const out = write(body, cell.line, cell.col, 'ZQZ');
      expect(out, `印が焼かれているのに書けない(行 ${cell.line} 列 ${cell.col})`).not.toBeNull();
      const after = grid(out!);
      const moved = after.flatMap((row, r) => row.map((v, c) => (v === before[r]?.[c] ? null : `${r}:${c}`))).filter((x) => x !== null);
      expect(moved, `巻き込んだ升がある(行 ${cell.line} 列 ${cell.col})`).toHaveLength(1);
    }
  });

  /**
   * ⚠ **空振り防止** ── 上の `it.each` は印が 0 個でも緑になる。
   * 🔑 だから「印が焼かれる形」と「1 つも焼かれない形」を**別々に名指しで pin する**
   *   (どちらが崩れても鳴る)。
   */
  it('⚠ 印が焼かれる形と、焼かれない形を名指しで数える', () => {
    const n = (name: string) => marks(CORPUS.find((c) => c.name === name)!.body).length;
    expect(n('ふつうの表'), 'ふつうの表で印が焼かれていない').toBe(6);
    expect(n(':::の板の中'), '板の中の表で印が焼かれていない').toBe(4);
    expect(n('升の数が足りない行'), '空の升にまで焼いている').toBe(7);
    expect(n('字下げの記号の下'), '記号の下で行がずれて焼き落としている').toBe(6);
    // 🔴 **押せない形**(押せると「押せるのに書けない」= 打った字が消える動線になる)
    expect(n('引用の中'), '書けないのに押せる').toBe(0);
    // 🔑 字下げした表は**押せて書ける**(行頭の空白ぶんを詰めて書く ── 変異 R1)
    expect(n('箇条書きの中'), '字下げした表の升が押せない').toBe(4);
    expect(n('囲みの中'), 'コードの字を押せてしまう').toBe(0);
    // 🔑 板の中の ` ```psv ` は**表**なので押せる(#743 で書けるようにした)──
    //    押せるのに書けない形ではない(上の it.each がその往復を見ている)
    expect(n('板の中の囲み'), '板の中の csv の升が押せない(#743)').toBe(6);
  });

  /**
   * 🔴 **行の対応がずれない**(#747-3)。⚠ `preprocessAlignPrefix` は寄せ・字下げの
   *   記号の前に**空行を挿す**ので、前処理**後**の行番号で原文を引くとずれる ──
   *   直す前は最後の行の升が 1 つも押せず、逆に**別の行**の升に印が焼かれていた。
   */
  it('🔴 寄せの記号より下でも、印は原文の行を指す', () => {
    const body = '文章\n__字下げ\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
    const lines = body.split('\n');
    for (const cell of marks(body)) {
      expect(
        lines[cell.line],
        `印の行 ${cell.line} が表の行ではない(原文と食い違っている)`,
      ).toMatch(/^\|/);
      expect(lines[cell.line], `印の字が原文のその行に無い`).toContain(cell.raw);
    }
    expect(marks(body).filter((m) => m.line === 5), '最後の行が押せない').toHaveLength(2);
  });

  /**
   * 🔴 **欄に出るのは原文の字**(#747-1 / -4)。
   * ⚠ 直す前は前処理**後**の字を焼いていたので、①`{{vars.…}}` の升は
   *   属性が `<span class="` で突き破られ、②打ち直すと原文の記法が消えた。
   */
  it('🔴 記法を書いた升は、原文の記法がそのまま欄に出る', () => {
    for (const [src, head] of [
      ['{{vars.v}}', '---\nvars:\n  v: X\n---\n\n'],
      ['%%内緒%%', ''],
      ['**太い**', ''],
    ] as [string, string][]) {
      const body = `${head}| a | b |\n|---|---|\n| ${src} | 2 |\n`;
      // 🔑 行番号は**原文を数えて**採る(実装の綴りから作らない)
      const row = body.split('\n').findIndex((l) => l.includes(src));
      expect(row, `空振り(原文にその行が無い:${src})`).toBeGreaterThan(0);
      const m = marks(body).find((x) => x.line === row && x.col === 0);
      expect(m?.raw, `欄に出る字が原文ではない(${src})`).toBe(src);
      // 🔴 **打ち直しても記法が残る**(= 打っただけで記法が消えない)
      const out = write(body, row, 0, `${src}!`);
      expect(out, `書けない(${src})`).toContain(`${src}!`);
    }
  });

  /** 🔴 **属性を突き破らない**(#747-1 / 変異 R8)。 */
  it('🔴 升に `"` や `<` を書いても、属性の外へ出ない', () => {
    const body = '| a | b |\n|---|---|\n| "><b>わる | 2 |\n';
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(body, { interactiveCells: true });
    const cells = [...host.querySelectorAll('[data-pkc-action="edit-cell"]')];
    expect(cells, '空振り(印が焼かれていない)').toHaveLength(4);
    expect(host.querySelector('b'), '升の字がタグとして生えた').toBeNull();
    const td = cells[2]!;
    expect(td.getAttribute('data-pkc-cell-raw')).toBe('"><b>わる');
    // ⚠ 属性が割れると余計な属性が生える ── 数で見る(名前を数え上げない)
    expect([...td.attributes].map((a) => a.name).sort()).toEqual([
      'data-pkc-action',
      'data-pkc-cell-col',
      'data-pkc-cell-line',
      'data-pkc-cell-raw',
    ]);
  });

  /**
   * 🔴 **字下げした表でも、打った字は升の側へ書かれる**(変異 R1)。
   * ⚠ `splitRowSpans` の `lead`(行頭の空白の幅)を落とすと、打った字が
   *   **字下げの空白の側**へ書かれる ── 全量 8440 件が緑のまま生き延びた変異である。
   */
  it('🔴 行頭に空白のある表でも、升の中が置き換わる', () => {
    const body = '- 覚書\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n';
    const out = write(body, 4, 0, 'ZQZ');
    expect(out, '書けない(前提が崩れた)').not.toBeNull();
    expect(out!.split('\n')[4], '字下げの空白の側へ書いた').toBe('  | ZQZ | 2 |');
  });

  /**
   * 🔴 **frontmatter の中の「表に見える行」へは書かない**(変異 R5)。
   * ⚠ こちらも全量緑のまま生き延びた ── 囲みの門には test が在るのに、
   *   **隣の門には 1 件も無かった**(CLAUDE.md「門を N 個置いたら、N 個目だけが鳴る
   *   場面を N 通り作る」)。
   */
  it('🔴 frontmatter の中は書き換えない', () => {
    const body = '---\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n\n本文\n';
    expect(frontmatterLineCount(body), '空振り(frontmatter と読まれていない)').toBeGreaterThan(3);
    expect(write(body, 3, 0, 'ZQZ'), 'frontmatter の中へ書いた').toBeNull();
    expect(marks(body), 'frontmatter の中に印を焼いた').toHaveLength(0);
  });

  /**
   * 🔴 **空白だけの升で範囲が反転しない**(#747-6)。
   * ⚠ 直す前は `start > end` になり、差し替えが**挿入**になって
   *   `|     | 2 |` が `|     ZZZ     | 2 |` と余白ごと伸びた。
   */
  it('🔴 空白だけの升に打っても、余白が複製されない', () => {
    const out = write('| a | b |\n|---|---|\n|     | 2 |\n', 2, 0, 'ZZZ');
    expect(out, '書けない').not.toBeNull();
    const row = out!.split('\n')[2]!;
    expect(row.match(/ZZZ/g), '打った字が 2 つ以上入った').toHaveLength(1);
    expect(grid(out!)[1], '別の升まで動いた').toEqual(['ZZZ', '2']);
    // ⚠ 行が伸びるのは打った字のぶんだけ
    expect(row.length).toBe('|     | 2 |'.length + 3);
  });

  /**
   * 🔴 **板の中の囲みを書き換えない**(#747-5)。
   * ⚠ `scanContainers` は最上位しか返さないので、直す前は板の中の ` ```psv ` の
   *   升が**押せて、打つとコードの中身が化けた**(段④ の前は「断り」だった)。
   */
  it('🔴 `:::` の板の中の囲みは、csv の升として書く(markdown の表として読まない)', () => {
    const body = ':::note\n\n```psv\na|b\n-|-\n1|2\n```\n\n:::\n';
    const out = write(body, 3, 0, 'x|y');
    // 🔴 **csv の作法で逃がす** ── markdown の表として書くと `x\|y` になり、
    //    csv の読み手は `\` を字と読むので**列が 3 つに増えて表が壊れる**
    expect(out, '板の中の囲みで升が打てない(#743)').toContain('"x|y"|b');
    expect(out, 'markdown の表として書き換えた').not.toContain('x\\|y');
    // ⚠ 対照群 ── 板の中の**素の表**は markdown の表として書ける
    const ok = ':::note\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n:::\n';
    expect(write(ok, 4, 0, 'ZQZ'), '板の中の表まで断った').toContain('| ZQZ | 2 |');
    // 🔴 **コードの囲み(表ではない)は書き換えない**
    const code = ':::note\n\n```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n\n:::\n';
    expect(write(code, 3, 0, 'ZQZ'), 'コードの中身を書き換えた').toBeNull();
  });
});
