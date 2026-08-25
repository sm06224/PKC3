/**
 * #195 / C-5 段③: **書き戻しの当て方**。
 *
 * 🔑 **`main.ts` から取り出してある理由がここに在る** ── `main.ts` は
 *   原文を読む test しか持たないので、判断を置くと**全 test 緑のまま**取り違える。
 *
 * 見るのは 4 点:
 * ① ⚠ **編集中は 1 バイトも書かない**
 * ② 🔴 **読めない 1 件で全体を断る**(半分だけ書かない)
 * ③ 🔴 **先を越されたら止めて、件数を添えて言う**
 * ④ 🔴 **履歴へ積む**(別のアプリが書いた本文を、戻せない形にしない)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  applyExtWriteOps,
  type ExtWriteApplyDeps,
  type ExtWriteEntry,
} from '../../src/adapter/state/ext-write-apply';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 7,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function rig(
  disk: Record<string, string>,
  over: Partial<ExtWriteApplyDeps> & { conflictOn?: Set<string>; gone?: Set<string> } = {},
) {
  const wrote: { entry: ExtWriteEntry; expectHash: string }[] = [];
  let refreshed = 0;
  const deps: ExtWriteApplyDeps = {
    // ⚠ 既定は「そのまま走らせる」── chain の有無はここの主題ではない
    run: (job) => job(),
    phase: () => 'ready',
    metaOf: (lid) => (over.gone?.has(lid) ? null : lid in disk ? meta(lid) : null),
    getBody: async (lid) => disk[lid] ?? null,
    write: async (entry, expectHash) => {
      if (over.conflictOn?.has(entry.lid)) return { conflict: true };
      wrote.push({ entry, expectHash });
      disk[entry.lid] = entry.body;
      return {};
    },
    refresh: async () => void (refreshed += 1),
    ...Object.fromEntries(
      Object.entries(over).filter(([k]) => k !== 'conflictOn' && k !== 'gone'),
    ),
  };
  return { deps, wrote, disk, refreshed: (): number => refreshed };
}

const setBody = (lid: string, body: string) => ({ op: 'setBody' as const, lid, body });

describe('通る形', () => {
  it('渡された分だけ書いて、件数を返す', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps);
    expect(out).toEqual({ ok: true, wrote: 2 });
    expect(r.disk).toEqual({ a: '新 A', b: '新 B' });
  });

  it('🔴 読んだ本文の指紋を添えて書く(別の窓を黙って上書きしない)', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新')], r.deps);
    expect(r.wrote[0]!.expectHash, '指紋を添えていない').toBe(contentHash64Hex('ふるい'));
  });

  it('⚠ 題名・並び順・種類は触らない(語彙は setBody だけ)', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新')], r.deps);
    expect(r.wrote[0]!.entry.title).toBe('t-a');
    expect(r.wrote[0]!.entry.entryOrder).toBe(7);
    expect(r.wrote[0]!.entry.archetype).toBe('text');
  });

  it('🔑 frontmatter の抽出列は当て直す(印や日付が本文と食い違わない)', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '---\nstatus: done\n---\n本文\n')], r.deps);
    expect(r.wrote[0]!.entry.status, '本文の印が列に入っていない').toBe('done');
  });

  it('書いたら画面を取り直す', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新')], r.deps);
    expect(r.refreshed()).toBe(1);
  });
});

describe('🔴 断る形', () => {
  it('⚠ 編集中は 1 バイトも書かない', async () => {
    const r = rig({ a: 'ふるい' }, { phase: () => 'editing' });
    const out = await applyExtWriteOps([setBody('a', '新')], r.deps);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why).toContain('編集中');
    expect(r.disk['a'], '編集中なのに書いた').toBe('ふるい');
    expect(r.refreshed(), '書いていないのに取り直した').toBe(0);
  });

  it('🔴 居ない 1 件が混ざれば全体を断る(半分だけ書かない)', async () => {
    const r = rig({ a: 'ふるい' });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps);
    expect(out.ok).toBe(false);
    expect(r.disk['a'], '居ない 1 件が混ざっているのに書いた').toBe('ふるい');
    expect(r.wrote, '1 バイトも書かないはずが書いた').toEqual([]);
  });

  /**
   * 🔴 **「行が在るのに本文が読めない」を別に見る**(2 稿目。変異試験が拾った)。
   *
   * ⚠ 1 稿目は disk に無い lid で見ていたので、落ちていたのは **meta の門**で、
   *   **本文の門は 1 度も通っていなかった** ── だから `body ?? ''` に変えても緑
   *   だった(CLAUDE.md §2「弱いのではなく走っていない」)。
   * 🔑 **meta は在る / 本文だけ読めない**という形を作る。
   */
  it('🔴 行は在るのに本文が読めない 1 件でも、全体を断る', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' }, { getBody: async (lid) => (lid === 'b' ? null : 'ふるい') });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps);
    expect(out.ok, '読めない 1 件を空として通した').toBe(false);
    expect(!out.ok && out.why).toContain('本文を読めませんでした');
    expect(r.wrote, '1 バイトも書かないはずが書いた').toEqual([]);
  });

  it('🔴 先を越されたら止めて、そこまでの件数を言う', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' }, { conflictOn: new Set(['b']) });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why, '件数を言っていない').toContain('1 件まで書いて止めました');
    expect(r.disk['a'], '先に書いた分まで巻き戻った').toBe('新 A');
    expect(r.disk['b'], '先を越されたのに書いた').toBe('ふるい');
  });

  it('⚠ 途中まで書いたなら、断っても画面は取り直す(古いまま残さない)', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' }, { conflictOn: new Set(['b']) });
    await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps);
    expect(r.refreshed(), '1 件書いたのに取り直していない').toBe(1);
  });

  it('⚠ 読んだ後に消えていたら、黙って作らない', async () => {
    const gone = new Set<string>();
    const r = rig(
      { a: 'ふるい', b: 'ふるい' },
      {
        gone,
        write: async (entry) => {
          // 1 件目を書いた直後に b が消える
          if (entry.lid === 'a') gone.add('b');
          return {};
        },
      },
    );
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why).toContain('消えました');
  });
});

describe('🔴 chain に載せる(2 本目の待ち口を作らない)', () => {
  it('全部の仕事が `run` の中で走る', async () => {
    let inside = 0;
    let seen = 0;
    const r = rig(
      { a: 'ふるい' },
      {
        run: async (job) => {
          inside += 1;
          const out = await job();
          inside -= 1;
          return out;
        },
      },
    );
    const deps: ExtWriteApplyDeps = {
      ...r.deps,
      // ⚠ 読みの最中に「中に居るか」を数える(外で走っていたら 0 になる)
      getBody: async (lid) => {
        seen = inside;
        return r.disk[lid] ?? null;
      },
    };
    await applyExtWriteOps([setBody('a', '新')], deps);
    expect(seen, 'chain の外で読んでいる').toBe(1);
  });
});
