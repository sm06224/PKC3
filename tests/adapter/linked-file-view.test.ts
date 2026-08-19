/** @vitest-environment happy-dom */
/**
 * 🔴 **元ファイルへの書き戻しが画面から届く**(2026-08-05、user 報告
 * 「マークダウンファイルに紐付けれるけど、取り込みもスポットの編集プレビュー導線も
 * 存在しない」)。
 *
 * ⚠ 紐づけは **取込の後**に届く(`FILE_LINKED`)── 情報ペインの断面指紋が
 * meta と phase だけだと、**開いた直後は導線が出ない**(実際そうなる形だった)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState, reduce, type AppState } from '@adapter/state/app-state';
import { InspectorRenderer } from '@adapter/ui/render/inspector';
import { bindActions, type BinderServices } from '@adapter/ui/actions/binder';
import type { EntryMeta } from '@core/model/entry-meta';

const meta = (lid: string, order: number): EntryMeta => ({
  lid,
  title: `題 ${lid}`,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const booted = (cid: string, lids: string[]): Parameters<typeof reduce>[1] => ({
  type: 'SYS_BOOTED',
  cid,
  metas: lids.map((l, i) => meta(l, i + 1)),
  relations: [],
});

function run(state: AppState, actions: Parameters<typeof reduce>[1][]): AppState {
  let s = state;
  for (const a of actions) s = reduce(s, a).state;
  return s;
}

describe('紐づけの state(FILE_LINKED)', () => {
  it('lid → ファイル名を持つ', () => {
    const s = run(initialState, [
      booted('c1', ['n1']),
      { type: 'FILE_LINKED', lid: 'n1', name: 'メモ.md' },
    ]);
    expect(s.linkedFiles.get('n1')).toBe('メモ.md');
  });

  it('🔴 居ない entry には紐づけない(嘘の導線を作らない)', () => {
    const s = run(initialState, [
      booted('c1', ['n1']),
      { type: 'FILE_LINKED', lid: 'no-such', name: 'x.md' },
    ]);
    expect(s.linkedFiles.size).toBe(0);
  });

  it('同じ名前の再通知では state を作り直さない(断面指紋を無駄に壊さない)', () => {
    const a = run(initialState, [
      booted('c1', ['n1']),
      { type: 'FILE_LINKED', lid: 'n1', name: 'x.md' },
    ]);
    const b = reduce(a, { type: 'FILE_LINKED', lid: 'n1', name: 'x.md' });
    expect(b.state).toBe(a);
  });

  it('🔴 削除すると紐づけも外れる(戻せない器を指す導線を残さない)', () => {
    const s = run(initialState, [
      booted('c1', ['n1', 'n2']),
      { type: 'FILE_LINKED', lid: 'n1', name: 'x.md' },
      { type: 'DELETE_ENTRY', lid: 'n1' },
    ]);
    expect(s.linkedFiles.has('n1')).toBe(false);
  });

  it('🔴 同じ container の再読込では残る(取込の直後に書き戻せる)', () => {
    // ⚠ 取込は `reload()` → `SYS_BOOTED` を通る ── ここで消すと、開いた直後に
    //    「元ファイル」が消えて書き戻せない
    const a = run(initialState, [
      booted('c1', ['n1']),
      { type: 'FILE_LINKED', lid: 'n1', name: 'x.md' },
    ]);
    const b = run(a, [booted('c1', ['n1', 'n2'])]);
    expect(b.linkedFiles.get('n1')).toBe('x.md');
    expect(b.linkedFiles, '変化が無いのに参照が変わった').toBe(a.linkedFiles);
  });

  it('🔴 消えた lid の紐づけは落とす', () => {
    const a = run(initialState, [
      booted('c1', ['n1', 'n2']),
      { type: 'FILE_LINKED', lid: 'n2', name: 'x.md' },
    ]);
    const b = run(a, [booted('c1', ['n1'])]);
    expect(b.linkedFiles.size).toBe(0);
  });

  it('🔴 別 container へ切り替えたら全部捨てる(他人のファイルへ書かない)', () => {
    const a = run(initialState, [
      booted('c1', ['n1']),
      { type: 'FILE_LINKED', lid: 'n1', name: 'x.md' },
    ]);
    const b = run(a, [booted('c2', ['n1'])]); // lid の偶然衝突
    expect(b.linkedFiles.size).toBe(0);
  });
});

beforeEach(() => {
  document.body.textContent = '';
});

function setupInspector() {
  const root = document.createElement('div');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  const d = new Dispatcher(initialState);
  const inspector = new InspectorRenderer(region);
  d.onState((s) => inspector.render(s));
  const writeBackFile = vi.fn();
  const services: BinderServices = { writeBackFile };
  bindActions(root, d, services);
  d.dispatch(booted('c1', ['n1', 'n2']));
  return { root, region, d, writeBackFile };
}

describe('情報ペインの導線', () => {
  it('紐づいていなければ、書き戻す導線は出ない', () => {
    const { region, d } = setupInspector();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(region.querySelector('[data-pkc-action="write-back-file"]')).toBeNull();
    expect(region.querySelector('[data-pkc-field="inspector-linked-file"]')).toBeNull();
  });

  it('🔴 紐づいたら、その場で導線とファイル名が出る(指紋に入っている)', () => {
    const { region, d } = setupInspector();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    // ⚠ ここが本題 ── meta も phase も変わらないまま紐づけだけが届く
    d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: '議事録.md' });
    expect(
      region.querySelector('[data-pkc-field="inspector-linked-file"]')?.textContent,
      '元ファイルが出ていない',
    ).toBe('議事録.md');
    const btn = region.querySelector<HTMLButtonElement>('[data-pkc-action="write-back-file"]');
    expect(btn, '書き戻す導線が出ていない').not.toBeNull();
    expect(btn!.title).toContain('議事録.md');
  });

  it('別のノートへ移ると導線は消える(紐づいていないものに出さない)', () => {
    const { region, d } = setupInspector();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'a.md' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(region.querySelector('[data-pkc-action="write-back-file"]')).toBeNull();
  });

  it('🔴 押すと、その lid で書き戻しが呼ばれる', () => {
    const { region, d, writeBackFile } = setupInspector();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'a.md' });
    region.querySelector<HTMLElement>('[data-pkc-action="write-back-file"]')!.click();
    expect(writeBackFile).toHaveBeenCalledWith('n1');
  });

  it('編集中は押せない(無言で何もしない導線を出さない)', () => {
    const { region, d } = setupInspector();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'a.md' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    const btn = region.querySelector<HTMLButtonElement>('[data-pkc-action="write-back-file"]');
    expect(btn!.disabled).toBe(true);
    expect(btn!.title).toContain('編集中');
  });

  it('🔴 書出し / 取込の最中は断る(user のファイルを巻き込まない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const region = document.createElement('div');
    root.append(region);
    const d = new Dispatcher(initialState);
    const inspector = new InspectorRenderer(region);
    d.onState((s) => inspector.render(s));
    const writeBackFile = vi.fn();
    bindActions(root, d, { writeBackFile, busy: () => true });
    d.dispatch(booted('c1', ['n1']));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'FILE_LINKED', lid: 'n1', name: 'a.md' });
    region.querySelector<HTMLElement>('[data-pkc-action="write-back-file"]')!.click();
    expect(writeBackFile).not.toHaveBeenCalled();
    // ⚠ **可視に断る**(無言の操作拒否を作らない)
    expect(d.getState().error).toContain('実行中');
  });
});
