/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 G1 / 依頼 227(A)・228。2 ペインで移した直後の「元に戻す」と、見ていたフォルダが消えたとき。
 *
 * - 227: 1 つのノートは 2 つ以上のフォルダに同時に入れられる。移すと元のフォルダからは全部外れるので、
 *   「元に戻す」も**入っていたフォルダ全部**へ戻す(直す前は正準の親 1 つにしか戻らず、もう片方は黙って消えた)。
 * - 228: 2 ペインのもう片方が消えたフォルダの中を開いていたら、残っている親を見せて、そう言う(直す前は黙ってルート)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { clearDualMoveOffer, currentDualMoveOffer } from '../../src/adapter/ui/render/dual-move-undo';
import { clearTrashOffer } from '../../src/adapter/ui/render/trash-undo';
import { paneScope } from '../../src/features/relation/dual-pane';

const meta = (lid: string, order: number, title: string, archetype = 'text'): EntryMeta => ({
  lid, title, archetype, createdAt: null, updatedAt: null, entryOrder: order,
  status: null, date: null, archived: false, bodyChars: null,
});
const rel = (id: string, from: string, to: string): Relation => ({
  id, fromLid: from, toLid: to, kind: 'structural', createdAt: null, updatedAt: null,
});
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const PKC_DRAG = 'application/x-pkc-lids';

function dtStub(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types(): string[] { return [...data.keys()]; },
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

function setup(metas: EntryMeta[], relations: Relation[]) {
  document.body.innerHTML = '';
  clearDualMoveOffer();
  clearTrashOffer();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  bindActions(root, d, { showStatus: () => {} });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const region = document.createElement('div');
  root.append(region);
  const r = new DualFilerRenderer(region);
  d.onState((st) => r.render(st));
  r.render(d.getState());
  const parentsOf = (lid: string): string[] =>
    d.getState().relations.filter((x) => x.toLid === lid && x.kind === 'structural').map((x) => x.fromLid).sort();
  return { root, d, region, parentsOf };
}

const pane = (region: HTMLElement, side: string): HTMLElement =>
  region.querySelector<HTMLElement>(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`)!;

function pressUndo(root: HTMLElement): void {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', 'undo-dual-move');
  root.append(b);
  b.click();
}

describe('227 2 つのフォルダに入っていたノートを移して「元に戻す」(台帳 #1852 G1)', () => {
  const METAS = [
    meta('f1', 1, 'あ箱', 'folder'),
    meta('f2', 2, 'い箱', 'folder'),
    meta('f3', 3, 'う箱', 'folder'),
    meta('n', 4, '二重のノート'),
    meta('s', 5, '一重のノート'),
  ];
  // n は f1 と f2 の両方に入っている。s は f1 だけ。
  const RELS = [rel('r1', 'f1', 'n'), rel('r2', 'f2', 'n'), rel('r3', 'f1', 's')];

  it('🔴 移すと元の 2 つから外れ、「元に戻す」で 2 つとも戻る(片方だけ消えない)', async () => {
    const { root, d, region, parentsOf } = setup(METAS, RELS);
    expect(parentsOf('n'), '前提: 2 つのフォルダに入っていない').toEqual(['f1', 'f2']);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f3' });
    pane(region, 'right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG]: 'n' })));
    await tick();
    expect(parentsOf('n'), '前提: 移せていない(元の 2 つから外れて、移し先だけ)').toEqual(['f3']);
    expect(currentDualMoveOffer()?.moves[0]?.fromAll?.slice().sort(), '入っていたフォルダ全部を控えていない').toEqual(['f1', 'f2']);
    pressUndo(root);
    expect(parentsOf('n'), '片方のフォルダにしか戻っていない').toEqual(['f1', 'f2']);
  });

  it('対照群: 1 つのフォルダだけに入っていたノートは、従来どおり控えを増やさず 1 つへ戻る', async () => {
    const { root, d, region, parentsOf } = setup(METAS, RELS);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f3' });
    pane(region, 'right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG]: 's' })));
    await tick();
    expect(parentsOf('s'), '前提: 移せていない').toEqual(['f3']);
    expect(currentDualMoveOffer()?.moves[0]?.fromAll, '1 つだけなのに全部の控えを持っている').toBeUndefined();
    pressUndo(root);
    expect(parentsOf('s')).toEqual(['f1']);
  });

  it('⚠ 入っていたフォルダの片方がその後なくなっていたら、残っている方へ戻る(居ない親へは入れない)', async () => {
    const { root, d, region, parentsOf } = setup(METAS, RELS);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f3' });
    pane(region, 'right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG]: 'n' })));
    await tick();
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'f2' });
    pressUndo(root);
    expect(parentsOf('n')).toEqual(['f1']);
  });
});

describe('228 見ていたフォルダが消えたら、残っている親を見せる(台帳 #1852 G1)', () => {
  const METAS = [
    meta('top', 1, '上の箱', 'folder'),
    meta('mid', 2, '中の箱', 'folder'),
    meta('x', 3, 'ノート'),
    meta('lone', 4, 'ひとり箱', 'folder'),
  ];
  const RELS = [rel('r1', 'top', 'mid'), rel('r2', 'mid', 'x')];

  it('🔴 もう片方が見ていたフォルダを消すと、親のフォルダへ移り、そう言う', () => {
    const { d } = setup(METAS, RELS);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'mid' });
    expect(paneScope(d.getState().dual.right), '前提: 右が「中の箱」を見ていない').toBe('mid');
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'mid' });
    expect(paneScope(d.getState().dual.right), '黙っていちばん上へ飛んだ').toBe('top');
    expect(d.getState().notice ?? '').toBe('開いていたフォルダがゴミ箱へ移ったので、親のフォルダ「上の箱」を見せています');
  });

  it('親も無い(いちばん上の)フォルダなら、いちばん上の階層を見せて、そう言う', () => {
    const { d } = setup(METAS, RELS);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'lone' });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'lone' });
    expect(paneScope(d.getState().dual.right)).toBeNull();
    expect(d.getState().notice ?? '').toBe('開いていたフォルダがゴミ箱へ移ったので、いちばん上の階層を見せています');
  });

  it('対照群: 見ていないフォルダを消しても、2 ペインの場所は動かず、この知らせも出ない', () => {
    const { d } = setup(METAS, RELS);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'mid' });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'lone' });
    expect(paneScope(d.getState().dual.right)).toBe('mid');
    expect(d.getState().notice ?? '').not.toContain('開いていたフォルダ');
  });

  it('🔴 自分で消した回の「ゴミ箱へ移しました」の知らせにも、行き先が載る(知らせの上書きで消えない)', async () => {
    const { root, d } = setup(METAS, RELS);
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'mid' });
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'top' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'mid', mode: 'set' });
    const del = document.createElement('button');
    del.setAttribute('data-pkc-action', 'dual-delete');
    del.setAttribute('data-pkc-side', 'left');
    root.append(del);
    del.click();
    await tick();
    expect(d.getState().entryMetas.has('mid'), '前提: 消せていない').toBe(false);
    const n = d.getState().notice ?? '';
    expect(n, 'ゴミ箱へ移した知らせが出ていない').toContain('をゴミ箱へ移しました');
    expect(n, '行き先の一文が上書きで消えた').toContain('親のフォルダ「上の箱」を見せています');
  });
});
