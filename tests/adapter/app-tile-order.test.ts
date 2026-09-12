/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリのタイルを並べ替える**(#857 段①)── **disk に何が書かれたか**まで見る。
 *
 * ⚠ 計画そのもの(どこへ入るか)は `tests/features/tile-order.test.ts`。
 *   ここが見るのは **①画面が先に動くか ②書けるか ③断りが声に出るか** の 3 つ。
 * ⚠ 掴めるか(`draggable` / 上半分・下半分)は実ブラウザにしか無い層である。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import type { LauncherTile } from '../../src/features/launcher/tiles';

const tick = (ms = 20): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 添付の body。`order` / `group` は書いてあるときだけ行を作る。 */
function body(name: string, order?: number, group?: string): string {
  const lines = [
    `attachment.name: ${name}`,
    'attachment.mime: text/html',
    'attachment.asset_key: k',
    'attachment.registered_as_app: true',
  ];
  if (order !== undefined) lines.push(`attachment.app_order: ${String(order)}`);
  if (group !== undefined) lines.push(`attachment.app_group: ${group}`);
  return `---\n${lines.join('\n')}\n---\n説明\n`;
}

interface Harness {
  d: Dispatcher;
  bodies: Record<string, string>;
  readonly writes: number;
  readonly writeLids: string[];
  tiles(): LauncherTile[];
}

function setup(
  initial: Record<string, string>,
  opts: { conflictOn?: string } = {},
): Harness {
  const bodies: Record<string, string> = { ...initial };
  const writeLids: string[] = [];
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    getBodies: async (lids) =>
      lids.filter((l) => bodies[l] !== undefined).map((l) => ({ lid: l, body: bodies[l]! })),
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      writeLids.push(e.lid);
      // 🔴 **別の窓が書き替えた**を作る(`expectHash` の断りを見るため)
      if (opts.conflictOn === e.lid) return { ...stubStamps(), conflict: true };
      bodies[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(initial).map((lid) => meta(lid, lid)),
    relations: [],
  });
  d.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
  return {
    d,
    bodies,
    get writes() {
      return writeLids.length;
    },
    get writeLids() {
      return writeLids;
    },
    tiles: () =>
      (d.getState().launcherTiles ?? []).filter((t) => !t.lid.startsWith('builtin:')),
  };
}

/** frontmatter から並び順を読む。⚠ 行が無ければ `undefined`。 */
const orderOf = (b: string): unknown => parseFrontmatter(b).meta['attachment.app_order'];
const groupOf = (b: string): unknown => parseFrontmatter(b).meta['attachment.app_group'];

describe('掴んで落とすと、その順で disk に書かれる', () => {
  const three = { a: body('a.html', 0), b: body('b.html', 1), c: body('c.html', 2) };

  it('🔴 いちばん下を先頭へ落とすと、3 件とも書き替わる', async () => {
    const h = setup(three);
    await tick();
    expect(h.tiles().map((t) => t.lid), '前提が崩れている').toEqual(['a', 'b', 'c']);

    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', before: 'a' },
    });
    // 🔴 **画面は先に動く**(disk の往復を待たない)
    expect(h.tiles().map((t) => t.lid), '掴んだ手を離しても画面が動かない').toEqual([
      'c',
      'a',
      'b',
    ]);
    await tick(40);
    expect(orderOf(h.bodies.c!)).toBe(0);
    expect(orderOf(h.bodies.a!)).toBe(1);
    expect(orderOf(h.bodies.b!)).toBe(2);
    // 🔑 数は**文字列ではなく数**で書く ── 文字列だと `tileFrom` が読まず、
    //    **書けたのに並ばない**(いちばん気づけない壊れ方)
    expect(typeof parseFrontmatter(h.bodies.c!).meta['attachment.app_order']).toBe('number');
  });

  it('🔴 読み直したあとも同じ並び(画面と disk が食い違わない)', async () => {
    const h = setup(three);
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', before: 'a' },
    });
    await tick(40);
    expect(h.tiles().map((t) => t.lid)).toEqual(['c', 'a', 'b']);
  });

  it('⚠ 元の位置へ落とし戻したら、1 件も書かない', async () => {
    const h = setup(three);
    await tick();
    const before = h.writes;
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'b',
      target: { kind: 'edge', group: '', before: 'c' },
    });
    await tick(40);
    expect(h.writes - before, '触っていないノートまで書いた').toBe(0);
  });

  it('🔴 群をまたぐと、群の行も書き替わる(user 裁定「またげる」)', async () => {
    const h = setup({ a: body('a.html', 0), x: body('x.html', 0, '仕事') });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'a',
      target: { kind: 'edge', group: '仕事', before: null },
    });
    await tick(40);
    expect(groupOf(h.bodies.a!), '群が書き替わっていない(落とせて効かない)').toBe('仕事');
    expect(h.tiles().map((t) => [t.lid, t.group])).toEqual([
      ['x', '仕事'],
      ['a', '仕事'],
    ]);
  });

  it('🔴 既定の群へ戻すと、群の行は**消える**(既定値で frontmatter を埋めない)', async () => {
    const h = setup({ a: body('a.html', 0), x: body('x.html', 0, '仕事') });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'x',
      target: { kind: 'edge', group: '', before: 'a' },
    });
    await tick(40);
    expect(h.bodies.x, 'グループの行が残っている').not.toContain('app_group');
  });
});

describe('上へ / 下へ(掴めない人の道)', () => {
  it('🔴 1 つ下へ動く', async () => {
    const h = setup({ a: body('a.html', 0), b: body('b.html', 1) });
    await tick();
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: 1 } });
    await tick(40);
    expect(h.tiles().map((t) => t.lid)).toEqual(['b', 'a']);
  });

  it('⚠ 端では何も起きない(理由も出さない ── 断りではない)', async () => {
    const h = setup({ a: body('a.html', 0), b: body('b.html', 1) });
    await tick();
    const before = h.writes;
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: -1 } });
    await tick(40);
    expect(h.writes - before).toBe(0);
    expect(h.d.getState().error, '端で断り文が出た').toBeNull();
  });
});

describe('断るときは理由を出す(無言の操作拒否を作らない)', () => {
  it('🔴 組み込みは並べ替えられない、と言う', async () => {
    const h = setup({ a: body('a.html', 0) });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'builtin:dual',
      target: { kind: 'step', by: -1 },
    });
    expect(h.d.getState().error).toContain('最初から入っているアプリ');
  });

  it('🔴 編集中は断る(黙って元へ戻さない)', async () => {
    const h = setup({ a: body('a.html', 0), b: body('b.html', 1) });
    await tick();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    h.d.dispatch({ type: 'START_EDIT' });
    // ⚠ 空振り防止 ── 編集に入れていなければ、この test は何も見ていない
    expect(h.d.getState().phase, '編集に入れていない(前提が崩れている)').toBe('editing');
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: 1 } });
    expect(h.d.getState().error).toContain('編集を終えてから');
    expect(h.tiles().map((t) => t.lid), '断ったのに画面だけ動いた').toEqual(['a', 'b']);
  });

  /**
   * 🔴 **書けなかった回も、必ず読み直す。**
   * ⚠ 画面は楽観で動かしてあるので、読み直さないと**画面と disk が食い違ったまま残る**
   *   ── user には「並べ替えた」ように見えて、次に開くと戻っている。
   */
  it('🔴 別のウィンドウが書き替えていたら断り、画面を disk へ戻す', async () => {
    const h = setup({ a: body('a.html', 0), b: body('b.html', 1), c: body('c.html', 2) }, {
      conflictOn: 'c',
    });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', before: 'a' },
    });
    expect(h.tiles().map((t) => t.lid), '楽観で動いていない(前提が崩れている)').toEqual([
      'c',
      'a',
      'b',
    ]);
    await tick(60);
    expect(h.d.getState().error).toContain('並べ替えを保存できませんでした');
    expect(h.tiles().map((t) => t.lid), 'disk へ戻していない').toEqual(['a', 'b', 'c']);
  });
});

describe('ロックは 1 回だけ解く', () => {
  it('🔴 並べ替えが終われば、また編集にも並べ替えにも入れる', async () => {
    const h = setup({ a: body('a.html', 0), b: body('b.html', 1) });
    await tick();
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: 1 } });
    // ⚠ 飛んでいる間は次を受けない(理由つき)
    expect(h.d.getState().tileWrite, '書込を数えていない').not.toBeNull();
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: -1 } });
    expect(h.d.getState().error).toContain('いま並べ替えを保存しています');
    await tick(60);
    expect(h.d.getState().tileWrite, 'ロックが解けていない(二度と並べ替えられない)').toBeNull();
    // 🔑 対照群 ── 解けたら次が通る
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: -1 } });
    await tick(60);
    expect(h.tiles().map((t) => t.lid)).toEqual(['a', 'b']);
  });
});
