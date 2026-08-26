/**
 * 🔴 **スマートフォルダの条件**(#421 段①。user 要望 2026-08-26
 * 「iPhoneとかのメモアプリにあるスマートメモのような整理機能が欲しいです」)。
 *
 * 守る主張:
 * 1. **正本は本文の frontmatter** ── 読み書きは原文 splice(説明文を壊さない)
 * 2. 🔴 **条件が空なら「何も集めない」**(「全部集める」ではない)
 * 3. 条件が 2 つ以上なら **AND**(全部付いているものだけ)
 * 4. **自分自身は当てない**(入れ子が 1 段深く見える)
 * 5. **上限で切っても、数は数え続ける**(「これで全部」と嘘をつかない)
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SMART,
  MAX_SMART_TAGS,
  SMART_LIMIT,
  SMART_TAGS_KEY,
  createSmartScan,
  isSmartEmpty,
  matchesSmart,
  readSmartSpec,
  smartCondError,
  withSmartTag,
  writeSmartSpec,
  type SmartCondResult,
  type SmartSpec,
} from '../../src/features/smart/smart-spec';
import { MAX_TAG_CHARS } from '../../src/features/flavor/tags';

const withTags = (...tags: string[]): string =>
  `---\ntags: [${tags.join(', ')}]\n---\n本文\n`;

describe('条件を読む(#421 段①)', () => {
  it('🔴 配列でもカンマ区切りでも読む(user がどちらで書いても通す)', () => {
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [請求, 未処理]\n---\n`).tags).toEqual([
      '請求',
      '未処理',
    ]);
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: 請求, 未処理\n---\n`).tags).toEqual([
      '請求',
      '未処理',
    ]);
  });

  it('条件が書いていなければ空(= 何も集めない)', () => {
    expect(isSmartEmpty(readSmartSpec('ただの本文\n'))).toBe(true);
    expect(isSmartEmpty(readSmartSpec(`---\n${SMART_TAGS_KEY}: \n---\n`))).toBe(true);
  });

  /**
   * ⚠ **空の要素は `null` で来る**(frontmatter の parser がそう返す)── そのまま
   * 文字にすると **`"null"` という名前の条件**が生まれる(`readTags` が同じ罠を
   * 踏んで直してある)。
   */
  it('⚠ 空の要素が「null」という条件にならない', () => {
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [請求, , 未処理]\n---\n`).tags).toEqual([
      '請求',
      '未処理',
    ]);
  });

  it('⚠ 重複は 1 つに畳む(大小は無視)', () => {
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [Bill, bill, 請求]\n---\n`).tags).toEqual([
      'Bill',
      '請求',
    ]);
  });

  it('⚠ 上限を超えたぶんは読まない(条件が読めなくなる)', () => {
    const many = Array.from({ length: MAX_SMART_TAGS + 5 }, (_, i) => `t${String(i)}`);
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [${many.join(', ')}]\n---\n`).tags).toHaveLength(
      MAX_SMART_TAGS,
    );
  });
});

describe('条件を書く(#421 段①)', () => {
  it('🔴 説明文を壊さずに書き足す(原文 splice)', () => {
    const body = `---\ntitle-note: あ\n---\n\n月末にまとめて処理するぶん。\n`;
    const out = writeSmartSpec(body, { tags: ['請求'] });
    expect(out, '説明文が消えた').toContain('月末にまとめて処理するぶん。');
    expect(out, '他の key が消えた').toContain('title-note: あ');
    expect(readSmartSpec(out).tags).toEqual(['請求']);
  });

  /**
   * 🔴 **空になったら key ごと消す** ── `smart-tags: []` を残すと、次に読んだとき
   * 「条件が在るのに当たらない」に見える。
   */
  it('🔴 条件が空になったら key ごと消える', () => {
    const body = writeSmartSpec('本文\n', { tags: ['請求'] });
    expect(body).toContain(SMART_TAGS_KEY);
    const off = writeSmartSpec(body, EMPTY_SMART);
    expect(off, '空の条件が残っている').not.toContain(SMART_TAGS_KEY);
  });

  const okSpec = (r: SmartCondResult): SmartSpec => {
    if (!r.ok) throw new Error(`通るはずが ${r.reason} で断られた`);
    return r.spec;
  };

  it('足す / 外すは、押しても同じなら unchanged(呼び側が「書かない」を選べる)', () => {
    const one = withSmartTag(EMPTY_SMART, '請求', 'add');
    expect(okSpec(one).tags).toEqual(['請求']);
    const again = withSmartTag(okSpec(one), '請求', 'add');
    expect(again, '同じ条件が 2 度並ぶ').toEqual({ ok: false, reason: 'unchanged' });
    expect(withSmartTag(EMPTY_SMART, '請求', 'remove'), '無いものを外せている').toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(okSpec(withSmartTag(okSpec(one), '請求', 'remove')).tags).toEqual([]);
  });

  /**
   * 🔴 **断られた理由が読めること**(着地前の変異試験 S14b から)。
   * ⚠ 「変わらなかった」を 1 つに畳むと、呼び側は**黙って捨てるしかない** ──
   *   user は 9 個目を足したつもりで、何も起きない画面を見る。
   */
  it('🔴 上限に当たったら足さず、**理由が出る**(黙って古い方を落とさない)', () => {
    const full = { tags: Array.from({ length: MAX_SMART_TAGS }, (_, i) => `t${String(i)}`) };
    const over = withSmartTag(full, 'new', 'add');
    expect(over, '上限を超えて足している').toEqual({ ok: false, reason: 'limit' });
    expect(smartCondError('limit'), '理由が読めない').toContain(String(MAX_SMART_TAGS));
    // ⚠ 満杯でも**外す**ほうは通る(でないと詰んで動かせない)
    expect(okSpec(withSmartTag(full, 't0', 'remove')).tags).not.toContain('t0');
  });

  it('🔴 タグとして受けられないものは invalid で、理由が出る', () => {
    expect(withSmartTag(EMPTY_SMART, '   ', 'add')).toEqual({ ok: false, reason: 'invalid' });
    expect(withSmartTag(EMPTY_SMART, 'x'.repeat(MAX_TAG_CHARS + 1), 'add')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(smartCondError('invalid')).toContain(String(MAX_TAG_CHARS));
    // 🔑 **黙ってよいのは「押しても同じ」だけ** ── ここを取り違えると無言で捨てる
    expect(smartCondError('unchanged'), '黙るべきものに帯を出している').toBeNull();
  });
});

describe('当てる(#421 段①)', () => {
  it('🔴 条件が空なら、どんなノートにも当たらない(「全部」ではない)', () => {
    expect(matchesSmart(EMPTY_SMART, ['請求'])).toBe(false);
    expect(matchesSmart(EMPTY_SMART, [])).toBe(false);
  });

  it('🔴 条件が 2 つなら AND(全部付いているものだけ)', () => {
    const spec = { tags: ['請求', '未処理'] };
    expect(matchesSmart(spec, ['請求', '未処理', '他'])).toBe(true);
    expect(matchesSmart(spec, ['請求']), '片方だけで当たっている').toBe(false);
  });

  it('⚠ 突き合わせは大小を無視する(札の見た目は原文のまま)', () => {
    expect(matchesSmart({ tags: ['Bill'] }, ['bill'])).toBe(true);
  });
});

describe('走査(#421 段①)', () => {
  const run = (spec: { tags: string[] }, rows: { lid: string; head: string }[], self = 'self') => {
    const scan = createSmartScan(spec, self);
    scan.feed(rows);
    return scan.finish();
  };

  it('🔴 条件に当たったものだけ集める', () => {
    const out = run({ tags: ['請求'] }, [
      { lid: 'a', head: withTags('請求') },
      { lid: 'b', head: withTags('家事') },
      { lid: 'c', head: withTags('請求', '未処理') },
    ]);
    expect(out.lids).toEqual(['a', 'c']);
    expect(out.total).toBe(2);
  });

  /**
   * 🔴 **自分自身は当てない** ── 条件タグを書いた本文が自分の中に並ぶと、
   * 開くたびに入れ子が 1 段深く見える。
   */
  it('🔴 自分自身は当たらない', () => {
    const out = run({ tags: ['請求'] }, [
      { lid: 'self', head: withTags('請求') },
      { lid: 'a', head: withTags('請求') },
    ]);
    expect(out.lids, '自分が中に並んでいる').toEqual(['a']);
  });

  it('⚠ 条件が空なら 1 件も集めない(走査ごと素通り)', () => {
    const out = run({ tags: [] }, [{ lid: 'a', head: withTags('請求') }]);
    expect(out.lids).toEqual([]);
    expect(out.total).toBe(0);
  });

  /**
   * 🔴 **上限で切っても数は数え続ける** ── 黙って切ると user は「これで全部」と読む。
   */
  it('🔴 上限を超えても、総数は正しく返る', () => {
    const rows = Array.from({ length: SMART_LIMIT + 25 }, (_, i) => ({
      lid: `n${String(i)}`,
      head: withTags('請求'),
    }));
    const out = run({ tags: ['請求'] }, rows);
    expect(out.lids, '上限を超えて lid を持っている').toHaveLength(SMART_LIMIT);
    expect(out.total, '切ったぶんを数えていない').toBe(SMART_LIMIT + 25);
  });

  it('⚠ 何回に分けて食わせても答えは同じ(worker は 500 件ずつ渡す)', () => {
    const rows = [
      { lid: 'a', head: withTags('請求') },
      { lid: 'b', head: withTags('家事') },
      { lid: 'c', head: withTags('請求') },
    ];
    const scan = createSmartScan({ tags: ['請求'] }, 'self');
    scan.feed(rows.slice(0, 2));
    scan.feed(rows.slice(2));
    expect(scan.finish().lids).toEqual(['a', 'c']);
  });
});
