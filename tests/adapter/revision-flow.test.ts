/** @vitest-environment happy-dom */
/**
 * P5b: 履歴・ゴミ箱の app 層 flow pin。
 * - 刻む縁: 変更ありの commit だけ / fresh 初回は積まない / 無変更は積まない
 * - 復元 = 前進変異(現状を先に積む順序)
 * - trash 復元の lid 衝突は可視ブロック
 * - purge-trash の confirm は fail closed
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { reduce, initialState, type AppState } from '../../src/adapter/state/app-state';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, port: Partial<StorePort> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  // binder は root 配下しか拾わない ── filer region も root 内に置く
  const filerRegion = document.createElement('div');
  root.append(filerRegion);
  const filer = new FilerRenderer(filerRegion);
  d.onState((s) => {
    detail.render(s);
    /**
     * ⚠ **面の切替を harness の都合で借りない**(#241 段⑥-b)。
     * 直す前は `viewMode === 'filer'` を「ファイラを描く合図」に使っていたが、
     * フォルダの面は P8 段⑤ で**左の列**へ移っており、中央の面ではない
     * ── 製品では既定で常に描かれている。合図に使っていた `ViewMode` の値は
     * 死に値だったので畳んだ(この test はその借り物を返しただけ)。
     */
    filer.render(s);
  });
  const log: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    persistEntry: async (e, opts) => {
      // checkpoint = 「変更前の disk body を履歴に刻む」意思(実記録は worker)
      log.push(`persist:${e.lid}:${e.body}${opts?.checkpoint ? ':cp' : ''}`);
      return stubStamps();
    },
    deleteEntry: async () => {
      log.push('delete');
    },
    setEntryParent: async () => {},
    ...port,
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
  return { d, root, log, q };
}

describe('revision flow (P5b)', () => {
  it('変更ありの commit だけが baseline を積む(persist より先)── 無変更・RETRY は積まない', async () => {
    const { d, log } = setup({ e1: '# v1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# v2' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    expect(log).toEqual(['persist:e1:# v2:cp']); // checkpoint 付きで書かれる

    // 無変更 commit は書込自体が出ない
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    expect(log).toHaveLength(1);
  });

  it('fresh(新規作成)の初回 commit は revision を積まない ── seed へ戻す復元先はゴミ', async () => {
    const { d, log } = setup({});
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: 'new' });
    await tick();
    const created = log.length; // CREATE の初回 persist
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 初稿' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    const added = log.slice(created);
    expect(added).toEqual(['persist:n1:# 初稿']); // checkpoint 無し = 刻まない
  });

  it('履歴 panel: SHOW_HISTORY → 一覧描画 → 復元 = 前進変異の順序 + panel 畳み', async () => {
    const { d, log, q } = setup(
      { e1: '# 現在' },
      {
        listRevisionMetas: async () => [
          { id: 'r-9', rev_order: 9, created_at: '2026-08-01', title: '旧題', archetype: 'text' },
        ],
        getRevision: async (revId) =>
          revId === 'r-9' ? { body: '# 復元先', title: '旧題', archetype: 'text' } : null,
      },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'SHOW_HISTORY' });
    await tick();
    expect(d.getState().revisionPanel?.items).toHaveLength(1);
    const panel = q('[data-pkc-field="history-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('#9');

    d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-9' });
    await tick();
    // 前進変異: checkpoint 付きで書く = worker が現状(# 現在)を履歴に積む
    expect(log).toEqual(['persist:e1:# 復元先:cp']);
    const s = d.getState();
    expect(s.openBody?.body).toBe('# 復元先');
    expect(s.entryMetas.get('e1')?.title).toBe('旧題'); // title も戻る
    expect(s.revisionPanel).toBeNull(); // panel は畳む(履歴が 1 件伸びたため)
    expect(q('[data-pkc-field="history-panel"]')).toBeNull();
  });

  it('ゴミ箱: 一覧 → 復元で entry が戻り選択される。lid 衝突は可視ブロック', async () => {
    const { d, log, q } = setup(
      { e1: '# live' },
      {
        listTrash: async () => [
          { id: 'r-t', entry_lid: 'gone1', created_at: '2026-08-01', title: '消した子', archetype: 'todo' },
        ],
        getRevision: async () => ({
          body: '---\nstatus: open\n---\n\nやる',
          title: '消した子',
          archetype: 'todo',
        }),
      },
    );
    d.dispatch({ type: 'SHOW_TRASH' });
    await tick();
    expect(d.getState().trashPanel?.items).toHaveLength(1);
    const region = q('[data-pkc-region="filer-trash"]')!;
    expect(region.textContent).toContain('消した子');

    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'gone1', revId: 'r-t' });
    await tick();
    const s = d.getState();
    expect(log.at(-1)).toContain('persist:gone1');
    expect(s.entryMetas.get('gone1')).toMatchObject({
      title: '消した子',
      archetype: 'todo',
      status: 'open', // 抽出一元化(extractMeta)を通っている
    });
    expect(s.selectedLid).toBe('gone1');
    expect(s.trashPanel?.items).toHaveLength(0); // 復元した行は消える
    expect(s.order).toContain('gone1');

    // lid 衝突(既存 e1)── 黙って上書きしない
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'e1', revId: 'r-t' });
    await tick();
    expect(d.getState().error).toContain('既に存在します');
  });

  it('編集中の着弾・同一 lid: draft 無傷 + diskAhead(無変更 cancel で復元内容が勝つ)', async () => {
    let release: (v: { body: string; title: string | null; archetype: string | null }) => void =
      () => {};
    const { d, log } = setup(
      { e1: '# 現在' },
      {
        getRevision: () =>
          new Promise((r) => {
            release = r;
          }),
      },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-9' });
    await tick(); // effect が getRevision の gate に到達する
    // gate で停止している間に編集開始・打鍵
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 打鍵中の draft' });
    release({ body: '# 復元先', title: null, archetype: 'text' });
    await tick();

    const s = d.getState();
    expect(s.phase).toBe('editing'); // editor は乗っ取られない
    expect(s.openBody?.body).toBe('# 打鍵中の draft'); // draft 無傷(F1 の反例封鎖)
    expect(s.openBody?.diskAhead).toBe(true); // disk 先行の印
    expect(s.openBody?.persisted).toBe('# 復元先');

    // draft を捨てる cancel → disk(復元内容)が勝つ(TODO_TOGGLED と同じ規律)
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(d.getState().openBody?.body).toBe('# 復元先');
    expect(log).toContain('persist:e1:# 復元先:cp'); // disk には復元が済んでいる
  });

  it('編集中の着弾・別 lid(trash 復元): 破棄 ── 選択も editor も動かない', async () => {
    let release: (v: { body: string; title: string | null; archetype: string | null }) => void =
      () => {};
    const { d } = setup(
      { e1: '# live' },
      {
        listTrash: async () => [
          { id: 'r-t', entry_lid: 'gone1', created_at: null, title: 'x', archetype: 'text' },
        ],
        getRevision: () =>
          new Promise((r) => {
            release = r;
          }),
      },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' }); // 先に e1 の body を確立
    await tick();
    d.dispatch({ type: 'SHOW_TRASH' });
    await tick();
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'gone1', revId: 'r-t' });
    await tick(); // effect が gate に到達
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'draft' });
    release({ body: '# 復元', title: 'x', archetype: 'text' });
    await tick();

    const s = d.getState();
    expect(s.selectedLid).toBe('e1'); // 乗っ取りなし
    expect(s.openBody?.body).toBe('draft'); // draft 無傷
    expect(s.entryMetas.has('gone1')).toBe(false); // 着弾は破棄(disk には居る ──
    // 前進変異なので再操作(reload / 再復元)で回収できる)
  });

  it('復元発行 → 即削除: 後着の ENTRY_RESTORED は破棄(幽霊 entry を作らない)', async () => {
    let release: (v: { body: string; title: string | null; archetype: string | null }) => void =
      () => {};
    const { d, log } = setup(
      { e1: '# 現在' },
      {
        getRevision: () =>
          new Promise((r) => {
            release = r;
          }),
      },
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-9' });
    await tick(); // effect が gate に到達
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'e1' }); // 楽観反映で state から消える
    release({ body: '# 復元先', title: null, archetype: 'text' });
    await tick();

    const s = d.getState();
    expect(s.entryMetas.has('e1')).toBe(false); // 幽霊は作らない(F2 の反例封鎖)
    expect(s.selectedLid).toBeNull();
    // disk は queue 直列で「復元 persist → 削除」の順に終わる = 最終状態は削除
    expect(log.at(-1)).toBe('delete');
  });

  it('fresh → rename → 初回 commit は seed revision を積まない(F4)', async () => {
    const { d, log } = setup({});
    d.dispatch({ type: 'CREATE_ENTRY', archetype: 'text', lid: 'n1', title: 'ノート 1' });
    await tick();
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'n1', title: '買い物メモ' }); // fresh 解除
    await tick();
    const before = log.length;
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# 初稿' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    const added = log.slice(before);
    expect(added).toEqual(['persist:n1:# 初稿']); // :cp が付かない = 空 seed を刻まない
  });

  it('SYS_BOOTED: entryOrder の tie は lid 辞書順で安定(F3 の無害化)', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('b2', { entryOrder: 2 }), meta('a2', { entryOrder: 2 }), meta('c1', { entryOrder: 1 })],
      relations: [],
    });
    expect(d.getState().order).toEqual(['c1', 'a2', 'b2']);
  });

  it('purge-trash: confirm 不在は fail closed、承諾で TRASH_PURGED が panel を空にする', async () => {
    let purged = 0;
    const { d, root } = setup(
      {},
      {
        listTrash: async () => [
          { id: 'r-t', entry_lid: 'gone1', created_at: null, title: null, archetype: null },
        ],
        purgeTrash: async () => {
          purged++;
          return { purged: 1 };
        },
      },
    );
    bindActions(root, d);
    d.dispatch({ type: 'SHOW_TRASH' });
    await tick();

    const btn = document.querySelector<HTMLElement>('[data-pkc-action="purge-trash"]')!;
    expect(btn).not.toBeNull();
    btn.click(); // happy-dom に confirm は無い → ?? false → 実行しない
    await tick();
    expect(purged).toBe(0);

    Object.defineProperty(window, 'confirm', { value: () => true, configurable: true });
    btn.click();
    await tick();
    expect(purged).toBe(1);
    expect(d.getState().trashPanel?.items).toHaveLength(0);
  });
});

describe('🔴 ゴミ箱一覧の後着(P8 段⑪ hotfix)', () => {
  it('復元より後に届いた古い一覧で、戻したものが**ゴミ箱に生き返らない**', () => {
    // ⚠ 「ゴミ箱を開く」→「すぐ復元する」の順で、一覧の要求のほうが遅いと起きる。
    // 世代(token)ではなく**導出**で塞ぐ ── ゴミ箱の定義は
    // 「entry が居ない revision」なので、届いた一覧をその場の真実で濾せばよい
    // (どの順で着いても正しい)
    const restored: EntryMeta = {
      lid: 'x',
      title: '戻したノート',
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    };
    const base: AppState = {
      ...initialState,
      phase: 'ready',
      entryMetas: new Map([['x', restored]]),
      order: ['x'],
      trashPanel: { items: [] },
    };
    const { state } = reduce(base, {
      type: 'TRASH_LIST_LOADED',
      items: [
        { revId: 'r1', entryLid: 'x', createdAt: null, title: '戻したノート', archetype: 'text' },
        { revId: 'r2', entryLid: 'y', createdAt: null, title: 'まだゴミ箱', archetype: 'text' },
      ],
    });
    expect(state.trashPanel?.items.map((t) => t.entryLid), '戻したものが生き返った').toEqual(['y']);
  });
});

/**
 * 🔴 **ゴミ箱から戻したら、居場所と並びも戻る**(2026-08-06。user 報告 2-9)。
 *
 * 直す前は 2 つとも失われていた:
 *  ① **親リンク**(フォルダ)── `deleteEntry` は disk の relations を消さないのに、
 *    復元が読み直していなかったので **常駐から永久に消えた**(= フォルダの外に出る)
 *  ② **位置** ── `[...order, lid]` で **末尾に飛んだ**
 *
 * ⚠ 観測点は「entry が戻ったか」ではない ── 戻るのは直す前もそうだった。
 *   **どこに戻ったか**(親リンクと並びの位置)を見る。
 */
describe('ゴミ箱からの復元: 居場所と並びが戻る', () => {
  const rel = (id: string, from: string, to: string) => ({
    id,
    kind: 'structural',
    from_lid: from,
    to_lid: to,
  });

  function bootWithFolder(port: Partial<StorePort> = {}) {
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      ...port,
    });
    // 並び: a(1) / 消える child(2) / z(3)。child は folder の中に居る
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        meta('folder', { entryOrder: 0, archetype: 'folder' }),
        meta('a', { entryOrder: 1 }),
        meta('child', { entryOrder: 2 }),
        meta('z', { entryOrder: 3 }),
      ],
      relations: [
        { id: 'r1', kind: 'structural', fromLid: 'folder', toLid: 'child', createdAt: null, updatedAt: null },
      ],
    });
    return d;
  }

  it('🔴 親リンクが戻る(フォルダの外に出ない)', async () => {
    const d = bootWithFolder({ listRelations: async () => [rel('r1', 'folder', 'child')] });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'child' });
    // 前提: 常駐からは落ちている(ここが非ゼロでないと、次の assert は自明に通る)
    expect(d.getState().relations.some((r) => r.toLid === 'child')).toBe(false);
    d.dispatch({
      type: 'ENTRY_RESTORED',
      mode: 'trash',
      meta: meta('child', { entryOrder: 2 }),
      body: '',
      relations: [
        { id: 'r1', kind: 'structural', fromLid: 'folder', toLid: 'child', createdAt: null, updatedAt: null },
      ],
    });
    const s = d.getState();
    expect(
      s.relations.find((r) => r.toLid === 'child')?.fromLid,
      'フォルダの外に出た(親リンクが戻っていない)',
    ).toBe('folder');
    await tick();
  });

  it('🔴 並びの位置が戻る(末尾に飛ばない)', () => {
    const d = bootWithFolder();
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'child' });
    expect(d.getState().order).toEqual(['folder', 'a', 'z']);
    d.dispatch({
      type: 'ENTRY_RESTORED',
      mode: 'trash',
      meta: meta('child', { entryOrder: 2 }),
      body: '',
    });
    expect(d.getState().order, '末尾に飛んだ').toEqual(['folder', 'a', 'child', 'z']);
  });

  it('先頭に戻るものも先頭へ入る(挿入位置が末尾固定になっていない)', () => {
    const d = bootWithFolder();
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'folder' });
    d.dispatch({
      type: 'ENTRY_RESTORED',
      mode: 'trash',
      meta: meta('folder', { entryOrder: 0, archetype: 'folder' }),
      body: '',
    });
    expect(d.getState().order[0]).toBe('folder');
  });

  const R1 = {
    id: 'r1',
    kind: 'structural',
    fromLid: 'folder',
    toLid: 'child',
    createdAt: null,
    updatedAt: null,
  };

  it('trash 復元の後着は破棄(幽霊 entry を作らない ── `exists` の門)', () => {
    const d = bootWithFolder();
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'child' });
    d.dispatch({ type: 'ENTRY_RESTORED', mode: 'trash', meta: meta('child', { entryOrder: 2 }), body: '', relations: [R1] });
    d.dispatch({ type: 'ENTRY_RESTORED', mode: 'trash', meta: meta('child', { entryOrder: 2 }), body: '', relations: [R1] });
    expect(d.getState().order.filter((l) => l === 'child')).toHaveLength(1);
  });

  /**
   * ⚠ **同じ id の合流は上書き**。
   *
   * かつてここは trash 復元を 2 回投げて「関係が 2 本にならない」を見ていたが、
   * 2 度目は `exists` の門で**丸ごと破棄**されるので合流に一度も届いておらず、
   * 合流を `[...current, ...incoming]` に壊しても**緑のまま**だった(変異試験 R11)。
   * 関係を持つ復元は**既に居る entry にも来る**(action の型は mode を問わず
   * `relations` を許す)ので、そちら = 履歴復元の形で当てる。
   */
  it('🔴 既に居る関係と同じ id が来ても 2 本にならない(合流は上書き)', () => {
    const d = bootWithFolder();
    expect(d.getState().relations.filter((x) => x.id === 'r1'), '前提が空(合流に届かない)').toHaveLength(1);
    d.dispatch({
      type: 'ENTRY_RESTORED',
      mode: 'revision',
      meta: meta('child', { entryOrder: 2 }),
      body: '戻した本文',
      relations: [R1],
    });
    expect(d.getState().relations.filter((x) => x.id === 'r1'), '同じ関係が 2 本になった').toHaveLength(1);
  });

  it('🔴 効果層が disk から関係を読み直して渡す(その entry のぶんだけ)', async () => {
    const seen: string[] = [];
    const d = bootWithFolder({
      listRelations: async () => {
        seen.push('read');
        return [rel('r1', 'folder', 'child'), rel('rX', 'a', 'z')];
      },
      getRevision: async () => ({
        id: 'r-t',
        entry_lid: 'child',
        rev_order: 1,
        created_at: null,
        title: 'child',
        archetype: 'text',
        body: '本文',
      }),
      listTrash: async () => [
        { id: 'r-t', entry_lid: 'child', created_at: null, title: 'child', archetype: 'text' },
      ],
    });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'child' });
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'child', revId: 'r-t' });
    await tick(30);
    expect(seen, 'disk の関係を読み直していない').toEqual(['read']);
    const s = d.getState();
    expect(s.relations.find((r) => r.toLid === 'child')?.fromLid).toBe('folder');
    // ⚠ **その entry に触らない関係は撒かない**(他で消された関係が復活しないこと)
    expect(s.relations.some((r) => r.id === 'rX'), '無関係な関係まで復活させた').toBe(false);
  });
});
