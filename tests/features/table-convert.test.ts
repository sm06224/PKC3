/** @vitest-environment happy-dom */
/**
 * 🔴 **表の形を変える**(#708 段②)── markdown の表 ⇄ csv の囲み。
 *
 * ## 🔑 期待値は「別の観測」から作る(CLAUDE.md §1)
 *
 * ⚠ 行範囲も升の割り方も、**実装は markdown-it の table rule を書き写した**ものである。
 *   だから期待値を同じ文法で書き直すと、**実装が間違える形では期待値も同じように
 *   間違える**(2026-08-22 の frontmatter の件と同じ型)。
 * 🔑 だからこの file の主張は 2 本とも**実物の読み手**から採る:
 *   ① 行範囲 … `renderMarkdown` が塊へ焼いた `data-pkc-source-line` / `-end`
 *   ② 升 … **描かれた表の `<td>` / `<th>` の字**(往復の前後で見比べる)
 *   どちらも `table-convert.ts` の綴りを 1 行も参照しない。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import {
  convertTable,
  tableAt,
  tableConvertRefusal,
} from '../../src/features/markdown/table-convert';

/** 描いた表の升(表ごと・行ごと)。⚠ **実物の読み手**から採る観測点である。 */
function grid(body: string): string[][][] {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, {});
  return [...host.querySelectorAll('table')].map((t) =>
    [...t.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => (c.textContent ?? '').trim()),
    ),
  );
}

/** 描いた塊の行範囲(`data-pkc-source-line` / `-end`)。⚠ 読み手の答えそのもの。 */
function blockSpans(body: string): Array<{ start: number; end: number }> {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
  return [...host.querySelectorAll('.pkc-md-block[data-pkc-source-line]')].map((b) => ({
    start: Number(b.getAttribute('data-pkc-source-line')),
    end: Number(b.getAttribute('data-pkc-source-end')),
  }));
}

/** 形を変えた本文(`applyBodyRewrite` を通す ── 製品と同じ 1 本)。 */
const convert = (body: string, line: number, to: 'markdown' | 'csv'): string | null =>
  applyBodyRewrite(body, { kind: 'table-format', line, to });

describe('表の形を変える(#708 段②)', () => {
  /**
   * 🔴 **行範囲は読み手と一致する**(空振り・取り違えの本体)。
   *
   * ⚠ ここがずれると「**別の表 / 表の下の段落まで書き換える**」といういちばん
   *   静かなデータ破壊になる。⚠ 前置きの段落・箇条書きで切れる形・前後の縦棒が
   *   無い形・`\|` を含む形・1 列の表・**表が 2 つ**の形を入れてある
   *   (fixture のゼロ件次元を作らない ── CLAUDE.md §2)。
   */
  const SPAN_CASES: Array<{ name: string; body: string }> = [
    { name: '素の表', body: '| a | b |\n|---|---|\n| 1 | 2 |\n' },
    {
      name: '前後に段落',
      body: '前置き\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n後書き\n',
    },
    { name: '前後の縦棒なし', body: 'a | b\n--- | ---\n1 | 2\n' },
    { name: '箇条書きで終わる', body: '| a | b |\n|:--|--:|\n| 1 | 2 |\n- 箇条書き\n' },
    { name: '升の中の縦棒', body: '| a\\|b | c |\n|---|---|\n| x | y |\n' },
    { name: '1 列', body: '| a |\n| --- |\n| 1 |\n' },
    { name: '段落に続く表', body: '段落\n| a | b |\n|---|---|\n| 1 | 2 |\n' },
    { name: 'csv の囲み', body: '```csv\nA,B\n1,2\n```\n' },
    { name: 'csv noheader', body: '```csv noheader\nA,B\n1,2\n```\n' },
    { name: 'tsv の囲み', body: '```tsv\nA\tB\n1\t2\n```\n' },
    { name: 'psv の囲み', body: '```psv\nA|B\n1|2\n```\n' },
    {
      name: '表が 2 つ',
      body: '| a | b |\n|---|---|\n| 1 | 2 |\n\n| c | d |\n|---|---|\n| 3 | 4 |\n',
    },
  ];

  it('🔴 表の行範囲が、描いた読み手の答え(source-line / -end)と一致する', () => {
    for (const c of SPAN_CASES) {
      const spans = blockSpans(c.body);
      // 空振り防止 ── 塊が 1 つも出ていない body で「全部一致した」と言わない
      expect(spans.length, `${c.name}: 塊が出ていない(前提が崩れている)`).toBeGreaterThan(0);
      for (const s of spans) {
        const at = tableAt(c.body, s.start);
        expect(at, `${c.name}: ${s.start} 行目の表を読めていない`).not.toBeNull();
        expect({ start: at!.start, end: at!.end }, `${c.name}: 行範囲が読み手とずれている`).toEqual(
          s,
        );
      }
    }
  });

  it('🔴 表の升の数も、描いた表の行数と一致する(範囲だけ合っていても駄目)', () => {
    for (const c of SPAN_CASES) {
      const rows = grid(c.body)[0]!;
      const at = tableAt(c.body, blockSpans(c.body)[0]!.start)!;
      /**
       * ⚠ `noheader` の csv は**見出しの行を持たない**ので、描いた `<tr>` の数と
       *   読んだ升の並びの数がそのまま揃う。見出しが在る形も同じ(見出しも `<tr>`)。
       */
      expect(at.rows.length, `${c.name}: 升の行数が描いた表と違う`).toBe(rows.length);
      expect(at.rows[0]!.cells.length, `${c.name}: 升の列数が描いた表と違う`).toBe(rows[0]!.length);
    }
  });

  /**
   * 🔴 **押した行はどこでもよい**(見出しの行・区切りの行・中身の行)。
   * ⚠ 実際に渡ってくるのは塊の先頭だが、**同じ表を指しているのに答えが違う**形を
   *   作らない(次に別の面から呼んだとき、そこだけ壊れる)。
   */
  it('🔴 表のどの行を指しても、同じ範囲の表が返る', () => {
    const body = '前\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n後\n';
    for (const line of [2, 3, 4, 5]) {
      const at = tableAt(body, line);
      expect(at, `${line} 行目で表を読めていない`).not.toBeNull();
      expect({ start: at!.start, end: at!.end }, `${line} 行目だけ範囲が違う`).toEqual({
        start: 2,
        end: 5,
      });
    }
    // 対照群 ── 表の外(段落 / 空行)では表を返さない
    expect(tableAt(body, 0), '段落を表として読んだ').toBeNull();
    expect(tableAt(body, 7), '表の下の段落を表として読んだ').toBeNull();
  });

  it('🔴 markdown → csv の往復で、画面に出る升が 1 つも変わらない', () => {
    const body = '| 品名 | 数 |\n|---|---|\n| りんご | 3 |\n| みかん | 12 |\n';
    const before = grid(body);
    const csv = convert(body, 0, 'csv');
    expect(csv, 'csv にできなかった').not.toBeNull();
    expect(grid(csv!), 'csv にしたら升が変わった').toEqual(before);
    const back = convert(csv!, 0, 'markdown');
    expect(back, 'markdown に戻せなかった').not.toBeNull();
    expect(grid(back!), '往復で升が変わった').toEqual(before);
    // ⚠ 形も戻っている(字面まで同じであることは主張しない ── 揃うのは画面である)
    expect(tableAt(back!, 0)!.format).toBe('markdown');
  });

  it('🔴 csv → markdown の往復でも、画面に出る升が 1 つも変わらない', () => {
    const body = '```csv\n品名,数\n"りんご, 赤",3\n```\n';
    const before = grid(body);
    expect(before[0]![1], '前提: 引用で囲んだ升が 1 つの升として描かれていない').toEqual([
      'りんご, 赤',
      '3',
    ]);
    const md = convert(body, 0, 'markdown');
    expect(grid(md!), 'markdown にしたら升が変わった').toEqual(before);
    const back = convert(md!, 0, 'csv');
    expect(grid(back!), '往復で升が変わった').toEqual(before);
  });

  /**
   * 🔴 **見出しの無い表は `noheader` のまま往復する**(#708 段①の `gfmTable` の作法)。
   *
   * ⚠ markdown の表は**必ず見出しを持つ**ので、`noheader` の csv を markdown に
   *   すると**空の見出しが 1 行増える**(先頭行を格上げすると**データが 1 行消える**
   *   ため。段① と同じ判断)。⚠ 戻すときはその空の行を落とすので、
   *   **何度往復しても行は増えない** ── ここを外すと往復のたびに空行が積む。
   */
  it('🔴 noheader の csv は、往復しても行が増えない', () => {
    const body = '```csv noheader\nA,B\n1,2\n```\n';
    const md = convert(body, 0, 'markdown')!;
    expect(grid(md)[0], '空の見出しが足されていない(データが 1 行消えている)').toEqual([
      ['', ''],
      ['A', 'B'],
      ['1', '2'],
    ]);
    const back = convert(md, 0, 'csv')!;
    expect(back, 'noheader が落ちている(1 行目が見出しに化ける)').toContain('csv noheader');
    expect(grid(back), '往復で行が増えた').toEqual(grid(body));
    // もう 1 往復しても増えない(積む形になっていないことを見る)
    expect(grid(convert(convert(back, 0, 'markdown')!, 0, 'csv')!), '2 往復で行が増えた').toEqual(
      grid(body),
    );
  });

  /**
   * 🔴 **markdown に字として書いた `=…` が、csv で式に化けない**(#708 段②)。
   *
   * ⚠ 逃がさないと、表を csv にした瞬間に `=B2*C2` が**計算されて数字になる** ──
   *   user が打った字が画面から消える。観測点は**描かれた升の字**である
   *   (実装の `'` の付け方ではなく、読み手が何を出すか)。
   */
  it('🔴 markdown の升に書いた `=B2*C2` は、csv にしても字のまま出る', () => {
    const body = '| 式 | 覚書 |\n|---|---|\n| =B2*C2 | 掛け算 |\n';
    const before = grid(body);
    expect(before[0]![1]![0], '前提: markdown では字として出ていない').toBe('=B2*C2');
    const csv = convert(body, 0, 'csv')!;
    expect(grid(csv), 'csv にしたら式として評価された(打った字が消えた)').toEqual(before);
    // ⚠ `'` で始まる字も同じ ── 逃がさないと `'あ` が `あ` に見える
    const q = "| 印 |\n| --- |\n| 'あ |\n";
    expect(grid(convert(q, 0, 'csv')!), "`'` で始まる字が変わった").toEqual(grid(q));
  });

  /**
   * 🔴 **逆向きも同じ** ── csv の `'` は「字のまま」の印なので、markdown にするときは
   *   **剥がす**(変異試験 M4 が SURVIVED で教えた ── 剥がさない実装を誰も見ていなかった)。
   * ⚠ 剥がさないと、画面に `=A1` と出ていた升が **`'=A1`** に変わる。
   */
  it("🔴 csv の `'` の逃がしは、markdown にすると剥がれる(画面の字が変わらない)", () => {
    for (const raw of ["'=A1", "'あ"]) {
      const body = `\`\`\`csv\n印\n${raw}\n\`\`\`\n`;
      const before = grid(body);
      expect(before[0]![1]![0], `前提: ${raw} が剥がされて描かれていない`).toBe(raw.slice(1));
      expect(grid(convert(body, 0, 'markdown')!), `${raw}: 画面の字が変わった`).toEqual(before);
    }
  });

  /**
   * 🔴 **式が在る csv は markdown にしない**(user 裁定 2026-09-04)。
   * ⚠ 断り方は **2 通りある**ので、**どちらが鳴ったかを文言で見分ける**
   *   (CLAUDE.md §1「門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る」)。
   */
  it('🔴 式が在る csv は Markdown にできない ── 理由を返し、本文を 1 バイトも変えない', () => {
    const body = '```csv\n数,単価,計\n2,100,=A2*B2\n```\n';
    const at = tableAt(body, 0)!;
    expect(tableConvertRefusal(at, 'markdown'), '式が在るのに通した').toContain('式');
    expect(convert(body, 0, 'markdown'), '式が在るのに本文を書き換えた').toBeNull();
    // 🔑 対照群 ── 式を字にすれば通る(門が常に閉じているのではない)
    const ok = body.replace('=A2*B2', '200');
    expect(tableConvertRefusal(tableAt(ok, 0)!, 'markdown'), '式が無いのに断った').toBeNull();
    expect(convert(ok, 0, 'markdown'), '式が無いのに書き換えなかった').not.toBeNull();
  });

  it('🔴 升の中に改行が在る csv も Markdown にできない ── 別の理由を返す', () => {
    const body = '```csv\n品名,覚書\nりんご,"赤い\n甘い"\n```\n';
    expect(grid(body)[0]!.length, '前提: 引用の中の改行が行を割っている').toBe(2);
    const why = tableConvertRefusal(tableAt(body, 0)!, 'markdown');
    expect(why, '改行を含む升を通した').toContain('改行');
    expect(why, '式の断りと同じ字を返している(どちらが鳴ったか読めない)').not.toContain('式');
    expect(convert(body, 0, 'markdown'), '改行が在るのに書き換えた').toBeNull();
  });

  /**
   * 🔴 **書き換えるのはその表の行だけ**(`csv-shape` と同じ作法)。
   * ⚠ 同じノートに表が 3 つ在るとき、**触っていない 2 つが 1 バイトも動かない**
   *   ことを見る ── 範囲の取り違えはここでしか出ない。
   */
  it('🔴 同じノートに表が 3 つあっても、押した表だけが変わる', () => {
    const body = [
      '# 見出し',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| c | d |',
      '|---|---|',
      '| 3 | 4 |',
      '',
      '```csv',
      'e,f',
      '5,6',
      '```',
      '',
      '終わり',
      '',
    ].join('\n');
    const out = convert(body, 6, 'csv');
    expect(out, '真ん中の表を変えられなかった').not.toBeNull();
    /**
     * 🔴 **本文まるごとで比べる**(変異試験 M11 が SURVIVED で教えた)。
     *
     * ⚠ 1 稿目は「上の 6 行」「下の 8 行」「真ん中に囲みが在る」の 3 点で見ていたが、
     *   **差し替える行数が 1 行足りない**変異はそれを全部すり抜けた ── 消し残った
     *   `| 3 | 4 |` は囲みの**下**に落ちるので、上も下も「同じ」に見えてしまう
     *   (描画で数えても、その行は表にならないので表の数は 3 のまま)。
     * 🔑 範囲の主張は**本文の全行**で見るしかない。
     */
    const src = body.split('\n');
    expect(out!.split('\n'), '書き換えた範囲がずれている').toEqual([
      ...src.slice(0, 6),
      '```csv',
      'c,d',
      '3,4',
      '```',
      ...src.slice(9),
    ]);
    // 表の数は変わらない(1 つ潰していない)
    expect(grid(out!).length, '表の数が変わった').toBe(3);
  });

  /**
   * 🔴 **frontmatter の中は見ない**(変異試験 S-3 が SURVIVED で教えた)。
   *
   * ⚠ 直す前の fixture は `tags: [a]` だけだったので、**門が在っても無くても `null`**
   *   だった(§1「代替物で満たされている」)── 門を落とす変異が生き延びる。
   * 🔑 だから fixture を**「frontmatter の中に、表として読める 2 行が在る」**形にする
   *   ── 門を落とすと `1-3` が返って落ちる。
   */
  it('🔴 frontmatter の中に表の形の字が在っても、表として読まない', () => {
    const body = '---\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n\n本文\n';
    // 空振り防止 ── 門が無ければ表として読めてしまう字であること
    expect(tableAt(body.slice(4), 0), '前提: この 3 行は表として読める字ではない').not.toBeNull();
    for (const line of [1, 2, 3]) {
      expect(tableAt(body, line), `frontmatter の ${line} 行目を表として読んだ`).toBeNull();
    }
  });

  it('🔴 frontmatter の下の表はふつうに読める(対照群)', () => {
    const body = '---\ntags: [a]\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(tableAt(body, 1), 'frontmatter を表として読んだ').toBeNull();
    const at = tableAt(body, 4);
    expect(at, 'frontmatter の下の表を読めていない').not.toBeNull();
    expect({ start: at!.start, end: at!.end }).toEqual({ start: 4, end: 6 });
  });

  /**
   * 🔴 **表に見える字が入っただけの囲みは触らない**(`csvTableAt` の註記と同じ罠)。
   * ⚠ ` ```txt ` の中の `| a | b |` を markdown の表として書き換えたら、
   *   **囲みの中身が消える**。
   */
  it('🔴 csv 以外の囲みの中の「表に見える字」は書き換えない', () => {
    const body = '```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n';
    for (const line of [0, 1, 2, 3, 4]) {
      expect(tableAt(body, line), `${line} 行目を表として読んだ`).toBeNull();
    }
  });

  it('⚠ 閉じていない csv の囲みは触らない(下の本文ごと飲み込む)', () => {
    const body = '```csv\nA,B\n1,2\n\nまだ書いている\n';
    expect(tableAt(body, 0), '閉じていない囲みを表として読んだ').toBeNull();
  });

  /**
   * ⚠ 升の字が柵で始まると、**囲みがそこで閉じる** ── 柵を 1 本長くする。
   * 🔑 観測点は「描いた表が 1 つに保たれているか」(実物の読み手)。
   */
  it('🔴 升の字が ``` そのものでも、囲みが途中で閉じない', () => {
    /**
     * ⚠ **升の字が「柵ちょうど」でなければ意味が無い**(変異試験 M6 が SURVIVED で
     *   教えた)── ` ```x ` のように後ろに字が付くと**閉じとして読まれない**ので、
     *   柵を伸ばさない実装でも表は壊れず、この検査は何も見ていなかった。
     */
    const body = '| 例 |\n| --- |\n| ``` |\n';
    expect(grid(body)[0], '前提: 升の字が柵そのものになっていない').toEqual([['例'], ['```']]);
    const csv = convert(body, 0, 'csv');
    expect(csv, '変換できなかった').not.toBeNull();
    expect(grid(csv!), '囲みが途中で閉じて表が壊れた').toEqual(grid(body));
  });

  it('⚠ もうその形なら断る(同じ本文を書き直して更新日時だけ動かさない)', () => {
    const body = '| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(tableConvertRefusal(tableAt(body, 0)!, 'markdown'), '同じ形なのに通した').not.toBeNull();
    expect(convert(body, 0, 'markdown'), '同じ形なのに書き換えた').toBeNull();
    expect(convertTable(tableAt(body, 0)!, 'markdown'), '同じ形なのに組んだ').toBeNull();
  });

  /**
   * 🔴 **区切りの列数が見出しと合わない形は、表ではない**(変異試験 M2 が
   *   SURVIVED で教えた)。⚠ 読み手(markdown-it)は**段落として描く**ので、
   *   表として書き換えると**段落が csv の囲みに化ける**。
   */
  it('🔴 区切りの列数が見出しと合わない 2 行は、表として読まない', () => {
    const body = '| a | b |\n| --- |\n| 1 | 2 |\n';
    // 前提 ── 読み手はこれを表として描いていない(描いていたら主張が逆になる)
    expect(grid(body), '前提: 読み手が表として描いている').toEqual([]);
    for (const line of [0, 1, 2]) {
      expect(tableAt(body, line), `${line} 行目を表として読んだ`).toBeNull();
    }
  });

  it('⚠ 表の無い行を指したら断る(当てずっぽうで別の行を書き換えない)', () => {
    const body = '# 見出し\n\nただの段落\n';
    expect(convert(body, 2, 'csv'), '段落を表として書き換えた').toBeNull();
    expect(convert(body, 99, 'csv'), '存在しない行で書き換えた').toBeNull();
    expect(convert(body, -1, 'csv'), '負の行で書き換えた').toBeNull();
  });

  /**
   * 🔴 **表が終わる所は、読み手が終える所と 1 行もずれない**(着地前レビューが
   *   変異試験で拾った ── 終端の選択肢を 1 つずつ落とす 5 変異が**全部 SURVIVED**)。
   *
   * ⚠ 直す前の `SPAN_CASES` は空行と箇条書きしか押さえていなかったので、
   *   終端を落としても緑のままだった(§2「fixture のゼロ件次元」)。
   * 🔑 だから**終端を全数**並べ、期待値は**実装の綴りではなく描いた読み手**
   *   (`data-pkc-source-end`)から採る(§1「期待値は別の観測から作る」)。
   * ⚠ この形で回したら**本物の欠陥が 3 つ**出た ── 改頁(`+++`)・4 字下げ・tab の
   *   字下げが終端に無く、**表の下の行を升へ飲んでいた**(`+++` は本文から消えた)。
   */
  const TABLE_ENDS = [
    '段落',
    '# 見出し',
    '> 引用',
    '- 箇条書き',
    '1. 番号',
    '```js',
    '~~~',
    ':::note',
    '---',
    '***',
    '___',
    '    const x = 1;',
    '\tconst x = 1;',
    '+++',
    '+++ {role=page}',
  ];

  it('🔴 表の終わりが、終端どの形でも読み手と一致する', () => {
    const bad: string[] = [];
    for (const after of TABLE_ENDS) {
      const body = `| a | b |\n|---|---|\n| 1 | 2 |\n${after}\n\nしっぽ\n`;
      const first = blockSpans(body).find((b) => b.start === 0);
      // 空振り防止 ── 表の塊が焼かれていない body で「一致した」と言わない
      expect(first, `${JSON.stringify(after)}: 0 行目の塊が焼かれていない`).toBeDefined();
      const at = tableAt(body, 0);
      const mine = at === null ? 'none' : String(at.end);
      if (String(first!.end) !== mine) {
        bad.push(`${JSON.stringify(after)}: 読み手=${first!.end} tableAt=${mine}`);
      }
    }
    expect(bad.join(' / '), '表の下の行を飲み込んでいる(または早く切っている)').toBe('');
  });

  /**
   * 🔴 **改頁は本文から消えない**(上の一般形を、いちばん害の大きい 1 形で名指しする)。
   * ⚠ 一般形の検査だけだと、落ちたときに「どの終端か」が読み取りにくい
   *   (§1「どの門が鳴ったのかを文言で見分ける」)。
   */
  it('🔴 表の直後の改頁(+++)を、表の升へ飲み込まない', () => {
    const body = '| a | b |\n|---|---|\n| 1 | 2 |\n+++\n\n次の頁\n';
    const out = convert(body, 0, 'csv');
    expect(out, '書き換えられなかった').not.toBeNull();
    expect(out, '改頁が本文から消えた').toContain('+++');
    expect(out, '改頁が表の升になった').not.toContain('+++,');
  });

  /**
   * 🔴 **字下げした囲みでも、式は断る**(着地前レビューが UI 経路で再現した)。
   *
   * ⚠ 直す前は原文の行をそのまま `parseCsv` へ渡していたので、**先頭の升にだけ**
   *   字下げが残り `isFormula`(`=` で始まるか)が false になった ── user 裁定
   *   2026-09-04 の門が**空白 1 つで開き**、画面の `2` が `=1+1` に変わって
   *   **計算が止まった**。
   * 🔑 だから式は**1 列目**に置く(2 列目に置くと、字下げを剥がさない実装でも
   *   断るので、この検査は何も見ていない)。
   */
  it('🔴 字下げした csv の囲みでも、1 列目の式を見落とさない', () => {
    const body = '  ```csv\n  計,覚書\n  =1+1,ふたつ\n  ```\n';
    const at = tableAt(body, 0);
    expect(at, '字下げした囲みを読めていない').not.toBeNull();
    // 空振り防止 ── 字下げが剥がれて升が原文どおりに読めていること
    expect(at!.rows[1]!.cells[0], '字下げが升に残っている').toBe('=1+1');
    const why = tableConvertRefusal(at!, 'markdown');
    expect(why, '式が在るのに断らなかった(計算が止まる)').not.toBeNull();
    expect(why, '断り文がどの升か言っていない').toContain('2 行目の 1 列目');
  });

  /**
   * 🔴 **断り文は場所を言う**(着地前レビュー・動線 ⑤)。
   * ⚠ 式は描くと**ただの数字に見え**、升の中の改行は**空白 1 個に見える**ので、
   *   場所を言わないと user は升を 1 つずつ押して探すことになる。
   */
  it('🔴 断り文が、どの升かと代わりの道を言う', () => {
    const csv = '```csv\nA,B\nx,=1+1\n```\n';
    const why = tableConvertRefusal(tableAt(csv, 0)!, 'markdown');
    expect(why, '場所を言っていない').toContain('2 行目の 2 列目');
    expect(why, '式そのものを見せていない').toContain('=1+1');
    expect(why, '代わりにできることを言っていない').toContain('Markdown の表');
  });

  /**
   * 🔴 **わざとコードで見せている囲みは触らない**(着地前レビュー・動線 ⑥)。
   * ⚠ 出すと、markdown にして戻したとき `csv`(= 表)になり、**二度とコード表示へ
   *   戻せない**(片道の操作を作らない、user 指示 2026-08-23)。
   */
  it('🔴 csv-norender の囲みには出さない(表にするなと書いてある)', () => {
    for (const line of [0, 1, 2, 3]) {
      expect(
        tableAt('```csv-norender\nA,B\n1,2\n```\n', line),
        `${line} 行目で norender の囲みを表として読んだ`,
      ).toBeNull();
    }
    // 対照群 ── 素の csv と `-render` は読める(norender だけを外している)
    expect(tableAt('```csv\nA,B\n1,2\n```\n', 0), '素の csv を読めなくした').not.toBeNull();
    expect(
      tableAt('```csv-render\nA,B\n1,2\n```\n', 0),
      'render の囲みを読めなくした',
    ).not.toBeNull();
  });

  /**
   * 🔴 **`:::` の板の中の表には出さない**(着地前レビュー・動線 ③ / 実装 S-6)。
   *
   * ⚠ 板の中の csv の囲みは `scanContainers`(最上位だけ)に出ないので、変換すると
   *   **戻す項目も出ず、升も押して打てない** ── 片道の操作になる。
   * ⚠ 板の中の ` ```txt ` に書いた表の形の字を読む穴も、同じ門で塞がる。
   * 🔑 板の中でも扱えるようにする直しは **#743**。
   */
  it('🔴 ::: の板の中の表には出さない(戻れなくなるので)', () => {
    const md = ':::note\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n:::\n';
    // 空振り防止 ── 板の外に同じ表を置けば読めること(門だけが効いている)
    expect(tableAt('| a | b |\n|---|---|\n| 1 | 2 |\n', 0), '前提: この表は読めない').not.toBeNull();
    for (const line of [1, 2, 3, 4]) {
      expect(tableAt(md, line), `板の中の ${line} 行目を表として読んだ`).toBeNull();
    }
    const nested = ':::note\n```txt\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n:::\n';
    expect(tableAt(nested, 2), '板の中のコードの字を表として読んだ').toBeNull();
  });
});
