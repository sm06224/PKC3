/**
 * 🔴 **貼り付けた素のパーマリンクを内部リンクにする**(#251)。
 *
 * ⚠ 触るか触らないかの判定だけをここで見る(差し込みの配線は
 * `tests/adapter/paste-text.test.ts`)。
 *
 * 🔑 **迷ったら触らない**が既定である ── 貼った字は user の物なので、
 * 「たぶんこれだろう」で書き換えない。
 */
import { describe, expect, it } from 'vitest';
import { convertPastedPermalink } from '@features/link/permalink';

const CTX = {
  containerId: 'c1',
  titleOf: (lid: string) =>
    ({ n1: '会議のメモ', n2: '買い物 [済]', n3: '' }) [lid as 'n1' | 'n2' | 'n3'] ?? null,
};

describe('素で貼ったパーマリンク', () => {
  it('🔴 同じ入れ物のノートなら、題名つきの内部リンクにする', () => {
    expect(convertPastedPermalink('pkc://c1/entry/n1', CTX)).toBe('[会議のメモ](entry:n1)');
  });

  it('前後の空白は落とす(コピーに紛れ込む)', () => {
    expect(convertPastedPermalink('  pkc://c1/entry/n1\n', CTX)).toBe('[会議のメモ](entry:n1)');
  });

  it('🔴 断片(`#log/…`)は持ち越す', () => {
    expect(convertPastedPermalink('pkc://c1/entry/n1#log/abc', CTX)).toBe(
      '[会議のメモ](entry:n1#log/abc)',
    );
  });

  it('🔴 題名の `[` `]` を逃がす(リンクが途中で切れる)', () => {
    // ⚠ 逃がさないと `[買い物 [済]](entry:n2)` は `買い物 [済` までしかリンクにならない
    expect(convertPastedPermalink('pkc://c1/entry/n2', CTX)).toBe(
      '[買い物 \\[済\\]](entry:n2)',
    );
  });
});

describe('触らない形(⚠ 迷ったら触らない)', () => {
  it('🔴 前後に文が付いていたら触らない(散文を書き換えない)', () => {
    expect(convertPastedPermalink('ここに pkc://c1/entry/n1 を貼った', CTX)).toBeNull();
    expect(convertPastedPermalink('pkc://c1/entry/n1 と pkc://c1/entry/n1', CTX)).toBeNull();
  });

  it('🔴 断片に空白が在るものも触らない(壊れたリンクを作らない)', () => {
    /**
     * ⚠ **この形だけは `parsePortablePkcReference` を通り抜ける** ── 断片は
     *   綴りを検めないので、素直に組むと `[題名](entry:n1#log/a b)` になり、
     *   markdown の宛先に空白は置けないので**リンクが壊れる**。
     * ⚠ 変異試験 P3 が SURVIVED で教えた ── 上の 2 つは parse 側が落としているので、
     *   **空白を見る行が守っている当の形は、こちらである**。
     */
    expect(convertPastedPermalink('pkc://c1/entry/n1#log/a b', CTX)).toBeNull();
    // ⚠ 対照群 ── 空白の無い断片は通る(規則そのものが生きていること)
    expect(convertPastedPermalink('pkc://c1/entry/n1#log/ab', CTX)).toBe(
      '[会議のメモ](entry:n1#log/ab)',
    );
  });

  it('🔴 別の入れ物宛は触らない(持ち運べる参照のままにする)', () => {
    expect(convertPastedPermalink('pkc://other/entry/n1', CTX)).toBeNull();
  });

  it('🔴 題名を引けない lid は触らない(在りもしない題名を書かない)', () => {
    expect(convertPastedPermalink('pkc://c1/entry/zzz', CTX)).toBeNull();
    // ⚠ 題名が空文字のノートも触らない(`[](entry:n3)` は押せないリンクになる)
    expect(convertPastedPermalink('pkc://c1/entry/n3', CTX)).toBeNull();
  });

  it('🔴 添付(asset)宛は触らない', () => {
    /**
     * ⚠ **id はノートと同じ綴りを取りうる** ── 1 稿目は `asset/k1`(題名を引けない id)
     *   で見ていたので、種別の判定を外しても「題名が無いから触らない」で通っていた
     *   (変異試験 P6 が SURVIVED)。**題名を引ける id で見る**と、種別を見ない実装は
     *   添付を**ノートへのリンクに化けさせる**。
     */
    expect(convertPastedPermalink('pkc://c1/asset/n1', CTX)).toBeNull();
    expect(convertPastedPermalink('pkc://c1/asset/k1', CTX)).toBeNull();
  });

  it('パーマリンクでない字は触らない', () => {
    for (const s of ['', 'https://example.com/', 'ただの文', 'pkc://c1/entry']) {
      expect(convertPastedPermalink(s, CTX), s).toBeNull();
    }
  });

  it('入れ物がまだ決まっていないときは触らない', () => {
    expect(convertPastedPermalink('pkc://c1/entry/n1', { ...CTX, containerId: null })).toBeNull();
  });
});
