/** @vitest-environment happy-dom */
/**
 * 🔴 **`|` で書いた表にも、行・列を足す / 消す「＋ ×」**(#1662 6。Gemini 裁定 = #1163 依頼 48 の 6 = A)。
 *
 * 直す前は、セルは打てるのに行や列を足すには「CSV の表にする」で書き方ごと変えるか、原文を開くしか無かった。
 * 見るのは ①書換が触るのは行 / 区画だけ(触っていない升・余白・桁揃えの印は 1 バイトも動かない)
 * ②読み手(markdown-it)が書いた後の本文を同じ表として読む ③画面に ＋ × が焼かれ、書き出し・印刷の面には焼かれない。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite, bodyRewriteRefusal, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const T = ['前置き', '', '| 品名 | 数 | 備考 |', '|:---|---:|:---:|', '| りんご | 3 | 赤い |', '| みかん | 5 | 甘い |', '', '後ろ', ''].join('\n');
const shape = (
  body: string,
  line: number,
  what: 'row' | 'col',
  mode: 'add' | 'remove',
  col = 0,
): BodyRewrite => ({
  kind: 'csv-shape',
  line,
  openLine: body.split('\n')[line]!,
  col,
  what,
  mode,
});
const apply = (body: string, rw: BodyRewrite): string | null => applyBodyRewrite(body, rw);

describe('| の表の行(#1662 6)', () => {
  it('🔴 行を足すと、押した行の下に空の行が入る。見出しの行からは、本文の 1 行目になる', () => {
    expect(apply(T, shape(T, 4, 'row', 'add'))!.split('\n')).toEqual([
      '前置き',
      '',
      '| 品名 | 数 | 備考 |',
      '|:---|---:|:---:|',
      '| りんご | 3 | 赤い |',
      '|  |  |  |',
      '| みかん | 5 | 甘い |',
      '',
      '後ろ',
      '',
    ]);
    expect(apply(T, shape(T, 2, 'row', 'add'))!.split('\n').slice(2, 6)).toEqual([
      '| 品名 | 数 | 備考 |',
      '|:---|---:|:---:|',
      '|  |  |  |',
      '| りんご | 3 | 赤い |',
    ]);
  });

  it('🔴 行を消すと、その行だけが無くなる(双方向)。見出しの行は消せない / 最後の 1 行は理由を言って断る', () => {
    expect(apply(T, shape(T, 4, 'row', 'remove'))).toBe(T.replace('| りんご | 3 | 赤い |\n', ''));
    // 足した行は消して元に戻せる
    const added = apply(T, shape(T, 4, 'row', 'add'))!;
    expect(apply(added, shape(added, 5, 'row', 'remove'))).toBe(T);
    expect(apply(T, shape(T, 2, 'row', 'remove')), '見出しの行を消した').toBeNull();
    const one = apply(T, shape(T, 4, 'row', 'remove'))!;
    const rw = shape(one, 4, 'row', 'remove');
    expect(apply(one, rw), '最後の 1 行を消した').toBeNull();
    expect(bodyRewriteRefusal(one, rw)).toBe('最後の 1 行は消せません');
  });
});

describe('| の表の列(#1662 6)', () => {
  it('🔴 列を足すと、押した列の右に空の列が入り、桁揃えの印と触っていない升の字は動かない', () => {
    expect(apply(T, shape(T, 2, 'col', 'add', 0))!.split('\n').slice(2, 6)).toEqual([
      '| 品名 |  | 数 | 備考 |',
      '|:---|---|---:|:---:|',
      '| りんご |  | 3 | 赤い |',
      '| みかん |  | 5 | 甘い |',
    ]);
    // いちばん右にも足せる
    expect(apply(T, shape(T, 4, 'col', 'add', 2))!.split('\n')[2]).toBe('| 品名 | 数 | 備考 |  |');
  });

  it('🔴 列を消すと、その列の区画が全行(区切りの行も)から無くなり、残りの桁揃えは動かない / 最後の 1 列は断る', () => {
    expect(apply(T, shape(T, 2, 'col', 'remove', 1))!.split('\n').slice(2, 6)).toEqual([
      '| 品名 | 備考 |',
      '|:---|:---:|',
      '| りんご | 赤い |',
      '| みかん | 甘い |',
    ]);
    expect(apply(T, shape(T, 2, 'col', 'remove', 0))!.split('\n')[3]).toBe('|---:|:---:|');
    // 足した列は消して元に戻せる
    const added = apply(T, shape(T, 2, 'col', 'add', 1))!;
    expect(apply(added, shape(added, 2, 'col', 'remove', 2))).toBe(T);
    const solo = '| a |\n|---|\n| 1 |\n';
    const rw = shape(solo, 0, 'col', 'remove');
    expect(apply(solo, rw)).toBeNull();
    expect(bodyRewriteRefusal(solo, rw)).toBe('最後の 1 列は消せません');
  });

  it('その列を持たない短い行は飛ばす(埋めない)', () => {
    const short = '| a | b |\n|---|---|\n| 1 |\n| 2 | 3 |\n';
    expect(apply(short, shape(short, 0, 'col', 'add', 1))).toBe('| a | b |  |\n|---|---|---|\n| 1 |\n| 2 | 3 |  |\n');
  });

  it('縦棒の省略形(前後の | が無い表)でも、表のまま足せて消せる', () => {
    const bare = 'a | b\n--- | ---\n1 | 2\n';
    expect(apply(bare, shape(bare, 0, 'col', 'add', 1))).toBe('a | b|  |\n--- | ---| --- |\n1 | 2|  |\n');
    expect(apply(bare, shape(bare, 0, 'col', 'remove', 0))).toBe('| b |\n| --- |\n| 2 |\n');
  });

  it('🔴 引用の中の表も、前置きをそのまま残して足せる', () => {
    const q = '> | a | b |\n> |---|---|\n> | 1 | 2 |\n';
    expect(apply(q, shape(q, 2, 'row', 'add'))).toBe('> | a | b |\n> |---|---|\n> | 1 | 2 |\n> |  |  |\n');
    expect(apply(q, shape(q, 0, 'col', 'add', 0))).toBe('> | a |  | b |\n> |---|---|---|\n> | 1 |  | 2 |\n');
  });

  it('押した時点の行と違う本文には書かない / 表でない行・区切りの行も書かない', () => {
    expect(apply(T, { ...shape(T, 4, 'row', 'add'), openLine: '| ちがう |' } as BodyRewrite)).toBeNull();
    expect(apply(T, shape(T, 0, 'row', 'add')), '段落を表の行と読んだ').toBeNull();
    expect(apply(T, shape(T, 3, 'row', 'add')), '区切りの行を表の行と読んだ').toBeNull();
  });
});

describe('| の表の ＋ ×(#1662 6)── 描画', () => {
  const html = (body: string, interactive: boolean): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown(body, { sourceLineAnchors: true, taskLineOffset: 0, interactiveCells: interactive } as never);
    return el;
  };
  const btns = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>('button.pkc-csv-shape')].map(
      (b) =>
        `${b.closest('th') ? 'th' : 'td'}:${b.getAttribute('data-pkc-cell-line')}:${b.getAttribute('data-pkc-cell-col')}:${b.getAttribute('data-pkc-cell-what')}:${b.getAttribute('data-pkc-cell-mode')}`,
    );

  it('🔴 列の口は見出しの升に、行の口は本文の行の 1 列目に焼かれる(見出しの行の行の口は無い)', () => {
    const got = btns(html(T, true));
    expect(got.filter((s) => s.startsWith('th:2'))).toEqual([
      'th:2:0:col:add', 'th:2:0:col:remove', 'th:2:1:col:add', 'th:2:1:col:remove', 'th:2:2:col:add', 'th:2:2:col:remove',
    ]);
    expect(got.filter((s) => s.startsWith('td'))).toEqual([
      'td:4:0:row:add', 'td:4:0:row:remove', 'td:5:0:row:add', 'td:5:0:row:remove',
    ]);
  });

  it('🔴 押せない面(書き出し・印刷)には焼かない / 升の字には混ざらない', () => {
    expect(btns(html(T, false))).toEqual([]);
    const el = html(T, true);
    expect(el.querySelector('td')!.textContent, '升の字に ＋ × が混ざった').toBe('りんご');
  });

  it('🔴 書いた後の本文を、読み手は同じ表として読む(足した列の分だけ見出しが増える)', () => {
    const next = apply(T, shape(T, 2, 'col', 'add', 1))!;
    const el = html(next, false);
    expect([...el.querySelectorAll('th')].map((t) => t.textContent)).toEqual(['品名', '数', '', '備考']);
    expect(el.querySelectorAll('tbody tr').length).toBe(2);
  });
});
