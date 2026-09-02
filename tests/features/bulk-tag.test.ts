/**
 * #402 ①: **まとめてタグを付ける / 外す**(規則の側)。
 *
 * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
 * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
 *
 * 🔴 **双方向**(user 指示 2026-08-23)── 付けられるなら外せる必要がある。
 * 付けるだけだと、12 件に間違えて付けたものを **12 回開いて消す**ことになる。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TAGS,
  normalizeTag,
  readTags,
  withTag,
  withTagResult,
} from '../../src/features/flavor/tags';
import { applyBodyRewrite, applyTagsToBody } from '../../src/features/markdown/body-rewrite';

const doc = (tags: string): string => `---\n${tags}\n---\n本文\n`;

describe('タグを 1 つ足す / 外す', () => {
  it('足す ── 書いた順は保つ(user が意味のある順に書いている)', () => {
    expect(withTag(['家事', '買い物'], '請求済', 'add')).toEqual(['家事', '買い物', '請求済']);
  });

  it('🔴 既に在れば null(同じタグを 2 つ並べない)', () => {
    expect(withTag(['請求済'], '請求済', 'add')).toBeNull();
  });

  it('🔴 突き合わせは大小無視(`Tag` と `tag` を 2 つにしない)', () => {
    expect(withTag(['Tag'], 'tag', 'add')).toBeNull();
    expect(withTag(['Tag'], 'tag', 'remove')).toEqual([]);
  });

  it('外す ── 他のタグは残る', () => {
    expect(withTag(['家事', '請求済', '買い物'], '請求済', 'remove')).toEqual(['家事', '買い物']);
  });

  it('🔴 元から無ければ null(書かない材料になる)', () => {
    expect(withTag(['家事'], '請求済', 'remove')).toBeNull();
  });

  it('⚠ 空・空白だけのタグは null(空のタグを作らない)', () => {
    expect(withTag([], '   ', 'add')).toBeNull();
    expect(withTag([], '', 'add')).toBeNull();
  });

  it('🔴 上限を超えたら足さない(黙って古い方を落とさない)', () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(withTag(full, 'あふれる', 'add')).toBeNull();
  });

  it('⚠ 長すぎるタグは足さない', () => {
    expect(withTag([], 'あ'.repeat(41), 'add')).toBeNull();
  });

  it('正規化は読む側と同じ規則(前後の空白・連続空白)', () => {
    expect(normalizeTag('  請求  済  ')).toBe('請求 済');
  });
});

describe('本文への当て方(書換の 1 本を通る)', () => {
  const add = (body: string, tag: string): string | null =>
    applyBodyRewrite(body, { kind: 'tag', tags: [tag], mode: 'add' });
  const off = (body: string, tag: string): string | null =>
    applyBodyRewrite(body, { kind: 'tag', tags: [tag], mode: 'remove' });

  it('🔴 frontmatter が無い本文にも付く(器から作る)', () => {
    const out = add('ただの本文\n', '請求済')!;
    expect(readTags(out)).toEqual(['請求済']);
    expect(out, '本文が消えた').toContain('ただの本文');
  });

  it('既にある配列へ足す', () => {
    expect(readTags(add(doc('tags: [家事]'), '請求済')!)).toEqual(['家事', '請求済']);
  });

  it('⚠ カンマ区切りで書いてあっても読めて足せる(記法を減らさない)', () => {
    expect(readTags(add(doc('tags: 家事, 買い物'), '請求済')!)).toEqual([
      '家事',
      '買い物',
      '請求済',
    ]);
  });

  it('🔴 最後の 1 つを外したら鍵ごと消す(空のタグが 1 つ在るように見せない)', () => {
    const out = off(doc('tags: [請求済]'), '請求済')!;
    expect(readTags(out)).toEqual([]);
    expect(out, 'tags: [] が残っている').not.toContain('tags:');
  });

  it('🔴 変わらないときは null(同じ本文を書き直して更新日時を動かさない)', () => {
    expect(add(doc('tags: [請求済]'), '請求済')).toBeNull();
    expect(off(doc('tags: [家事]'), '請求済')).toBeNull();
  });

  it('⚠ 本文は 1 バイトも変わらない(frontmatter だけ触る)', () => {
    const body = doc('tags: [家事]') + '2 行目\n';
    const out = add(body, '請求済')!;
    expect(out.split('---\n')[2], '本文が書き換わった').toBe(body.split('---\n')[2]);
  });
});

/**
 * 🔴 **なぜ変わらなかったのかを言い分ける**(#640)。
 *
 * ⚠ 直す前は「既に付いている」も「上限に当たった」も**同じ `null`** だったので、
 *   画面には「**0 件に付けました / 1 件は既に付いていました**」という
 *   **事実と違う字**が出ていた ── 付いていないのに「既に付いていました」。
 */
describe('タグが変わらなかった理由(#640)', () => {
  const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${String(i)}`);

  it('🔴 「既に在る」と「上限」と「そもそも書けない」を別の答えで返す', () => {
    expect(withTagResult(['買い物'], '買い物', 'add'), '既に在るのに上限と言った').toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(withTagResult(full, '新しい', 'add'), '上限なのに「既に在る」と言った').toEqual({
      ok: false,
      reason: 'limit',
    });
    expect(withTagResult([], '   ', 'add')).toEqual({ ok: false, reason: 'invalid' });
    // ⚠ **対照群** ── 通る形は通る(規則そのものが生きている)
    expect(withTagResult(['家事'], '買い物', 'add')).toEqual({
      ok: true,
      tags: ['家事', '買い物'],
    });
    // 🔑 薄い包み(`withTag`)は今までどおり ── 判定を 2 つ持っていない
    expect(withTag(full, '新しい', 'add'), '包みの答えが変わった').toBeNull();
    expect(withTag(['家事'], '買い物', 'add')).toEqual(['家事', '買い物']);
  });

  it('🔴 本文へ当てる口も、打った字ごとの理由を返す', () => {
    const body = `---\ntags: [${full.join(', ')}]\n---\n本文\n`;
    // ⚠ 前提: この本文は上限に達している(達していなければ何も検めていない)
    expect(readTags(body).length, '前提が崩れている: 上限に達していない').toBe(MAX_TAGS);
    const r = applyTagsToBody(body, ['t0', '新しい'], 'add');
    expect(r.body, '1 つも動いていないのに本文を書いた').toBeNull();
    expect(r.outcomes.get('t0'), '既に在るものを上限と言った').toBe('unchanged');
    expect(r.outcomes.get('新しい'), '上限を「既に在る」と言った').toBe('limit');

    // ⚠ **対照群** ── 空きが在れば書けて、理由も `wrote` になる
    const room = applyTagsToBody('---\ntags: [家事]\n---\n本文\n', ['買い物'], 'add');
    expect(room.outcomes.get('買い物')).toBe('wrote');
    expect(readTags(room.body ?? ''), '書けていない').toEqual(['家事', '買い物']);

    /**
     * 🔑 **書く形と数える形が同じ 1 本であること**(§7)── `applyBodyRewrite` は
     *   この口へ委ねているので、答えは 1 バイトも違わない。
     */
    expect(
      applyBodyRewrite('---\ntags: [家事]\n---\n本文\n', {
        kind: 'tag',
        tags: ['買い物'],
        mode: 'add',
      }),
      '2 本目の規則が生えている',
    ).toBe(room.body);
  });
});
