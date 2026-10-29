/** @vitest-environment happy-dom */
/**
 * 🔴 **コマンドシェルの画面と、2 ペインのコマンドライン**(#274 / #241)── 実物の binder / 描画器を繋いで、user が打って見えるものを見る。
 *
 * ①シェルの面がある(ViewMode・タイル・左のタブ・鍵)②打って Enter で結果が出る ③🔴 移す / 作る / 追記 が**保存の経路まで**届く
 * ④↑ で履歴・Tab で補完 ⑤表の行を押すとそのノートが選ばれる ⑥2 ペインのコマンドラインが**同じコマンド表**で選んだ行に効く
 * ⑦失敗は失敗として出る
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isAsidePane, isViewMode, leavesOnSelect, viewModeLabel } from '../../src/adapter/state/app-state';
import { BUILTIN_KINDS, withBuiltinTiles } from '../../src/features/launcher/tiles';
import { BROWSE_MODES, hasPaneHome, homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { appDualShellSession, appShellSession, paintShellBlock } from '../../src/adapter/ui/render/cmdshell';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string, archetype = 'text', order = 1): EntryMeta {
  return { lid, title, archetype, createdAt: null, updatedAt: '2026-10-01T00:00:00Z', entryOrder: order, status: null, date: null, archived: false, bodyChars: 0 };
}
const rel = (from: string, to: string): Relation => ({ id: `${from}-${to}`, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null });

function setup() {
  appShellSession.blocks.length = 0;
  appShellSession.cwd = null;
  appShellSession.last = [];
  appShellSession.history = [];
  appDualShellSession.blocks.length = 0;
  appDualShellSession.last = [];
  appDualShellSession.history = [];
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  const parents: Array<{ lid: string; parentLid: string | null }> = [];
  const created: Array<{ lid: string; title: string; body: string }> = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    deleteEntry: async () => {},
    setEntryParent: async (lid: string, parentLid: string | null) => {
      parents.push({ lid, parentLid });
      return undefined as never;
    },
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; title: string; body: string }) => {
      created.push(e);
      return stubStamps();
    },
    getBody: async () => '',
  } as never);
  bindActions(root, d);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('f1', '資料', 'folder', 1), meta('f2', 'アーカイブ', 'folder', 2), meta('n1', '議事録', 'text', 3), meta('n2', '買い物メモ', 'text', 4)],
    relations: [rel('f1', 'n1')],
  });
  return { root, d, parents, created };
}

function press(input: HTMLInputElement, key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  return ev;
}
function typeInto(input: HTMLInputElement, v: string): void {
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function run(input: HTMLInputElement, line: string): Promise<void> {
  typeInto(input, line);
  press(input, 'Enter');
  await tick();
}

describe('シェルの入口', () => {
  it('ViewMode・左のタブ・別窓の退避先・タイル・鍵が揃っている', () => {
    expect(isViewMode('shell')).toBe(true);
    expect(isAsidePane('shell')).toBe(true);
    // ノートを選んでも面が退かない(`.` を相手にするコマンドの途中で出力が消えない)
    expect(leavesOnSelect('shell')).toBe(false);
    expect(viewModeLabel('shell')).toBe('コマンドシェル');
    expect(BROWSE_MODES).toContain('shell');
    expect(BROWSE_TABS.map((t) => t.mode)).toContain('shell');
    // 別窓が塞がれたときの退避先は中央ではなく左のタブ
    expect(homeTabOf('shell')).toBe('shell');
    expect(hasPaneHome('shell')).toBe(true);
    expect(BUILTIN_KINDS.has('shell')).toBe(true);
    const tile = withBuiltinTiles([], { office: false }).find((t) => t.kind === 'shell');
    expect(tile?.title).toBe('コマンドシェル');
    expect(KEY_COMMANDS.some((c) => c.id === 'view-shell')).toBe(true);
  });
});

describe('シェルの面', () => {
  let ctx: ReturnType<typeof setup>;
  let input: HTMLInputElement;
  const log = (): string => ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-field="shell-log"]')!.textContent ?? '';
  beforeEach(() => {
    ctx = setup();
    ctx.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'shell' });
    input = ctx.root.querySelector<HTMLInputElement>('[data-pkc-view-pane="shell"] [data-pkc-field="shell-input"]')!;
  });
  afterEach(() => {
    ctx.root.remove();
  });

  it('面があり、打つ欄・実行・履歴がある', () => {
    expect(input).not.toBeNull();
    expect(ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-action="shell-run"]')).not.toBeNull();
    expect(ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-action="shell-history-menu"]')).not.toBeNull();
  });

  it('ls を打って Enter で、表に行が出る。欄は空に戻る', async () => {
    await run(input, 'ls');
    expect(log()).toContain('資料/');
    expect(log()).toContain('買い物メモ');
    expect(input.value).toBe('');
    expect(log()).not.toContain('議事録'); // 資料の中は ls 資料 で見る
  });

  it('🔴 実行ボタン(マウス)でも同じ', async () => {
    typeInto(input, 'pwd');
    ctx.root.querySelector<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-action="shell-run"]')!.click();
    await tick();
    expect(log()).toContain('/');
    expect(appShellSession.history).toEqual(['pwd']);
  });

  it('🔴 mv は保存の経路まで届く(find → mv #1 で番号が使える)', async () => {
    await run(input, 'find 買い物');
    expect(log()).toContain('買い物メモ');
    await run(input, 'mv #1 資料');
    expect(ctx.d.getState().relations.some((r) => r.fromLid === 'f1' && r.toLid === 'n2')).toBe(true);
    expect(ctx.parents).toContainEqual({ lid: 'n2', parentLid: 'f1' });
    expect(log()).toContain('移しました');
  });

  it('🔴 mv の結果の文が出る。すでに入っているのは失敗ではない', async () => {
    await run(input, 'mv 議事録 アーカイブ');
    expect(log()).toContain('「アーカイブ」へ移しました');
    await run(input, 'mv 議事録 アーカイブ');
    expect(log()).toContain('すでに「アーカイブ」に入っています');
    const last = [...ctx.root.querySelectorAll('[data-pkc-view-pane="shell"] [data-pkc-field="shell-block"]')].pop()!;
    expect(last.getAttribute('data-pkc-state')).toBe('done');
  });

  it('🔴 new で作ったノートが保存され、本文は \\n で改行できる', async () => {
    await run(input, 'new 資料/新規メモ 一行目 \\n二行目');
    const made = [...ctx.d.getState().entryMetas.values()].find((m) => m.title === '新規メモ');
    expect(made).toBeDefined();
    expect(ctx.d.getState().relations.some((r) => r.fromLid === 'f1' && r.toLid === made!.lid)).toBe(true);
    await tick();
    expect(ctx.created.find((c) => c.title === '新規メモ')?.body).toBe('一行目 \n二行目');
  });

  it('🔴 cd すると「現在地:」の行が変わる(state が動かなくても)', async () => {
    const cwd = (): string => ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-field="shell-cwd"]')!.textContent ?? '';
    expect(cwd()).toBe('現在地: /');
    await run(input, 'cd 資料');
    expect(cwd()).toBe('現在地: /資料');
    await run(input, 'cd ..');
    expect(cwd()).toBe('現在地: /');
  });

  it('mkdir と rename は整理案と同じ実体で、題名が変わる', async () => {
    await run(input, 'mkdir 新しいフォルダ');
    expect([...ctx.d.getState().entryMetas.values()].some((m) => m.title === '新しいフォルダ' && m.archetype === 'folder')).toBe(true);
    await run(input, 'rename 買い物メモ 買い物リスト');
    expect(ctx.d.getState().entryMetas.get('n2')?.title).toBe('買い物リスト');
  });

  it('断りは失敗として出る(違うノートに黙って当てない)', async () => {
    await run(input, 'mv 存在しない 資料');
    const block = ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-field="shell-block"]')!;
    expect(block.getAttribute('data-pkc-state')).toBe('failed');
    expect(log()).toContain('存在しない');
    expect(ctx.parents).toEqual([]);
  });

  it('知らないコマンドは候補を添えて断る。履歴には積まない', async () => {
    await run(input, 'mkd');
    expect(log()).toContain('mkdir');
    expect(appShellSession.history).toEqual([]);
  });

  it('↑ で履歴が戻り、↓ で打ちかけに戻る', async () => {
    await run(input, 'pwd');
    await run(input, 'ls');
    typeInto(input, 'draft');
    const up = press(input, 'ArrowUp');
    expect(up.defaultPrevented).toBe(true);
    expect(input.value).toBe('ls');
    press(input, 'ArrowUp');
    expect(input.value).toBe('pwd');
    press(input, 'ArrowDown');
    press(input, 'ArrowDown');
    expect(input.value).toBe('draft');
  });

  it('Tab でコマンドを補完し、候補はボタンで押せる(マウスだけで完結)', async () => {
    typeInto(input, 'mk');
    const tab = press(input, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(input.value).toBe('mkdir ');
    typeInto(input, 'mv 議');
    const cand = ctx.root.querySelector<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-action="shell-pick"]');
    expect(cand?.textContent).toContain('議事録');
    cand!.click();
    expect(input.value).toBe('mv 議事録 ');
  });

  it('履歴ボタンの一覧を押すと入力欄に戻る', async () => {
    await run(input, 'pwd');
    ctx.root.querySelector<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-action="shell-history-menu"]')!.click();
    const item = ctx.root.querySelector<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-region="shell-complete"] [data-pkc-action="shell-recall"]');
    expect(item?.textContent).toBe('pwd');
    item!.click();
    expect(input.value).toBe('pwd');
  });

  it('表の行は既存の action を押す(別ウィンドウでは付箋のウィンドウ、左のタブ・2 ペインではノートを選ぶ)', async () => {
    await run(input, 'ls');
    const row = [...ctx.root.querySelectorAll<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-field="shell-table"] tr[data-pkc-entry]')].find((r) =>
      r.textContent?.includes('買い物メモ'),
    )!;
    expect(row.getAttribute('data-pkc-action')).toBe('open-note-window');
    // 左のタブ・2 ペインと同じ描き方の既定は、ノートを選ぶ
    const pane = paintShellBlock(appShellSession.blocks[0]!);
    const paneRow = [...pane.querySelectorAll<HTMLElement>('tr[data-pkc-entry]')].find((r) => r.textContent?.includes('買い物メモ'))!;
    expect(paneRow.getAttribute('data-pkc-action')).toBe('select-entry');
    ctx.root.append(pane);
    paneRow.click();
    await tick();
    expect(ctx.d.getState().selectedLid).toBe('n2');
    expect(ctx.d.getState().viewMode).toBe('shell');
  });

  it('🔴 「履歴を消す」ボタンで、端末の履歴が空になる', async () => {
    await run(input, 'pwd');
    expect(appShellSession.history).toEqual(['pwd']);
    ctx.root.querySelector<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-action="shell-history-clear"]')!.click();
    expect(appShellSession.history).toEqual([]);
  });

  it('コピー・出力を消す', async () => {
    await run(input, 'ls');
    expect(ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-action="shell-copy-block"]')).not.toBeNull();
    ctx.root.querySelector<HTMLElement>('[data-pkc-view-pane="shell"] [data-pkc-action="shell-clear"]')!.click();
    expect(ctx.root.querySelector('[data-pkc-view-pane="shell"] [data-pkc-field="shell-block"]')).toBeNull();
    expect(appShellSession.history).toEqual(['ls']);
  });

  it('do で「操作を探す」の操作を名前で呼べる(一致が複数なら候補)', async () => {
    await run(input, 'ops 設定');
    expect(log()).toContain('設定');
    await run(input, 'do 該当しない操作名');
    expect(log()).toContain('当てはまる操作はありません');
  });
});

describe('2 ペインのコマンドライン', () => {
  let ctx: ReturnType<typeof setup>;
  let input: HTMLInputElement;
  const out = (): string => ctx.root.querySelector('[data-pkc-region="dual-cmd-out"]')!.textContent ?? '';
  beforeEach(() => {
    ctx = setup();
    ctx.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    input = ctx.root.querySelector<HTMLInputElement>('[data-pkc-region="dual-cmdline"] [data-pkc-field="shell-input"]')!;
  });
  afterEach(() => {
    ctx.root.remove();
  });

  it('コマンドラインが 2 ペインの中にあり、シェルとは別の出力・同じコマンド表', () => {
    expect(input).not.toBeNull();
    expect(ctx.root.querySelector('[data-pkc-region="dual-cmdline"][data-pkc-session="dual"]')).not.toBeNull();
  });

  it('🔴 選んだ行へ mv(行き先を省くと反対側)', async () => {
    ctx.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    ctx.d.dispatch({ type: 'DUAL_FOCUS', side: 'left' });
    ctx.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'n2', mode: 'set' });
    await run(input, 'mv');
    expect(ctx.d.getState().relations.some((r) => r.fromLid === 'f2' && r.toLid === 'n2')).toBe(true);
    expect(out()).toContain('アーカイブ');
  });

  it('mv <先> は選んだ行を名指しのフォルダへ。-n は何も動かさない', async () => {
    ctx.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'n2', mode: 'set' });
    await run(input, 'mv 資料 -n');
    expect(ctx.d.getState().relations.some((r) => r.toLid === 'n2')).toBe(false);
    expect(out()).toContain('試し実行');
    await run(input, 'mv 資料');
    expect(ctx.d.getState().relations.some((r) => r.fromLid === 'f1' && r.toLid === 'n2')).toBe(true);
  });

  it('select で行を選び、cd で焦点のペインの場所が変わる', async () => {
    await run(input, 'cd 資料');
    expect(ctx.d.getState().dual.left.tabs[ctx.d.getState().dual.left.active]!.scopeLid).toBe('f1');
    await run(input, 'select 議事');
    expect(ctx.d.getState().dual.left.selection).toEqual(['n1']);
  });

  it('シェル専用のコマンド(sql)は 2 ペインでは使えない', async () => {
    await run(input, 'sql SELECT 1');
    expect(out()).toContain('コマンドはありません');
  });
});
