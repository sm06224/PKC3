/** @vitest-environment node */
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
  STALE_AFTER_HANDOFF,
  type ExtWriteApplyDeps,
  type ExtWriteEntry,
} from '../../src/adapter/state/ext-write-apply';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';
import { SECTION_DRAFT_NOTE } from '../../src/adapter/state/app-state';
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
  const wrote: { entry: ExtWriteEntry; expectHash: string; keepMeta: boolean }[] = [];
  let refreshed = 0;
  const notices: { message: string; open: string | null }[] = [];
  const deps: ExtWriteApplyDeps = {
    // ⚠ 既定は「そのまま走らせる」── chain の有無はここの主題ではない
    run: (job) => job(),
    phase: () => 'ready',
    bodyBlockReason: () => null,
    editedElsewhere: async () => null,
    metaOf: (lid) => (over.gone?.has(lid) ? null : lid in disk ? meta(lid) : null),
    getBody: async (lid) => disk[lid] ?? null,
    write: async (entry, { expectHash, keepMeta }) => {
      if (over.conflictOn?.has(entry.lid)) return { conflict: true };
      wrote.push({ entry, expectHash, keepMeta });
      disk[entry.lid] = entry.body;
      return {};
    },
    refresh: async () => void (refreshed += 1),
    notify: (message, open) => void notices.push({ message, open }),
    ...Object.fromEntries(
      Object.entries(over).filter(([k]) => k !== 'conflictOn' && k !== 'gone'),
    ),
  };
  // 🔑 送った時点の指紋 = 台の最初の本文(書かれて disk が動いても、ここは動かない)
  const handed = new Map(Object.entries(disk).map(([k, v]) => [k, contentHash64Hex(v)]));
  return { deps, wrote, disk, handed, notices, refreshed: (): number => refreshed };
}

const setBody = (lid: string, body: string) => ({ op: 'setBody' as const, lid, body });

describe('通る形', () => {
  it('渡された分だけ書いて、件数を返す', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(out).toEqual({ ok: true, wrote: 2 });
    expect(r.disk).toEqual({ a: '新 A', b: '新 B' });
  });

  it('🔴 読んだ本文の指紋を添えて書く(別の窓を黙って上書きしない)', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新')], r.deps, r.handed);
    expect(r.wrote[0]!.expectHash, '指紋を添えていない').toBe(contentHash64Hex('ふるい'));
  });

  it('⚠ 題名・並び順・種類は触らない(語彙は setBody だけ)', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新')], r.deps, r.handed);
    expect(r.wrote[0]!.entry.title).toBe('t-a');
    expect(r.wrote[0]!.entry.entryOrder).toBe(7);
    expect(r.wrote[0]!.entry.archetype).toBe('text');
  });

  it('🔑 frontmatter の抽出列は当て直す(印や日付が本文と食い違わない)', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '---\nstatus: done\n---\n本文\n')], r.deps, r.handed);
    expect(r.wrote[0]!.entry.status, '本文の印が列に入っていない').toBe('done');
  });

  it('書いたら画面を取り直す', async () => {
    const r = rig({ a: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新')], r.deps, r.handed);
    expect(r.refreshed()).toBe(1);
  });
});

describe('🔴 断る形', () => {
  it('⚠ 編集中は 1 バイトも書かない', async () => {
    const r = rig({ a: 'ふるい' }, { phase: () => 'editing' });
    const out = await applyExtWriteOps([setBody('a', '新')], r.deps, r.handed);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why).toContain('編集を保存するか、編集をやめてから');
    expect(r.disk['a'], '編集中なのに書いた').toBe('ふるい');
    expect(r.refreshed(), '書いていないのに取り直した').toBe(0);
  });

  it('🔴 居ない 1 件が混ざれば全体を断る(半分だけ書かない)', async () => {
    const r = rig({ a: 'ふるい' });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
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
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(out.ok, '読めない 1 件を空として通した').toBe(false);
    expect(!out.ok && out.why).toContain('本文を読めませんでした');
    expect(r.wrote, '1 バイトも書かないはずが書いた').toEqual([]);
  });

  it('🔴 先を越されたら止めて、そこまでの件数を言う', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' }, { conflictOn: new Set(['b']) });
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why, '件数を言っていない').toContain('1 件まで書いて止めました');
    expect(r.disk['a'], '先に書いた分まで巻き戻った').toBe('新 A');
    expect(r.disk['b'], '先を越されたのに書いた').toBe('ふるい');
  });

  it('⚠ 途中まで書いたなら、断っても画面は取り直す(古いまま残さない)', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' }, { conflictOn: new Set(['b']) });
    await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
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
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
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
    await applyExtWriteOps([setBody('a', '新')], deps, r.handed);
    expect(seen, 'chain の外で読んでいる').toBe(1);
  });
});

describe('🔴 送ったあとに書き換わったノートは、アプリからの書き戻しで上書きしない(M1)', () => {
  it('送ったあとに本文が変わっていたら、1 バイトも書かずに断る', async () => {
    const r = rig({ a: '送った本文' });
    const handed = new Map(r.handed);
    r.disk['a'] = '送ったあとに user が足した本文';
    const out = await applyExtWriteOps([setBody('a', 'アプリの版')], r.deps, handed);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why).toContain(STALE_AFTER_HANDOFF);
    expect(r.wrote, '書いてしまった').toEqual([]);
    expect(r.disk['a'], 'user の編集が消えた').toBe('送ったあとに user が足した本文');
    expect(r.refreshed()).toBe(0);
  });

  it('対照群: 送ったあとに変わっていなければ書ける', async () => {
    const r = rig({ a: '送った本文' });
    const out = await applyExtWriteOps([setBody('a', 'アプリの版')], r.deps, r.handed);
    expect(out).toEqual({ ok: true, wrote: 1 });
  });

  it('2 件のうち 1 件でも変わっていたら、もう 1 件も書かない(半分だけ書かない)', async () => {
    const r = rig({ a: 'A', b: 'B' });
    const handed = new Map(r.handed);
    r.disk['b'] = 'B を user が変えた';
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, handed);
    expect(out.ok).toBe(false);
    expect(r.wrote).toEqual([]);
  });

  it('指紋が無い lid(送った覚えが無い)は断る', async () => {
    const r = rig({ a: 'A' });
    const out = await applyExtWriteOps([setBody('a', '新')], r.deps, new Map());
    expect(out.ok).toBe(false);
    expect(r.wrote).toEqual([]);
  });
});

describe('🔴 書く lid ごとの門(編集中のノートを書かない)', () => {
  it('対照群: どちらの門も通せば書く', async () => {
    const r = rig({ a: 'ふるい' });
    const out = await applyExtWriteOps([setBody('a', '新')], r.deps, r.handed);
    expect(out).toEqual({ ok: true, wrote: 1 });
    expect(r.disk['a']).toBe('新');
  });

  it('別のタブが編集中の 1 件が混ざれば、1 バイトも書かずに全体を断る', async () => {
    const r = rig(
      { a: 'ふるい', b: 'ふるい' },
      { editedElsewhere: async (lid) => (lid === 'b' ? EDIT_ELSEWHERE_ERROR : null) },
    );
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(out).toEqual({ ok: false, why: EDIT_ELSEWHERE_ERROR });
    expect(r.wrote, '編集中のタブが居るのに書いた').toEqual([]);
    expect(r.disk['a']).toBe('ふるい');
    expect(r.refreshed(), '書いていないのに取り直した').toBe(0);
  });

  it('章の打ちかけがある 1 件が混ざれば、1 バイトも書かずに全体を断る(断り文は画面の字)', async () => {
    const note = SECTION_DRAFT_NOTE;
    expect(note, '前提: 章の断りは言い切りの文').toContain('を編集中は使えません');
    const r = rig(
      { a: 'ふるい', b: 'ふるい' },
      { bodyBlockReason: (lid) => (lid === 'b' ? note : null) },
    );
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(out).toEqual({ ok: false, why: `PKC3 側で${note}` });
    expect(r.wrote).toEqual([]);
    expect(r.disk['a']).toBe('ふるい');
  });

  it('⚠ 別のタブへの問い合わせは、章の断りが先なら呼ばない / 書く lid だけに聞く', async () => {
    const asked: string[] = [];
    const r = rig(
      { a: 'ふるい', c: 'ふるい' },
      {
        editedElsewhere: async (lid) => {
          asked.push(lid);
          return null;
        },
      },
    );
    await applyExtWriteOps([setBody('a', '1'), setBody('a', '2'), setBody('c', '3')], r.deps, r.handed);
    expect(asked.sort(), '書かないノートに聞いたか、重複して聞いた').toEqual(['a', 'c']);
  });
});

describe('🔑 本文だけを書く / 途中で投げたら件数を言う', () => {
  it('🔴 題名・並びは disk の値を保つ指定(keepMeta: true)で書く(古い写しで書き戻さない)', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(r.wrote.map((w) => w.keepMeta), '全件に付く').toEqual([true, true]);
  });

  it('2 件目の write が投げたら、1 件まで書いて止めたと言い、画面を取り直す', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' });
    const inner = r.deps.write;
    const deps: ExtWriteApplyDeps = {
      ...r.deps,
      write: async (entry, h) => {
        if (entry.lid === 'b') throw new Error('boom');
        return inner(entry, h);
      },
    };
    const out = await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], deps, r.handed);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why).toContain('1 件まで書いて止めました');
    expect(r.refreshed(), '書けた分の画面を読み直していない').toBe(1);
  });

  it('1 件目で投げたら(書けていない)今までどおり投げる', async () => {
    const r = rig({ a: 'ふるい' });
    const deps: ExtWriteApplyDeps = {
      ...r.deps,
      write: async () => {
        throw new Error('boom');
      },
    };
    await expect(applyExtWriteOps([setBody('a', '新')], deps, r.handed)).rejects.toThrow('boom');
    expect(r.refreshed()).toBe(0);
  });

  it('2 件書いた後の読み直しが投げたら、書けた件数を言う', async () => {
    const r = rig({ a: 'ふるい' });
    const deps: ExtWriteApplyDeps = {
      ...r.deps,
      refresh: async () => {
        throw new Error('boom');
      },
    };
    const out = await applyExtWriteOps([setBody('a', '新')], deps, r.handed);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.why).toContain('1 件は書きました');
  });
});

describe('🔴 依頼 75-3: 外のアプリ(拡張機能)が書き換えたら、画面に知らせる', () => {
  it('1 件通ったら「拡張機能 がノート『題名』を書き換えました(履歴から戻せます)」+ 開く先(書いたノート)', async () => {
    const r = rig({ a: 'ふるい' });
    const out = await applyExtWriteOps([setBody('a', '新')], r.deps, r.handed);
    expect(out).toEqual({ ok: true, wrote: 1 });
    expect(r.notices).toEqual([{ message: '拡張機能 がノート『t-a』を書き換えました(履歴から戻せます)', open: 'a' }]);
  });

  it('複数件は件数で言い、先頭のノートを開く先にする', async () => {
    const r = rig({ a: 'ふるい', b: 'ふるい' });
    await applyExtWriteOps([setBody('a', '新 A'), setBody('b', '新 B')], r.deps, r.handed);
    expect(r.notices).toEqual([{ message: '拡張機能 がノート 2 件を書き換えました(履歴から戻せます)', open: 'a' }]);
  });

  it('断ったら理由つきで知らせる(開く先は無い)。編集中 / 送ったあとに書き換わっていた、の 2 通り', async () => {
    const editing = rig({ a: 'ふるい' }, { phase: () => 'editing' });
    const o1 = await applyExtWriteOps([setBody('a', '新')], editing.deps, editing.handed);
    expect(o1.ok).toBe(false);
    expect(editing.notices).toHaveLength(1);
    expect(editing.notices[0]!.open).toBeNull();
    expect(editing.notices[0]!.message).toBe(`拡張機能からの書き換えを受け付けませんでした: ${(o1 as { why: string }).why}`);
    expect(editing.notices[0]!.message).toContain('編集');

    const stale = rig({ a: 'ふるい' });
    stale.disk.a = 'user が書いた';
    const o2 = await applyExtWriteOps([setBody('a', '新')], stale.deps, stale.handed);
    expect(o2.ok).toBe(false);
    expect(stale.notices[0]!.message).toContain(STALE_AFTER_HANDOFF);
  });

  it('⚠ 1 件も書いていない成功(あり得ない形)では、「書き換えました」と言わない / 投げたときも理由つきで知らせて投げ直す', async () => {
    const thrower = rig(
      { a: 'ふるい' },
      {
        write: async () => {
          throw new Error('disk が一杯');
        },
      },
    );
    await expect(applyExtWriteOps([setBody('a', '新')], thrower.deps, thrower.handed)).rejects.toThrow('disk が一杯');
    expect(thrower.notices).toEqual([{ message: '拡張機能からの書き換えを受け付けませんでした: disk が一杯', open: null }]);
  });
});
