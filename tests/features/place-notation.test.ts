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
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { isPlaceOpen, movePlace } from '../../src/features/markdown/place-notation';

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
