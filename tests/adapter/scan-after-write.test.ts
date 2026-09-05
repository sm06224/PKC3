/** @vitest-environment happy-dom */
/**
 * 🔴 **面のために集める走査は、並んでいる書込を追い越さない**(2026-09-05)。
 *
 * ## 直したバグ
 *
 * 書込は effect 層の **1 本の chain に直列化**されるが、面の走査
 * (`taskScan` / `contactScan` / `snippetScan` / `queryScan`)は**その外**から
 * worker を直に叩いていた ── だから**保存の直後にその面を開くと、保存前の DB を
 * 集める**。実測(`vite preview` + 実ブラウザ、書込の `postMessage` だけ 400ms
 * 遅らせた対照群):`taskScan` が `upsertEntry` より **195ms 先に**飛び、予定の面は
 * **0 枚のまま**だった(遅らせない群は 1 枚)。
 *
 * 🔴 **そして戻らない。** これらの走査は「面を開いたとき 1 回」しか走らないので、
 * 古い答えが居座る ── user から見ると「**保存したのに予定に出てこない**」で、
 * その面を開き直すまで直らない。
 *
 * ## ここが見るもの
 *
 * 🔑 **門を 5 つ置いたので、5 つとも別々に見る**(CLAUDE.md §1 ──
 * 1 本の fixture で全部を見ると、片方の門を殺してももう片方が救って落ち続ける)。
 * ⚠ 見るのは「**書込が飛んでいる間は走査が走らない**」であって、
 * 「最後に走った」ではない ── 後者は直す前の実装でも成り立つ
 * (追い越して走った後、書込が着地するので)。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

/** 待ち行列を一巡させる(`store-settle.test.ts` と同じ理由で macrotask を挟む)。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** 手で開けられる門(= 書込が「まだ着いていない」状態を作る)。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** 集めた走査の名前が、書込の後に並ぶこと。 */
async function setup() {
  const d = new Dispatcher();
  const order: string[] = [];
  const g = gate();
  const note = (name: string) => async (): Promise<never> => {
    order.push(name);
    // ⚠ 中身は要らない ── 「いつ走ったか」だけを見る。拒否で返して
    //    reducer の道は「集められなかった」側へ落とす(画面は止まらない)
    throw new Error('この test は結果を使わない');
  };
  const effects = connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => {
      await g.wait;
      order.push('write');
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    taskScan: note('taskScan'),
    contactScan: note('contactScan'),
    snippetScan: note('snippetScan'),
    queryScan: note('queryScan'),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  // 保存を 1 本積む(門が閉じているので着地しない)
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '' });
  d.dispatch({ type: 'START_EDIT' });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '- [ ] 見積を送る @2026-09-05' });
  d.dispatch({ type: 'COMMIT_EDIT' });
  /**
   * ⚠ **列を「保存の手前まで」進めておく** ── 編集を始めた時点で雛形
   *   (`snippetScan`)が 1 本積まれているので、流さずに数えると
   *   **その 1 本に満たされて**「追い越した」に見える(CLAUDE.md §1)。
   * 🔑 だから**流してから、その時点の並びを基準にする** ── 流しても
   *   保存は門で止まるので、「飛んでいる書込が在る」状態は崩れない。
   */
  await flush();
  return { d, effects, order, g, before: [...order] };
}

/**
 * 🔑 **門ごとに 1 件**(名前 / それを頼む操作)。⚠ 表にしても
 *   **落ちたときにどの門かが名前で分かる**ようにする(§「1 job = 1 主張」)。
 */
const GATES: readonly { name: string; ask: Dispatchable }[] = [
  { name: 'taskScan', ask: { type: 'REFRESH_TASK_SCAN' } },
  { name: 'contactScan', ask: { type: 'REFRESH_CONTACT_SCAN' } },
  { name: 'snippetScan', ask: { type: 'REFRESH_SNIPPET_SCAN' } },
  { name: 'queryScan', ask: { type: 'SET_QUERY_KEY', key: 'tags' } },
  { name: 'tagSuggestions', ask: { type: 'ASK_TAG_SUGGESTIONS' } },
];

describe('面の走査は、飛んでいる書込を追い越さない', () => {
  for (const { name, ask } of GATES) {
    it(`🔴 ${name} は、保存が着地するまで走らない`, async () => {
      const { d, order, g, before } = await setup();
      d.dispatch(ask);
      await flush();
      expect(order, `${name} が保存を追い越した(保存前の DB を集めている)`).toEqual(before);

      g.open();
      await flush();
      // ⚠ 走った名前は `queryScan`(タグの候補も同じ口を叩く ── #550 段④)
      const ran = name === 'tagSuggestions' ? 'queryScan' : name;
      expect(order, `${name} が走っていない`).toEqual([...before, 'write', ran]);
    });
  }

  /**
   * 🔴 **対照群** ── 門が最初から開いていれば、走査は普通に走る。
   * ⚠ 置かないと「いつも走らない」実装(= 頼んでも集めない)でも上が緑になる。
   */
  it('⚠ 飛んでいる書込が無ければ、頼んだ走査はそのまま走る', async () => {
    const { d, order, g, before } = await setup();
    g.open();
    await flush();
    expect(order).toEqual([...before, 'write']);
    d.dispatch({ type: 'REFRESH_TASK_SCAN' });
    await flush();
    expect(order).toEqual([...before, 'write', 'taskScan']);
  });
});
