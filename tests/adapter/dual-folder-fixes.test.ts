/** @vitest-environment happy-dom */
/**
 * #1087 のうち 2 ペインの 2 件(コピーが保存の書込を待つ / 移す口 4 つで「元に戻す」が出る)。
 * ⚠ 輪になるフォルダの断りは worker の仕事なので `storage-worker.test.ts` に置く。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import {
  clearDualMoveOffer,
  currentDualMoveOffer,
} from '../../src/adapter/ui/render/dual-move-undo';
import { openDialog } from './dialog-helper';

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
const METAS = [meta('f1', 1, 'はこ', 'folder'), meta('a', 2, 'あ'), meta('b', 3, 'い')];
const RELS: Relation[] = [];
const tick = () => new Promise((r) => setTimeout(r, 0));
const PKC_DRAG_DUAL = 'application/x-pkc-lids';
function dtStub(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types(): string[] {
      return [...data.keys()];
    },
    getData: (t: string) => data.get(t) ?? '',
    setData: (t: string, v: string) => void data.set(t, v),
    files: { length: 0, item: () => null },
    items: [] as unknown[],
  };
}
function dragEv(type: string, dt: ReturnType<typeof dtStub>): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  return e;
}

interface Gate {
  /** 保存の書込がまだ並んでいる間 `true`。 */
  pending: boolean;
  release: () => void;
}

function setup() {
  document.body.innerHTML = '';
  clearDualMoveOffer();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  let releaseFn: () => void = () => {};
  const gate: Gate = { pending: true, release: () => releaseFn() };
  const settled = new Promise<void>((resolve) => {
    releaseFn = () => {
      gate.pending = false;
      resolve();
    };
  });
  const statuses: string[] = [];
  const bodiesRead: string[] = [];
  bindActions(root, d, {
    // 書込が並んでいる間に読むと古い本文が返る(実物の worker が、書込より先に読むと古いのと同じ)
    readBodies: async (lids) =>
      new Map(
        lids.map((l) => {
          const body = gate.pending ? '# 古い本文' : '# 最新の本文';
          bodiesRead.push(body);
          return [l, body];
        }),
      ),
    settle: () => settled,
    showStatus: (t: string) => void statuses.push(t),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  const region = document.createElement('div');
  root.append(region);
  const r = new DualFilerRenderer(region);
  d.onState((st) => r.render(st));
  r.render(d.getState());
  const parentsOf = (lid: string): string[] =>
    d
      .getState()
      .relations.filter((x) => x.toLid === lid && x.kind === 'structural')
      .map((x) => x.fromLid);
  return { root, d, region, gate, statuses, bodiesRead, parentsOf };
}

describe('2 ペインのコピー(#1087)', () => {
  it('🔴 保存の書込が並んでいる間に押すと、書込が着くまで読まず、着いた後の最新の本文でコピーする', async () => {
    const { d, region, gate, bodiesRead } = setup();
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    region
      .querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    expect(bodiesRead, '書込が並んでいる間に本文を読んでいる(古い本文になる)').toEqual([]);
    expect([...d.getState().entryMetas.keys()].sort(), '待たずに作っている').toEqual(['a', 'b', 'f1']);
    gate.release();
    await tick();
    await tick();
    expect(bodiesRead, '書込が着いた後に読んでいない').toEqual(['# 最新の本文']);
    const made = [...d.getState().entryMetas.values()].find((m) => m.title === 'あ' && m.lid !== 'a');
    expect(made, '前提: コピーができていない').toBeTruthy();
    expect(
      d.getState().relations.some((r) => r.fromLid === 'f1' && r.toLid === made!.lid),
      '前提: 行き先に入っていない',
    ).toBe(true);
  });

  it('🔴 コピーの読み待ちの間に編集へ入ると、作れていないのに「コピーしました」と言わない', async () => {
    const { d, region, gate, statuses } = setup();
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    region
      .querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '本文\n' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集に入れていない').toBe('editing');
    gate.release();
    await tick();
    await tick();
    expect(d.getState().entryMetas.size, '前提: 編集中なのに作られた').toBe(METAS.length);
    expect(statuses.some((t) => t.includes('コピーしました')), '作れていないのに成功と言った').toBe(false);
    expect(d.getState().error ?? '', '失敗が言われていない').toContain('コピーしてください');
  });
});

describe('移す口 4 つで「元に戻す」が出る(#1087)', () => {
  const pane = (region: HTMLElement, side: string) =>
    region.querySelector<HTMLElement>(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`)!;

  it('🔴 ドラッグで落として移すと、戻す材料が出て、押すと元の親へ戻る', async () => {
    const { root, d, region, gate, parentsOf } = setup();
    gate.release();
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    pane(region, 'right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'a' })));
    await tick();
    expect(parentsOf('a'), '前提: 移せていない').toEqual(['f1']);
    expect(currentDualMoveOffer()?.moves.map((m) => m.lid), 'ドラッグの後に戻す口が出ない').toEqual(['a']);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'undo-dual-move');
    root.append(b);
    b.click();
    expect(parentsOf('a'), '戻っていない').toEqual([]);
  });

  it('🔴 「移す…」の選択窓で移すと、戻す材料が出て、押すと元の親へ戻る', async () => {
    const { root, gate, parentsOf } = setup();
    gate.release();
    const host = document.createElement('div');
    host.setAttribute('data-pkc-entry', 'a');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'move-to-folder');
    host.append(btn);
    root.append(host);
    btn.click();
    await tick();
    await tick();
    const list = openDialog()?.querySelector('[data-pkc-field="entry-pick-list"]') ?? null;
    const choice = [...(list?.querySelectorAll('button') ?? [])].find((x) =>
      (x.textContent ?? '').startsWith('はこ'),
    ) as HTMLElement | undefined;
    expect(choice, '前提: 選択窓に行き先が出ていない').toBeTruthy();
    choice!.click();
    await tick();
    await tick();
    expect(parentsOf('a'), '前提: 移せていない').toEqual(['f1']);
    expect(currentDualMoveOffer()?.moves.map((m) => m.lid), '選択窓の後に戻す口が出ない').toEqual(['a']);
    const u = document.createElement('button');
    u.setAttribute('data-pkc-action', 'undo-dual-move');
    root.append(u);
    u.click();
    expect(parentsOf('a'), '戻っていない').toEqual([]);
  });

  it('対照群: 動かなかった回(いまの親へ落とし直し)は戻す口を出さない', async () => {
    const { region, gate } = setup();
    gate.release();
    pane(region, 'right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'a' }))); // 右もルート → もう居る
    await tick();
    expect(currentDualMoveOffer(), '動いていないのに戻す口が出る').toBeNull();
  });
});
