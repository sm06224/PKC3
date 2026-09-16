/**
 * 🔴 **id は、窓をまたいでもぶつからない**(#973)。
 *
 * ## 何が起きていたか
 *
 * 直す前の綴りは `<epoch36>-<counter36 4 桁>` だけだった。⚠ `lidCounter` は
 * **module の変数**なので、**タブ / 別窓ごとに別の 0 から始まる** ── 入っているのは
 * 「時刻(ミリ秒)」と「**その窓の中の**通し番号」しかない。
 * 🔴 2 つの窓が同じミリ秒で同じ通し番号を引くと、**1 バイト違わず同じ字**になる。
 *
 * 🔴 そして `writeParent` の `ON CONFLICT … DO UPDATE` がそれを**上書きに変えて**いたので、
 * **先に在った別のノートの居場所が黙って消えた**(error も履歴も無し)。
 *
 * ## ⚠ 「2 つの窓」は unit では作れない
 *
 * `lidCounter` は module の変数なので、1 つの test 実行の中で
 * **0 から始まる 2 本目**を作れない。🔑 だから見るのは**同じことを言う別の形**
 * ── 「時刻と通し番号が同じでも字が違う」= **3 つ目の段が乱数である**。
 * ⚠ ここを「全部ちがう」だけで見ると、**通し番号が増えるので当たり前に通る**
 * (= 乱数を消しても緑になる)。だから**3 つ目の段そのもの**を見る。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateLid } from '../../src/adapter/ui/actions/binder';

afterEach(() => {
  vi.useRealTimers();
});

describe('id の採番(#973)', () => {
  it('🔴 綴りは 3 段 ── 時刻・通し番号・乱数', () => {
    const lid = generateLid();
    const parts = lid.split('-');
    expect(parts, `段が足りない: ${lid}`).toHaveLength(3);
    expect(parts[2], `3 段目が 8 桁の 16 進でない: ${lid}`).toMatch(/^[0-9a-f]{8}$/);
  });

  it('🔴 時刻を止めても、3 段目は毎回ちがう(= 別の窓とぶつからない)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    const tails = new Set<string>();
    const heads = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const parts = generateLid().split('-');
      heads.add(parts[0]!);
      tails.add(parts[2]!);
    }
    // ⚠ 前提の assert ── 時刻が止まっていなければ、この test は何も見ていない
    expect(heads.size, '時刻が止まっていない(3 段目を見たことにならない)').toBe(1);
    /**
     * 🔑 32 bit から 200 本引いて重なる見込みは **約 0.0005%** なので、
     *   190 という下限は**桁で余裕がある**(CLAUDE.md §2「差は桁で稼ぐ」)。
     * ⚠ 乱数を定数にする変異では **1** になるので、必ず落ちる。
     */
    expect(tails.size, `3 段目が散っていない(${tails.size}/200)`).toBeGreaterThanOrEqual(190);
  });

  /**
   * ⚠ **綴りの制約は 2 つあり、どちらも別の file が持っている。**
   * 段を 1 つ増やしたので、両方とも**まだ収まっている**ことをここで留める
   * ── 破ると `pkc://` のリンクが開かなくなり、添付の鍵空間が混ざる。
   */
  it('⚠ リンクと添付の綴りの制約に収まっている', () => {
    for (let i = 0; i < 50; i += 1) {
      const lid = generateLid();
      expect(lid, `token 規則から外れた: ${lid}`).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(lid.includes(':'), `コロンが入った: ${lid}`).toBe(false);
    }
  });
});
