/**
 * 🔴 **本文の `@2026-10-15` を、押せる字にして描く**(#1169)。
 *
 * 判定そのもの(実在する日か / 期間か)は `tests/features/line-date.test.ts` が見ている。
 * ⚠ ここが見るのは**描画に届いているか**である ── 判定が正しくても、渡し忘れ・
 * 当てる場所の間違いで「押せない」「本文が化ける」になる。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const on = (md: string): string => renderMarkdown(md, { interactiveDates: true });
const off = (md: string): string => renderMarkdown(md, {});

describe('本文の @日付を押せる字にする(#1169)', () => {
  it('🔴 入れた面では、押せる字になる(受け手と日付が属性に載る)', () => {
    const html = on('- [ ] 見積を送る @2026-10-15\n');
    expect(html, '日付が押せる字になっていない').toContain(
      '<span class="pkc-date-link" data-pkc-action="open-date-note" data-pkc-date="2026-10-15" role="link" tabindex="0">@2026-10-15</span>',
    );
    // 🔑 キーボードで焦点が乗り、Enter / Space で押せる(`tabindex="0"` の既存の道)
    expect(html, 'キーボードで焦点が乗らない').toContain('tabindex="0"');
    // ⚠ 前後の字が 1 文字も消えていない(切り貼りで本文を失うのが、いちばん取り返しがつかない)
    expect(html, '日付の前の字が消えた').toContain('見積を送る ');
  });

  /**
   * 🔴 **既定は切** ── 受け手の居ない面(書き出した HTML・印刷)が 1 バイトも変わらない。
   * ⚠ 空振り防止に、同じ本文で入れれば変わることを併せて見る。
   */
  it('🔴 渡さない面の本文は、1 文字も変わらない', () => {
    const html = off('見積を送る @2026-10-15 まで。');
    expect(html, '既定で押せる字になっている').not.toContain('pkc-date-link');
    expect(html, '既定で受け手の印が出ている').not.toContain('open-date-note');
    expect(html, '素の字が消えている').toContain('@2026-10-15');
    expect(on('見積を送る @2026-10-15 まで。')).not.toBe(html);
  });

  it('同じ行に 2 つ書けば 2 つとも押せる字になる(それぞれ自分の日付を持つ)', () => {
    const html = on('@2026-10-15 と @2026-10-20 の間\n');
    expect(html).toContain('>@2026-10-15</span>');
    expect(html).toContain('>@2026-10-20</span>');
    expect(html).toContain('data-pkc-date="2026-10-15"');
    expect(html).toContain('data-pkc-date="2026-10-20"');
    expect(html.match(/class="pkc-date-link"/g)).toHaveLength(2);
  });

  it('🔴 期間は開始の日だけが押せる字になり、`..` 以降は字のまま残る', () => {
    const html = on('出張 @2026-10-15..2026-10-20 です\n');
    // ⚠ `..` は書式置換(typographer)で `…` になる ── 押せる字の外に残ることだけを見る
    expect(html).toMatch(/data-pkc-date="2026-10-15"[^>]*>@2026-10-15<\/span>(\.\.|…)2026-10-20 です/);
    expect(html.match(/pkc-date-link/g)).toHaveLength(1);
  });

  it('時刻が付いていても、押せるのは日付の部分だけ(時刻は字のまま)', () => {
    const html = on('会議 @2026-10-15 14:00 開始\n');
    expect(html).toContain('>@2026-10-15</span> 14:00 開始');
  });

  /**
   * 🔴 **実在しない日は押せる字にしない**(押すと存在しない日のノートを作ることになる)。
   * ⚠ 字は消さない ── 打ち間違いは見て直せる形で残す。
   */
  it('🔴 実在しない日(2026-02-31)は押せる字にならず、字のまま残る', () => {
    const html = on('いつか @2026-02-31 に\n');
    expect(html, '実在しない日を押せる字にした').not.toContain('pkc-date-link');
    expect(html).toContain('@2026-02-31');
    // 対照群 ── 同じ形の実在する日は押せる(この test 自体が効いている)
    expect(on('いつか @2026-02-28 に\n')).toContain('pkc-date-link');
  });

  it('日付でない `@`(単価・個数・桁の足りない日付)は押せる字にしない', () => {
    const html = on('牛乳 @1,500 で 3 個 @3 と @2026-8-5\n');
    expect(html).not.toContain('pkc-date-link');
  });

  it('⚠ 既に押せるリンクの中は、入れ子にしない', () => {
    const html = on('[予定 @2026-10-15](entry:e1) と @2026-10-16\n');
    // 押せる字の入れ子を作ると、リンクの中に押し先が 2 つ在ることになる
    expect(html.match(/pkc-date-link/g), 'リンクの外の 1 つだけ').toHaveLength(1);
    expect(html).toContain('data-pkc-date="2026-10-16"');
    expect(html).not.toContain('data-pkc-date="2026-10-15"');
  });

  it('⚠ コードの中は押せる字にしない(インライン / コード枠)', () => {
    expect(on('`@2026-10-15` と書く\n')).not.toContain('pkc-date-link');
    expect(on('```\n@2026-10-15\n```\n')).not.toContain('pkc-date-link');
    // 対照群 ── 同じ字が普通の段落なら押せる
    expect(on('@2026-10-15\n')).toContain('pkc-date-link');
  });

  it('表のセルの中でも押せる(日付を表に書く人が居る)', () => {
    const html = on('| 予定 | 日 |\n|---|---|\n| 提出 | @2026-10-15 |\n');
    expect(html).toContain('data-pkc-date="2026-10-15"');
  });

  /**
   * 🔴 **単日でない日付には種類が焼かれる**(#1225)── 読む面が「あとN日」を添えるのは単日だけ。
   * ⚠ 単日には**何も足さない**(上の最初の test が、これまでの出力 1 バイトも変えないことを見ている)。
   */
  it('🔴 期間(@a..b)は data-pkc-date-kind="range"、繰り返しは "repeat"、単日には付かない', () => {
    const range = on('出張 @2026-10-15..2026-10-20 です\n');
    expect(range).toContain('data-pkc-date-kind="range"');
    expect(on('出張 @2026-10-15〜2026-10-20 です\n')).toContain('data-pkc-date-kind="range"');
    const repeat = on('- [ ] ゴミ出し @2026-10-15 毎週\n');
    expect(repeat).toContain('data-pkc-date-kind="repeat"');
    // 時刻つきの繰り返しも繰り返し(時刻は日付の隣に在るだけ)
    expect(on('会議 @2026-10-15 14:00 毎週\n')).toContain('data-pkc-date-kind="repeat"');
    // 対照群 ── 単日(時刻つきも)には付かない
    expect(on('見積 @2026-10-15 まで\n')).not.toContain('data-pkc-date-kind');
    expect(on('会議 @2026-10-15 14:00 開始\n')).not.toContain('data-pkc-date-kind');
  });

  it('🔴 同じ行の 2 つめの日付は、1 つめの種類に引きずられない(それぞれ自分の後ろを読む)', () => {
    const html = on('@2026-10-15..2026-10-20 のあと @2026-10-25 に\n');
    expect(html.match(/data-pkc-date-kind="range"/g)).toHaveLength(1);
    // 2 つめの `<span …>` に種類が無い
    const second = html.slice(html.indexOf('data-pkc-date="2026-10-25"'));
    expect(second.slice(0, second.indexOf('>'))).not.toContain('data-pkc-date-kind');
  });
});
