/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 G1(元に戻す)・G2(ゴミ箱の画面)のうち、画面の状態と効果層の約束。
 * 保存の仕組み(worker)側は `storage-worker-g1g2.test.ts`、2 ペイン側は `g1g2-dual-undo.test.ts`。
 *
 * 231 参照元をまだ調べ終えていないときの一文 / 298 別のタブで読んでいたノートが消えた / 299 ゴミ箱の中に居る相手へのつながり /
 * 229・141 履歴から戻したときの題名 / 140・301 ゴミ箱を空にした・1 件だけ消した後の知らせ / 106・300 ゴミ箱から戻したときの並びと更新日時 /
 * 109 まとめてタグを付けた直後の「元に戻す」 / 108 別のタブで消えていたノートの保存
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, RECREATED_BY_SAVE_TEXT, type StorePort } from '../../src/adapter/state/store-effects';
import { revisionRestoredNotice } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import { clearTrashOffer, LINKED_FROM_MAYBE, trashMessage } from '../../src/adapter/ui/render/trash-undo';
import { stubRevisionOps } from '../helpers/revision-stub';
import { readTags } from '../../src/features/flavor/tags';
import { answerDialog, dialogMessage } from './dialog-helper';

const meta = (lid: string, over: Partial<EntryMeta> = {}): EntryMeta => ({
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
});
const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
  clearTrashOffer();
});

function boot(metas: EntryMeta[], relations: Relation[] = [], port: Partial<StorePort> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  const inspector = new InspectorRenderer(regions.inspector);
  const filerHost = document.createElement('div');
  root.append(filerHost);
  const filer = new FilerRenderer(filerHost);
  d.onState((s) => {
    detail.render(s);
    inspector.render(s);
    filer.render(s);
  });
  bindActions(root, d, { showStatus: () => {} });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    ...port,
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  return { root, d, regions };
}

describe('231 参照元をまだ調べ終えていないとき', () => {
  it('🔴 ノートを選んだ直後にゴミ箱へ移すと、「リンクされているかもしれません」と言う', () => {
    // 参照元の調べを、終わらないままにしておく(選んだ直後 = まだ調べ終えていない場面)
    const { root, d } = boot([meta('a', { title: '議事録' }), meta('b')], [], {
      findBacklinks: () => new Promise(() => {}),
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    // 参照元はまだ引き終わっていない(`backlinks` が無い)
    expect(d.getState().backlinks, '前提: 調べ終えている').toBeNull();
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'delete-entry');
    btn.setAttribute('data-pkc-entry', 'a');
    root.append(btn);
    btn.click();
    expect(d.getState().entryMetas.has('a'), '前提: 移せていない').toBe(false);
    expect(d.getState().notice ?? '').toContain(LINKED_FROM_MAYBE);
  });

  it('対照群: 調べ終えて 0 件なら何も言わず、N 件なら件数を言う', () => {
    const a = boot([meta('a'), meta('b'), meta('c')]);
    a.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    a.d.dispatch({ type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false });
    const b1 = document.createElement('button');
    b1.setAttribute('data-pkc-action', 'delete-entry');
    b1.setAttribute('data-pkc-entry', 'a');
    a.root.append(b1);
    b1.click();
    expect(a.d.getState().notice ?? '', '0 件なのに言った').not.toContain('リンク');
    clearTrashOffer();
    document.body.textContent = '';
    const c = boot([meta('a'), meta('b'), meta('c')]);
    c.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    c.d.dispatch({ type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b', 'c'], truncated: false });
    const b2 = document.createElement('button');
    b2.setAttribute('data-pkc-action', 'delete-entry');
    b2.setAttribute('data-pkc-entry', 'a');
    c.root.append(b2);
    b2.click();
    expect(c.d.getState().notice ?? '').toContain('2 件のノートからのリンクは、戻すまで開けません');
    expect(c.d.getState().notice ?? '', '件数が分かるのに「かもしれません」と言った').not.toContain(LINKED_FROM_MAYBE);
  });

  it('知らせの組み立て: 件数の形でなく、この一文はそのまま載る', () => {
    expect(trashMessage(['猫'], 0, LINKED_FROM_MAYBE)).toContain(`(${LINKED_FROM_MAYBE} / `);
  });
});

describe('298 別のタブで、読んでいたノートがゴミ箱へ移された', () => {
  it('🔴 読んでいたノートが一覧から無くなったら、黙らずに言う', () => {
    const { d } = boot([meta('a', { title: '読んでいた' }), meta('b')]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    // 別のタブの保存で一覧が読み直され、a が無くなっている
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('b')], relations: [] });
    expect(d.getState().selectedLid, '前提: 選択が外れていない').toBeNull();
    expect(d.getState().notice ?? '').toContain('読んでいたノート「読んでいた」が一覧から無くなりました');
    expect(d.getState().notice ?? '').toContain('ゴミ箱から戻せます');
  });

  it('対照群: 読んでいたノートが残っているなら、一覧が読み直されても何も言わない', () => {
    const { d } = boot([meta('a'), meta('b')]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a'), meta('b'), meta('c')], relations: [] });
    expect(d.getState().notice ?? '').not.toContain('無くなりました');
  });
});

describe('299 ゴミ箱の中に居る相手へのつながり', () => {
  const relation = (): Relation => ({
    id: 'r1', fromLid: 'a', toLid: 'gone', kind: 'related', createdAt: null, updatedAt: null,
  });
  const item = (root: HTMLElement): HTMLElement =>
    root.querySelector<HTMLElement>('[data-pkc-field="inspector-relations"] [data-pkc-field="relation-target-link"]')!;

  it('🔴 相手が一覧に居ないつながりは、ゴミ箱を読む前は断定せず、押せる顔にしない', () => {
    const { root, d } = boot([meta('a')], [relation()]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(item(root).textContent).toBe('(見つかりません。ゴミ箱の中かもしれません)');
    expect(item(root).tagName, '押しても開かないのにボタンの顔').toBe('SPAN');
    expect(item(root).getAttribute('data-pkc-action')).toBeNull();
  });

  it('ゴミ箱の一覧を開いていて題名が分かるときは、題名も出る', () => {
    const { root, d } = boot([meta('a')], [relation()]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({
      type: 'TRASH_LIST_LOADED',
      items: [{ revId: 'rv', entryLid: 'gone', createdAt: null, title: '相手の題名', archetype: 'text' }],
    });
    expect(item(root).textContent).toBe('相手の題名(ゴミ箱の中)');
  });

  it('🔴 ゴミ箱の一覧に居なければ「(見つかりません)」── ゴミ箱の中だと言い切らない', () => {
    const { root, d } = boot([meta('a')], [relation()]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'TRASH_LIST_LOADED', items: [] });
    expect(item(root).textContent).toBe('(見つかりません)');
  });

  it('対照群: 相手が居るつながりは、従来どおり押せる題名', () => {
    const { root, d } = boot([meta('a'), meta('gone', { title: '居る相手' })], [relation()]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(item(root).textContent).toBe('居る相手');
    expect(item(root).tagName).toBe('BUTTON');
  });
});

describe('229・141 履歴から戻したときの題名', () => {
  it('知らせの字: 題名が変わるときだけ「題名も…」を添える', () => {
    expect(revisionRestoredNotice('新', '旧', false)).toBe('「新」を前の版に戻しました(題名も「旧」に戻しました)');
    expect(revisionRestoredNotice('同', '同', false)).toBe('「同」を前の版に戻しました');
    expect(revisionRestoredNotice('新', '旧', true)).toBe('「旧」を、戻す前の本文に戻しました(題名も「旧」に戻しました)');
  });

  /** 本文は同じで題名だけ違う版。履歴は積まれない(worker は同じ本文を積まない)。 */
  function titleOnly() {
    const renamed: string[] = [];
    const h = boot([meta('e1', { title: '今の題名' })], [], {
      getBody: async () => '同じ本文\n',
      listRevisionMetas: async () => [{ id: 'r-1', rev_order: 1, created_at: '2026-01-01', title: '昔の題名', archetype: 'text' }],
      getRevision: async () => ({ body: '同じ本文\n', title: '昔の題名', archetype: 'text' }),
      renameEntry: async (lid, title) => {
        renamed.push(`${lid}:${title}`);
        return stubStamps();
      },
    });
    return { ...h, renamed };
  }

  it('🔴 本文が同じで題名だけ違う版を戻しても、「元に戻す」が出て、押すと題名だけ戻る', async () => {
    const { root, d, regions, renamed } = titleOnly();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-1' });
    await tick();
    expect(d.getState().entryMetas.get('e1')?.title, '前提: 題名が戻っていない').toBe('昔の題名');
    expect(d.getState().notice).toBe('「今の題名」を前の版に戻しました(題名も「昔の題名」に戻しました)');
    expect(d.getState().restoreUndo, '題名だけの戻しに、戻す先が無い').toMatchObject({ lid: 'e1', title: '今の題名' });
    const btn = regions.statusUndo;
    paintStatusUndo(btn, d.getState(), d.getState().notice ?? '');
    expect(btn.hidden, '「元に戻す」が出ない').toBe(false);
    expect(btn.getAttribute('data-pkc-undo-title')).toBe('今の題名');
    btn.click();
    await tick();
    expect(d.getState().entryMetas.get('e1')?.title, '押したのに題名が戻らない').toBe('今の題名');
    expect(renamed.at(-1), '題名が disk へ書かれていない').toBe('e1:今の題名');
    expect(root.isConnected).toBe(true);
  });

  it('⚠ 別の知らせに上書きされたら畳む(題名の戻しを別の知らせの隣に残さない)', async () => {
    const { d, regions } = titleOnly();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'RESTORE_REVISION', revId: 'r-1' });
    await tick();
    paintStatusUndo(regions.statusUndo, { ...d.getState(), notice: 'コピーしました' }, 'コピーしました');
    expect(regions.statusUndo.hidden).toBe(true);
  });
});

describe('140・301 ゴミ箱を空にした後・1 件だけ消した後の知らせ', () => {
  const items = [
    { revId: 'rv1', entryLid: 'x1', createdAt: null, title: '消す物', archetype: 'text' },
    { revId: 'rv2', entryLid: 'x2', createdAt: null, title: '残す物', archetype: 'text' },
  ];

  it('🔴 空にすると、ノート数と、添付の容量の空け方を言う', () => {
    const { d } = boot([meta('a')]);
    d.dispatch({ type: 'TRASH_LIST_LOADED', items });
    d.dispatch({ type: 'TRASH_PURGED', purged: 5 });
    const n = d.getState().notice ?? '';
    expect(n, '件数はノートの数(版の数 5 ではない)').toContain('2 件を消しました');
    expect(n).toContain('「使われていない添付を消す」');
    expect(d.getState().trashPanel?.items).toHaveLength(0);
  });

  it('🔴 1 件だけ消すと、その行だけが一覧から消え、題名つきで言う', () => {
    const { d } = boot([meta('a')]);
    d.dispatch({ type: 'TRASH_LIST_LOADED', items });
    d.dispatch({ type: 'TRASH_PURGED', purged: 2, lid: 'x1' });
    expect(d.getState().trashPanel?.items.map((t) => t.entryLid), '指した 1 件だけのはず').toEqual(['x2']);
    expect(d.getState().notice ?? '').toContain('「消す物」を完全に消しました');
  });

  it('効果層: 行の lid が worker まで渡る / 渡さなければ全部', async () => {
    const asked: Array<string | undefined> = [];
    const { d } = boot([meta('a')], [], {
      purgeTrash: async (lid) => {
        asked.push(lid);
        return { purged: 1 };
      },
    });
    d.dispatch({ type: 'PURGE_TRASH', lid: 'x1' });
    await tick();
    d.dispatch({ type: 'PURGE_TRASH' });
    await tick();
    expect(asked, '1 件の指定が worker に届いていない / 全部の呼びに lid が混ざった').toEqual(['x1', undefined]);
  });

  it('🔴 ゴミ箱の行ごとに「完全に消す」が出て、押すと確認のあとその行だけが消える', async () => {
    const asked: Array<string | undefined> = [];
    const { root, d } = boot([meta('a')], [], {
      purgeTrash: async (lid) => {
        asked.push(lid);
        return { purged: 1 };
      },
    });
    d.dispatch({ type: 'TRASH_LIST_LOADED', items });
    const rows = [...root.querySelectorAll<HTMLElement>('[data-pkc-trash-entry]')];
    expect(rows, '前提: ゴミ箱の行が出ていない').toHaveLength(2);
    const one = rows[0]!.querySelector<HTMLElement>('[data-pkc-action="purge-trash"]');
    expect(one?.textContent, '行に「完全に消す」が無い').toBe('完全に消す');
    expect(one?.getAttribute('data-pkc-trash-lid')).toBe('x1');
    // 見出しの「ゴミ箱を空にする」は lid を持たない(全部を消す口と混ざらない)
    const all = root.querySelector<HTMLElement>('[data-pkc-region="filer-trash"] > div > [data-pkc-action="purge-trash"]');
    expect(all?.getAttribute('data-pkc-trash-lid')).toBeNull();
    one!.click();
    await tick();
    expect(asked, '確認を出さずに消した').toEqual([]);
    expect(dialogMessage(), '確認が「その 1 件」を指していない').toContain('「消す物」を完全に消します');
    await answerDialog('ok');
    await tick();
    expect(asked).toEqual(['x1']);
  });
});

describe('106・300 ゴミ箱から戻したときの並びと更新日時', () => {
  function restoring(rev: { entryOrder?: number | null; entryUpdatedAt?: string | null }) {
    const written: Array<{ entryOrder: number; updatedAt?: string | null }> = [];
    const h = boot([meta('a', { entryOrder: 1 }), meta('b', { entryOrder: 9 })], [], {
      getBody: async () => null,
      getRevision: async () => ({ body: '本文\n', title: '戻すノート', archetype: 'text', entryCreatedAt: '2026-01-01 00:00:00', ...rev }),
      persistEntry: async (e) => {
        written.push({ entryOrder: e.entryOrder, updatedAt: e.updatedAt });
        return stubStamps();
      },
    });
    return { ...h, written };
  }

  it('🔴 ゴミ箱の一覧の「戻す」も、控えた並びの位置・更新日時で戻る', async () => {
    const { d, written } = restoring({ entryOrder: 4, entryUpdatedAt: '2026-02-02 02:02:02' });
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'z', revId: 'rv' });
    await tick();
    expect(written, '書込が出ていない').toHaveLength(1);
    expect(written[0]!.entryOrder, '末尾へ飛んだ(控えを使っていない)').toBe(4);
    expect(written[0]!.updatedAt, '更新日時が「戻した時刻」になる').toBe('2026-02-02 02:02:02');
  });

  it('対照群: 控えの無い版は、従来どおり末尾(いちばん下)に戻る', async () => {
    const { d, written } = restoring({});
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'z', revId: 'rv' });
    await tick();
    expect(written[0]!.entryOrder, '末尾の番号になっていない').toBe(10);
    expect(written[0]!.updatedAt, '控えが無いのに更新日時を指した').toBeUndefined();
  });

  it('「元に戻す」が運んだ並びは、控えより優先する(移す直前の並び)', async () => {
    const { d, written } = restoring({ entryOrder: 4 });
    d.dispatch({ type: 'RESTORE_TRASH', entryLid: 'z', revId: 'rv', entryOrder: 2 });
    await tick();
    expect(written[0]!.entryOrder).toBe(2);
  });
});

describe('109 まとめてタグを付けた直後の「元に戻す」', () => {
  function setup(bodies: Record<string, string>) {
    const disk = { ...bodies };
    const h = boot(
      Object.keys(bodies).map((l) => meta(l)),
      [],
      {
        getBody: async (lid) => disk[lid] ?? null,
        getBodies: async (lids) => lids.filter((l) => disk[l] !== undefined).map((l) => ({ lid: l, body: disk[l]! })),
        persistEntry: async (e) => {
          disk[e.lid] = e.body;
          return stubStamps();
        },
      },
    );
    return { ...h, disk };
  }
  const mark = (s: ReturnType<typeof setup>, lids: string[]): void => {
    for (const lid of lids) s.d.dispatch({ type: 'TOGGLE_SELECT', lid });
  };

  it('🔴 付けた直後に「元に戻す」が出て、押すと今回付けたノートだけから外れる(もとから付いていたノートは触らない)', async () => {
    // e1 にはもとから #重要 が付いている / e2・e3 には無い
    const s = setup({ e1: '---\ntags: [重要]\n---\nあ\n', e2: 'い\n', e3: 'う\n' });
    mark(s, ['e1', 'e2', 'e3']);
    await tick();
    s.root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value = '重要';
    s.root.querySelector<HTMLElement>('[data-pkc-action="bulk-tag-add"]')!.click();
    await tick();
    expect(readTags(s.disk['e2']!), '前提: 付いていない').toEqual(['重要']);
    expect(s.d.getState().tagUndo?.groups, '今回付けたノートだけを控えるはず').toEqual([{ tags: ['重要'], lids: ['e2', 'e3'] }]);
    const btn = s.regions.statusUndo;
    paintStatusUndo(btn, s.d.getState(), s.d.getState().notice ?? '');
    expect(btn.hidden, '「元に戻す」が出ない').toBe(false);
    expect(btn.getAttribute('data-pkc-action')).toBe('undo-bulk-tag');
    btn.click();
    await tick();
    expect(readTags(s.disk['e2']!), '付けた分が外れていない').toEqual([]);
    expect(readTags(s.disk['e3']!)).toEqual([]);
    expect(readTags(s.disk['e1']!), 'もとから付いていたノートからも外れた').toEqual(['重要']);
  });

  it('⚠ 別の知らせに上書きされたら畳む / 「外す」の操作には出さない', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    s.root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value = '請求';
    s.root.querySelector<HTMLElement>('[data-pkc-action="bulk-tag-add"]')!.click();
    await tick();
    paintStatusUndo(s.regions.statusUndo, { ...s.d.getState(), notice: 'コピーしました' }, 'コピーしました');
    expect(s.regions.statusUndo.hidden, '別の知らせの隣に残った').toBe(true);
    // 外す操作では、戻す材料を作らない
    mark(s, []);
    s.root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value = '請求';
    s.root.querySelector<HTMLElement>('[data-pkc-action="bulk-tag-remove"]')!.click();
    await tick();
    const u = s.d.getState().tagUndo;
    expect(u?.notice === s.d.getState().notice, '外した知らせに「付けた分の戻し」が付いている').toBe(false);
  });

  it('⚠ 全部がもとから付いていた回は、戻す材料を作らない(押しても何も外れない口を出さない)', async () => {
    const s = setup({ e1: '---\ntags: [重要]\n---\nあ\n' });
    mark(s, ['e1']);
    await tick();
    s.root.querySelector<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value = '重要';
    s.root.querySelector<HTMLElement>('[data-pkc-action="bulk-tag-add"]')!.click();
    await tick();
    expect(s.d.getState().tagUndo ?? null, '付けていないのに戻す材料がある').toBeNull();
  });
});

describe('108 別のタブで消されていたノートを保存した', () => {
  it('🔴 作り直した保存には「ノートとして戻っています」と知らせる', async () => {
    const { d } = boot([meta('e1')], [], {
      getBody: async () => '元の本文\n',
      persistEntry: async () => ({ ...stubStamps(), recreated: true }),
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '打った字\n' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    expect(d.getState().notice).toBe(RECREATED_BY_SAVE_TEXT);
  });

  it('対照群: 普通の保存は何も言わない', async () => {
    const { d } = boot([meta('e1')], [], {
      getBody: async () => '元の本文\n',
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '打った字\n' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await tick();
    expect(d.getState().notice ?? '').not.toBe(RECREATED_BY_SAVE_TEXT);
  });
});
