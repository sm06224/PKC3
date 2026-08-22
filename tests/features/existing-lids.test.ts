/**
 * 🔴 **取込の衝突検査は DB に問う**(#328、2026-08-22)。
 *
 * ## 直す前に起きていたこと(user から見て)
 *
 * タブ A で PKC2 のファイルを取り込む。**そのまま**タブ B へ移って同じファイルを
 * 取り込む。⇒ **タブ A で取り込んだノートが消える。** 警告も出ず、件数が増えない。
 *
 * ⚠ 原因は、衝突検査の材料が **state と DB の混成**だったこと。
 *   `entryMetas` は DB の射影で、他タブの書込が `store-proxy` の `'changed'` 放送で
 *   届くまで遅れる ── その窓の中では既存 lid を見落とし、取り込んだ entry が
 *   **元の lid のまま**上書きする(`pkc2-convert.ts` の `taken` が唯一の門)。
 *
 * ## この test が守る主張は 2 つあり、**片方だけでは足りない**
 *
 * ① **DB に居るなら、state に居なくても拾う**(← 直した当のもの)
 * ② **state にしか居なくても拾う**(← 逆へ倒す変異を殺す。書込 ack がまだ返って
 *    いない lid を落とすと、今度はそちらを上書きする)
 */
import { describe, expect, it, vi } from 'vitest';
import { collectExistingLids } from '../../src/features/import/existing-lids';

describe('取込の衝突検査に渡す既存 lid(#328)', () => {
  it('🔴 DB の entry に居る lid を拾う(state が遅れていても)', async () => {
    // ⚠ **他タブが取り込んだ直後**の姿 ── DB には在るが、放送がまだ届いていない
    const got = await collectExistingLids({
      fromState: () => [],
      entryLids: async () => ['a1', 'a2'],
      revisionLids: async () => [],
    });
    expect(
      [...got].sort(),
      'DB に居る lid を見落とす(= 取り込んだ entry が既存を上書きする)',
    ).toEqual(['a1', 'a2']);
  });

  it('⚠ 対照群 ── state にしか居ない lid も拾う(和集合であって置換ではない)', async () => {
    const got = await collectExistingLids({
      fromState: () => ['draft-1'],
      entryLids: async () => [],
      revisionLids: async () => [],
    });
    expect([...got], '書込 ack 待ちの lid を落とした').toEqual(['draft-1']);
  });

  /**
   * 🔴 **ゴミ箱の lid も拾う**(review H-1、実 sqlite で実証)。
   * ⚠ 生存 entry だけでは足りない ── ゴミ箱の lid(entries に居ないが revisions を
   *   持つ)と衝突すると、その item が**ゴミ箱から消え**、取り込んだ entry が
   *   **他人の履歴を背負う**。
   */
  it('🔴 revision にしか居ない lid(ゴミ箱)も拾う', async () => {
    const got = await collectExistingLids({
      fromState: () => [],
      entryLids: async () => [],
      revisionLids: async () => ['trashed-1'],
    });
    expect([...got], 'ゴミ箱の lid を見落とす(履歴を背負う)').toEqual(['trashed-1']);
  });

  it('🔴 3 つの出所の和集合になる(重複は畳む)', async () => {
    const got = await collectExistingLids({
      fromState: () => ['x', 'shared'],
      entryLids: async () => ['y', 'shared'],
      revisionLids: async () => ['z', 'shared'],
    });
    expect([...got].sort(), '出所のどれかが落ちている').toEqual(['shared', 'x', 'y', 'z']);
  });

  /**
   * ⚠ **取込は user を待たせる操作**なので、2 本の DB 問い合わせは並行に投げる。
   * 🔑 観測点は「返ってきたか」ではなく**発行の順**(直列だと 1 本目の解決を待つ)。
   */
  /**
   * ⚠ **取込は user を待たせる操作**なので、2 本の DB 問い合わせは並行に投げる。
   *
   * 🔴 **観測点は「entry が解決する前に revision が走り出したか」**。
   * ⚠ 初稿は「entry が**開始**したか」を見ていたので、**直列でも真**になり
   *   変異(328-d)が生き延びた ── 主張が成り立たない条件だった(CLAUDE.md §1)。
   */
  it('⚠ DB の 2 本は並行に投げる(直列にして往復を 2 倍にしない)', async () => {
    let entryResolved = false;
    let revisionRanBeforeEntryResolved = false;
    let releaseEntry: (() => void) | undefined;
    const entryGate = new Promise<void>((r) => {
      releaseEntry = r;
    });
    const p = collectExistingLids({
      fromState: () => [],
      entryLids: async () => {
        await entryGate;
        entryResolved = true;
        return ['a'];
      },
      revisionLids: async () => {
        // ⚠ entry が**まだ解決していない**のに走り出していれば並行
        if (!entryResolved) revisionRanBeforeEntryResolved = true;
        return ['b'];
      },
    });
    // ⚠ entry を止めたまま microtask を進める ── 直列ならここで revision は走らない
    await Promise.resolve();
    await Promise.resolve();
    releaseEntry!();
    const got = await p;
    expect(revisionRanBeforeEntryResolved, '直列に投げている(往復が 2 倍になる)').toBe(true);
    expect([...got].sort()).toEqual(['a', 'b']);
  });

  /**
   * ⚠ **空振り防止** ── 口を 1 つも呼ばずに空集合を返す実装でも、上の it は
   *   「拾えた」側だけ見ていると通りうる。**3 つとも実際に呼ばれた**ことを見る。
   */
  it('⚠ 3 つの出所を全部呼ぶ(黙って 1 本捨てていない)', async () => {
    const fromState = vi.fn(() => [] as string[]);
    const entryLids = vi.fn(async () => [] as string[]);
    const revisionLids = vi.fn(async () => [] as string[]);
    await collectExistingLids({ fromState, entryLids, revisionLids });
    expect(fromState, 'state を読んでいない').toHaveBeenCalledTimes(1);
    expect(entryLids, 'DB の entry を読んでいない').toHaveBeenCalledTimes(1);
    expect(revisionLids, 'DB の revision を読んでいない').toHaveBeenCalledTimes(1);
  });
});
