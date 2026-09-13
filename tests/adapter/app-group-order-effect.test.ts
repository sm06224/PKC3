/** @vitest-environment happy-dom */
/**
 * 🔴 **`REQUEST_APP_GROUP_ORDER` を実際に動かす**(#857 段③、変異試験 20 件中 4 件が
 * SURVIVED だった穴を塞ぐ)。
 *
 * ⚠ 4 件はどれも「検査が弱い」のではなく、**`store-effects.ts` の
 *   `REQUEST_APP_GROUP_ORDER` ハンドラを動かす test が 1 本も無い**ために
 *   生き延びていた(CLAUDE.md §2「経路が一度も通っていない」):
 *   M3(`appGroupOrdersOf` の先勝ち)/ M4(`order: null` の削除経路)/
 *   M19(`expectHash` の突き合わせ)/ M20(在るノートの使い回し)。
 *
 * 🔑 event を直接撃つ口が無い(`Dispatcher.dispatch` は `Dispatchable` =
 *   `UserAction | SystemCommand` しか受けず、`REQUEST_APP_GROUP_ORDER` は
 *   `DomainEvent` である)── だから `onEvent` の listener を横取りして直に呼ぶ
 *   (`tests/adapter/app-tile-order.test.ts` が `dispatch` を横取りするのと同じ作法)。
 *   ⚠ reducer 側(`MOVE_APP_GROUP` / `RESET_APP_GROUP_ORDER`)は別 test が見るので、
 *   ここは **store-effects.ts 自身の振る舞い**だけを切り出す。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher, type EventListener } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import type { EntryStamps, EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';
import {
  APP_GROUP_ARCHETYPE,
  appGroupSeed,
  readAppGroupOrder,
  writeAppGroupOrder,
} from '../../src/features/launcher/app-group-spec';

const tick = (ms = 30): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** `REQUEST_APP_GROUP_ORDER` の 1 行(app-state.ts の event と同じ形)。 */
interface OrderRow {
  name: string;
  order: number | null;
  lid: string;
  title: string;
  archetype: string;
  entryOrder: number;
}

function orderRow(over: Partial<OrderRow> & { lid: string }): OrderRow {
  return {
    lid: over.lid,
    name: over.name ?? over.lid,
    order: over.order ?? null,
    title: over.title ?? over.lid,
    archetype: over.archetype ?? APP_GROUP_ARCHETYPE,
    entryOrder: over.entryOrder ?? 1,
  };
}

/** `persistEntry` へ実際に渡った引数(呼ばれた回数と中身の両方を見る)。 */
interface PersistCall {
  lid: string;
  title: string;
  archetype: string;
  entryOrder: number;
  body: string;
  expectHash: string | undefined;
}

interface Harness {
  d: Dispatcher;
  bodies: Record<string, string>;
  calls: PersistCall[];
  /** `store-effects.ts` の `onEvent` listener を直に撃つ。 */
  fire(ev: DomainEvent): void;
}

/**
 * ⚠ **stub は本物の意味論を真似る**(CLAUDE.md §3。`app-tile-order.test.ts` と
 *   同じ作法)── `conflictOn` の lid は、**`persistEntry` が呼ばれた瞬間に別窓が
 *   書き足す** ことにする。これで「読んでから書くまでの間に食い違った」という
 *   `expectHash` の唯一の発火条件を、推測ではなく実際に作れる。
 */
function setup(initial: Record<string, string>, opts: { conflictOn?: string } = {}): Harness {
  const bodies: Record<string, string> = { ...initial };
  const calls: PersistCall[] = [];
  const bumped = new Set<string>();
  const d = new Dispatcher();

  // 🔑 `onEvent` の listener を横取りする ── これが唯一の「直に撃つ」口になる
  let captured: EventListener | null = null;
  const rawOnEvent = d.onEvent.bind(d);
  d.onEvent = (listener: EventListener): (() => void) => {
    captured = listener;
    return rawOnEvent(listener);
  };

  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid: string) => bodies[lid] ?? null,
    getBodies: async (lids: string[]) =>
      lids.filter((l) => bodies[l] !== undefined).map((l) => ({ lid: l, body: bodies[l]! })),
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    persistEntry: async (
      e: EntryUpsert,
      po?: { expectHash?: string },
    ): Promise<EntryStamps> => {
      if (opts.conflictOn === e.lid && !bumped.has(e.lid)) {
        // ⚠ 別の窓が本文を書き替えた ── 以後、読んだときの hash と食い違う
        bumped.add(e.lid);
        bodies[e.lid] = `${bodies[e.lid] ?? ''}別の窓が足した行\n`;
      }
      const now = bodies[e.lid];
      calls.push({
        lid: e.lid,
        title: e.title,
        archetype: e.archetype,
        entryOrder: e.entryOrder,
        body: e.body,
        expectHash: po?.expectHash,
      });
      if (
        po?.expectHash !== undefined &&
        now !== undefined &&
        po.expectHash !== contentHash64Hex(now)
      )
        return { ...stubStamps(), conflict: true };
      bodies[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });

  return {
    d,
    bodies,
    calls,
    fire: (ev) => captured!(ev),
  };
}

describe('① 番号がノートに書かれる', () => {
  it('🔴 `appgroup.order` が本文に入る(persistEntry が row.lid へ書く。M20 も兼ねる)', async () => {
    const h = setup({ g1: appGroupSeed('仕事') });
    // 前提: まだ番号は無い(ゼロ件次元を作らない)
    expect(readAppGroupOrder(h.bodies.g1!), '前提が崩れている(既に番号がある)').toBeUndefined();

    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [orderRow({ lid: 'g1', name: '仕事', title: '仕事', order: 5 })],
    });
    await tick();

    // 空振り防止: 本当に persistEntry が呼ばれたか
    expect(h.calls, '書込が 1 度も走っていない').toHaveLength(1);
    // 🔴 M20: 渡された行の lid(既存ノート)へ書く ── 別の lid を作らない
    expect(h.calls[0]!.lid, '既存ノートの lid を使い回していない').toBe('g1');
    expect(h.calls[0]!.title).toBe('仕事');
    expect(readAppGroupOrder(h.bodies.g1!), '番号が本文に反映されていない').toBe(5);
  });

  it('🔴 変わらない番号は書かない(no-op で persistEntry を呼ばない)', async () => {
    const h = setup({ g1: writeAppGroupOrder(appGroupSeed('仕事'), 5) });
    expect(readAppGroupOrder(h.bodies.g1!), '前提が崩れている').toBe(5);

    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [orderRow({ lid: 'g1', name: '仕事', title: '仕事', order: 5 })],
    });
    await tick();

    expect(h.calls, '変わっていないのに書き込んだ').toHaveLength(0);
  });
});

describe('② `order: null` で番号の行が消える(M4)', () => {
  it('🔴 `writeAppGroupOrder(body, null)` の削除経路を実際に通す', async () => {
    const h = setup({ g1: writeAppGroupOrder(appGroupSeed('仕事'), 5) });
    // 前提: 番号が在ることを実測してから消す(消える先が既に無いと「消えた」と言えない)
    expect(readAppGroupOrder(h.bodies.g1!), '前提が崩れている(消す番号が無い)').toBe(5);

    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [orderRow({ lid: 'g1', name: '仕事', title: '仕事', order: null })],
    });
    await tick();

    expect(h.calls, '削除の書込が走っていない(前提が崩れている)').toHaveLength(1);
    expect(readAppGroupOrder(h.bodies.g1!), '番号の行が消えていない').toBeUndefined();
    // ⚠ 目印の key(appgroup.icon)まで一緒に消してはいけない ── 別の鍵である
    expect(h.bodies.g1, '無関係な key まで消えた').toContain('appgroup.icon');
  });
});

describe('③ 同じ名前のノートが 2 枚あるときは先勝ち(M3)', () => {
  it('🔴 `appGroupOrdersOf` は event の並びの最初を採る', async () => {
    const h = setup({
      dup1: writeAppGroupOrder(appGroupSeed('仕事'), 1),
      dup2: writeAppGroupOrder(appGroupSeed('仕事'), 99),
    });
    // 前提: 2 枚が異なる番号を持つ(同じ値だと先勝ちか後勝ちか区別できない)
    expect(readAppGroupOrder(h.bodies.dup1!)).toBe(1);
    expect(readAppGroupOrder(h.bodies.dup2!)).toBe(99);

    h.fire({
      type: 'REQUEST_APP_GROUP_NOTES',
      entries: [
        { lid: 'dup1', title: '仕事' },
        { lid: 'dup2', title: '仕事' },
      ],
    });
    await tick();

    // 空振り防止: 読み出し自体が届いているか
    expect(
      Object.prototype.hasOwnProperty.call(h.d.getState().appGroupOrders, '仕事'),
      '読み出しが state に届いていない(前提が崩れている)',
    ).toBe(true);
    expect(h.d.getState().appGroupOrders['仕事'], '後勝ちになっている(先勝ちを守っていない').toBe(
      1,
    );
  });
});

describe('④ 別の窓が先に書いていたら expectHash で弾き、途中で止める(M19)', () => {
  it('🔴 2 行目で衝突すると、3 行目は 1 度も試みない', async () => {
    const h = setup(
      {
        g1: appGroupSeed('A'),
        g2: appGroupSeed('B'),
        g3: appGroupSeed('C'),
      },
      { conflictOn: 'g2' },
    );

    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [
        orderRow({ lid: 'g1', name: 'A', title: 'A', order: 1, entryOrder: 1 }),
        orderRow({ lid: 'g2', name: 'B', title: 'B', order: 2, entryOrder: 2 }),
        orderRow({ lid: 'g3', name: 'C', title: 'C', order: 3, entryOrder: 3 }),
      ],
    });
    await tick(60);

    // 🔴 1 行目は通り、2 行目で衝突する ── 「途中まで書けた状態」を実際に作る
    expect(h.calls.map((c) => c.lid), '衝突後も進み続けた(門が無い)').toEqual(['g1', 'g2']);
    expect(readAppGroupOrder(h.bodies.g1!), '1 行目が書けていない(前提が崩れている)').toBe(1);
    // ⚠ `expectHash` を外す変異は、この行を「持たない」形にしてしまう
    expect(h.calls[1]!.expectHash, 'expectHash を渡していない(M19 が生きている)').toBeDefined();
    expect(readAppGroupOrder(h.bodies.g3!), '3 行目まで書いてしまった').toBeUndefined();
    expect(h.d.getState().error).toContain(
      '別のウィンドウがグループのノートを書き替えたため、並べ替えを最後まで保存できませんでした',
    );
  });
});

describe('⑤ 在るノートは使い回す(M20)', () => {
  it('🔴 2 件を渡すと、それぞれ自分の lid へ書く(取り違えない)', async () => {
    const h = setup({
      alpha: appGroupSeed('AAA'),
      beta: appGroupSeed('BBB'),
    });

    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [
        orderRow({ lid: 'alpha', name: 'AAA', title: 'AAA', order: 10, entryOrder: 1 }),
        orderRow({ lid: 'beta', name: 'BBB', title: 'BBB', order: 20, entryOrder: 2 }),
      ],
    });
    await tick();

    expect(h.calls.map((c) => c.lid).sort(), '書込先の lid が取り違えられている').toEqual([
      'alpha',
      'beta',
    ]);
    // ⚠ 取り違え(alpha に 20 / beta に 10)が起きていないことまで見る
    expect(readAppGroupOrder(h.bodies.alpha!)).toBe(10);
    expect(readAppGroupOrder(h.bodies.beta!)).toBe(20);
  });
});

describe('⑥ 書いたあとに読み直す ── APP_GROUP_NOTES_LOADED が disk の実値を返す', () => {
  it('🔴 成功した回は、書いた値がそのまま返る', async () => {
    const h = setup({ g1: appGroupSeed('仕事') });

    // ⚠ 実物(reducer)と同じく、書込 event の直後に読み直し event を同じ tick で撃つ
    // ── `enqueue` の直列化を、実際に 2 つの event で確かめる。
    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [orderRow({ lid: 'g1', name: '仕事', title: '仕事', order: 7 })],
    });
    h.fire({
      type: 'REQUEST_APP_GROUP_NOTES',
      entries: [{ lid: 'g1', title: '仕事' }],
    });
    await tick(60);

    expect(h.d.getState().appGroupOrders['仕事'], '書込の後ろで読み直せていない').toBe(7);
  });

  it('🔴 衝突した回でも、disk の実値(書けなかった事実)へ戻る', async () => {
    const h = setup(
      { g1: appGroupSeed('A'), g2: appGroupSeed('B') },
      { conflictOn: 'g2' },
    );

    h.fire({
      type: 'REQUEST_APP_GROUP_ORDER',
      rows: [
        orderRow({ lid: 'g1', name: 'A', title: 'A', order: 1, entryOrder: 1 }),
        orderRow({ lid: 'g2', name: 'B', title: 'B', order: 2, entryOrder: 2 }),
      ],
    });
    h.fire({
      type: 'REQUEST_APP_GROUP_NOTES',
      entries: [
        { lid: 'g1', title: 'A' },
        { lid: 'g2', title: 'B' },
      ],
    });
    await tick(60);

    const orders = h.d.getState().appGroupOrders;
    expect(orders['A'], '書けた側が読み直しに反映されていない').toBe(1);
    // 🔴 B は衝突で 1 バイトも書けていない ── 「狙いの 2」ではなく「無い」が正しい
    expect(
      Object.prototype.hasOwnProperty.call(orders, 'B'),
      '書けなかったのに、狙った値が state に入っている',
    ).toBe(false);
  });
});
