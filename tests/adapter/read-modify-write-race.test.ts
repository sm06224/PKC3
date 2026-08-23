/**
 * 🔴 **読んで → 直して → 書き戻す**経路が、別の窓の本文を消さないこと(#178)。
 *
 * ⚠ **実測して初めて分かった**(2026-08-23)── `expectHash` を渡さない書込は
 * worker の **amend** に落ちるので、上書きされた版は **disk からも履歴からも
 * 消える**(`tests/adapter/storage-worker.test.ts` の
 * 「expectHash を渡さなければ、食い違っていても書く」が同じ主張を worker 側で pin する)。
 * つまりここは「見えなくなる」ではなく**本当に消える**側だった。
 *
 * 🔑 **この面が見るのは「効果層が門を渡しているか」**である ── 門そのもの
 * (`expectHash` を受けて断る)は worker の test が見ている。⚠ **2 か所で
 * 答えていると、片方だけ壊しても届かない**(CLAUDE.md §7)ので、
 * ここでは**呼び側が渡しているか**だけを見る。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';
import { PersistOnce } from '../../src/adapter/platform/storage-persist';

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

/**
 * disk を持つ fake store。
 * ⚠ **stub は本物の意味論を真似る**(CLAUDE.md §3)── `expectHash` を受け取ったら
 *   **同じ tx の中で比べる**本物と同じく、いまの disk と突き合わせて断る。
 */
function makeStore(disk: Record<string, string>) {
  /** 次の `getBody` の**直後**に別の窓が書く(読みと書きの隙間の再現)。 */
  let raceWith: { lid: string; body: string } | null = null;
  const store = {
    ...stubRevisionOps(),
    getBody: async (lid: string): Promise<string | null> => {
      const read = disk[lid] ?? null;
      if (raceWith !== null) {
        disk[raceWith.lid] = raceWith.body;
        raceWith = null;
      }
      return read;
    },
    getBodies: async (lids: string[]) => lids.map((lid) => ({ lid, body: disk[lid] ?? '' })),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    persistEntry: async (
      e: { lid: string; body: string },
      opts?: { expectHash?: string },
    ) => {
      if (opts?.expectHash !== undefined && contentHash64Hex(disk[e.lid] ?? '') !== opts.expectHash)
        return { ...stubStamps(), conflict: true };
      disk[e.lid] = e.body;
      return stubStamps();
    },
  };
  return { store, race: (lid: string, body: string) => (raceWith = { lid, body }) };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

let d: Dispatcher;
let errors: string[];
/** 効果層が撃った action の種別(画面へ「成功した」と言っていないかを見る)。 */
let sent: string[];
let dispose: (() => void) | null = null;

/** 🔴 保存の ack で永続化を頼んでいるか(#347)を見るための控え。 */
let persistCalls = 0;
let persistOnce: PersistOnce;

function boot(disk: Record<string, string>, metas: EntryMeta[]) {
  persistCalls = 0;
  persistOnce = new PersistOnce({
    persisted: async () => false,
    persist: async () => {
      persistCalls += 1;
      return true;
    },
  });
  const { store, race } = makeStore(disk);
  d = new Dispatcher();
  errors = [];
  sent = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: { type: string }) => {
    sent.push(a.type);
    return raw(a as never);
  }) as typeof d.dispatch;
  // ⚠ **`OP_FAILED` は event ではなく action** ── 受け側は `state.error` に写す。
  //    event を待つ観測点は**永遠に空**で、しかも「黙って落とした」と読める。
  d.onState((s) => {
    if (s.error !== null && errors[errors.length - 1] !== s.error) errors.push(s.error);
  });
  dispose = connectStoreEffects(d, store as never, { persist: persistOnce });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  return { race };
}

beforeEach(() => {
  errors = [];
});
afterEach(() => {
  dispose?.();
  dispose = null;
});

const TASKS = '- [ ] 牛乳を買う\n- [ ] 郵便を出す\n';

/**
 * 🔴 **最初の書込で「消えない側へ置いて」と頼む**(#347、2026-08-23)。
 *
 * ⚠ 直す前は `navigator.storage.persist()` の呼び出しが Office 一式の経路
 * (`office-pack-install.ts`)にしか無く、**ノート本体は一度も頼んでいなかった** ──
 * origin の quota は OPFS(= SQLite 本体)と共用なので、空き容量が減ると
 * **黙って消える**(user から見ると「昨日まで在ったノートが今日は 1 件も無い」)。
 *
 * 🔑 観測点は**保存の ack**(`stamp`)── 全部の書込経路が通る 1 か所である。
 * ⚠ 経路ごとに書くと必ずどれかが漏れる(#347 がまさにその形だった)。
 */
describe('最初の書込で永続化を頼む (#347)', () => {
  it('🔴 書けたら頼む', async () => {
    const disk: Record<string, string> = { a: TASKS };
    boot(disk, [meta('a')]);
    d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0 });
    await tick();
    expect(disk['a'], '前提: 書けていない(この test は何も測っていない)').toContain('- [x]');
    expect(persistCalls, '書けたのに永続化を頼んでいない').toBe(1);
  });

  it('🔴 2 回目以降は頼まない(保存のたびに user へ尋ねない)', async () => {
    const disk: Record<string, string> = { a: TASKS };
    boot(disk, [meta('a')]);
    d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0 });
    await tick();
    d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 1 });
    await tick();
    expect(disk['a'], '前提: 2 回目が書けていない').toContain('- [x] 郵便');
    expect(persistCalls, '保存のたびに尋ねている').toBe(1);
  });

  /** ⚠ **対照群** ── 書けなかった回は頼まない(断った書込で尋ねない)。 */
  it('⚠ 断った書込では頼まない', async () => {
    const disk: Record<string, string> = { a: TASKS };
    const { race } = boot(disk, [meta('a')]);
    race('a', '- [ ] 割り込み\n' + TASKS);
    d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0 });
    await tick();
    expect(persistCalls, '書いていないのに尋ねた').toBe(0);
  });
});

describe('読んで直して書き戻す経路が、別の窓の本文を消さない (#178)', () => {
  /**
   * 🔴 **面のチェック**(`TOGGLE_TASK` → `REQUEST_BODY_REWRITE`)。
   * ⚠ ここは**行番号**で当てるので、別の窓が行を足していると同じ番号が
   *   **別の項目**を指す ── だから当て直さず**断る**。
   */
  it('🔴 チェックを裏返す間に別の窓が書いたら、書かずに断る', async () => {
    const disk: Record<string, string> = { a: TASKS };
    const { race } = boot(disk, [meta('a')]);
    race('a', '- [ ] 割り込みで足した行\n' + TASKS);

    d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0 });
    await tick();

    expect(disk['a'], '別の窓が書いた本文が消えた').toBe(
      '- [ ] 割り込みで足した行\n' + TASKS,
    );
    expect(errors.join('|'), '黙って落とした(user に理由が出ていない)').toContain('別の窓');
    /**
     * 🔴 **断ったのに画面へ「裏返った」と言わない**(変異試験 M4 が SURVIVED で教えた)。
     * ⚠ `return` を落とすと OP_FAILED の**直後に** `BODY_REWRITTEN` が飛び、
     *   **画面のチェックだけ裏返って disk は元のまま**になる ── user は
     *   保存されたと思って閉じる(いちばん気づけない形)。
     */
    expect(sent, '断ったのに画面へ「反映した」と言った').not.toContain('BODY_REWRITTEN');
  });

  /** ⚠ **対照群** ── 割り込みが無ければ、ふつうに書く(空振り防止)。 */
  it('⚠ 割り込みが無ければ、チェックはふつうに裏返る', async () => {
    const disk: Record<string, string> = { a: TASKS };
    boot(disk, [meta('a')]);
    d.dispatch({ type: 'TOGGLE_TASK', lid: 'a', line: 0 });
    await tick();
    expect(disk['a'], '対照群が届いていない ── 上の test は何も測っていない').toBe(
      '- [x] 牛乳を買う\n- [ ] 郵便を出す\n',
    );
    expect(errors, '通ったのに断った').toEqual([]);
    // ⚠ **対照群** ── 通ったときは画面へ言う(上の not.toContain が空振りでない)
    expect(sent, '通ったのに画面へ言っていない').toContain('BODY_REWRITTEN');
  });

  /** 🔴 **板の設定**(`SET_APP_TILE` → `REQUEST_TILE_UPDATE`)。 */
  it('🔴 アプリの設定を書き戻す間に別の窓が書いたら、書かずに断る', async () => {
    const disk: Record<string, string> = { b: '本文\n' };
    const { race } = boot(disk, [meta('b', 'attachment')]);
    race('b', '別の窓が書いた本文\n');

    d.dispatch({ type: 'SET_APP_TILE', lid: 'b', registered: true });
    await tick();

    expect(disk['b'], '別の窓が書いた本文が消えた').toBe('別の窓が書いた本文\n');
    expect(errors.join('|'), '黙って落とした').toContain('別の窓');
  });

  /**
   * ⚠ **対照群 + ロックを解いていること** ── 断ったあと `tileWrite` が
   *   残っていると、user は**二度と設定を変えられない**(P8 段⑯)。
   */
  it('⚠ 断ってもロックは解ける(次の設定変更が通る)', async () => {
    const disk: Record<string, string> = { b: '本文\n' };
    const { race } = boot(disk, [meta('b', 'attachment')]);
    race('b', '別の窓が書いた本文\n');
    d.dispatch({ type: 'SET_APP_TILE', lid: 'b', registered: true });
    await tick();
    expect(d.getState().tileWrite, 'ロックを握ったままにした').toBeNull();

    // 2 本目は割り込みが無いので通る
    d.dispatch({ type: 'SET_APP_TILE', lid: 'b', registered: true });
    await tick();
    expect(disk['b'], '断ったあと設定が二度と変えられない').toContain('registered_as_app');
  });
});
