/** @vitest-environment happy-dom */
/**
 * 🔴 **追記が、別の窓の書込を消さない**(#178、2026-08-22)。
 *
 * ## user から見た物語
 *
 * 本文の下の追記欄に打って「追記」を押す。⚠ **その瞬間、別の窓が同じノートに
 * 日付やチェックを書いている**ことがある(#300 段③ で組み込みアプリが既定で
 * 別窓になったので、これは特殊な使い方ではない)。
 *
 * ## 直す前に何が起きていたか
 *
 * 追記は **わざと disk から読み直して**いる(画面の古い本文を基底にしない)ので、
 * 防御は既に在った。⚠ 残っていたのは **`getBody` と書込の間(数ミリ秒)**だけ ──
 * ただしそこで重なると**本文は消え**、`checkpoint` を渡していないので
 * **履歴にも残らない**(= どこからも戻せない。改名と同じ形だった)。
 *
 * ## この test が守る主張
 *
 * ① 🔴 **重なったら足し直す** ── 断るより user の意図に近い(追記は
 *    「この見出しの下にこの塊を足す」なので、新しい本文へ足し直すのが頼まれたこと)
 * ② 🔴 **別の窓が書いたものが残る** ── ここが本丸
 * ③ 🔴 **やり直しは 1 回だけ**(無限に回さない)。それでも重なったら**黙らない**
 * ④ ⚠ **読み直してから**足し直す(古い基底で再送しない)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const tick = (ms = 10): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/**
 * ⚠ **本物の意味論を真似る**(CLAUDE.md §3)── `expectHash` を**実際に見る**。
 * 見ない fake にすると、この PR で足した**やり直しの経路が 1 度も走らない**
 * (§2「弱いのではなく走っていない」)。
 */
function bench(initial: string, opts: { interleave?: (disk: Record<string, string>) => void } = {}) {
  const disk: Record<string, string> = { a: initial };
  const reads: string[] = [];
  /** 書込の試み(`expectHash` 込み)。⚠ 断られた回も残す ── そこが観測点である。 */
  const attempts: Array<{ body: string; expectHash?: string; conflict: boolean }> = [];
  let interleaved = false;
  const port = {
    ...stubRevisionOps(),
    getBody: async (lid: string) => {
      reads.push(lid);
      return disk[lid] ?? null;
    },
    renameEntry: async () => stubStamps(),
    persistEntry: async (
      e: { lid: string; body: string },
      o?: { expectHash?: string },
    ) => {
      // 🔴 **1 回目の書込の直前に、別の窓が書く**(= 直したかった当の窓)
      if (!interleaved && opts.interleave) {
        interleaved = true;
        opts.interleave(disk);
      }
      const conflict =
        o?.expectHash !== undefined && contentHash64Hex(disk[e.lid] ?? '') !== o.expectHash;
      attempts.push({ body: e.body, ...(o?.expectHash !== undefined ? { expectHash: o.expectHash } : {}), conflict });
      if (conflict) return { createdAt: null, updatedAt: null, conflict: true };
      disk[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  } as unknown as StorePort;

  const d = new Dispatcher();
  const errors: string[] = [];
  d.onState((s) => {
    if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
  });
  connectStoreEffects(d, port);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  return { d, disk, reads, attempts, errors };
}

describe('追記が別の窓の書込を消さない(#178)', () => {
  it('🔴 重なったら足し直す ── 別の窓が書いたものが残る', async () => {
    const b = bench('# 見出し\n\n最初の本文\n', {
      // 🔴 別の窓が日付を書いた(追記する側は、これを読んでいない)
      interleave: (disk) => {
        disk['a'] = '# 見出し\n\n最初の本文\n\n別の窓が書いた行\n';
      },
    });
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記した行', heading: null });
    await tick(30);

    // ① 2 回試している(1 回目は断られ、2 回目が通る)
    expect(b.attempts.map((a) => a.conflict), 'やり直していない').toEqual([true, false]);
    // ④ **読み直している** ── getBody は 2 回(最初 + やり直しの前)
    expect(b.reads.length, '古い基底のまま再送している').toBe(2);
    // ② 🔴 **本丸** ── 別の窓が書いた行も、自分の追記も、両方在る
    expect(b.disk['a'], '別の窓が書いた行を消した').toContain('別の窓が書いた行');
    expect(b.disk['a'], '自分の追記が入っていない').toContain('追記した行');
    expect(b.errors, '成功したのに理由を出した').toEqual([]);
  });

  /** ⚠ **対照群** ── 重なっていなければ 1 回で通る(やり直しが常時走らない)。 */
  it('⚠ 重なっていなければ 1 回で書く', async () => {
    const b = bench('# 見出し\n\n最初の本文\n');
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記した行', heading: null });
    await tick(30);
    expect(b.attempts.map((a) => a.conflict), '重なっていないのにやり直した').toEqual([false]);
    expect(b.reads.length, '要らない読み直しをしている').toBe(1);
    expect(b.disk['a']).toContain('追記した行');
  });

  /**
   * 🔴 **③ やり直しは 1 回だけ。それでも重なったら黙らない。**
   * ⚠ 無限に回すと、書き続けている別の窓がいる間ずっと戻らない。
   * 🔑 追記欄の字は残る(`APPEND_FAILED` はロックを解いて理由を出すだけ)ので、
   *   user は押し直せる ── だから**断って安全**である。
   */
  it('🔴 2 回とも重なったら、理由を出してやめる', async () => {
    const disk: Record<string, string> = { a: '# 見出し\n\n本文\n' };
    let n = 0;
    const port = {
      ...stubRevisionOps(),
      getBody: async () => disk['a'] ?? null,
      renameEntry: async () => stubStamps(),
      // ⚠ **毎回**別の窓が先に書く(= 何度やっても重なる)
      persistEntry: async (_e: unknown, o?: { expectHash?: string }) => {
        n += 1;
        disk['a'] = `# 見出し\n\n本文 ${n}\n`;
        return o?.expectHash !== undefined
          ? { createdAt: null, updatedAt: null, conflict: true }
          : stubStamps();
      },
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    } as unknown as StorePort;
    const d = new Dispatcher();
    const errors: string[] = [];
    d.onState((s) => {
      if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    });
    connectStoreEffects(d, port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記', heading: null });
    await tick(30);

    expect(n, 'やり直しが 1 回で止まっていない(無限に回る)').toBe(2);
    expect(errors, '黙ってやめた(user は追記が消えたとしか見えない)').toHaveLength(1);
    expect(errors[0], '何が起きたか書いていない').toContain('別の窓');
    expect(errors[0], '次にどうすればよいか書いていない').toContain('もう一度');
    // 🔑 **書込ロックが解けている** ── 解かないと user は永久に追記できない
    expect(d.getState().writeLock, '書込ロックを握ったままにしている').toBeNull();
  });
});
