/** @vitest-environment happy-dom */
/**
 * P8 段⑭: **PKC3 の中からタイルを作る**。
 *
 * > user 報告 2026-08-03「**ランチャーの設定導線が消えた**」
 *
 * 🔴 タイルの元データ(`registered_as_app` / `app_group` / `app_icon`)は添付の
 * frontmatter に在るのに、PKC3 には**書く手段が 1 つも無かった** ── binder の
 * action 表にランチャー関連は起動(`open-tile`)だけで、`UserAction` 型にも
 * 添付メタを書くものが無い。PKC2 から取り込んだ user だけがタイルを持てた。
 *
 * ⚠ 観測点は「action が dispatch された」で止めない ── **disk に何が書かれ、
 * ランチャーが読み直したか**まで見る(押しても次にタブを開くまで出ない、を落とす)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import type { LauncherTile } from '../../src/features/launcher/tiles';

const tick = (ms = 10): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

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
  };
}

const BASE = '---\nattachment.name: a.html\nattachment.mime: text/html\nattachment.asset_key: k\n---\n説明\n';

function setup(
  initial = BASE,
  /** ⚠ **ack のあとの読み直しだけ**を落とす(段㉕ の観測点)。 */
  opts: { failGetBodies?: boolean } = {},
): {
  d: Dispatcher;
  bodies: Record<string, string>;
  writes: number;
} {
  const bodies: Record<string, string> = { a1: initial };
  const counter = { writes: 0 };
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    getBodies: async (lids) => {
      if (opts.failGetBodies) throw new Error('worker が落ちた');
      return lids.filter((l) => bodies[l] !== undefined).map((l) => ({ lid: l, body: bodies[l]! }));
    },
    persistEntry: async (e) => {
      counter.writes += 1;
      bodies[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1', 'メモ帳')], relations: [] });
  return {
    d,
    bodies,
    get writes() {
      return counter.writes;
    },
  };
}

/**
 * entry 由来のタイルだけ(#241 で**組み込みの 2 ペイン**が常に 1 枚居るようになった)。
 * ⚠ 素で数えると、組み込みを足し引きするたびにこの file が意味なく落ちる ──
 *   ここが見たいのは「添付の frontmatter がタイルに反映されるか」だけである。
 */
function entryTiles(h: { d: { getState: () => { launcherTiles: readonly LauncherTile[] | null } } }) {
  return (h.d.getState().launcherTiles ?? []).filter((t) => !t.lid.startsWith('builtin:'));
}

describe('タイル設定を書く(P8 段⑭)', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 登録すると frontmatter に 1 行入り、**ランチャーがその場で読み直す**', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    const fm = parseFrontmatter(h.bodies.a1!).meta;
    expect(fm['attachment.registered_as_app']).toBe(true);
    // ⚠ **タイルが出る**ところまで見る(書いただけで画面に出ないのが元の姿)
    /**
     * ⚠ **組み込みタイル(#241 の 2 ペイン)は常に 1 枚居る**ので、
     * ここは **entry 由来だけ**を見る ── 素で数えると、組み込みを足したり
     * 減らしたりするたびにこの test が意味なく落ちる。
     */
    expect(entryTiles(h).map((t) => t.lid)).toEqual(['a1']);
  });

  it('🔴 本文と他の key を**壊さない**(原文 splice)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    const parsed = parseFrontmatter(h.bodies.a1!);
    expect(parsed.body).toBe('説明\n');
    expect(parsed.meta['attachment.asset_key']).toBe('k');
    expect(parsed.meta['attachment.mime']).toBe('text/html');
  });

  it('🔴 登録を外すと **行ごと消える**(`false` を書き置かない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: false });
    await tick(20);
    expect(h.bodies.a1).not.toContain('registered_as_app');
    expect(entryTiles(h), 'entry 由来のタイルが残っている').toEqual([]);
  });

  it('グループと目印が付き、空にすると消える', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', group: '道具', icon: '🧮' });
    await tick(20);
    expect(entryTiles(h)[0]?.group).toBe('道具');
    expect(entryTiles(h)[0]?.icon).toBe('🧮');
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', group: '' });
    await tick(20);
    expect(h.bodies.a1).not.toContain('app_group');
    expect(entryTiles(h)[0]?.group).toBe('');
  });

  it('⚠ 変わらないなら**書かない**(同じ値で disk を叩かない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    const before = h.writes;
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    expect(h.writes).toBe(before);
  });

  it('🔴 **開いている body も差し替わる**(画面が古いまま残らない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    expect(h.d.getState().openBody?.body).toBe(BASE);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(20);
    // ⚠ ここが本丸 ── `BODY_PERSISTED` だけだと `persisted` しか動かず、
    //    「チェックを入れてもグループ欄が出てこない」になる(実測で踏んだ)
    expect(h.d.getState().openBody?.body).toContain('registered_as_app');
    expect(h.d.getState().openBody?.baseline).toBe(h.d.getState().openBody?.body);
  });

  it('⚠ 編集中は開いている body を触らない(打っている draft を潰さない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    h.d.dispatch({ type: 'START_EDIT' });
    h.d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '打ちかけ' });
    h.d.dispatch({ type: 'APP_TILE_SAVED', lid: 'a1', gen: 0, body: 'よそから来た' });
    expect(h.d.getState().openBody?.body).toBe('打ちかけ');
    // 🔴 **draft は守るが、disk が進んだ印は残す**(P8 段⑯)── 印が無いと
    //    無変更 commit / cancel で旧本文が disk を上書きして、書けた設定が消える
    expect(h.d.getState().openBody?.persisted, 'disk の内容を追えていない').toBe('よそから来た');
    expect(h.d.getState().openBody?.diskAhead, 'disk が進んだ印が無い').toBe(true);
  });

  /**
   * 🔴 **disk を観測点にする**(P8 段⑯。レビュー H-1 が実測で再現させた欠陥)。
   *
   * 直す前の実測: 登録にチェック(SET_APP_TILE)→ ack が返る前に編集して保存
   * → disk に着地した `registered_as_app: true` が旧本文の書き戻しで**消えた**。
   * ⚠ 上の test は draft の保全しか見ておらず、**disk を見ていないので緑のまま**
   * だった ── 下流(state)ではなく**最後に disk に何が残ったか**を見る。
   */
  it('🔴 設定を変えた直後に編集して保存しても、disk の設定が消えない', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    // ⚠ **ack を待たずに**編集へ入ろうとする(これが本番で起きる窓)
    h.d.dispatch({ type: 'START_EDIT' });
    await tick(30);
    // 書込中は編集に入れない(ロックが効いている)
    expect(h.d.getState().phase, '書込中なのに編集へ入れてしまう').toBe('ready');
    expect(h.bodies.a1).toContain('registered_as_app');

    // ロックが解けてから編集 → 本文を足して保存
    h.d.dispatch({ type: 'START_EDIT' });
    expect(h.d.getState().phase).toBe('editing');
    h.d.dispatch({
      type: 'UPDATE_OPEN_BODY',
      body: `${h.d.getState().openBody!.body}追記した説明\n`,
    });
    h.d.dispatch({ type: 'COMMIT_EDIT' });
    await tick(30);
    // 🔴 ここが本丸 ── 本文も設定も**両方**残っている
    expect(h.bodies.a1, 'commit で登録が消えた').toContain('registered_as_app');
    expect(h.bodies.a1).toContain('追記した説明');
  });

  it('🔴 続けて設定を変えても**落ちない**(登録 → グループ → 目印)', async () => {
    // ⚠ 書込を `writeLock` で止めると 2 件目以降が**無言で拒否される**
    //    (smoke が実際に落ちた)。タイルの書込どうしは disk を読み直すので安全
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', group: '道具' });
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', icon: '🧮' });
    await tick(40);
    const t = entryTiles(h)[0];
    expect(t?.group, '2 件目が落ちた').toBe('道具');
    expect(t?.icon, '3 件目が落ちた').toBe('🧮');
    expect(h.d.getState().tileWrite, '数え上げが戻っていない').toBeNull();
  });

  it('🔴 タイル設定の書込中は編集に入れない(交錯で disk の設定が消える)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    h.d.dispatch({ type: 'START_EDIT' });
    expect(h.d.getState().phase, '書込中なのに編集へ入れた').toBe('ready');
    await tick(30);
    h.d.dispatch({ type: 'START_EDIT' });
    expect(h.d.getState().phase, '書込が終わっても編集へ入れない').toBe('editing');
  });

  it('⚠ 強制解放でタイル設定の書込も畳む(片方だけ残らない)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    expect(h.d.getState().tileWrite).not.toBeNull();
    h.d.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(h.d.getState().tileWrite, '解放しても編集へ入れないまま').toBeNull();
    await tick(30);
  });

  it('⚠ 書けなかったときも**ロックは解く**(二度と設定を変えられない、を作らない)', async () => {
    const h = setup();
    // 同じ値なので書込は起きない ── それでもロックは残ってはいけない
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: false });
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(30);
    expect(h.d.getState().tileWrite, '数え上げを握ったまま').toBeNull();
  });

  it('🔴 書込が飛んでいる間は受け付けない(読んで書き戻す操作なので片方が消える)', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
    await tick(20);
    // ⚠ **event を数える** ── 「body が変わっていない」だけを見ると、追記も
    //    タイル書込もまだ非同期で走っていないので**何をしても通る**
    //    (実際それで変異が生き残った)。止まったことを直接見る
    const seen: string[] = [];
    const off = h.d.onEvent((e) => seen.push(e.type));
    h.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a1', text: 'x', heading: null });
    expect(h.d.getState().writeLock, 'writeLock が立っていない(前提が崩れた)').not.toBeNull();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    expect(seen.filter((t) => t === 'REQUEST_TILE_UPDATE'), '書込中なのに受け付けた').toEqual([]);
    // 追記が終わってロックが解けたら、今度は通る
    await tick(30);
    expect(h.d.getState().writeLock).toBeNull();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    expect(seen.filter((t) => t === 'REQUEST_TILE_UPDATE'), 'ロックが解けても通らない').toHaveLength(
      1,
    );
    off();
  });

  it('⚠ 知らない lid は何もしない', async () => {
    const h = setup();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'nope', registered: true });
    await tick(20);
    expect(h.writes).toBe(0);
  });
});

/**
 * P8 段㉕: 🔴 **1 要求に ack は 1 回**。
 *
 * 🔴 直す前は「書けた」の ack を撃ったあと、同じ `try` の中で
 * タイルの読み直し(`getBodies`)を続けていた。ここが落ちると catch の
 * `fail()` が **2 回目の `APP_TILE_SAVED`** を撃ち、受け側の計数
 * (`tileWrite.n`)が **1 要求で 2 減る**。
 *
 * 壊れ方: 「グループ」を変えて Tab、続けて「目印」を変えて Tab(n = 2)→
 * 1 本目は成功するが読み直しが失敗する → n が 2→1→0 になり、
 * **2 本目が飛んでいるのに `tileWrite` が null** になる。この隙に編集へ入れて
 * しまい、保存すると 2 本目の書き戻しの上に旧本文が乗って
 * **目印の設定が黙って消える** ── 段⑯ が `tileWrite` を入れて塞いだ H-1 と同型。
 */
describe('タイル設定の ack(段㉕)', () => {
  it('🔴 読み直しが落ちても、書込ロックは 1 回しか解けない', async () => {
    const h = setup(BASE, { failGetBodies: true });
    // 2 本続けて要求する(n = 2 になる)
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', group: '道具' });
    await tick(30);

    // 前提: 2 本とも書けている(この次元が非ゼロ)
    expect(h.writes, '2 本目が書けていない(測れていない)').toBe(2);
    const fm = parseFrontmatter(h.bodies.a1!).meta;
    expect(fm['attachment.registered_as_app']).toBe(true);
    expect(fm['attachment.app_group'], '2 本目の設定が消えている').toBe('道具');
  });

  it('🔴 読み直しの失敗は**その旨**を出す(書込の失敗と混ぜない)', async () => {
    const h = setup(BASE, { failGetBodies: true });
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', registered: true });
    await tick(30);
    expect(h.d.getState().error ?? '', '読み直しの失敗を書込の失敗として出している').toMatch(
      /一覧を読み直せません/,
    );
  });
});
