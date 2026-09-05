/** @vitest-environment happy-dom */
/**
 * 🔴 **面のために集める走査は、並んでいる書込を追い越さない**(2026-09-05)。
 *
 * ## 直したバグ
 *
 * 書込は effect 層の **1 本の chain に直列化**されるが、面の走査
 * (`taskScan` / `contactScan` / `snippetScan` / `queryScan` / タグの候補 /
 * 参照元)は**その外**から worker を直に叩いていた ── だから**保存の直後に
 * その面を開くと、保存前の DB を集める**。実測(`vite preview` + 実ブラウザ、
 * 書込の `postMessage` だけ 400ms 遅らせた対照群):`taskScan` が `upsertEntry`
 * より **195ms 先に**飛び、予定の面は **0 枚のまま**だった(遅らせない群は 1 枚)。
 *
 * 🔴 **そして戻らない。** これらの走査は「その面を開いたとき 1 回」しか走らないので、
 * 古い答えが居座る ── user から見ると「**保存したのに予定に出てこない**」で、
 * その面を開き直すまで直らない。
 *
 * ## 直し方(`scanAfterWrites`)
 *
 * 🔑 **列に積むのではなく、その時点の列の末尾だけ待って、列の外で走らせる**。
 * ⚠ 列に積むと**買いすぎる** ── `settled()` が走査を待つようになり、
 *   「編集」を押してから入力欄が出るまでが全件走査 1 往復ぶん延びる
 *   (着地前レビュー 2-A)。
 *
 * ## ここが見るもの
 *
 * 🔑 **門を 6 つ置いたので、6 つとも別々の場面で見る**(CLAUDE.md §1 ──
 * 1 本の fixture で全部を見ると、片方の門を殺してももう片方が救って落ち続ける)。
 * ⚠ 見るのは「**書込が飛んでいる間は走査が走らない**」であって「最後に走った」では
 * ない ── 後者は直す前の実装でも成り立つ(追い越して走った後、書込が着地するので)。
 * ⚠ そして**逆向きの門**も置く(下の「載せない側」)── 上限だけの tripwire は、
 * 「何でも列の後ろへ回す」という**逆の壊し方**を 1 つも止められない。
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

/**
 * 走った順を採る台。
 * 🔑 **走査は「答えを返す」**(投げない)── 投げるだけの台にすると、
 *   *集めた答えが画面へ届くか*を 1 件も見ないまま緑になる(変異試験 M3)。
 */
async function setup() {
  const d = new Dispatcher();
  const order: string[] = [];
  const g = gate();
  const seen = (name: string): void => {
    order.push(name);
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
    taskScan: async () => {
      seen('taskScan');
      return { cards: [], totalNotes: 1, scannedNotes: 1, truncated: false };
    },
    contactScan: async () => {
      seen('contactScan');
      return { cards: [], totalNotes: 1, scannedNotes: 1, truncated: false };
    },
    snippetScan: async () => {
      seen('snippetScan');
      return { items: [], total: 0, truncated: false };
    },
    queryScan: async () => {
      seen('queryScan');
      return {
        keys: { keys: [], omittedKeys: 0, scanned: 1 },
        groups: { key: 'tags', groups: [], omittedGroups: 0, scanned: 1, truncated: false },
      };
    },
    findBacklinks: async () => {
      seen('findBacklinks');
      return { lids: ['n1'], truncated: false };
    },
    searchEntries: async () => {
      seen('searchEntries');
      return { lids: [], truncated: false };
    },
  } as unknown as Parameters<typeof connectStoreEffects>[1]);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  // 保存を 1 本積む(門が閉じているので着地しない)
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '' });
  d.dispatch({ type: 'START_EDIT' });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '- [ ] 見積を送る @2026-09-05' });
  d.dispatch({ type: 'COMMIT_EDIT' });
  /**
   * ⚠ **列を「保存の手前まで」進めておく** ── 編集を始めた時点で雛形と参照元が
   *   積まれているので、流さずに数えると**それに満たされて**「追い越した」に見える
   *   (CLAUDE.md §1)。流しても保存は門で止まるので、
   *   「飛んでいる書込が在る」状態は崩れない。
   */
  await flush();
  return { d, effects, order, g, before: [...order] };
}

/**
 * 🔑 **門ごとに 1 件**(名前 / それを頼む操作 / 届いた答えの読み方)。
 * ⚠ 表にしても**落ちたときにどの門かが名前で分かる**ようにする。
 */
const GATES: readonly {
  name: string;
  op: string;
  ask: Dispatchable;
  landed: (s: ReturnType<Dispatcher['getState']>) => boolean;
}[] = [
  {
    name: '予定',
    op: 'taskScan',
    ask: { type: 'REFRESH_TASK_SCAN' },
    landed: (s) => s.taskScan !== null,
  },
  {
    name: '連絡先',
    op: 'contactScan',
    ask: { type: 'REFRESH_CONTACT_SCAN' },
    landed: (s) => s.contactScan !== null,
  },
  {
    name: '雛形',
    op: 'snippetScan',
    ask: { type: 'REFRESH_SNIPPET_SCAN' },
    landed: (s) => s.snippetScan !== null,
  },
  {
    name: '集計',
    op: 'queryScan',
    ask: { type: 'SET_QUERY_KEY', key: 'tags' },
    landed: (s) => s.queryKeys !== null,
  },
  {
    // ⚠ タグの候補は集計と**同じ口**を叩く(#550 段④)── 走る名前は `queryScan`
    name: 'タグの候補',
    op: 'queryScan',
    ask: { type: 'ASK_TAG_SUGGESTIONS' },
    landed: (s) => s.tagSuggestions !== null,
  },
  {
    // 🔴 参照元は「選びが動いた 1 回」しか撃たれない ── 追い越すと選び直すまで戻らない
    name: '参照元',
    op: 'findBacklinks',
    ask: { type: 'SELECT_ENTRY', lid: 'n2' },
    landed: (s) => s.backlinks !== null,
  },
];

describe('面の走査は、飛んでいる書込を追い越さない', () => {
  for (const { name, op, ask, landed } of GATES) {
    it(`🔴 ${name}(${op})は、保存が着地するまで走らない`, async () => {
      const { d, order, g, before } = await setup();
      d.dispatch(ask);
      await flush();
      expect(order, `${name} が保存を追い越した(保存前の DB を集めている)`).toEqual(before);

      g.open();
      await flush();
      expect(order, `${name} が走っていない`).toEqual([...before, 'write', op]);
      // 🔑 **答えが画面まで届いたか**(走っただけで捨てている、を作らない)
      expect(landed(d.getState()), `${name} の答えが state に入っていない`).toBe(true);
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

  /**
   * 🔴 **逆向きの門**(着地前レビュー M1)。打鍵で走るものまで列の後ろへ回すと、
   * 1 文字打つたびに全文検索が保存の後ろへ並び、`settled()` を待つ「編集」が固まる。
   * ⚠ 上の 6 件は「後ろへ回すこと」しか主張していないので、これが無いと
   *   **何でも回す**実装が素通りする(tripwire は上限だけでなく下限も置く)。
   */
  it('🔴 左の列の絞り込みは、飛んでいる書込を待たずにその場で走る', async () => {
    const { d, order, g, before } = await setup();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'あ' });
    await flush();
    expect(order, '検索が保存の後ろへ回された(打鍵ごとに固まる)').toEqual([
      ...before,
      'searchEntries',
    ]);
    g.open();
    await flush();
  });

  /**
   * 🔴 **解いた後は走らない**(着地前レビュー M2)。⚠ 見ないと、タブを閉じる /
   * 本体へ昇格する途中で走査が走り、死んだ dispatcher へ答えを投げる。
   */
  it('🔴 effects を解いた後は、待っていた走査も走らない', async () => {
    const { d, effects, order, g, before } = await setup();
    d.dispatch({ type: 'REFRESH_TASK_SCAN' });
    effects();
    g.open();
    await flush();
    expect(order, '解いた後に走査が走った').toEqual([...before, 'write']);
  });

  /**
   * 🔴 **同じ走査を積み増さない**(着地前レビュー 2-B)。別タブの書込は 300ms 束ねで
   * `SYS_BOOTED` を撃ち、そこで予定・連絡先・集計を毎回頼み直す ── 畳まないと
   * **全件走査が秒に何本も**飛ぶ。⚠ 走り出したら鍵は外す(次の 1 本は積める)。
   */
  it('🔴 同じ走査を 5 回頼んでも、待っている間は 1 本にまとまる', async () => {
    const { d, order, g, before } = await setup();
    for (let i = 0; i < 5; i += 1) d.dispatch({ type: 'REFRESH_TASK_SCAN' });
    g.open();
    await flush();
    expect(order, '待っている間の依頼が畳まれていない').toEqual([...before, 'write', 'taskScan']);
    // ⚠ 走り終えた後は、次の 1 本が積める(畳んだまま二度と走らない、を作らない)
    d.dispatch({ type: 'REFRESH_TASK_SCAN' });
    await flush();
    expect(order, '2 本目が積めない(鍵を外していない)').toEqual([
      ...before,
      'write',
      'taskScan',
      'taskScan',
    ]);
  });
});
