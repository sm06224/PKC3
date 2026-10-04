/**
 * 🔴 **文字起こしの行頭の時刻(`0:15 こんにちは`)を、押せる字にして描く**(#1232 段 b)。
 *
 * 時刻の読み(`0:15` → 15000)は `tests/features/elapsed-text.test.ts`、押した後は
 * `tests/adapter/seek-media-actions.test.ts`、どの面が旗を立てるかは `tests/adapter/detail-seek-links.test.ts`。
 * ⚠ ここが見るのは**描画に届いているか** ── 判定が正しくても、渡し忘れ・当てる場所の間違いで
 *   「押せない」「文中の `14:00` まで押せる」「本文が化ける」になる。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const on = (md: string): string => renderMarkdown(md, { interactiveSeek: true });
const off = (md: string): string => renderMarkdown(md, {});
const count = (html: string): number => (html.match(/class="pkc-seek-link"/g) ?? []).length;

describe('文字起こしの行頭の時刻を押せる字にする(#1232 段 b)', () => {
  it('🔴 入れた面では、行頭の時刻が押せる字になる(位置のミリ秒が属性に載り、字はそのまま)', () => {
    const html = on('0:15 こんにちは\n');
    expect(html, '行頭の時刻が押せる字になっていない').toContain(
      '<span class="pkc-seek-link" data-pkc-action="seek-media" data-pkc-seek-ms="15000" role="button" tabindex="0">0:15</span> こんにちは',
    );
    // 🔑 キーボードで焦点が乗り、Enter / Space で押せる(`tabindex="0"` の既存の道)
    expect(html).toContain('tabindex="0"');
  });

  /**
   * 🔴 **既定は切** ── 再生機の居ない面(書き出した HTML・印刷・別窓・プレビュー)が 1 バイトも変わらない。
   * ⚠ 空振り防止に、同じ本文で入れれば変わることを併せて見る。
   */
  it('🔴 渡さない面の本文は、1 文字も変わらない', () => {
    const md = '0:15 こんにちは\n';
    const html = off(md);
    expect(html, '既定で押せる字になっている').not.toContain('pkc-seek-link');
    expect(html, '既定で受け手の印が出ている').not.toContain('seek-media');
    expect(html, '素の字が消えている').toContain('0:15 こんにちは');
    expect(on(md), '旗を立てても変わらない = 旗を見ていない').not.toBe(html);
  });

  it('🔴 1 時間を超える時刻(1:02:03)は時・分・秒から位置を出す', () => {
    const html = on('1:02:03 長い録音の終わり近く\n');
    expect(html).toContain('data-pkc-seek-ms="3723000"');
    expect(html).toContain('>1:02:03</span> 長い録音');
  });

  it('🔴 文字起こしの本物の並び(1 行 = 時刻 + 字)は、行ごとに自分の位置を持つ', () => {
    const html = on('0:07 はじめに\n0:15 つぎに\n12:34 おわりに\n');
    expect(count(html), '3 行とも押せる字になるはず').toBe(3);
    expect(html).toContain('data-pkc-seek-ms="7000"');
    expect(html).toContain('data-pkc-seek-ms="15000"');
    expect(html).toContain('data-pkc-seek-ms="754000"');
    // ⚠ 字が 1 文字も消えていない(切り貼りで本文を失うのがいちばん取り返しがつかない)
    for (const t of ['はじめに', 'つぎに', 'おわりに']) expect(html, `${t} が消えた`).toContain(t);
  });

  /**
   * 🔴 **行頭だけ** ── 文中の `14:00` は時刻の字で、経過ではない。押せる字にすると
   * 「会議は 14:00 から」の字が、押すと録音を動かす物に化ける。
   */
  it('🔴 文中の時刻は押せる字にしない(行頭だけ)', () => {
    expect(count(on('会議は 14:00 から\n')), '文中の時刻を拾った').toBe(0);
    expect(count(on('0:15 と 0:20 の間\n')), '同じ行の 2 つ目を拾った').toBe(1);
    // 🔑 1 行目が普通の字でも、2 行目の頭は行頭である(`breaks: true` の改行の直後)
    const two = on('メモ\n0:15 こんにちは\n');
    expect(count(two), '改行の直後の行頭を拾えていない').toBe(1);
    expect(two).toContain('data-pkc-seek-ms="15000"');
  });

  /**
   * 🔴 **字の塊の頭であって、行頭ではない形** ── 太字・コード・リンクの直後は、markdown-it が**新しい字の塊**を
   * 始めるので、塊の頭が `0:15 ` と読めても行の途中である(塊の頭だけを見る実装は、ここで拾ってしまう)。
   */
  it('🔴 行の途中の字の塊の頭は押せる字にしない(太字・コード・リンクの直後)', () => {
    expect(count(on('**会議**0:15 から\n')), '太字の直後を拾った').toBe(0);
    expect(count(on('`x`0:15 から\n')), 'コードの直後を拾った').toBe(0);
    expect(count(on('[a](https://example.com/)0:15 から\n')), 'リンクの直後を拾った').toBe(0);
    // 🔑 対照群 ── 同じ字が行頭に在れば押せる(= 上の 0 は「そもそも拾えない」ではない)
    expect(count(on('0:15 から\n'))).toBe(1);
  });

  it('時刻の綴りでないものは字のまま(秒が 2 桁でない / 60 以上 / 後ろに空白が無い)', () => {
    expect(count(on('0:5 こんにちは\n'))).toBe(0);
    expect(count(on('0:75 こんにちは\n'))).toBe(0);
    expect(count(on('0:15こんにちは\n')), '空白で区切られていない').toBe(0);
    expect(count(on('12:34:56:78 こんにちは\n'))).toBe(0);
  });

  it('リンクの中の字は押せる字にしない(入れ子の押し口を作らない)', () => {
    expect(count(on('[0:15 メモ](https://example.com/)\n'))).toBe(0);
  });

  it('リスト・引用の中の行頭も押せる(段落の先頭だから)', () => {
    expect(count(on('- 0:15 こんにちは\n'))).toBe(1);
    expect(count(on('> 0:15 こんにちは\n'))).toBe(1);
  });
});
