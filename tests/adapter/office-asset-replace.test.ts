/** @vitest-environment happy-dom */
/**
 * 🔴 **Office の保存を書き戻す ── effect 層の受け持ち**(#205 段 C / #178 / #212)。
 *
 * ## ⚠ 2026-08-25 に、この file の受け持ちが変わった
 *
 * 直す前は effect 層が `listBodies` で**全ノートの本文を主スレッドへ運び**、
 * `planSaveBack` を掛け、`persistEntry` を**1 件ずつ**呼んでいた ── 読んでから
 * 書くまでの間に別のタブ / 窓が書くと**それを消し**、`checkpoint` を渡していない
 * ので **amend** = **履歴にも残らない**(#178 で改名 / 並べ替えを直したのと
 * まったく同じ形)。
 * 🔑 走査ごと worker の 1 tx(`op: 'replaceAssetRefs'`)へ移したので、
 * **衝突しうる状態そのものが消えた**。
 *
 * ⚠ だから**「何が書かれたか」はここでは見ない** ── それは
 * `tests/adapter/storage-worker.test.ts` が**本物の SQL の上で**見る。
 * ここで fake に同じ段取りを書き直すと、**fake を検めているだけ**になる
 * (CLAUDE.md §3「stub が実装より正しいとバグが隠れる」)。
 *
 * ここが持つ主張は 4 つ:
 *
 * 1. **1 往復で頼む**(本文を主スレッドへ運ばない ── `listBodies` / `persistEntry` を
 *    この経路で呼ばない)
 * 2. 断りの理由(`problem`)を **user の言葉**に直す
 * 3. 書けた本文を**画面へ差し替える**(次に開き直すまで古い、を作らない)
 * 4. **おかしなことだけ言う**(`unchanged` は黙る / `stale` と `overBudget` は出す)
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';

const tick = (ms = 20): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const DOC = [
  '---',
  'attachment.name: 報告書.odt',
  'attachment.asset_key: ast-old',
  '---',
  '説明',
  '',
].join('\n');

type Reply = Awaited<ReturnType<Parameters<typeof connectStoreEffects>[1]['replaceAssetRefs']>>;

const OK: Reply = {
  problem: null,
  unchanged: false,
  wrote: [{ lid: 'a1', body: DOC.replace('ast-old', 'ast-new'), stamps: stubStamps() }],
  stale: [],
  overBudget: false,
};

function setup(
  metas: EntryMeta[],
  reply: Reply | (() => Promise<Reply>) = OK,
): {
  d: Dispatcher;
  /** この経路が呼んだ口(⚠ 本文を主スレッドへ運んでいないことを見る)。 */
  calls: string[];
  asked: Array<{ targetLid: string; newKey: string }>;
} {
  const calls: string[] = [];
  const asked: Array<{ targetLid: string; newKey: string }> = [];
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => DOC,
    getBodies: async () => {
      calls.push('getBodies');
      return [];
    },
    listBodies: async () => {
      calls.push('listBodies');
      return { rows: [], done: true };
    },
    renameEntry: async () => stubStamps(),
    reorderEntry: async () => stubStamps(),
    replaceAssetRefs: async (input) => {
      calls.push('replaceAssetRefs');
      asked.push({ targetLid: input.targetLid, newKey: input.newKey });
      return typeof reply === 'function' ? await reply() : reply;
    },
    persistEntry: async () => {
      calls.push('persistEntry');
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  return { d, calls, asked };
}

const saved = (lid: string, key = 'ast-new'): Parameters<Dispatcher['dispatch']>[0] => ({
  type: 'OFFICE_ASSET_SAVED',
  lid,
  newKey: key,
  newHash: 'h'.repeat(64),
  newBytes: 4242,
  newName: '報告.docx',
  newMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  savedAt: '2026-08-16T00:00:00.000Z',
});

describe('Office の保存を書き戻す(effect 層の受け持ち)', () => {
  /**
   * 🔴 **これが #178 / #212 の当の保証** ── 本文を主スレッドへ 1 バイトも運ばない。
   * ⚠ 昔の段取り(`listBodies` → `persistEntry`)へ戻すと、この test が落ちる。
   */
  it('🔴 1 往復で頼む(本文を主スレッドへ運ばない)', async () => {
    const h = setup([meta('a1', 'attachment')]);
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.calls, '頼んでいない').toContain('replaceAssetRefs');
    expect(h.calls, '本文を主スレッドへ運んでいる(#212 が戻っている)').not.toContain('listBodies');
    expect(h.calls, '主スレッドから 1 件ずつ書いている(#178 の穴が戻っている)').not.toContain(
      'persistEntry',
    );
    expect(h.asked, '何に差し替えるかが伝わっていない').toEqual([
      { targetLid: 'a1', newKey: 'ast-new' },
    ]);
  });

  it('🔴 開いている本文は、その場で差し替わる(次に開き直すまで古い、を作らない)', async () => {
    const h = setup([meta('a1', 'attachment')]);
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'a1', body: DOC });
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.d.getState().openBody?.body, '画面の本文が古いまま').toContain('ast-new');
  });

  it('中身が同じ(key が変わらない)なら黙って終える', async () => {
    const h = setup([meta('a1', 'attachment')], {
      problem: null,
      unchanged: true,
      wrote: [],
      stale: [],
      overBudget: false,
    });
    h.d.dispatch(saved('a1', 'ast-old'));
    await tick();
    // ⚠ **異常ではない**(「取り込みました」は呼び側が出す)── 苦情を出すと
    //    user は保存が失敗したと思う
    expect(h.d.getState().error, '変わっていないだけなのに苦情を出した').toBe(null);
  });

  /**
   * 🔴 **断りの理由は user の言葉に直す。**
   * ⚠ worker は名前(`missing-entry` / `missing-asset`)で返す ── そのまま画面に
   * 出すと user には読めない。⚠ **2 つを見分ける**(片方だけ pin すると、
   * 両方を同じ文へ潰す変異が生き延びる)。
   */
  it('🔴 断りの理由を、見分けのつく言葉にする', async () => {
    const h1 = setup([meta('a1', 'attachment')], {
      problem: 'missing-entry',
      unchanged: false,
      wrote: [],
      stale: [],
      overBudget: false,
    });
    h1.d.dispatch(saved('a1'));
    await tick();
    expect(h1.d.getState().error).toContain('ノートが見つかりません');

    const h2 = setup([meta('a1', 'attachment')], {
      problem: 'missing-asset',
      unchanged: false,
      wrote: [],
      stale: [],
      overBudget: false,
    });
    h2.d.dispatch(saved('a1'));
    await tick();
    expect(h2.d.getState().error).toContain('添付の実体が分かりません');
  });

  /**
   * 🔴 **書き換え漏れは件数を出す**(2026-08-16、着地前レビュー R12)。
   * ⚠ 黙って「取り込みました」と言うと、GC が実体を消した時点で
   * **切れた参照だけが残る**。
   */
  it('🔴 旧い参照が残った / 上限を超えたときは、黙らない', async () => {
    const h = setup([meta('a1', 'attachment')], {
      problem: null,
      unchanged: false,
      wrote: [{ lid: 'a1', body: DOC, stamps: stubStamps() }],
      stale: ['n1', 'n2'],
      overBudget: true,
    });
    h.d.dispatch(saved('a1'));
    await tick();
    const err = h.d.getState().error ?? '';
    expect(err, '旧い参照が残ったのに黙っている').toContain('旧い参照が残りました: 2 件');
    expect(err, '上限を超えたのに黙っている').toContain('版の保管上限を超えています');
  });

  it('🔴 1 件も書けなかったら、そう言う', async () => {
    const h = setup([meta('a1', 'attachment')], {
      problem: null,
      unchanged: false,
      wrote: [],
      stale: [],
      overBudget: false,
    });
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.d.getState().error).toContain('ノートを 1 件も更新できませんでした');
  });

  it('🔴 worker が落ちたら理由を出す(黙って無かったことにしない)', async () => {
    const h = setup([meta('a1', 'attachment')], () => Promise.reject(new Error('壊れた')));
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.d.getState().error, '落ちたのに理由が出ない').toContain('書き戻せませんでした');
  });

  it('🔴 編集中は何も起きない(棚に残して撃ち直す側と対)', async () => {
    const h = setup([meta('a1', 'attachment')]);
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    h.d.dispatch({ type: 'BODY_LOADED', lid: 'a1', body: DOC });
    h.d.dispatch({ type: 'START_EDIT' });
    await tick();
    // 空振り防止 ── 本当に編集に入っているか(入っていなければこの test は無意味)
    expect(h.d.getState().phase, '編集に入れていない').toBe('editing');
    h.d.dispatch(saved('a1'));
    await tick();
    expect(h.calls, '編集中に書き戻した').not.toContain('replaceAssetRefs');
  });

  /**
   * 🔴 **添付でないノート / 知らない lid では、頼みもしないし苦情も出ない。**
   * ⚠ 「頼まない」だけを見ると、reducer の門を外しても worker が
   * `missing-asset` を返して**身に覚えのない苦情**が出る ── 両方を見る。
   */
  it('🔴 添付でないノート / 知らない lid では、頼まないし苦情も出ない', async () => {
    const h = setup([meta('a1', 'attachment'), meta('t1', 'text')]);
    h.d.dispatch(saved('t1'));
    await tick();
    expect(h.calls, '添付でないノートで頼んだ').not.toContain('replaceAssetRefs');
    expect(h.d.getState().error, '添付でないノートで苦情が出た').toBe(null);
    h.d.dispatch(saved('nope'));
    await tick();
    expect(h.calls, '知らない lid で頼んだ').not.toContain('replaceAssetRefs');
    expect(h.d.getState().error, '知らない lid で苦情が出た').toBe(null);
  });
});
