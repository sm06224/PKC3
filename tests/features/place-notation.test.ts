/**
 * 🔴 **自由配置の板の記法**(#283 P4)── 受理の判定と、位置だけの書き換え。
 *
 * ## 守る主張
 *
 * 1. 🔴 受理は**描画と同じ**(正式形 + Tier 1 の寛容形。`::::format` は描画されない
 *    ので受けない)── 判定が 2 本あると番号がずれ、**別の付箋が動く**
 *    (レビュー実測 2026-08-28。CLAUDE.md §7)
 * 2. 🔴 書き換えるのは **x= / y= だけ**(他は 1 byte も変えない)
 * 3. 🔴 指した行が掴んだ時点の開き行と **byte 一致しなければ書かない**(別の窓の
 *    書込を巻き戻さない ── `undo-append` と同じ作法)
 * 4. 🔑 値が変わらないときは **body をそのまま返す**(null = 断る、と区別する ──
 *    null に混ぜると、取りやめた drop に「開き直してください」の嘘の赤帯が出る)
 * 5. 🔴 #676 の 3 操作(大きさ / 消す / 足す)も**同じ門**を通る ── 指定の札以外は
 *    1 byte も変わらない / 閉じていない板は消さない(末尾まで消える事故) /
 *    足した塊は**描画が板として描く綴り**である
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  addPlace,
  isPlaceOpen,
  movePlace,
  NEW_PLACE_H,
  NEW_PLACE_W,
  raisePlace,
  removePlace,
  resizePlace,
} from '../../src/features/markdown/place-notation';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
  ':::',
].join('\n');

describe('板の開き行の受理(isPlaceOpen)── 描画と同じ形だけ', () => {
  it('正式形 ── クラス札の判定(前後に別の札があってもよい)', () => {
    expect(isPlaceOpen(':::format{.pkc-place}')).toBe(true);
    expect(isPlaceOpen(':::format{#a .pkc-place x=1}')).toBe(true);
    expect(isPlaceOpen(':::format{.pkc-placeholder}')).toBe(false);
    expect(isPlaceOpen(':::format{x=1}')).toBe(false);
  });

  it('🔴 Tier 1 の寛容形も受ける(描画が板として描く ── 実測 2026-08-28)', () => {
    expect(isPlaceOpen('::: {.pkc-place x=10 y=10}')).toBe(true);
    expect(isPlaceOpen(':::{.pkc-place x=10 y=10}')).toBe(true);
    expect(isPlaceOpen(':::.pkc-place')).toBe(true);
    expect(isPlaceOpen('::: .pkc-place')).toBe(true);
    expect(isPlaceOpen('::: pkc-place')).toBe(true);
  });

  it('🔴 描画されない形は受けない(受けると描画と数がずれる)', () => {
    // 4 コロンは parseBlockDirectiveOpen(3 コロン固定)が受けない = 描画されない
    expect(isPlaceOpen('::::format{.pkc-place x=1}')).toBe(false);
    // 別名の directive はクラスが付いても板ではない(描画は callout などになる)
    expect(isPlaceOpen(':::note{.pkc-place}')).toBe(false);
    // 引用値の中の字面は札ではない(描画側のパースと同じ盲点を共有する)
    expect(isPlaceOpen(':::format{note="a .pkc-place b"}')).toBe(false);
  });

  /**
   * 🔴 **描画との合意を 1 か所で見る**(CLAUDE.md §7「A と B が合意していることは、
   * A の test にも B の test にも書けない」)── 実物の描画器に同じ本文を渡し、
   * 板として描かれた塊の `data-pkc-source-line` が、**全部** `isPlaceOpen` の
   * 受理する行を指すことを assert する。
   */
  it('🔴 描画が板として描いた塊の行は、全部 isPlaceOpen が受理する', () => {
    const body = [
      ':::format{.pkc-place x=1 y=1}',
      'A',
      ':::',
      '::: {.pkc-place x=2 y=2}',
      'B',
      ':::',
      ':::.pkc-place',
      'C',
      ':::',
      '::: pkc-place',
      'D',
      ':::',
      '::::format{.pkc-place x=9}',
      'not a place',
      '::::',
    ].join('\n');
    const html = renderMarkdown(body, { sourceLineAnchors: true } as never);
    const opens = [
      ...html.matchAll(
        /<div[^>]*class="[^"]*pkc-format-block[^"]*pkc-place[^"]*"[^>]*data-pkc-source-line="(\d+)"/g,
      ),
    ].map((m) => Number(m[1]));
    // ⚠ 空振り防止 ── 寛容形が 1 つも描かれない世界ならこの test 自体が嘘になる
    expect(opens.length, '板として描かれた塊の数').toBe(4);
    const lines = body.split('\n');
    for (const at of opens) {
      expect(isPlaceOpen(lines[at]!), `line ${at}: ${lines[at]}`).toBe(true);
    }
  });
});

describe('位置だけの書き換え(movePlace)', () => {
  const line0 = BOARD.split('\n')[0]!;

  it('🔴 x= / y= だけが変わり、他は 1 byte も変わらない', () => {
    const next = movePlace(BOARD, { line: 0, openLine: line0, x: 10, y: 20 });
    expect(next).not.toBeNull();
    const lines = next!.split('\n');
    expect(lines[0]).toBe(':::format{#p1 .pkc-place x=10 y=20 w=320 h=200}');
    // ⚠ 他の行は無傷
    expect(lines.slice(1)).toEqual(BOARD.split('\n').slice(1));
  });

  it('x= / y= が無い塊には足す', () => {
    const body = ':::format{.pkc-place}\n:::';
    const next = movePlace(body, { line: 0, openLine: ':::format{.pkc-place}', x: 5, y: 6 });
    expect(next!.split('\n')[0]).toBe(':::format{.pkc-place x=5 y=6}');
  });

  it('🔴 Tier 1 の brace 形は、括弧の中だけ書き換える', () => {
    const open = '::: {.pkc-place x=10 y=10}';
    const body = `${open}\nB\n:::`;
    const next = movePlace(body, { line: 0, openLine: open, x: 30, y: 40 });
    expect(next!.split('\n')[0]).toBe('::: {.pkc-place x=30 y=40}');
  });

  it('🔴 括弧を持たない Tier 1 形は、同義の括弧つき形へ整えて座標を書く', () => {
    const body = ':::.pkc-place\nC\n:::';
    const next = movePlace(body, { line: 0, openLine: ':::.pkc-place', x: 3, y: 4 });
    expect(next!.split('\n')[0]).toBe('::: {.pkc-place x=3 y=4}');
    // id も落とさない
    const body2 = '::: .pkc-place #tag\nC\n:::';
    const next2 = movePlace(body2, { line: 0, openLine: '::: .pkc-place #tag', x: 3, y: 4 });
    expect(next2!.split('\n')[0]).toBe('::: {.pkc-place #tag x=3 y=4}');
  });

  it('引用つき(x="120")や数字でない値も、丸ごと引用なしの整数へ揃える(2 つ目の x= を作らない)', () => {
    const q = ':::format{.pkc-place x="120" y=4}';
    expect(movePlace(`${q}\n:::`, { line: 0, openLine: q, x: 7, y: 8 })!.split('\n')[0]).toBe(
      ':::format{.pkc-place x=7 y=8}',
    );
    const odd = ':::format{.pkc-place x=+5 y=1e2}';
    expect(movePlace(`${odd}\n:::`, { line: 0, openLine: odd, x: 7, y: 8 })!.split('\n')[0]).toBe(
      ':::format{.pkc-place x=7 y=8}',
    );
  });

  it('🔴 開き行が掴んだ時点と違えば書かない(別の窓の書込を巻き戻さない)', () => {
    expect(movePlace(BOARD, { line: 0, openLine: ':::format{.pkc-place x=999}', x: 1, y: 2 })).toBeNull();
  });

  it('🔴 同じ字の塊が 2 つあっても、指した行だけが変わる', () => {
    const twin = ':::format{.pkc-place x=1 y=1}';
    const body = [twin, ':::', twin, ':::'].join('\n');
    const next = movePlace(body, { line: 2, openLine: twin, x: 9, y: 9 });
    const lines = next!.split('\n');
    expect(lines[0]).toBe(twin);
    expect(lines[2]).toBe(':::format{.pkc-place x=9 y=9}');
  });

  it('🔑 値が変わらないときは body をそのまま返す(書く物が無い ≠ 競合)', () => {
    expect(movePlace(BOARD, { line: 0, openLine: line0, x: 120, y: 40 })).toBe(BOARD);
  });

  it('行が範囲の外 / 板の行でない / 値が負・小数 ── どれも null(書かない)', () => {
    expect(movePlace(BOARD, { line: 99, openLine: line0, x: 1, y: 2 })).toBeNull();
    // 行番号が板でない行(本文の行)を指しても、byte 一致の前に受理で断る
    expect(movePlace(BOARD, { line: 2, openLine: '- 牛乳', x: 1, y: 2 })).toBeNull();
    expect(movePlace(BOARD, { line: 0, openLine: line0, x: -1, y: 2 })).toBeNull();
    expect(movePlace(BOARD, { line: 0, openLine: line0, x: 1.5, y: 2 })).toBeNull();
  });

  it('🔴 frontmatter の中の行は書かない(行番号は原文基準)', () => {
    const open = ':::format{.pkc-place x=1 y=1}';
    // ⚠ frontmatter の中身を**開き行そのものの字面**にする ── byte 一致も
    //   isPlaceOpen も通る形にしないと、frontmatter の門ではなく受理の門が
    //   先に断って、この test は門を 1 つも見ていないことになる(§1「救い手が別」。
    //   実際に変異 N3 が SURVIVED で教えた)
    const body = `---\n${open}\n---\n${open}\n:::`;
    expect(movePlace(body, { line: 1, openLine: open, x: 2, y: 3 })).toBeNull();
    // 本体側(line 3)は書ける ── 同じ字面でも、frontmatter の外なら通る(対照群)
    const next = movePlace(body, { line: 3, openLine: open, x: 2, y: 3 });
    expect(next!.split('\n')[3]).toBe(':::format{.pkc-place x=2 y=3}');
    expect(next!.split('\n')[1], 'frontmatter 側まで書き換えた').toBe(open);
  });

  it('🔴 fence の中へ移った同じ字面の行には書かない(別の窓の書込で行が動いた形)', () => {
    const open = ':::format{.pkc-place x=1 y=1}';
    const fenced = ['```', open, '```'].join('\n');
    expect(movePlace(fenced, { line: 1, openLine: open, x: 2, y: 3 })).toBeNull();
    // ~~~ の fence も同じ(閉じは同種・同長以上)
    const tilde = ['~~~', open, '~~~'].join('\n');
    expect(movePlace(tilde, { line: 1, openLine: open, x: 2, y: 3 })).toBeNull();
    // ``` を ~~~ が閉じることは無い ── fence は開いたまま = やはり書かない
    const crossed = ['```', '~~~', open].join('\n');
    expect(movePlace(crossed, { line: 2, openLine: open, x: 2, y: 3 })).toBeNull();
  });
});

describe('大きさだけの書き換え(resizePlace)(#676)', () => {
  const line0 = BOARD.split('\n')[0]!;

  it('🔴 w= / h= だけが変わり、x= / y= も他の行も 1 byte も変わらない', () => {
    const next = resizePlace(BOARD, { line: 0, openLine: line0, w: 400, h: 90 });
    expect(next).not.toBeNull();
    const lines = next!.split('\n');
    expect(lines[0]).toBe(':::format{#p1 .pkc-place x=120 y=40 w=400 h=90}');
    expect(lines.slice(1)).toEqual(BOARD.split('\n').slice(1));
  });

  it('w= / h= が無い塊には足す(x= / y= の後ろ)', () => {
    const open = ':::format{#p2 .pkc-place entry=n2 x=460 y=40}';
    const next = resizePlace(BOARD, { line: 5, openLine: open, w: 200, h: 120 });
    expect(next!.split('\n')[5]).toBe(':::format{#p2 .pkc-place entry=n2 x=460 y=40 w=200 h=120}');
  });

  it('🔴 同じ門を通る ── byte 不一致 / fence の中 / 負・小数 は null、同じ値は body そのまま', () => {
    expect(resizePlace(BOARD, { line: 0, openLine: ':::format{.pkc-place x=999}', w: 1, h: 2 })).toBeNull();
    const open = ':::format{.pkc-place x=1 y=1 w=10 h=10}';
    expect(resizePlace(['```', open, '```'].join('\n'), { line: 1, openLine: open, w: 5, h: 5 })).toBeNull();
    expect(resizePlace(BOARD, { line: 0, openLine: line0, w: -1, h: 2 })).toBeNull();
    expect(resizePlace(BOARD, { line: 0, openLine: line0, w: 1.5, h: 2 })).toBeNull();
    expect(resizePlace(BOARD, { line: 0, openLine: line0, w: 320, h: 200 })).toBe(BOARD);
  });
});

describe('板の塊を消す(removePlace)(#676)', () => {
  const lines = BOARD.split('\n');

  it('🔴 開き行から閉じの ::: まで + 後ろの空行 1 本が消え、次の板の開き行は 1 byte も動かない', () => {
    const next = removePlace(BOARD, { line: 0, openLine: lines[0]! });
    expect(next).toBe([lines[5], lines[6]].join('\n'));
  });

  it('末尾の板は、前の空行 1 本と一緒に消える(空行が 2 本並ばない)', () => {
    const next = removePlace(BOARD, { line: 5, openLine: lines[5]! });
    expect(next).toBe(lines.slice(0, 4).join('\n'));
  });

  it('空行は 1 本しか消さない(隣の段落の間隔まで詰めない)', () => {
    const body = ['A', '', '', ':::format{.pkc-place x=1 y=1}', 'B', ':::', '', '', 'C'].join('\n');
    expect(removePlace(body, { line: 3, openLine: ':::format{.pkc-place x=1 y=1}' })).toBe(
      ['A', '', '', '', 'C'].join('\n'),
    );
  });

  it('🔴 閉じていない板は消さない(消すと末尾まで丸ごと消える)', () => {
    const open = ':::format{.pkc-place x=1 y=1}';
    const body = [open, 'まだ書いている', '', '## 次の章', '本文'].join('\n');
    expect(removePlace(body, { line: 0, openLine: open })).toBeNull();
    // 対照群 ── 閉じを足せば消せる(門が閉じの有無を見ていることを見る)
    const closed = [open, 'まだ書いている', ':::', '', '## 次の章', '本文'].join('\n');
    expect(removePlace(closed, { line: 0, openLine: open })).toBe('## 次の章\n本文');
  });

  it('入れ子の内側の板は、内側だけ消える(外側の囲みは残る)', () => {
    const open = ':::format{.pkc-place x=1 y=1}';
    const body = [':::section', open, 'A', ':::', ':::'].join('\n');
    expect(removePlace(body, { line: 1, openLine: open })).toBe(':::section\n:::');
  });

  it('🔴 frontmatter のあるノートでも、行番号は生の body 基準で当たる', () => {
    const open = ':::format{.pkc-place x=1 y=1}';
    const body = ['---', 'a: 1', '---', '', open, ':::', '', '段落'].join('\n');
    expect(removePlace(body, { line: 4, openLine: open })).toBe('---\na: 1\n---\n\n段落');
  });

  it('同じ門 ── byte 不一致 / 板でない行 / fence の中 は null', () => {
    expect(removePlace(BOARD, { line: 0, openLine: ':::format{.pkc-place x=999}' })).toBeNull();
    expect(removePlace(BOARD, { line: 2, openLine: '- 牛乳' })).toBeNull();
    const open = ':::format{.pkc-place x=1 y=1}';
    expect(removePlace(['```', open, ':::', '```'].join('\n'), { line: 1, openLine: open })).toBeNull();
  });
});

describe('板の塊を足す(addPlace)(#676)', () => {
  it('🔴 末尾に空の塊が足され、元の行は 1 byte も動かない', () => {
    const body = '# 題\n\n本文\n';
    const next = addPlace(body, 30, 50);
    expect(next).toBe(`# 題\n\n本文\n\n:::format{.pkc-place x=30 y=50 w=${NEW_PLACE_W} h=${NEW_PLACE_H}}\n\n:::\n`);
    expect(next!.startsWith(body), '元の本文が変わった').toBe(true);
  });

  it('末尾に改行が無い本文でも、空行 1 本で区切って足す', () => {
    expect(addPlace('本文', 0, 0)).toBe(`本文\n\n:::format{.pkc-place x=0 y=0 w=${NEW_PLACE_W} h=${NEW_PLACE_H}}\n\n:::\n`);
    expect(addPlace('', 0, 0)).toBe(`:::format{.pkc-place x=0 y=0 w=${NEW_PLACE_W} h=${NEW_PLACE_H}}\n\n:::\n`);
  });

  /**
   * 🔴 **描画との合意をここで見る** ── 足した綴りを実物の描画器に渡し、板の塊として
   * **その座標で**描かれることを assert する(綴りが描画から外れたら、置いたのに画面に
   * 出ないという最も静かな壊れ方になる)。
   */
  it('🔴 足した塊は、描画が板として(その座標で)描く', () => {
    const next = addPlace('本文\n', 30, 50)!;
    const html = renderMarkdown(next, { sourceLineAnchors: true } as never);
    const m = /<div[^>]*class="[^"]*pkc-format-block[^"]*pkc-place[^"]*"[^>]*>/.exec(html);
    expect(m, '板として描かれていない').not.toBeNull();
    expect(m![0]).toContain('data-pkc-x="30"');
    expect(m![0]).toContain('data-pkc-y="50"');
    expect(m![0]).toContain(`data-pkc-w="${NEW_PLACE_W}"`);
    // 開き行の行番号は、足した塊の開き行(2 行目 = 本文 / 空行 / 開き)
    expect(m![0]).toContain('data-pkc-source-line="2"');
    // ⚠ 開き行は isPlaceOpen が受ける(動かす / 消す の門を通れる)
    expect(isPlaceOpen(next.split('\n')[2]!)).toBe(true);
  });

  it('🔴 末尾の囲いが閉じていなければ足さない(fence / ::: の中に書くと画面に出ない)', () => {
    expect(addPlace('本文\n```js\nconst a = 1;\n', 1, 1)).toBeNull();
    expect(addPlace(':::note\nまだ書いている\n', 1, 1)).toBeNull();
    // 対照群 ── 閉じていれば足せる
    expect(addPlace('本文\n```js\nconst a = 1;\n```\n', 1, 1)).not.toBeNull();
  });

  it('負・小数の座標は null', () => {
    expect(addPlace('本文', -1, 0)).toBeNull();
    expect(addPlace('本文', 0, 1.5)).toBeNull();
  });
});

describe('板を前へ出す(raisePlace)(#676 段②)', () => {
  const A = ':::format{#a .pkc-place x=1 y=1 z=2}';
  const B = ':::format{#b .pkc-place x=2 y=2}';
  const C = ':::format{#c .pkc-place x=3 y=3 z=5}';
  const FENCED = ':::format{#f .pkc-place x=9 y=9 z=99}';
  // 0:A 1:::: 2:'' 3:B 4:::: 5:``` 6:FENCED 7:``` 8:C 9::::
  const BODY = [A, ':::', '', B, ':::', '```', FENCED, '```', C, ':::'].join('\n');

  it('🔴 他の板の z= の最大 + 1 を書く ── fence の中の板は数えない(99 ではなく 5 + 1)', () => {
    const next = raisePlace(BODY, { line: 3, openLine: B });
    expect(next).not.toBeNull();
    const lines = next!.split('\n');
    expect(lines[3]).toBe(':::format{#b .pkc-place x=2 y=2 z=6}');
    // ⚠ 他の行は 1 byte も動かない(他の板の z を触って「後ろへ送る」形にしない)
    expect([...lines.slice(0, 3), ...lines.slice(4)]).toEqual([...BODY.split('\n').slice(0, 3), ...BODY.split('\n').slice(4)]);
  });

  it('🔑 既に独りでいちばん前なら body をそのまま返す(書く物が無い ≠ 競合)', () => {
    expect(raisePlace(BODY, { line: 8, openLine: C })).toBe(BODY);
  });

  it('同じ z が並ぶ(引き分け)なら 1 つ上げる', () => {
    const tie = [C, ':::', '', C.replace('#c', '#d'), ':::'].join('\n');
    const next = raisePlace(tie, { line: 0, openLine: C });
    expect(next!.split('\n')[0]).toBe(':::format{#c .pkc-place x=3 y=3 z=6}');
  });

  it('z= を持たない板しか居なければ z=1(無し = auto の上に乗る)、括弧なしの Tier 1 形は括弧つきに整える', () => {
    const lone = ':::.pkc-place\nA\n:::\n\n::: pkc-place\nB\n:::';
    expect(raisePlace(lone, { line: 0, openLine: ':::.pkc-place' })!.split('\n')[0]).toBe('::: {.pkc-place z=1}');
  });

  it('🔴 fence の中の板を数えない ── 対照群: fence を外せば 99 + 1 になる', () => {
    const open = [A, ':::', '', B, ':::', '', FENCED, ':::', '', C, ':::'].join('\n');
    expect(raisePlace(open, { line: 3, openLine: B })!.split('\n')[3]).toBe(':::format{#b .pkc-place x=2 y=2 z=100}');
  });

  it('同じ門 ── byte 不一致 / 板でない行 / fence の中の行 は null', () => {
    expect(raisePlace(BODY, { line: 3, openLine: A })).toBeNull();
    expect(raisePlace(BODY, { line: 2, openLine: '' })).toBeNull();
    expect(raisePlace(BODY, { line: 6, openLine: FENCED })).toBeNull();
  });
});
