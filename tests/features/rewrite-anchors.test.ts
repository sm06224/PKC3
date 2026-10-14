/**
 * 🔴 **行番号だけで指していた書換が、押した時点の行の中身で突き合わせる**(#1087)。
 *
 * 対象は `csv-shape`(表の行・列の足し引き)/ `table-format`(表の形変え)/ `move-lines` の落とし先
 * (`toBeforeLine`)/ `insert-lines` の `anchor`。どれも「別のタブが上へ行を足したあと、古い表示から押すと
 * **1 行上の行 / 別の表 / 別の所**を書き換える」形だった。`task` / `csv-cell` の `openLine` と同じ作法で、
 * 突き合わせて合わなければ書かない(`null`)。
 *
 * 観測点は `applyBodyRewrite` の戻り(書換の実体)。対照群は「合っていれば書ける」を同じ台で置く。
 * ⚠ 「別のタブが上へ 1 行足した」形は、**押した時点の本文**と**いまの disk の本文**を 2 つ作って表す。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite, bodyRewriteRefusal } from '../../src/features/markdown/body-rewrite';
import { moveLinesWithInverse, insertLines } from '../../src/features/markdown/line-move';

const lineOf = (body: string, i: number): string => body.split('\n')[i] ?? '';

describe('csv-shape ── 押した行の中身が違えば、別の行を足さず・消さない', () => {
  // 押した時点の本文(行 2 = `c,d`)と、別のタブが先頭へ 1 行足した後の disk
  const PRESSED = '```csv\na,b\nc,d\ne,f\n```';
  const DISK = '```csv\nz,z\na,b\nc,d\ne,f\n```';
  const shape = (
    body: string,
    over: Partial<{ line: number; openLine: string; col: number; what: 'row' | 'col'; mode: 'add' | 'remove' }> = {},
  ): string | null =>
    applyBodyRewrite(body, {
      kind: 'csv-shape',
      line: 2,
      openLine: lineOf(PRESSED, 2),
      col: 0,
      what: 'row',
      mode: 'remove',
      ...over,
    });

  it('🔴 行を消す:押した時点で行 2 だった `c,d` ではなく、いま行 2 の `a,b` を消さない', () => {
    expect(shape(DISK), '1 行上の行を消した').toBeNull();
    // 対照群 ── 押した時点の本文なら `c,d` が消える(台が常に断る形になっていない)
    expect(shape(PRESSED)).toBe('```csv\na,b\ne,f\n```');
  });

  it('🔴 列を消す・行/列を足す、も同じ門を通る(4 通り全部)', () => {
    for (const what of ['row', 'col'] as const) {
      for (const mode of ['add', 'remove'] as const) {
        expect(shape(DISK, { what, mode }), `${what}/${mode} が古い行番号のまま書いた`).toBeNull();
        expect(shape(PRESSED, { what, mode }), `${what}/${mode} が合っているのに断った(台の前提)`).not.toBeNull();
      }
    }
  });

  it('断りの理由は「最後の行 / 列」だけを言う ── 行が違う断りでは言わない(呼び側の「本文が変わっている」のまま)', () => {
    const why = (body: string, openLine: string): string | null =>
      bodyRewriteRefusal(body, { kind: 'csv-shape', line: 1, openLine, col: 0, what: 'row', mode: 'remove' });
    expect(why('```csv\na,b\n```', 'a,b')).toBe('最後の 1 行は消せません');
    expect(why('```csv\nz,z\n```', 'a,b'), '行が違うのに「最後の 1 行」と言った').toBeNull();
  });
});

describe('table-format ── 2 つ目の表を押したのに 1 つ目が変わらない', () => {
  const T1 = ['| a | b |', '|---|---|', '| 1 | 2 |'];
  const T2 = ['| c | d |', '|---|---|', '| 3 | 4 |'];
  const PRESSED = [...T1, '', ...T2, ''].join('\n');
  // 別のタブが先頭へ 1 つ表を足した → 押した時点で 2 つ目だった行番号は、いまは 3 つ目の表の中
  const DISK = [...T1, '', ...T1, '', ...T2, ''].join('\n');
  const press = PRESSED.split('\n').indexOf('| c | d |'); // 2 つ目の表の見出し行 = 4
  const fmt = (body: string, line: number, openLine: string): string | null =>
    applyBodyRewrite(body, { kind: 'table-format', line, openLine, to: 'csv' });

  it('🔴 行番号だけなら 1 つ上の表(いま 4 行目)が CSV になる ── 突き合わせて断る', () => {
    // 前提:行番号 4 は disk では別の表の行(押した表ではない)
    expect(lineOf(DISK, press)).not.toBe('| c | d |');
    expect(fmt(DISK, press, '| c | d |'), '別の表を変えた').toBeNull();
    // 対照群 ── 押した時点の本文なら 2 つ目の表だけが CSV になり、1 つ目は 1 byte も動かない
    const out = fmt(PRESSED, press, '| c | d |')!;
    expect(out).toContain('```csv');
    expect(out.startsWith(T1.join('\n') + '\n\n```'), '1 つ目の表が動いた').toBe(true);
  });
});

describe('move-lines ── 落とし先の行も、落とした時点の字のままでなければ動かさない', () => {
  const RAW = ['# 題', '', '段落 A', '', '段落 B', '', '段落 C', ''].join('\n');
  // 段落 A(行 2)を、段落 C(行 6)の前へ。別のタブが先頭へ 1 行足すと、行 6 は `段落 B` の後ろの空行になる
  const DISK = ['新しい行', '', ...RAW.split('\n').slice(0)].join('\n');
  const move = (body: string, over: Partial<{ toBefore: number; toBeforeLine: string | null; lines: string[]; start: number; end: number }> = {}) =>
    applyBodyRewrite(body, {
      kind: 'move-lines',
      start: 2,
      end: 2,
      toBefore: 6,
      lines: ['段落 A'],
      toBeforeLine: lineOf(RAW, 6),
      ...over,
    });

  it('🔴 塊の字が一致していても、落とし先がずれていれば書かない', () => {
    // 塊のほうは「同じ字の行がたまたま同じ番号に居る」形にして、落とし先だけが食い違う台にする
    const shiftedTarget = ['# 題', '', '段落 A', '', '段落 B', '', '挿入された行', '段落 C', ''].join('\n');
    expect(lineOf(shiftedTarget, 2), '台の前提:塊の字は合っている').toBe('段落 A');
    expect(move(shiftedTarget), '落とし先が別の行なのに動かした').toBeNull();
    // 対照群 ── 落とし先も合っていれば動く
    expect(move(RAW), '合っているのに断った(台の前提)').not.toBeNull();
    expect(DISK).not.toBe(RAW);
  });

  it('末尾(`toBeforeLine: null`)は、行数と等しい `toBefore` のときだけ', () => {
    const n = RAW.split('\n').length;
    expect(move(RAW, { toBefore: n, toBeforeLine: null })).not.toBeNull();
    // 末尾のつもりなのに、その番号にはもう行が在る(別のタブが行を足した)
    expect(move(`${RAW}\n追加された行`, { toBefore: n, toBeforeLine: null })).toBeNull();
    // 逆:行が在るつもりなのに、その番号がもう末尾
    expect(move(RAW, { toBefore: n, toBeforeLine: '段落 C' })).toBeNull();
  });

  it('🔴 取りやめ(自分の中へ落とす)は、落とし先が古くても断らない ── 1 byte も変わらないので嘘の赤帯を出さない', () => {
    const out = move(RAW, { toBefore: 3, toBeforeLine: '別の字(古い)' });
    expect(out, '取りやめが断りになった').toBe(RAW);
  });

  it('🔴 「元に戻す」の逆向きの指示も落とし先の字を持ち、戻す本文が古ければ断る', () => {
    const moved = moveLinesWithInverse(RAW, {
      start: 2,
      end: 2,
      toBefore: 6,
      lines: ['段落 A'],
      toBeforeLine: lineOf(RAW, 6),
    })!;
    expect(moved.inverse, '逆向きの指示が無い').not.toBeNull();
    expect(typeof moved.inverse!.toBeforeLine === 'string' || moved.inverse!.toBeforeLine === null).toBe(true);
    // 対照群 ── そのまま戻せば元の本文
    expect(applyBodyRewrite(moved.body, { kind: 'move-lines', ...moved.inverse! })).toBe(RAW);
    // 戻す先の行が書き換わっていたら、戻さない
    const edited = moved.body.replace('段落 B', '段落 B(別のタブが直した)');
    expect(edited).not.toBe(moved.body);
    expect(applyBodyRewrite(edited, { kind: 'move-lines', ...moved.inverse! }), '戻す先が古いのに戻した').toBeNull();
  });
});

describe('insert-lines ── 落とした所の目印(anchor)', () => {
  const DOC = ['# 題', '', '段落', ''].join('\n');
  it('🔴 目印が合わなければ書かない / 合えば書く(`insertLines` の既存の門を、書換の型が必須で運ぶ)', () => {
    const rw = (body: string, text: string) =>
      applyBodyRewrite(body, { kind: 'insert-lines', toBefore: 2, lines: ['[相手](entry:n2)'], anchor: { line: 2, text } });
    expect(rw(DOC, '段落')).not.toBeNull();
    expect(rw(`新しい行\n${DOC}`, '段落'), '別の窓が行を足したのに刺さった').toBeNull();
    expect(insertLines(DOC, 2, ['x'], { line: 2, text: '段落' })).not.toBeNull();
  });

  it('`anchor: null` は、行き先の末尾へ入れた ack の顔だけ ── 突き合わせない(落とした所が無い)', () => {
    expect(
      applyBodyRewrite(DOC, { kind: 'insert-lines', toBefore: 2, lines: ['[相手](entry:n2)'], anchor: null }),
    ).not.toBeNull();
  });
});
