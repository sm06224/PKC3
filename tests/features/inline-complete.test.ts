import { describe, expect, it } from 'vitest';
import { atChoices, detectTrigger, slashChoices } from '../../src/features/markdown/inline-complete';

const meta = (lid: string, title: string, i: number) =>
  ({ lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i, status: null, date: null, archived: false }) as never;
const metas = new Map<string, never>([
  ['a', meta('a', '先週の議事録', 1)],
  ['b', meta('b', '買い物メモ', 2)],
  ['self', meta('self', '議事録の下書き', 3)],
]);

describe('detectTrigger(#1449 / #1450)', () => {
  it('行頭の / は引き金。途中の / は引き金ではない', () => {
    expect(detectTrigger('/h2', 3)).toEqual({ kind: 'slash', start: 0, query: 'h2' });
    expect(detectTrigger('前の行\n  /table', 13)).toMatchObject({ kind: 'slash', query: 'table' });
    expect(detectTrigger('A/B', 3)).toBeNull();
    expect(detectTrigger('https://x', 9)).toBeNull();
    expect(detectTrigger('2026/10/26', 10)).toBeNull();
    expect(detectTrigger('//', 2)).toBeNull();
  });
  it('日本語入力の ／ は引き金。・ は字が続いたときだけ', () => {
    expect(detectTrigger('／表', 2)).toMatchObject({ kind: 'slash', query: '表' });
    expect(detectTrigger('・', 1)).toBeNull();
    expect(detectTrigger('・りんご', 4)).toMatchObject({ kind: 'slash', query: 'りんご' });
  });
  it('@ は行頭か空白の直後だけ。予定記法 @2026- と @[card] は引き金ではない', () => {
    expect(detectTrigger('@', 1)).toEqual({ kind: 'at', start: 0, query: '' });
    expect(detectTrigger('見て @議事', 6)).toEqual({ kind: 'at', start: 3, query: '議事' });
    expect(detectTrigger('foo@example.com', 15)).toBeNull();
    expect(detectTrigger('- [ ] 提出 @2026-10-26', 22)).toBeNull();
    expect(detectTrigger('@[card](entry:x)', 2)).toBeNull();
  });
});

describe('slashChoices', () => {
  it('/h2 は見出し2、/table は表、/ だけなら上限まで', () => {
    expect(slashChoices([], 'h2').map((c) => c.title)).toContain('見出し2');
    expect(slashChoices([], 'table').map((c) => c.title)).toContain('表');
    expect(slashChoices([], '')).toHaveLength(8);
    expect(slashChoices([], 'zzzz-no-such')).toHaveLength(0);
  });
  it('自分のテンプレートは短縮語でも引け、先頭に出る', () => {
    const items = [{ lid: 't1', title: '議事録の型', abbr: 'gj', body: '# 議事録' }] as never;
    const got = slashChoices(items, 'gj');
    expect(got[0]).toMatchObject({ kind: 'snippet', lid: 't1' });
  });
});

describe('atChoices', () => {
  const now = new Date(2026, 9, 26);
  it('today / 明日 は日付、題名はノート。自分自身は出さない', () => {
    const d = atChoices('today', now, metas, ['a', 'b', 'self'], 'self');
    expect(d[0]).toMatchObject({ kind: 'date', id: 'today', date: '2026-10-26' });
    expect(atChoices('明日', now, metas, ['a'], null)[0]).toMatchObject({ kind: 'date', date: '2026-10-27' });
    const n = atChoices('議事', now, metas, ['a', 'b', 'self'], 'self');
    expect(n.map((c) => (c.kind === 'note' ? c.lid : 'date'))).toEqual(['a']);
  });
});

describe('コードの中・表の行では出ない(着地前レビュー)', () => {
  const at = (v: string) => detectTrigger(v, v.length);
  it('フェンスの中(``` / ~~~)では / も @ も出ない。閉じたあとは出る(対照群)', () => {
    expect(at('```\n/h2')).toBeNull();
    expect(at('```js\ncode\n@議事')).toBeNull();
    expect(at('~~~\n/表')).toBeNull();
    expect(at('```\ncode\n```\n/h2'), '閉じたあとなのに出ない').toMatchObject({ kind: 'slash', query: 'h2' });
    expect(at('```\ncode\n```\n見て @議事'), '閉じたあとなのに出ない').toMatchObject({ kind: 'at' });
  });
  it('行内コードの中では出ない。閉じたあとは出る(対照群)', () => {
    expect(at('`foo @bar')).toBeNull();
    expect(at('`a` と @bar'), '閉じたあとなのに出ない').toMatchObject({ kind: 'at', query: 'bar' });
  });
  it('表の行(| で始まる行)では出ない。ふつうの行は出る(対照群)', () => {
    expect(at('| 項目 | @議事')).toBeNull();
    expect(at('  | a | b | @x')).toBeNull();
    expect(at('項目 @議事')).toMatchObject({ kind: 'at' });
  });
});
