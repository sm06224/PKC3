/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートを複製する**(#1163 依頼 169。user 回答 = 要る)。
 *
 * - 引き継ぐもの: 本文・タグ・添付(本文の中のタグ・添付への参照がそのまま入る)
 * - 引き継がないもの: つながり(関係)・履歴(新しいノートとして作る)
 * - 置き場: 元のノートと同じフォルダ / 題名: 「元の題名 (コピー)」
 * - 入口: 行の右クリック / 右の列 / 「操作を探す」(受け手は 1 本)
 *
 * ⚠ 台は実物(shell + BrowseRouter + binder + effect 層)── 押してから disk への要求まで通して見る。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';
import { resolveCanonicalParents } from '../../src/features/relation/tree';
import { copyTitle } from '../../src/features/relation/copy-plan';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { ENTRY_ACTION_LABELS } from '../../src/features/entry-actions';

function meta(lid: string, order: number, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const rel = (id: string, from: string, to: string, kind = 'structural'): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind,
  createdAt: null,
  updatedAt: null,
});

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const MENU = '[data-pkc-region="context-menu"]';
// 🔑 本文にタグ・添付の参照・別ノートへのリンクを持たせる(本文ごと引き継がれることを見る)
const BODY = '#仕事 の打ち合わせ\n\n![図](asset:a1)\n\n[相手](entry:n2)\n';

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

const METAS = [meta('f1', 1, 'はこ', 'folder'), meta('n1', 2, '会議メモ'), meta('n2', 3, '相手')];
// n1 は f1 の中。n1 → n2 に構造ではないつながり(引き継がない物)
const RELS = [rel('r1', 'f1', 'n1'), rel('r2', 'n1', 'n2', 'link')];

function setup() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  // 🔑 画面の下に出す知らせ(`OP_NOTICE`)を控える ── 複製の言い方を見る
  const notices: string[] = [];
  const dispatch = d.dispatch.bind(d);
  d.dispatch = ((a: Parameters<typeof dispatch>[0]) => {
    if (a.type === 'OP_NOTICE') notices.push(a.message);
    return dispatch(a);
  }) as typeof d.dispatch;
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => browse.render(s, 'filer'));
  const errors: string[] = [];
  d.onState((s) => {
    if (s.error !== null && errors.at(-1) !== s.error) errors.push(s.error);
  });
  const read: string[] = [];
  bindActions(root, d, {
    setBrowse: () => browse.render(d.getState(), 'filer'),
    showStatus: () => {},
    readBodies: async (lids) => {
      read.push(...lids);
      return new Map(lids.map((l) => [l, l === 'n1' ? BODY : ''] as const));
    },
  });
  const created: Array<{ lid: string; title: string; body: string; parent: unknown }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => (lid === 'n1' ? BODY : ''),
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      created.push({ lid: e.lid, title: e.title, body: e.body, parent: opts?.parent });
      return { ...stubStamps(), ...(opts?.parent ? { parentWritten: true } : {}) };
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
  // n1 は f1 の中に居るので、f1 に入って行を出す
  d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const row = (lid: string): HTMLElement => {
    const el = pane.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`);
    expect(el, `前提が崩れている: 台に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  return { root, d, row, press, created, errors, read, notices };
}

describe('ノートを複製する(#1163 依頼 169)', () => {
  it('🔴 行の右クリックに「ノートを複製する」が出る', () => {
    const r = setup();
    rightClick(r.row('n1'));
    const b = r.root.querySelector(`${MENU} [data-pkc-action="duplicate-entry"]`);
    expect(b, '右クリックに複製が無い').not.toBeNull();
    expect(b!.textContent).toContain('ノートを複製する');
  });

  it('🔴 同じフォルダに「元の題名 (コピー)」ができ、本文(タグ・添付・リンク)がそのまま入り、複製が選ばれる', async () => {
    const r = setup();
    rightClick(r.row('n1'));
    r.press('duplicate-entry');
    await tick(30);
    const st = r.d.getState();
    const made = [...st.entryMetas.values()].filter((m) => !['f1', 'n1', 'n2'].includes(m.lid));
    expect(made.length, '複製が 1 件できていない').toBe(1);
    const copy = made[0]!;
    expect(copy.title, '題名が「元の題名 (コピー)」ではない').toBe('会議メモ (コピー)');
    expect(copy.archetype).toBe('text');
    // 🔴 置き場は元と同じフォルダ(ルートに出ない)
    expect(resolveCanonicalParents(st.entryMetas, st.relations).get(copy.lid), '元と違う場所にできた').toBe('f1');
    // 🔴 本文は丸ごと(タグ・添付・別ノートへのリンクを引き継ぐ)── disk への要求まで見る
    const persisted = r.created.find((c) => c.lid === copy.lid);
    expect(persisted, 'disk へ書く要求が出ていない').toBeDefined();
    expect(persisted!.body, '本文が引き継がれていない').toBe(BODY);
    // 🔴 つながり(構造ではない関係)は引き継がない ── 複製から出る関係は親フォルダへの 1 本だけ
    const fromCopy = st.relations.filter((x) => x.fromLid === copy.lid || x.toLid === copy.lid);
    expect(
      fromCopy.map((x) => `${x.kind}:${x.fromLid}->${x.toLid}`),
      'つながりまで引き継いだ',
    ).toEqual([`structural:f1->${copy.lid}`]);
    // 🔴 できた複製を選ぶ(続けて直せる)
    expect(st.selectedLid, '複製が選ばれていない').toBe(copy.lid);
    // 🔴 言い方は「『元の題名 (コピー)』を作りました」(「1 件を『はこ』へコピーしました」ではない)
    expect(r.notices, '複製の知らせが出ていない').toContain('「会議メモ (コピー)」を作りました');
    expect(r.errors, `断られた: ${r.errors.join(' / ')}`).toEqual([]);
    // 元はそのまま
    expect(st.entryMetas.get('n1')!.title).toBe('会議メモ');
  });

  it('⚠ 印が複数あっても、押した行の 1 件だけを複製する(名前どおり)', async () => {
    const r = setup();
    r.d.dispatch({ type: 'SET_SCOPE', lid: null });
    // ルートの n2 と f1 に印 ── n2 の行を右クリックして複製
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'f1' });
    rightClick(r.row('n2'));
    r.press('duplicate-entry');
    await tick(30);
    expect(r.read, '押した行の 1 件だけを読むはず').toEqual(['n2']);
    const made = [...r.d.getState().entryMetas.values()].filter((m) => !['f1', 'n1', 'n2'].includes(m.lid));
    expect(made.map((m) => m.title)).toEqual(['相手 (コピー)']);
    // ルートの物はルートに
    expect(resolveCanonicalParents(r.d.getState().entryMetas, r.d.getState().relations).get(made[0]!.lid) ?? null).toBeNull();
  });

  it('⚠ 編集中は複製しない(理由を出す)', async () => {
    const r = setup();
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick(30);
    r.d.dispatch({ type: 'START_EDIT' });
    expect(r.d.getState().phase, '前提が崩れている(編集に入っていない)').toBe('editing');
    // 編集中の右クリックは灰色の項目になるので、受け手を直接押す(押せても断る門を見る)
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'duplicate-entry');
    btn.setAttribute('data-pkc-lid', 'n1');
    r.root.append(btn);
    btn.click();
    await tick(30);
    expect(r.d.getState().entryMetas.size, '編集中に複製した').toBe(3);
    expect(r.read, '編集中なのに本文を読みに行った').toEqual([]);
    expect(r.errors.at(-1) ?? '', '断りの理由が出ていない').toContain('複製');
  });

  it('🔑 字は 1 か所 ── 「操作を探す」と右クリックが同じ名前', () => {
    const cmd = KEY_COMMANDS.find((k) => k.id === 'duplicate-entry');
    expect(cmd, '「操作を探す」に無い').toBeDefined();
    expect(cmd!.label).toBe(ENTRY_ACTION_LABELS['duplicate-entry']);
    expect(copyTitle('あ')).toBe('あ (コピー)');
  });
});
