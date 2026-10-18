/** @vitest-environment happy-dom */
/**
 * 🔴 **スマートフォルダ・フォルダの直し 4 件**(台帳 #1852 束 N2。Gemini 裁定 = #1163 の依頼 85-4 / 85-5 / 85-8 / 85-9)。
 *
 * 1. 85-4 スマートフォルダを作ったら、そのまま中に入る(編集には入らない)
 * 2. 85-5 いま中に入っているフォルダの名前を変えたら、打ち終わった(確定でもやめるでも)後に元のフォルダの中へ戻る
 * 3. 85-8 フォルダを移した知らせは、中の件数も言う
 * 4. 85-9 本文に書いたスマートフォルダの条件が読めなかったら、条件バーが数を言う / 画面の字でも書ける
 *
 * ⚠ 台は実物(shell + BrowseRouter + binder + effect 層)── 「面が描く」と「binder が受ける」の合意は片方の test には書けない。
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
import {
  countUnreadSmartConds,
  readSmartSpec,
  SMART_ARCHETYPE,
  EMPTY_SMART,
  JA_FLAGS,
} from '../../src/features/smart/smart-spec';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const RENAME = '[data-pkc-field="row-rename"]';

function key(el: Element, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

function setup(
  metas: EntryMeta[],
  relations: Relation[] = [],
  bodies: Record<string, string> = {},
) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  let cur: 'filer' | 'launcher' = 'filer';
  d.onState((s) => browse.render(s, cur));
  const status: string[] = [];
  bindActions(root, d, {
    setBrowse: (m) => {
      cur = m as typeof cur;
      browse.render(d.getState(), cur);
    },
    showStatus: (t) => void status.push(t),
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (_e, opts) => ({ ...stubStamps(), ...(opts?.parent ? { parentWritten: true } : {}) }),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    smartScan: async () => ({ lids: [], total: 0 }),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const press = (attrs: Record<string, string>): void => {
    const b = document.createElement('button');
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    root.append(b);
    b.click();
    b.remove();
  };
  return { root, d, pane, status, press };
}

describe('85-4:スマートフォルダを作ったら、そのまま中に入る', () => {
  it('作った直後、左の一覧がそのスマートフォルダの中になり、編集には入らない', () => {
    const r = setup([meta('f1', 1, 'folder')]);
    r.press({ 'data-pkc-action': 'create-entry', 'data-pkc-archetype': SMART_ARCHETYPE });
    const st = r.d.getState();
    const made = [...st.entryMetas.values()].find((m) => m.archetype === SMART_ARCHETYPE);
    expect(made, '前提が崩れている(スマートフォルダが作られていない)').toBeDefined();
    expect(st.scopeLid, '作った中に入っていない').toBe(made!.lid);
    expect(st.phase, '編集に入ってしまった(条件バーは編集の外にしか出ない)').toBe('ready');
    expect(r.pane.querySelector('[data-pkc-field="smart-bar"]'), '条件バーが出ていない').not.toBeNull();
  });

  it('対照群:ふつうのノートを作っても、場所は動かず、編集に入る', () => {
    const r = setup([meta('f1', 1, 'folder')]);
    r.press({ 'data-pkc-action': 'create-entry', 'data-pkc-archetype': 'text' });
    const st = r.d.getState();
    expect(st.scopeLid).toBeNull();
    expect(st.phase).toBe('editing');
  });
});

describe('85-5:いま居るフォルダの名前を変えたら、打ち終わって元の中へ戻る', () => {
  const METAS = [meta('f1', 1, 'folder'), meta('n1', 2), meta('f2', 3, 'folder')];
  const RELS = [rel('r1', 'f1', 'n1')];
  const begin = (r: ReturnType<typeof setup>, lid: string): void =>
    r.press({ 'data-pkc-action': 'rename-entry-begin', 'data-pkc-entry': lid });

  it('確定(Enter)で戻る。打っている間は 1 つ上の階層に欄が出る', () => {
    const r = setup(METAS, RELS);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    begin(r, 'f1');
    const input = r.pane.querySelector<HTMLInputElement>(RENAME);
    expect(input, '入力欄が出ていない(前提)').not.toBeNull();
    expect(r.d.getState().scopeLid, '欄を出すために 1 つ上へ移っている(前提)').toBeNull();
    input!.value = '請求';
    key(input!, 'Enter');
    expect(r.d.getState().entryMetas.get('f1')?.title).toBe('請求');
    expect(r.d.getState().scopeLid, '打ち終わっても上の階層にいたまま').toBe('f1');
  });

  it('やめる(Esc)でも戻る', () => {
    const r = setup(METAS, RELS);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    begin(r, 'f1');
    key(r.pane.querySelector<HTMLInputElement>(RENAME)!, 'Escape');
    expect(r.d.getState().entryMetas.get('f1')?.title).toBe('t-f1');
    expect(r.d.getState().scopeLid).toBe('f1');
  });

  it('他所を押して確定したときも戻る', () => {
    const r = setup(METAS, RELS);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    begin(r, 'f1');
    const input = r.pane.querySelector<HTMLInputElement>(RENAME)!;
    input.value = 'ぼかし';
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(r.d.getState().entryMetas.get('f1')?.title).toBe('ぼかし');
    expect(r.d.getState().scopeLid).toBe('f1');
  });

  it('打っている間に user が別の階層へ入っていたら、勝手に戻さない', () => {
    const r = setup(METAS, RELS);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    begin(r, 'f1');
    const input = r.pane.querySelector<HTMLInputElement>(RENAME)!;
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f2' });
    key(input, 'Escape');
    expect(r.d.getState().scopeLid, '別の階層に居たのに f1 へ戻された').toBe('f2');
  });

  it('対照群:中に入っていないフォルダの名前を変えても、場所は動かない', () => {
    const r = setup(METAS, RELS);
    begin(r, 'f2');
    const input = r.pane.querySelector<HTMLInputElement>(RENAME)!;
    expect(input, '前提').not.toBeNull();
    key(input, 'Escape');
    expect(r.d.getState().scopeLid).toBeNull();
  });

  it('次の改名には前回の「戻り先」を持ち越さない', () => {
    const r = setup(METAS, RELS);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    begin(r, 'f1');
    key(r.pane.querySelector<HTMLInputElement>(RENAME)!, 'Escape'); // f1 の中へ戻る
    r.d.dispatch({ type: 'SET_SCOPE', lid: null });
    begin(r, 'f2'); // ふつうの改名
    key(r.pane.querySelector<HTMLInputElement>(RENAME)!, 'Escape');
    expect(r.d.getState().scopeLid, '前回の戻り先(f1)へ飛んだ').toBeNull();
  });
});

describe('85-8:フォルダを移した知らせは、中の件数も言う', () => {
  const METAS = [
    meta('t', 1, 'folder'),
    meta('f', 2, 'folder'),
    meta('d', 3),
    meta('x', 4),
    meta('s1', 5),
  ];
  const RELS = [rel('r1', 'f', 'd'), rel('r2', 'f', 'x')];

  /** 右クリックの「移す…」と同じ口(`move-to-folder`)を、入れ先を選ぶ小さな画面ごと通す。 */
  async function moveTo(r: ReturnType<typeof setup>, lids: string[], to: string): Promise<void> {
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: lids[0]! });
    for (const l of lids.slice(1)) r.d.dispatch({ type: 'TOGGLE_SELECT', lid: l });
    const row = r.pane.querySelector<HTMLElement>(`[data-pkc-entry="${lids[0]}"]`)!;
    r.press({ 'data-pkc-action': 'move-to-folder', 'data-pkc-entry': row.getAttribute('data-pkc-entry')! });
    await tick();
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((x) => x.open);
    expect(dialog, '入れ先を選ぶ画面が出ていない').toBeDefined();
    dialog!.querySelector<HTMLElement>(`[data-pkc-field="entry-pick-row"][data-pkc-lid="${to}"]`)!.click();
    await tick();
  }

  it('中に 2 件あるフォルダを 1 つ移すと「(中の 2 件ごと)」と言う', async () => {
    const r = setup(METAS, RELS);
    await moveTo(r, ['f'], 't');
    expect(r.d.getState().notice).toBe('「t-f」(中の 2 件ごと)を「t-t」へ入れました');
  });

  it('フォルダとふつうのノートを一緒に移すと「中身を含め N 件」と言う', async () => {
    const r = setup(METAS, RELS);
    await moveTo(r, ['f', 's1'], 't');
    expect(r.d.getState().notice).toBe('2 件(中身を含め 4 件)を「t-t」へ入れました');
  });

  it('対照群:中が空のフォルダ・ふつうのノートは今までどおり', async () => {
    const r = setup(METAS, RELS);
    await moveTo(r, ['s1'], 't');
    expect(r.d.getState().notice).toBe('1 件を「t-t」へ入れました');
    const r2 = setup([meta('t', 1, 'folder'), meta('e', 2, 'folder')]);
    await moveTo(r2, ['e'], 't');
    expect(r2.d.getState().notice).toBe('1 件を「t-t」へ入れました');
  });
});

describe('85-9:本文に書いた条件が読めなかったら言う / 画面の字でも書ける', () => {
  it('画面の選択肢の字(種類・日数・有無)でも読める(条件ごとの字で)', () => {
    const spec = readSmartSpec(
      ['---', 'smart-kind: ノート', 'smart-updated: 30 日以内', 'smart-created: 1 年以内', 'smart-dated: 先頭に書いてある', 'smart-tasks: 項目が無い', 'smart-open-tasks: 未処理がある', '---', ''].join('\n'),
    );
    expect(spec).toMatchObject({ kind: 'text', updatedDays: 30, createdDays: 365, dated: true, tasks: false, openTasks: true });
  });

  it('「ある / ない」でも書ける。⚠ 条件ごとの字は別の条件では読まない(取り違えない)', () => {
    expect(readSmartSpec('---\nsmart-dated: ある\n---\n').dated).toBe(true);
    expect(readSmartSpec('---\nsmart-tasks: ない\n---\n').tasks).toBe(false);
    // 日付の字は「未処理がある」を読まない
    expect(readSmartSpec('---\nsmart-dated: 未処理がある\n---\n').dated).toBeNull();
  });

  it('JA_FLAGS は画面の選択肢の字そのもの(filer.ts の SMART_FIELD_UI と食い違わない)', () => {
    // 画面の字との突き合わせは、描いた条件バーの <option> から引く
    const r = setup([meta('s', 1, SMART_ARCHETYPE)]);
    r.d.dispatch({ type: 'SET_SCOPE', lid: 's' });
    const labelsOf = (field: string): string[] =>
      [...r.pane.querySelectorAll(`[data-pkc-field="smart-${field}"] option`)].map((o) => o.textContent ?? '');
    expect(labelsOf('dated')).toEqual(expect.arrayContaining([...JA_FLAGS.dated]));
    expect(labelsOf('tasks')).toEqual(expect.arrayContaining([...JA_FLAGS.tasks]));
    expect(labelsOf('openTasks')).toEqual(expect.arrayContaining([...JA_FLAGS.openTasks]));
  });

  it('読めなかった条件の数: 値の読めない条件・知らない smart- の key・上限を超えたタグ', () => {
    expect(countUnreadSmartConds('---\nsmart-kind: ノート\nsmart-tags: [a]\n---\n'), '全部読めるなら 0').toBe(0);
    expect(countUnreadSmartConds('---\nsmart-kind: なんだこれ\n---\n')).toBe(1);
    expect(countUnreadSmartConds('---\nsmart-updated: ずっと前\nsmart-dated: たぶん\n---\n')).toBe(2);
    expect(countUnreadSmartConds('---\nsmart-kinds: text\n---\n'), '綴りの間違い').toBe(1);
    const tags = Array.from({ length: 10 }, (_, i) => `t${i}`).join(', ');
    expect(countUnreadSmartConds(`---\nsmart-tags: [${tags}]\n---\n`), '9 個目以降の 2 つ').toBe(2);
    expect(countUnreadSmartConds('---\nsmart-kind:\n---\n'), '値が空は「書いていない」').toBe(0);
    expect(countUnreadSmartConds('ふつうの本文'), '条件を持たない本文').toBe(0);
  });

  it('条件バー:全部読めなくて「条件を選んでください」のときも、読めなかった数を別の 1 行で言う', async () => {
    const body = '---\nsmart-kind: なんだこれ\nsmart-foo: 1\n---\n説明';
    const r = setup([meta('s', 1, SMART_ARCHETYPE)], [], { s: body });
    r.d.dispatch({ type: 'SET_SCOPE', lid: 's' });
    await tick(30);
    const bar = r.pane.querySelector('[data-pkc-field="smart-bar"]');
    expect(bar, '前提:条件バーが出ている').not.toBeNull();
    expect(bar!.querySelector('[data-pkc-field="smart-why"]')?.textContent).toContain('条件を選んでください');
    expect(bar!.querySelector('[data-pkc-field="smart-unread"]')?.textContent).toContain(
      '本文の条件のうち 2 個が読めていません',
    );
  });

  it('対照群:全部読めた条件には何も添えない', async () => {
    const r = setup([meta('s', 1, SMART_ARCHETYPE)], [], { s: '---\nsmart-kind: ノート\n---\n' });
    r.d.dispatch({ type: 'SET_SCOPE', lid: 's' });
    await tick(30);
    const bar = r.pane.querySelector('[data-pkc-field="smart-bar"]');
    expect(bar).not.toBeNull();
    expect(bar!.querySelector('[data-pkc-field="smart-unread"]')).toBeNull();
    // 画面の字(ノート)が読めている ── 条件は空ではない
    expect(bar!.querySelector('[data-pkc-field="smart-why"]')?.textContent).not.toContain('条件を選んでください');
  });

  it('SMART_SCANNED の unreadable が 0 / 省略なら state に載せない', () => {
    const r = setup([meta('s', 1, SMART_ARCHETYPE)]);
    r.d.dispatch({ type: 'SMART_SCANNED', lid: 's', lids: [], total: 0, spec: EMPTY_SMART });
    expect(r.d.getState().smartHits.get('s')?.unreadable).toBeUndefined();
    r.d.dispatch({ type: 'SMART_SCANNED', lid: 's', lids: [], total: 0, spec: EMPTY_SMART, unreadable: 3 });
    expect(r.d.getState().smartHits.get('s')?.unreadable).toBe(3);
  });
});
