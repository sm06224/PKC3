/** @vitest-environment happy-dom */
/**
 * entry CRUD(P3-7a)の end-to-end: 作成 → seed 編集 → 保存 / fresh 掃除 /
 * 削除(確認)/ rename。binder → dispatcher → renderer → fake store を通す。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { openDialog } from './dialog-helper';
import { clearTrashOffer, currentTrashOffer } from '../../src/adapter/ui/render/trash-undo';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { createByUi } from '../helpers/create-entry';

function meta(lid: string, order: number, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// root がテスト間で堆積すると region 外 query の事故を隠す ── 毎回掃除
beforeEach(() => {
  // 2026-08-14(#104 第 2 弾): 既定は live ── この file は split の機構
  // (全文 textarea)を測るので、設定で split を明示する
  localStorage.setItem('pkc3.editor-mode', 'split');
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  // 🔴 左の列の行はフォルダの表が描く(「一覧」の描画器は #813 段③ で外した)
    const browse = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
    const sidebar = { render: (s: Parameters<BrowseRouter['render']>[0]): void => browse.render(s, 'filer') };
  const detail = new DetailRenderer(regions.detail);
  // 🔑 削除 / 履歴 / 書き出す は**情報ペイン**が持つ(P8)
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => {
    sidebar.render(s);
    detail.render(s);
    inspector.render(s);
  });
  bindActions(root, d);
  const store = { ...bodies };
  const deleted: string[] = [];
  const persisted: EntryUpsert[] = [];
  /** 🔴 題名だけの書換(#178)。⚠ **本物の意味論を真似る** ── 本文に触らない。 */
  const renamed: Array<{ lid: string; title: string }> = [];
  const reordered: Array<{ lid: string; entryOrder: number }> = [];
  const trash: Record<string, string> = {};
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    renameEntry: async (lid, title) => {
      renamed.push({ lid, title });
      return stubStamps();
    },
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async (lid, entryOrder) => {
      reordered.push({ lid, entryOrder });
      return stubStamps();
    },
    persistEntry: async (e) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async (lid) => {
      deleted.push(lid);
      // 🔑 本物と同じく、消した本文はゴミ箱(履歴)に残る ── 「元に戻す」の材料
      trash[lid] = store[lid] ?? '';
      delete store[lid];
    },
    // ⚠ 本物の意味論:ゴミ箱 = 「entries に居ない entry_lid」。復元(persist)で居るようになれば一覧から消える
    listTrash: async () =>
      Object.keys(trash)
        .filter((lid) => !(lid in store))
        .map((lid) => ({ id: `rev-${lid}`, entry_lid: lid, created_at: null, title: `t-${lid}`, archetype: 'text' })),
    getRevision: async (revId) => {
      const lid = revId.replace(/^rev-/, '');
      return lid in trash ? { body: trash[lid]!, title: `t-${lid}`, archetype: 'text' } : null;
    },
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, persisted, renamed, deleted, store, q, qa };
}

describe('create (P3-7a)', () => {
  it('作成ボタン → seed 付き editor + 即永続、保存で本文が確定する', async () => {
    // ⚠ かつては todo で見ていたが、todo は封印中(features/sealed.ts)で select に出ない。
    // ⚠ **2026-09-08(#753)に表からも移した** ── 表は「読む面で開く」へ変わったので、
    //    「作ると編集の面が出る」を見る台にはもう使えない。seed を持ち、
    //    作ったら本文を打つ種類(雛形)で同じことを見る。
    const { root, d, q, qa, persisted, store } = setup([meta('a', 1)], { a: 'x' });
    createByUi(root, 'snippet');
    await tick();

    // 即永続(作成時点で行が存在 ── PKC2 と同じ)+ seed が editor に見える
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ archetype: 'snippet', entryOrder: 2 });
    const seed = persisted[0]!.body;
    // 空振り防止 ── seed が空なら「seed が editor に見える」を 1 文字も見ていない
    expect(seed.length, 'seed が空(この台は seed を見るためのもの)').toBeGreaterThan(20);
    const lid = persisted[0]!.lid;
    expect(d.getState().phase).toBe('editing');
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value).toBe(seed);
    // 既定 title(日付 + 種別 + 連番)が title input に入っている
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    expect(title.value).toMatch(/^\d{4}-\d{2}-\d{2} テンプレート 1$/);
    // sidebar に行が生えている
    expect(qa(`[data-pkc-entry="${lid}"]`).length).toBeGreaterThan(0);

    ta.value = `${seed}買い物`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(store[lid]).toBe(`${seed}買い物`);
  });

  /**
   * 🔴 **表は「読む面」で開く**(#753、2026-09-08)。
   *
   * ⚠ 直す前は編集の面(ライブエディタ)で開いていたが、**升を押せる印を焼くのは
   *   読む面だけ**なので、**升を押すと原文の欄に化けた** ── #418 が無くそうとした
   *   「カンマを目で数える画面」が、作った直後だけ戻っていた。
   * ⚠ しかもマニュアルは「**そのままセルから打てます**」と書いており、
   *   **約束のほうが嘘**だった。
   *
   * 🔑 **対照群を同じ it に置く**(ノートは今までどおり編集の面)── 置かないと
   *   「全部の種類を読む面にした」という**逆の壊し方**を 1 つも止められない。
   */
  it('🔴 表は読む面で開く / ノートは編集の面のまま (#753)', async () => {
    const a = setup([meta('a', 1)], { a: 'x' });
    createByUi(a.root, 'spreadsheet');
    await tick();
    expect(a.persisted).toHaveLength(1);
    expect(a.persisted[0]).toMatchObject({
      archetype: 'spreadsheet',
      body: '```csv-render noheader\n,,,,\n,,,,\n,,,,\n```',
    });
    expect(a.d.getState().phase, '表が編集の面で開いている(升を押しても打てない)').toBe('ready');
    expect(
      a.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]'),
      '原文の欄が出ている(読む面ではない)',
    ).toBeNull();
    // 🔑 作った表が**選ばれている**(作っただけで見えないと、次に押す所が無い)
    expect(a.d.getState().selectedLid).toBe(a.persisted[0]!.lid);

    // ⚠ 対照群 ── ノートは今までどおり編集の面で開く
    const b = setup([meta('a', 1)], { a: 'x' });
    createByUi(b.root, 'text');
    await tick();
    expect(b.d.getState().phase, 'ノートまで読む面にしてしまった').toBe('editing');
    expect(b.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')).not.toBeNull();
  });

  it('未編集のまま cancel → entry ごと掃除(PKC2 の空 entry 堆積の対策)', async () => {
    const { root, d, q, qa, deleted } = setup([meta('a', 1)], { a: 'x' });
    createByUi(root, 'text');
    const lid = d.getState().selectedLid!;
    q<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click();
    await tick(20);
    expect(d.getState().entryMetas.has(lid)).toBe(false);
    expect(qa(`[data-pkc-entry="${lid}"]`)).toHaveLength(0);
    expect(deleted).toEqual([lid]); // disk からも掃除
    // 掃除後は元の entry に選択が戻る
    expect(d.getState().selectedLid).toBe('a');
  });

  it('作成 → 即 cancel × 初回 persist 失敗でも app はロックしない(review 重大 pin)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    // 🔴 左の列の行はフォルダの表が描く(「一覧」の描画器は #813 段③ で外した)
    const browse = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
    const sidebar = { render: (s: Parameters<BrowseRouter['render']>[0]): void => browse.render(s, 'filer') };
    const detail = new DetailRenderer(regions.detail);
    d.onState((s) => {
      sidebar.render(s);
      detail.render(s);
    });
    bindActions(root, d);
    let failNext = true;
    connectStoreEffects(d, {
    ...stubRevisionOps(),
      getBody: async () => '# A',
      /**
       * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
       *   だから fake も本文を持たない(触らないものは持たない)。
       */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => {
        if (failNext) {
          failNext = false;
          throw new Error('first write fails');
        }
        return stubStamps();
      },
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1)], relations: [] });
    createByUi(root, 'text');
    // persist 失敗が届く前に cancel(fresh 掃除)── 同期で
    root.querySelector<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click();
    await tick(30);
    // 守るべき未達 commit は無い ── phase は落ちない(修正前は error phase 固着 +
    // error 表示も後続 BODY_LOADED に消され「無言ロック」だった)。
    // 🔴 設計 doc §7、段②a ── 知らせはステータスバーではなく「メッセージ」の
    // ノートへ移ったので、次の成功読込では**消えない**(消えるのは MESSAGES_READ だけ)。
    expect(d.getState().phase).toBe('ready');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    expect(d.getState().openBody?.body).toBe('# A'); // 選択・読込が生きている
    expect(d.getState().error).toMatch(/first write fails/);
  });

  it('draft を打った cancel で fresh は解除 ── 後日の無変更 Esc が entry を消さない', async () => {
    const { root, d, q } = setup([], {});
    createByUi(root, 'text');
    const lid = d.getState().selectedLid!;
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '下書き';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click(); // 残す(仕様)
    expect(d.getState().entryMetas.has(lid)).toBe(true);
    expect(d.getState().freshLid).toBeNull(); // 寿命は作成直後の編集セッション内
    // 再編集 → 無変更 Esc ── もう消えない
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    q<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click();
    expect(d.getState().entryMetas.has(lid)).toBe(true);
  });

  it('title だけ入力して Esc → title を保存して entry を残す(入力を失わない)', async () => {
    const { root, d, q, qa } = setup([], {});
    createByUi(root, 'text');
    const lid = d.getState().selectedLid!;
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    title.value = '大事なタイトル';
    title.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await tick(20);
    expect(d.getState().entryMetas.get(lid)?.title).toBe('大事なタイトル');
    expect(qa(`[data-pkc-entry="${lid}"]`).length).toBeGreaterThan(0);
  });

  it('一度 commit した entry は cancel でも消えない(fresh 解除)', async () => {
    const { root, d, q } = setup([], {});
    createByUi(root, 'text');
    const lid = d.getState().selectedLid!;
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '本文';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    // 再編集 → 未変更 cancel ── もう fresh ではないので残る
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    q<HTMLElement>('[data-pkc-action="cancel-edit"]')!.click();
    expect(d.getState().entryMetas.has(lid)).toBe(true);
  });
});

describe('delete (P3-7a)', () => {
  /**
   * 🔴 **確認は出さず、移したあとに「元に戻す」を出す**(#1087 流れ 29。Gemini 裁定 = #1163 への依頼 29 の Q3)。
   * ⚠ かつての 5 本(確認 OK / 待っている間に編集が始まる / 対象が消える / キャンセル …)は、
   *   確認という**窓が無くなった**ので成り立たない ── 窓の間に前提が崩れる経路ごと消えた。
   *   代わりに「押した瞬間の前提(編集中)」と「戻せること」を見る。
   */
  // ⚠ 戻す材料は module の 1 つ(直前の 1 回だけ持つ)── it をまたいで持ち越さない
  beforeEach(() => clearTrashOffer());
  const undoOffer = async () => currentTrashOffer();

  it('🔴 押すと確認なしで消え、「『題名』をゴミ箱へ移しました」が出て、選択が隣へ移り、store の掃除 op が走る', async () => {
    const { d, q, qa, deleted } = setup(
      [meta('a', 1), meta('b', 2), meta('c', 3)],
      { a: 'A', b: 'B', c: 'C' },
    );
    q<HTMLElement>('[data-pkc-entry="b"]')!.click();
    await tick();
    q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await tick(20);
    expect(openDialog(), '確認が出ている(出さない裁定)').toBeNull();
    expect(qa('[data-pkc-entry="b"]')).toHaveLength(0);
    expect(deleted).toEqual(['b']);
    expect(d.getState().selectedLid).toBe('c');
    expect(d.getState().openBody?.body).toBe('C');
    expect(d.getState().notice, '移したことを言っていない').toBe('「t-b」をゴミ箱へ移しました');
    expect((await undoOffer())?.lids, '戻す材料を持っていない').toEqual(['b']);
  });

  it('🔴 フォルダを移したら、中のノートがルートに出たことも言う(中身ごと消えたと読ませない)', async () => {
    const { d, q } = setup(
      [meta('f', 1, { archetype: 'folder' }), meta('n1', 2), meta('n2', 3), meta('x', 4)],
      { f: '', n1: 'N1', n2: 'N2', x: 'X' },
    );
    d.dispatch({ type: 'SET_ENTRY_PARENT', lid: 'n1', parentLid: 'f', relationId: 'r1' });
    d.dispatch({ type: 'SET_ENTRY_PARENT', lid: 'n2', parentLid: 'f', relationId: 'r2' });
    expect(d.getState().relations, '前提: 中に 2 件入っていない').toHaveLength(2);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'f' });
    await tick();
    q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await tick(20);
    expect(d.getState().entryMetas.has('n1'), '中のノートまで消えた').toBe(true);
    expect(d.getState().notice).toBe('「t-f」をゴミ箱へ移しました(中のノート 2 件は消えずにルートに出ています)');
  });

  it('🔴 ほかのノートからリンクされているノートを移したら、そのリンクが開けなくなることも言う', async () => {
    const { d, q } = setup([meta('a', 1), meta('b', 2), meta('c', 3)], { a: 'A', b: 'B', c: 'C' });
    q<HTMLElement>('[data-pkc-entry="b"]')!.click();
    await tick();
    d.dispatch({ type: 'BACKLINKS_LOADED', lid: 'b', lids: ['a', 'c'], truncated: false });
    expect(d.getState().backlinks?.lids, '前提: 参照元を持っていない').toEqual(['a', 'c']);
    q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await tick(20);
    expect(d.getState().notice).toBe('「t-b」をゴミ箱へ移しました(2 件のノートからのリンクは、戻すまで開けません)');
  });

  it('🔴 編集中は消さずに理由を出す(確認より前に断る ── 無言にしない)', async () => {
    const { d, q, deleted } = setup([meta('a', 1)], { a: 'A' });
    q<HTMLElement>('[data-pkc-entry="a"]')!.click();
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている(編集中になっていない)').toBe('editing');
    // ⚠ 編集中は描き直しで押し口が外れうる ── 受け手を直に押す(別窓・メニューから届く形)
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'delete-entry');
    document.body.firstElementChild!.append(btn);
    btn.click();
    await tick(20);
    expect(deleted).toHaveLength(0);
    expect(d.getState().entryMetas.has('a')).toBe(true);
    expect(d.getState().error ?? '', '無言で捨てた(理由が出ていない)').toContain(
      '編集を保存するか、編集をやめてからゴミ箱へ移してください',
    );
    expect(await undoOffer(), '消していないのに「元に戻す」を持っている').toBeNull();
  });

  it('🔴 「元に戻す」を押すと、消したノートが本文ごと戻る', async () => {
    const { d, q, qa, store } = setup([meta('a', 1), meta('b', 2)], { a: 'A', b: 'B' });
    q<HTMLElement>('[data-pkc-entry="b"]')!.click();
    await tick();
    q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
    await tick(20);
    expect(d.getState().entryMetas.has('b'), '前提: 消えている').toBe(false);
    // 画面の下の「元に戻す」(shell の status-undo)は paintStatusUndo が出し入れする。ここは受け手を直に押す
    const undo = document.createElement('button');
    undo.setAttribute('data-pkc-action', 'undo-trash');
    document.body.firstElementChild!.append(undo);
    undo.click();
    await tick(40);
    expect(d.getState().entryMetas.has('b'), '戻っていない').toBe(true);
    expect(store['b'], '本文が戻っていない').toBe('B');
    expect(qa('[data-pkc-entry="b"]').length, '行が画面に戻っていない').toBeGreaterThan(0);
    expect(d.getState().notice).toBe('ゴミ箱から元に戻しました');
    expect(await undoOffer(), '戻したあとも持っている(2 度押せる)').toBeNull();
  });

  it('⚠ 戻せる時間(7 秒)が過ぎたら知らせごと降ろす', async () => {
    const { d, q } = setup([meta('a', 1)], { a: 'A' });
    q<HTMLElement>('[data-pkc-entry="a"]')!.click();
    await tick();
    vi.useFakeTimers();
    try {
      q<HTMLElement>('[data-pkc-action="delete-entry"]')!.click();
      expect(await undoOffer(), '前提: 出ている').not.toBeNull();
      vi.advanceTimersByTime(7001);
      expect(await undoOffer()).toBeNull();
      expect(d.getState().notice, '知らせが居残っている').toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rename (P3-7a)', () => {
  it('editor の title input → 保存で sidebar と store に反映', async () => {
    const { d, q, persisted, renamed, store } = setup([meta('a', 1)], { a: '# 本文' });
    q<HTMLElement>('[data-pkc-entry="a"]')!.click();
    await tick();
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    title.value = '新しい題';
    q<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(d.getState().entryMetas.get('a')?.title).toBe('新しい題');
    expect(
      q('[data-pkc-entry="a"] [data-pkc-field="title"]')?.textContent,
    ).toBe('新しい題');
    /**
     * 🔴 **題名だけが disk へ行く**(#178、2026-08-22)。
     *
     * ⚠ 直す前は本文を読んで**行全体を書き戻して**いた ── 読んでから書くまでの間に
     *   別のタブ / 窓が本文を書いていると**それを消す**(しかも本文は変わらないので
     *   履歴にも残らない)。いまは題名だけの口を通る。
     * 🔑 **本文を書いていないこと**まで見る ── ここが緩むと、静かに戻る。
     */
    expect(renamed, '題名だけの口を通っていない').toEqual([{ lid: 'a', title: '新しい題' }]);
    expect(persisted, '本文を書き戻している(別の窓の本文を消す形)').toEqual([]);
    expect(store['a']).toBe('# 本文'); // body は無傷
  });
});

describe('reducer edges (P3-7a)', () => {
  const boot = (metas: EntryMeta[]) =>
    reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;

  it('CREATE_ENTRY: lid 衝突は可視エラーで拒否 / entryOrder は末尾 + 1', () => {
    const s = boot([meta('a', 5)]);
    const dup = reduce(s, { type: 'CREATE_ENTRY', archetype: 'text', lid: 'a', title: 't' });
    expect(dup.state.entryMetas.size).toBe(1);
    expect(dup.state.error).toContain('ノートを作れませんでした');
    // ⚠ 英語の内部文と ID を画面に出さない(#1087)
    expect(dup.state.error).not.toMatch(/collision/);
    const ok = reduce(s, { type: 'CREATE_ENTRY', archetype: 'text', lid: 'n', title: 't' });
    expect(ok.state.entryMetas.get('n')?.entryOrder).toBe(6);
    expect(ok.state.order[ok.state.order.length - 1]).toBe('n');
  });

  it('DELETE_ENTRY は常駐 relations も掃除する(worker の同 tx 掃除と整合)', () => {
    let s = boot([meta('a', 1), meta('b', 2)]);
    s = {
      ...s,
      relations: [
        { id: 'r1', fromLid: 'a', toLid: 'b', kind: 'structural', createdAt: null, updatedAt: null },
        { id: 'r2', fromLid: 'b', toLid: 'b', kind: 'semantic', createdAt: null, updatedAt: null },
      ],
    };
    const r = reduce(s, { type: 'DELETE_ENTRY', lid: 'a' });
    expect(r.state.relations.map((x) => x.id)).toEqual(['r2']);
    // 無関係な削除では参照維持(断面指紋を壊さない)
    const r2 = reduce(r.state, { type: 'DELETE_ENTRY', lid: 'b' });
    expect(r2.state.relations).toEqual([]);
  });

  it('DELETE_ENTRY の選択遷移: 末尾削除 → 前へ、唯一の entry 削除 → null', () => {
    let s = boot([meta('a', 1), meta('b', 2)]);
    s = { ...s, selectedLid: 'b' };
    const r1 = reduce(s, { type: 'DELETE_ENTRY', lid: 'b' });
    expect(r1.state.selectedLid).toBe('a'); // 末尾 fallback
    const only = boot([meta('x', 1)]);
    const r2 = reduce({ ...only, selectedLid: 'x' }, { type: 'DELETE_ENTRY', lid: 'x' });
    expect(r2.state.selectedLid).toBeNull();
    expect(r2.events).toEqual([{ type: 'REQUEST_DELETE', lid: 'x' }]);
  });

  it('RENAME_ENTRY_TITLE: trim / 空・同一は no-op / 楽観 meta 更新 + snapshot event', () => {
    const s = boot([meta('a', 1)]);
    expect(reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '  ' }).events).toEqual([]);
    expect(reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: 't-a' }).events).toEqual([]);
    const r = reduce(s, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '  改名  ' });
    expect(r.state.entryMetas.get('a')?.title).toBe('改名');
    expect(r.events).toEqual([
      { type: 'REQUEST_RENAME', lid: 'a', title: '改名', archetype: 'text', entryOrder: 1 },
    ]);
  });
});
