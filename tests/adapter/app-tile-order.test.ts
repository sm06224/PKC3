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
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';

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
  /** ロックを解く ack の数(**ちょうど 1 回**であること)。 */
  readonly acks: number;
  tiles(): LauncherTile[];
}

function setup(
  initial: Record<string, string>,
  /**
   * ⚠ **effect の出口は 4 つ**(正常 / 見つからない / 衝突 / 例外)── 台が 1 つしか
   *   作れないと、残り 3 つは**一度も走らない**(§2)。
   */
  opts: { conflictOn?: string; missingOn?: string; throwOn?: string } = {},
): Harness {
  const bodies: Record<string, string> = { ...initial };
  const writeLids: string[] = [];
  const d = new Dispatcher();
  /**
   * 🔴 **ロックを解く ack の回数を数える**(着地前レビュー ⚠9)。
   * ⚠ `tileWrite.n` は 1 なので、2 回解いても `null` のままで**差が見えない** ──
   *   しかも余分な ack は**別の lid の書込の計数を 1 減らす**(P8 段㉕ の事故の形)。
   */
  const acks: string[] = [];
  // ⚠ 包むのは **effects を繋ぐ前** ── 繋いだ後だと effect が握った参照が素のままになる
  const raw = d.dispatch.bind(d);
  d.dispatch = (a): void => {
    if ((a as { type?: string }).type === 'APP_TILE_SAVED') acks.push('x');
    raw(a);
  };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => {
      if (opts.missingOn === lid) return null;
      if (opts.throwOn === lid) throw new Error('worker が落ちた');
      return bodies[lid] ?? null;
    },
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
    get acks() {
      return acks.length;
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
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
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

  /**
   * 🔴 **disk から読み直した並びが同じ**(着地前レビュー ⚠11)。
   *
   * ⚠ 「書いた後に `tiles()` を見る」だけでは**楽観更新をもう一度見ているだけ**で、
   *   読み直しを丸ごと消しても緑になる。🔑 だから **一覧を捨ててから読み直させる** ──
   *   `REFRESH_LAUNCHER_TILES` は disk の本文からタイルを組み直すので、
   *   ここで同じ並びが返れば「frontmatter に本当に書けている」と言える。
   */
  it('🔴 disk から組み直しても同じ並び(画面と disk が食い違わない)', async () => {
    const h = setup(three);
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
    });
    await tick(40);
    h.d.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    await tick(40);
    expect(h.tiles().map((t) => t.lid), 'disk から組み直すと並びが違う').toEqual(['c', 'a', 'b']);
  });

  it('⚠ 元の位置へ落とし戻したら、1 件も書かない', async () => {
    const h = setup(three);
    await tick();
    const before = h.writes;
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'b',
      target: { kind: 'edge', group: '', anchor: 'c', edge: 'before' },
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
      target: { kind: 'edge', group: '仕事', anchor: 'x', edge: 'after' },
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
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
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
    expect(h.writes - before, '端なのに disk へ書いた').toBe(0);
    /**
     * 🔴 **端では理由を言う**(動線レビュー D2、2026-09-12 に直した)。
     * ⚠ 1 稿目は「何も起きない・理由も出さない」を pin していたが、それは
     *   **無言の dead click** である(押しても画面も言葉も 1 つも動かない)──
     *   フォルダの帯は同じ場面で押せなくして「すでに先頭です」と出している。
     */
    expect(h.d.getState().error).toContain('すでにこのまとまりのいちばん上です');
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
    /**
     * 🔑 断り文の出どころは `phaseBlockReason` **1 本**である(§7)──
     * ⚠ 1 稿目はここで `phase !== 'ready'` を一律に「編集を終えてから」と
     *   読み替えていた。`phase` には `error`(保存に失敗したときの保護)も
     *   `initializing` も在るので、**編集していない人に編集を探させる**嘘になる。
     */
    expect(h.d.getState().error).toBe('編集を終了してから並べ替えられます');
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
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
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

describe('途中で止まったとき(着地前レビュー 🔴3 / ⚠10)', () => {
  const three = { a: body('a.html', 0), b: body('b.html', 1), c: body('c.html', 2) };

  /**
   * 🔴 **2 行目で衝突すると、1 行目は既に書かれている。**
   * ⚠ 1 稿目の test は計画の**1 行目**で衝突させていたので、「元へ戻る」が
   *   **自明に成り立っていた** ── 守れていたのは「1 件も書く前に止まった回」だけ。
   * 🔑 ここが pin するのは**部分適用が起きること**そのものである(直すには
   *   worker の 1 tx が要る)。⚠ だから断り文は「**途中まで**」と言わねばならない。
   */
  it('🔴 2 行目で衝突すると、並びは元でも狙いでもない ── そう言う', async () => {
    const h = setup(three, { conflictOn: 'a' });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
    });
    await tick(60);
    // ⚠ `c` は書けている(計画の 1 行目)── 元(a b c)にも狙い(c a b)にも戻らない
    expect(orderOf(h.bodies.c!), '1 行目が書かれていない(前提が崩れている)').toBe(0);
    expect(h.d.getState().error, '「保存できませんでした」と言うと user は無傷だと読む')
      .toContain('途中までしか保存できませんでした');
    expect(h.d.getState().error).toContain('1 件');
    /**
     * 🔑 読み直しているので、画面は **disk の姿**になる ── 元(a b c)でも
     *   狙い(c a b)でもない **第 3 の並び**である。
     * ⚠ disk は `a:0`(衝突で書けず)/ `b:1`(そこまで届かず)/ `c:0`(書けた)なので、
     *   0 番が 2 つ並び、同点は元の順で割れて **a c b** になる。
     */
    expect(h.tiles().map((t) => t.lid), '部分適用が起きていない(前提が崩れている)').toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('🔴 ノートが見つからない回も、理由を言ってロックを解く', async () => {
    const h = setup(three, { missingOn: 'c' });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
    });
    await tick(60);
    expect(h.d.getState().error).toContain('ノートが見つかりません');
    expect(h.d.getState().tileWrite, 'ロックが解けていない').toBeNull();
    expect(h.writes, '見つからないのに書いた').toBe(0);
  });

  it('🔴 worker が落ちた回も、理由を言ってロックを解く', async () => {
    const h = setup(three, { throwOn: 'c' });
    await tick();
    h.d.dispatch({
      type: 'MOVE_APP_TILE',
      lid: 'c',
      target: { kind: 'edge', group: '', anchor: 'a', edge: 'before' },
    });
    await tick(60);
    expect(h.d.getState().error).toContain('並べ替えを保存できませんでした');
    expect(h.d.getState().tileWrite, 'ロックが解けていない').toBeNull();
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
    /**
     * 🔴 **解く ack は ちょうど 1 回**(着地前レビュー ⚠9)。
     * ⚠ `tileWrite.n` は 1 なので、2 回解いても `null` のままで**差が見えない** ──
     *   ところが余分な ack は**別の lid の書込の計数を 1 減らす**ので、
     *   飛んでいる書込があるのに編集へ入れてしまう(P8 段㉕ で実際に起きた形)。
     * 🔑 だから**数を見る**。
     */
    expect(h.acks, 'ロックを解く ack が 1 回ではない').toBe(1);
    // 🔑 対照群 ── 解けたら次が通る
    h.d.dispatch({ type: 'MOVE_APP_TILE', lid: 'a', target: { kind: 'step', by: -1 } });
    await tick(60);
    expect(h.tiles().map((t) => t.lid)).toEqual(['a', 'b']);
  });
});

/**
 * 🔴 **掴める口そのものを等値で pin する**(着地前レビュー 🔴1)。
 *
 * ⚠ `draggable` と `data-pkc-tile-group` の 2 つは、**3 つの入口すべての鍵**である
 *   (掴む / 落とし先を決める / 右クリックのメニューを出す)。⚠ 1 稿目はこの 2 つに
 *   検査が 1 件も無く、**`draggable` の行を消しても 9645 件すべて緑**だった。
 * 🔑 実ブラウザ側は `tests/smoke/launcher.smoke.spec.ts` が見る(上半分 / 下半分は
 *   採寸にしか無い層)── ここが見るのは**属性が出ているか**だけである。
 */
describe('掴める口が出ている(#857 段①)', () => {
  function paint(over: {
    tiles?: Array<Record<string, unknown>>;
    query?: string;
  } = {}): HTMLElement {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new LauncherRenderer(region);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    d.dispatch({
      type: 'LAUNCHER_TILES_LOADED',
      tiles: withBuiltinTiles(
        (over.tiles ?? [
          { lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/' },
          { lid: 'a2', title: '地図', group: '', kind: 'url', url: 'https://b.test/' },
        ]) as unknown as LauncherTile[],
        { office: false },
      ),
    } as never);
    if (over.query !== undefined) d.dispatch({ type: 'SET_ENTRY_FILTER', query: over.query });
    r.render(d.getState());
    return region;
  }

  it('🔴 自分のタイルは掴めて、群は落とし先になる', () => {
    const region = paint();
    expect(
      region.querySelector('[data-pkc-tile="a1"]')?.getAttribute('draggable'),
      '掴めない(掴む道も右クリックの道も、この属性が鍵)',
    ).toBe('true');
    expect(
      region.querySelector('[data-pkc-region="launcher-grid"]')?.getAttribute('data-pkc-tile-group'),
      '群の名前が出ていない(落とし先が決まらない)',
    ).toBe('');
  });

  it('🔴 組み込みは掴めない(entry を持たない ── 並び順を書く先が無い)', () => {
    const region = paint();
    expect(region.querySelector('[data-pkc-tile="builtin:dual"]')?.getAttribute('draggable')).toBeNull();
  });

  /**
   * 🔴 **絞り込んでいる間は掴ませない**(動線レビュー D3)。
   * ⚠ 画面は絞った一覧、並び順の正本は全件なので、隠れた 1 枚をまたぐ移動になる
   *   ──「上へ」を押しても画面が 1 ドットも動かないのに disk は書き替わる。
   */
  it('🔴 絞り込んでいる間は掴めない(勧めてから断らない)', () => {
    const region = paint({ query: '電' });
    // ⚠ 空振り防止 ── 絞れていなければ、この検査は何も見ていない
    expect(region.querySelectorAll('[data-pkc-tile]').length, '絞り込みが効いていない').toBe(1);
    expect(
      region.querySelector('[data-pkc-tile="a1"]')?.getAttribute('draggable'),
      '絞り込み中なのに掴める(落としても狙いと違う所へ着く)',
    ).toBeNull();
    expect(
      region.querySelector('[data-pkc-region="launcher-grid"]')?.getAttribute('data-pkc-tile-group'),
      '絞り込み中なのに落とし先になっている',
    ).toBeNull();
  });
});
