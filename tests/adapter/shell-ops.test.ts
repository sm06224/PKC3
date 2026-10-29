/** @vitest-environment happy-dom */
/**
 * 🔴 **実物の `makeShellOps` を通す**(#274 レビュー テスト A)── 偽の `ShellOps` では見えない所を見る。
 *
 * 命令表 → 段取り(`runShellLine`)→ **本物の実体**(`moveEntriesOfferingUndo` / `copyEntriesTo` / `deleteFrom` / `APPEND_TO_ENTRY` /
 * `BULK_TAG` / 自前の SQL・検索の口 / 確認ダイアログ)まで繋ぐ。
 *
 * ①rm: 実の確認ダイアログ(ok / cancel)・件数・「元に戻す」・別のタブの編集 ②cp: 本文ごと複製 ③append: 書込の錠が立ち、終わる
 * ④tag: 付ける / 外すが効果に届く ⑤sql / find -b: 自前の口で、SQL 画面・探す画面の状態を借りない ⑥編集中は書く命令が確認の前に断られ、読む命令は動く
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { makeShellOps, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { runShellLine } from '../../src/adapter/ui/actions/shell-run';
import { ShellSession } from '../../src/adapter/ui/render/cmdshell';
import { ShellHistoryStore } from '../../src/adapter/ui/render/shell-history-store';
import { setSqlEmbedRunner } from '../../src/adapter/ui/render/sql-embed-hydrate';
import { currentTrashOffer, clearTrashOffer } from '../../src/adapter/ui/render/trash-undo';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { answerDialog, dialogMessage, openDialog } from './dialog-helper';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string, archetype = 'text', order = 1): EntryMeta {
  return { lid, title, archetype, createdAt: null, updatedAt: null, entryOrder: order, status: null, date: null, archived: false, bodyChars: 0 };
}
const rel = (from: string, to: string): Relation => ({ id: `${from}-${to}`, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null });

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

interface Ctx {
  d: Dispatcher;
  root: HTMLElement;
  services: BinderServices;
  run(line: string): Promise<ReturnType<ShellSession['blocks']['at']>>;
  persisted: Array<{ lid: string; title: string; body: string }>;
  events: Array<{ type: string } & Record<string, unknown>>;
  session: ShellSession;
  bodies: Map<string, string>;
  deny: Set<string>;
}

function setup(): Ctx {
  resetAppDialogForTest();
  clearTrashOffer();
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const persisted: Ctx['persisted'] = [];
  const bodies = new Map<string, string>([['n2', '# 買い物メモ\n牛乳'], ['n1', '議事録の本文']]);
  const deny = new Set<string>();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    deleteEntry: async () => {},
    setEntryParent: async () => undefined as never,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; title: string; body: string }) => {
      persisted.push({ lid: e.lid, title: e.title, body: e.body });
      bodies.set(e.lid, e.body);
      return stubStamps();
    },
    getBody: async (lid: string) => bodies.get(lid) ?? '',
    // 🔴 SQL 画面の問い合わせは返ってこない(走りっぱなし)── シェルの SQL は別の口なので影響を受けない
    runReadOnlySql: () => new Promise<never>(() => {}),
  } as never);
  const events: Ctx['events'] = [];
  d.onEvent((ev) => events.push(ev as never));
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      meta('f1', '資料', 'folder', 1),
      meta('f2', 'アーカイブ', 'folder', 2),
      meta('n1', '議事録', 'text', 3),
      meta('n2', '買い物メモ', 'text', 4),
      meta('n3', '設計', 'text', 5),
    ],
    relations: [rel('f1', 'n1')],
  });
  const services = {
    readBodies: async (lids: readonly string[]) => new Map(lids.map((l) => [l, bodies.get(l) ?? ''] as const)),
    acquireEditLock: async (lid: string) => (deny.has(lid) ? 'denied' : 'granted'),
    releaseEditLock: () => {},
    showStatus: () => {},
  } as unknown as BinderServices;
  const session = new ShellSession('shell', new ShellHistoryStore(memoryStorage()));
  const ops = makeShellOps({ dispatcher: d, services, root, surface: 'shell', where: 'pane' });
  return {
    d,
    root,
    services,
    persisted,
    events,
    session,
    bodies,
    deny,
    run: async (line) => runShellLine(ops, session, line),
  } as Ctx;
}

describe('実物の命令の実行(makeShellOps)', () => {
  let c: Ctx;
  beforeEach(() => {
    c = setup();
    setSqlEmbedRunner(null);
  });
  afterEach(() => {
    c.root.remove();
    document.querySelectorAll('dialog').forEach((x) => x.remove());
    setSqlEmbedRunner(null);
  });

  it('🔴 rm: 件数つきの確認が実のダイアログで出て、ok で消え、「元に戻す」が出る(B)', async () => {
    const p = c.run('rm 買い物メモ');
    await tick();
    expect(openDialog(), '確認が出ていない').not.toBeNull();
    expect(dialogMessage()).toContain('をゴミ箱へ入れます(1 件。あとで戻せます)');
    expect(openDialog()!.querySelector('[data-pkc-field="dialog-ok"]')!.textContent).toBe('ゴミ箱へ入れる');
    await answerDialog('ok');
    const block = (await p)!;
    expect(c.d.getState().entryMetas.has('n2')).toBe(false);
    expect(block.lines.join('\n')).toContain('1 件をゴミ箱へ入れました');
    expect(block.failed).toBe(false);
    expect(currentTrashOffer(), '「元に戻す」が出ていない').not.toBeNull();
  });

  it('🔴 rm: フォルダは中身を含めた件数が確認に出る', async () => {
    const p = c.run('rm 資料');
    await tick();
    expect(dialogMessage()).toContain('(1 件。フォルダの中身を含めて 2 件。あとで戻せます)');
    await answerDialog('cancel');
    const block = (await p)!;
    expect(block.lines.join('\n')).toContain('やめました');
    expect(c.d.getState().entryMetas.has('f1')).toBe(true);
  });

  it('🔴 rm: cancel なら何も消えない', async () => {
    const p = c.run('rm 買い物メモ');
    await tick();
    await answerDialog('cancel');
    await p;
    expect(c.d.getState().entryMetas.has('n2')).toBe(true);
    expect(currentTrashOffer()).toBeNull();
  });

  it('🔴 rm: 別のタブが編集中のノートは消さず、理由を出す', async () => {
    c.deny.add('n2');
    const p = c.run('rm 買い物メモ');
    await tick();
    await answerDialog('ok');
    const block = (await p)!;
    expect(c.d.getState().entryMetas.has('n2')).toBe(true);
    expect(block.failed).toBe(true);
    expect(block.lines.join('\n')).toMatch(/別のタブ|編集/);
  });

  it('🔴 cp: 本文ごと複製され、フォルダへ入る。まとめて複製するときは件数つきの確認が出る', async () => {
    const one = (await c.run('cp 設計 アーカイブ'))!;
    expect(one.lines.join('\n')).toContain('「アーカイブ」へコピーしました');
    const copies = [...c.d.getState().entryMetas.values()].filter((m) => m.lid !== 'n3' && m.title.startsWith('設計'));
    expect(copies).toHaveLength(1);
    expect(c.d.getState().relations.some((r) => r.fromLid === 'f2' && r.toLid === copies[0]!.lid)).toBe(true);
    await tick();
    expect(c.persisted.some((p) => p.lid === copies[0]!.lid)).toBe(true);

    const p = c.run('cp * 資料');
    await tick();
    expect(dialogMessage()).toContain('へコピーします');
    expect(dialogMessage()).toContain('フォルダの中身を含めて');
    expect(openDialog()!.querySelector('[data-pkc-field="dialog-ok"]')!.textContent).toBe('コピーする');
    await answerDialog('cancel');
    const cancelled = (await p)!;
    expect(cancelled.lines.join('\n')).toContain('やめました');
  });

  it('🔴 append: 書込の錠が立って終わり、本文が足される。別のタブの編集なら足さない', async () => {
    const block = (await c.run('append 買い物メモ パンを足す'))!;
    expect(block.failed).toBe(false);
    expect(block.lines.join('\n')).toContain('の末尾に追記しました');
    expect(c.d.getState().writeLock).toBeNull();
    await tick();
    expect(c.bodies.get('n2')).toContain('パンを足す');
    // 別のタブが編集中
    c.deny.add('n3');
    const denied = (await c.run('append 設計 追記'))!;
    expect(denied.failed).toBe(true);
    expect(c.bodies.get('n3') ?? '').not.toContain('追記');
  });

  it('🔴 tag: 付ける / 外すが、それぞれの mode で効果に届く', async () => {
    const add = (await c.run('tag add 重要 設計'))!;
    expect(add.failed).toBe(false);
    const addEv = c.events.find((e) => e.type === 'REQUEST_BULK_TAG');
    expect(addEv?.mode).toBe('add');
    expect(addEv?.tags).toEqual(['重要']);
    c.events.length = 0;
    await c.run('tag remove 重要 設計');
    const rmEv = c.events.find((e) => e.type === 'REQUEST_BULK_TAG');
    expect(rmEv?.mode).toBe('remove');
    // 別のタブが編集中なら撃たない
    c.events.length = 0;
    c.deny.add('n3');
    const denied = (await c.run('tag add 重要 設計'))!;
    expect(denied.failed).toBe(true);
    expect(c.events.some((e) => e.type === 'REQUEST_BULK_TAG')).toBe(false);
  });

  it('🔴 sql: 自前の口で走り、SQL 画面の入力・履歴・結果を上書きしない。書く SQL は字の門で断る', async () => {
    const asked: string[] = [];
    setSqlEmbedRunner(async (sql) => {
      asked.push(sql);
      return { columns: ['title'], rows: [['議事録'], ['設計']], truncated: false, ms: 1 };
    });
    // SQL 画面の状態を先に作っておく(走っている最中でもよい)
    c.d.dispatch({ type: 'SET_SQL_TEXT', sql: 'SELECT 1 /* 画面の入力 */' });
    const before = c.d.getState().sqlPage;
    const block = (await c.run('sql SELECT title FROM entries'))!;
    expect(asked).toEqual(['SELECT title FROM entries']);
    expect(block.table!.rows).toEqual([['議事録'], ['設計']]);
    const after = c.d.getState().sqlPage;
    expect(after.sql).toBe(before.sql);
    expect(after.history).toEqual(before.history);
    expect(after.ranSql).toBe(before.ranSql);
    expect(after.running).toBe(false);

    asked.length = 0;
    const bad = (await c.run('sql DELETE FROM entries'))!;
    expect(bad.failed).toBe(true);
    expect(asked).toEqual([]);
  });

  it('🔴 sql: SQL 画面が走っていても、自分の答えだけを受け取る', async () => {
    setSqlEmbedRunner(async () => ({ columns: ['n'], rows: [[1]], truncated: false, ms: 1 }));
    c.d.dispatch({ type: 'SET_SQL_TEXT', sql: 'SELECT 2' });
    c.d.dispatch({ type: 'RUN_SQL' });
    expect(c.d.getState().sqlPage.running).toBe(true);
    const block = (await c.run('sql SELECT 1'))!;
    expect(block.table!.rows).toEqual([['1']]);
    expect(block.failed).toBe(false);
  });

  it('🔴 find -b: 自前の口で引き、「探す」画面の語と結果を上書きしない', async () => {
    const asked: string[] = [];
    (c.services as unknown as { searchDetail: unknown }).searchDetail = async (q: string) => {
      asked.push(q);
      return { rows: [{ lid: 'n2', title: '買い物メモ', snippet: '牛乳を\u0000買う\u0001', rank: 0 }], truncated: false };
    };
    c.d.dispatch({ type: 'SET_SEARCH_PAGE_QUERY', query: '画面の語' });
    const before = c.d.getState().searchPage;
    const s = new ShellSession('shell', new ShellHistoryStore(memoryStorage()));
    const ops = makeShellOps({ dispatcher: c.d, services: c.services, root: c.root, surface: 'shell', where: 'pane' });
    const block = (await runShellLine(ops, s, 'find 牛乳 -b'))!;
    expect(asked).toEqual(['牛乳']);
    expect(block.table!.lids).toEqual(['n2']);
    expect(c.d.getState().searchPage.query).toBe(before.query);
    expect(c.d.getState().searchPage.rows).toBe(before.rows);
    expect(s.last).toEqual(['n2']);
  });

  it('🔴 編集中: 書くコマンドは確認の前に断られ、読むコマンドは動く', async () => {
    c.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    c.d.dispatch({ type: 'START_EDIT' });
    expect(c.d.getState().phase).toBe('editing');
    for (const line of ['rm 設計', 'mv 設計 アーカイブ', 'cp 設計 アーカイブ', 'new 新規 本文', 'mkdir 新規', 'append 設計 追記', 'tag add 重要 設計', 'rename 設計 別名']) {
      const b = (await c.run(line))!;
      expect(b.failed, `${line} が断られていない`).toBe(true);
      expect(b.lines.join('\n'), line).toMatch(/編集/);
    }
    expect(openDialog(), 'rm の確認が先に出ている').toBeNull();
    expect(c.d.getState().entryMetas.has('n3')).toBe(true);
    expect([...c.d.getState().entryMetas.values()].some((m) => m.title === '新規')).toBe(false);
    // 読むコマンドは編集中でも動く
    const ls = (await c.run('ls'))!;
    expect(ls.failed).toBe(false);
    expect(ls.table!.rows.length).toBeGreaterThan(0);
    expect((await c.run('find 設計'))!.failed).toBe(false);
  });

  it('mv: 結果の文が出る', async () => {
    const b = (await c.run('mv 設計 アーカイブ'))!;
    expect(b.lines.join('\n')).toContain('「アーカイブ」へ移しました');
    expect(c.d.getState().relations.some((r) => r.fromLid === 'f2' && r.toLid === 'n3')).toBe(true);
  });
});
