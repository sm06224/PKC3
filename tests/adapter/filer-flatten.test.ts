/** @vitest-environment happy-dom */
/**
 * 🔴 **フォルダの面の「中まで全部出す」**(#813 段②。🟣 Gemini 裁定 2026-10-01 の C)。
 *
 * 左の列の「一覧」タブを外す前に、**全件を平らに見る道**をフォルダの面に作る。帯の
 * 入り切りを入れると、いま居る場所の下の階層まで平らに出る(切 = いままでどおり)。
 *
 * ⚠ 行の決め方(純関数)は `tests/features/filer-flatten.test.ts`。ここは**画面の道中**:
 *   押す → 押された見た目 → 行が増える → 端末に憶える → 降りても追従 →
 *   平らに出している間の D&D・右クリック・上下の並べ替え。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { FilerFlattenStore } from '../../src/adapter/ui/render/filer-flatten';
import { openDialog } from './dialog-helper';

const meta = (lid: string, order: number, archetype = 'text'): EntryMeta => ({
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
});
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 木:  (root) ── f1 ── { f2 ── { b },  a }
 *             ── f3 ── { c }
 *             ── x
 */
const METAS = [
  meta('f1', 1, 'folder'),
  meta('f2', 2, 'folder'),
  meta('b', 3),
  meta('a', 4),
  meta('f3', 5, 'folder'),
  meta('c', 6),
  meta('x', 7),
];
const RELS = [rel('r1', 'f1', 'f2'), rel('r2', 'f1', 'a'), rel('r3', 'f2', 'b'), rel('r4', 'f3', 'c')];

const PKC_DRAG = 'application/x-pkc-lids';
function dataTransfer(initial: Record<string, string> = {}) {
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
function dragEvent(type: string, dt: ReturnType<typeof dataTransfer>, row: HTMLElement, clientY: number): void {
  // ⚠ happy-dom は要素に大きさを持たない ── 行に(top 100 / 高さ 20)を差す
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 100, bottom: 120, height: 20, left: 0, right: 200, width: 200, x: 0, y: 100 }),
  });
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  Object.defineProperty(e, 'clientY', { value: clientY });
  row.dispatchEvent(e);
}

function setup(metas: EntryMeta[] = METAS, relations: Relation[] = RELS) {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  let mode: 'list' | 'filer' | 'launcher' = 'list';
  d.onState((s) => browse.render(s, mode));
  // ⚠ 憶えるのは端末の保存(本物の store を **null の保存**で包んで観測する)
  const store = new FilerFlattenStore(null);
  const remembered: boolean[] = [];
  const parentCalls: Array<{ lid: string; parentLid: string | null }> = [];
  const reordered: string[] = [];
  bindActions(root, d, {
    setBrowse: (m) => {
      mode = m as typeof mode;
      browse.render(d.getState(), mode);
    },
    rememberFilerFlatten: (on) => {
      remembered.push(on);
      store.setEnabled(on);
    },
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async (lid) => {
      reordered.push(lid);
      return stubStamps();
    },
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async (lid, parentLid) => {
      parentCalls.push({ lid, parentLid });
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const q = <T extends HTMLElement>(sel: string) => pane.querySelector<T>(sel);
  const rows = (): string[] =>
    [...pane.querySelectorAll('tbody [data-pkc-entry]')].map((r) => r.getAttribute('data-pkc-entry')!);
  const toggle = () => q<HTMLButtonElement>('[data-pkc-field="filer-flatten"]');
  return { root, d, pane, q, rows, toggle, store, remembered, parentCalls, reordered };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('🔴 「中まで全部出す」── 押す道中(#813 段②)', () => {
  it('帯にボタンが在り、切のときは押された見た目ではない(行は直下だけ = いままでどおり)', () => {
    const { rows, toggle } = setup();
    const b = toggle();
    expect(b, 'ルートの帯に「中まで全部出す」が無い').not.toBeNull();
    expect(b!.textContent).toBe('中まで全部出す');
    expect(b!.getAttribute('aria-pressed')).toBe('false');
    expect(rows(), '切なのに直下だけでない').toEqual(['f1', 'f3', 'x']);
  });

  it('🔴 押された見た目の規則が在る(属性だけでなく、他の入り切りと同じ器)', () => {
    const { toggle } = setup();
    // ⚠ 濃さの規則は `[data-pkc-choice-btn][aria-pressed='true']` が持つ ── その器に載っていること
    expect(toggle()!.hasAttribute('data-pkc-choice-btn'), '濃さの規則が当たる器でない').toBe(true);
  });

  it('🔴 押すと全件が平らに出て、押された見た目になり、端末に憶える', async () => {
    const { rows, toggle, d, remembered, store } = setup();
    toggle()!.click();
    await tick();
    expect(d.getState().filerFlatten, '旗が立っていない').toBe(true);
    expect(rows(), '全件が出ていない').toEqual(['f1', 'f2', 'b', 'a', 'f3', 'c', 'x']);
    expect(rows().length, '直下(3 件)より多いこと').toBeGreaterThan(3);
    expect(toggle()!.getAttribute('aria-pressed'), '押された見た目になっていない').toBe('true');
    expect(remembered, '憶えていない(次に開くと戻っている)').toEqual([true]);
    expect(store.enabled(), '端末の保存に書いていない').toBe(true);
  });

  it('もう一度押すと、いままでどおり直下だけに戻る(双方向)', async () => {
    const { rows, toggle, remembered, store } = setup();
    toggle()!.click();
    await tick();
    toggle()!.click();
    await tick();
    expect(rows()).toEqual(['f1', 'f3', 'x']);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('false');
    expect(remembered).toEqual([true, false]);
    expect(store.enabled()).toBe(false);
  });

  it('🔴 入れたままフォルダへ降りると、その配下の全部が出る(パンくずで戻っても入り切りは保つ)', async () => {
    const { rows, toggle, d, q } = setup();
    toggle()!.click();
    await tick();
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    await tick();
    expect(rows(), '配下だけが平らに出ていない').toEqual(['f2', 'b', 'a']);
    for (const out of ['f3', 'c', 'x', 'f1']) expect(rows(), `${out} が出ている`).not.toContain(out);
    expect(toggle(), '降りたらボタンが消えた').not.toBeNull();
    expect(toggle()!.getAttribute('aria-pressed'), '降りたら入り切りが切れた').toBe('true');
    // パンくずの「ルート」で戻る
    q<HTMLElement>('[data-pkc-region="filer-breadcrumb"] button')!.click();
    await tick();
    expect(d.getState().scopeLid).toBeNull();
    expect(d.getState().filerFlatten, '戻ったら入り切りが切れた').toBe(true);
    expect(rows(), '戻ったら全件でない').toEqual(['f1', 'f2', 'b', 'a', 'f3', 'c', 'x']);
  });

  it('フォルダの中で入れると、そのフォルダの配下だけ(別の枝は出ない)', async () => {
    const { rows, toggle, d } = setup();
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    await tick();
    expect(rows(), '前提(直下)が崩れている').toEqual(['f2', 'a']);
    toggle()!.click();
    await tick();
    expect(rows()).toEqual(['f2', 'b', 'a']);
  });

  it('🔴 入にして開き直しても入っている(起動時に state へ写す口は reducer の 1 本)', () => {
    // ⚠ 起動の配線(`main.ts`)は原文の pin で見る。ここは**reducer が受けること**と、
    //   同じ値の 2 回目が何も動かさないこと(`SET_FILER_FLATTEN` は冪等)
    const s0 = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c', metas: METAS, relations: RELS }).state;
    const s1 = reduce(s0, { type: 'SET_FILER_FLATTEN', on: true }).state;
    expect(s1.filerFlatten).toBe(true);
    expect(reduce(s1, { type: 'SET_FILER_FLATTEN', on: true }).state, '同じ値で state が動いた').toBe(s1);
  });
});

describe('🔴 親フォルダの名前を行に添える(#813 残り。🟣 Gemini 裁定 2026-10-01 = A)', () => {
  /** 行 → 添えた字(無ければ `null`)。 */
  const hintOf = (pane: HTMLElement, lid: string): string | null =>
    pane.querySelector(`tbody [data-pkc-entry="${lid}"] [data-pkc-field="parent-name"]`)
      ?.textContent ?? null;
  const hintCount = (pane: HTMLElement): number =>
    pane.querySelectorAll('[data-pkc-field="parent-name"]').length;

  it('切のときは 1 行にも出ない', () => {
    const { pane } = setup();
    expect(hintCount(pane)).toBe(0);
  });

  it('🔴 ルートで入: 孫以深の行に親の名前が出て、直下の行には出ない(字は DOM に在る)', async () => {
    const { pane, toggle } = setup();
    toggle()!.click();
    await tick();
    // 空振り防止 ── 孫(b)が実際に行として載っている
    expect(pane.querySelector('tbody [data-pkc-entry="b"]'), '前提: 孫が載っていない').not.toBeNull();
    expect(hintOf(pane, 'b')).toBe('─ t-f2');
    expect(hintOf(pane, 'a')).toBe('─ t-f1');
    expect(hintOf(pane, 'c')).toBe('─ t-f3');
    // 親が無い直下の行(f1 / f3 / x)には出ない
    for (const lid of ['f1', 'f3', 'x']) expect(hintOf(pane, lid), `${lid} に出ている`).toBeNull();
    // 重ねたときの説明にも親の名前が入る
    const td = pane.querySelector<HTMLElement>('tbody [data-pkc-entry="b"] [data-pkc-field="title"]')!;
    expect(td.title).toContain('t-f2');
  });

  it('🔴 フォルダの中で入: そのフォルダの直下の行には出ず、孫以深だけ(降りると付け替わる)', async () => {
    const { pane, toggle, d } = setup();
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    toggle()!.click();
    await tick();
    expect(hintOf(pane, 'b')).toBe('─ t-f2');
    expect(hintOf(pane, 'f2'), '直下の行に出ている').toBeNull();
    expect(hintOf(pane, 'a'), '直下の行に出ている').toBeNull();
    // もう 1 つ降りると、b も直下になって出なくなる
    d.dispatch({ type: 'SET_SCOPE', lid: 'f2' });
    await tick();
    expect(pane.querySelector('tbody [data-pkc-entry="b"]'), '前提: b が出ていない').not.toBeNull();
    expect(hintOf(pane, 'b')).toBeNull();
  });

  it('切に戻すと消える(双方向)', async () => {
    const { pane, toggle } = setup();
    toggle()!.click();
    await tick();
    expect(hintCount(pane)).toBeGreaterThan(0);
    toggle()!.click();
    await tick();
    expect(hintCount(pane)).toBe(0);
  });

  it('親フォルダを改名すると、添えた字も追従する(古い名前が残らない)', async () => {
    const { pane, toggle, d } = setup();
    toggle()!.click();
    await tick();
    expect(hintOf(pane, 'b')).toBe('─ t-f2');
    const renamed = METAS.map((m) => (m.lid === 'f2' ? { ...m, title: '改名後' } : m));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: renamed, relations: RELS });
    await tick();
    expect(hintOf(pane, 'b')).toBe('─ 改名後');
  });
});

describe('🔴 平らに出している間の、範囲選択・全選択・印(#813 段②)', () => {
  const ready = () => {
    const s0 = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c', metas: METAS, relations: RELS }).state;
    return reduce(s0, { type: 'SET_FILER_FLATTEN', on: true }).state;
  };

  it('全選択は**見えている平らな行**を全部選ぶ', () => {
    const s = reduce(ready(), { type: 'SELECT_ALL' }).state;
    expect([...s.selection].sort()).toEqual(['a', 'b', 'c', 'f1', 'f2', 'f3', 'x']);
  });

  it('切のときの全選択は直下だけ(対照群)', () => {
    const s0 = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c', metas: METAS, relations: RELS }).state;
    expect([...reduce(s0, { type: 'SELECT_ALL' }).state.selection].sort()).toEqual(['f1', 'f3', 'x']);
  });

  it('Shift の範囲は、階層をまたいだ**見た目の並び**で採る', () => {
    let s = ready();
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'f2' }).state;
    s = reduce(s, { type: 'SELECT_RANGE', lid: 'c' }).state;
    // 見た目の並び: f1 f2 b a f3 c x ── f2 から c まで
    expect(s.selection).toEqual(['f2', 'b', 'a', 'f3', 'c']);
  });

  it('入り切りを動かすと印は外れる(行の集合が変わるので、画面に無い物を消さない)', () => {
    let s = reduce(ready(), { type: 'SELECT_ALL' }).state;
    expect(s.selection.length, '前提').toBeGreaterThan(0);
    s = reduce(s, { type: 'SET_FILER_FLATTEN', on: false }).state;
    expect(s.selection).toEqual([]);
    expect(s.selectionAnchor).toBeNull();
  });
});

describe('🔴 平らに出している間の、掴んで落とす・右クリック・上下の並べ替え(#813 段②)', () => {
  const flat = async () => {
    const t = setup();
    t.toggle()!.click();
    await tick();
    return t;
  };

  it('🔴 孫の行を掴んで、別のフォルダの行の真ん中へ落とすと、移る(今までどおり)', async () => {
    const { q, parentCalls } = await flat();
    // b は f2(f1 の中)の子。ルートから見えている f3 へ
    dragEvent('drop', dataTransfer({ [PKC_DRAG]: 'b' }), q('tbody [data-pkc-entry="f3"]')!, 110);
    await tick();
    expect(parentCalls, '移っていない').toEqual([{ lid: 'b', parentLid: 'f3' }]);
  });

  it('🔴 フォルダの行は、端(上 / 下)でも「中へ入れる」だけ(並べ替えの線は出さない)', async () => {
    const { q, reordered, parentCalls } = await flat();
    const folder = q<HTMLElement>('tbody [data-pkc-entry="f3"]')!;
    dragEvent('dragover', dataTransfer({ [PKC_DRAG]: 'x' }), folder, 102);
    expect(folder.hasAttribute('data-pkc-drop-edge'), '階層をまたぐ並べ替えの線が出ている').toBe(false);
    expect(folder.hasAttribute('data-pkc-dropping'), '落とせる所なのに光っていない').toBe(true);
    dragEvent('drop', dataTransfer({ [PKC_DRAG]: 'x' }), folder, 102);
    await tick();
    expect(reordered, '階層をまたぐ並べ替えが走った').toEqual([]);
    expect(parentCalls).toEqual([{ lid: 'x', parentLid: 'f3' }]);
  });

  it('🔴 ノートの行の上下端には、並べ替えの線も落とし先も出さない', async () => {
    const { q, reordered } = await flat();
    const note = q<HTMLElement>('tbody [data-pkc-entry="a"]')!;
    dragEvent('dragover', dataTransfer({ [PKC_DRAG]: 'x' }), note, 102);
    expect(note.hasAttribute('data-pkc-drop-edge')).toBe(false);
    dragEvent('drop', dataTransfer({ [PKC_DRAG]: 'x' }), note, 102);
    await tick();
    expect(reordered).toEqual([]);
  });

  it('⚠ 対照群 ── 切に戻すと、同じ落とし方が今までどおり並べ替えになる(門が効いている証拠)', async () => {
    const { q, toggle, reordered } = await flat();
    toggle()!.click();
    await tick();
    // 直下は f1 f3 x ── x を f1 の上端へ
    dragEvent('drop', dataTransfer({ [PKC_DRAG]: 'x' }), q('tbody [data-pkc-entry="f1"]')!, 101);
    await tick();
    expect(reordered.length, '切に戻したのに並べ替えが効かない').toBeGreaterThan(0);
  });

  it('🔴 上へ / 下へ動かすは、平らに出している間は出ない(切に戻せば同じ場所に出る)', async () => {
    const { q, d, toggle } = await flat();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    expect(q('[data-pkc-field="order-nudge"]'), '階層をまたぐ並びで「上へ / 下へ」が出ている').toBeNull();
    // 対照群 ── 切に戻せば出る(「選んでいない」で出ないのではない)
    toggle()!.click();
    await tick();
    expect(q('[data-pkc-field="order-nudge"]'), '切に戻しても出ない').not.toBeNull();
  });

  it('🔴 右クリックの「移す…」が、孫の行でも今までどおり効く', async () => {
    const { q, root, parentCalls } = await flat();
    q<HTMLElement>('tbody [data-pkc-entry="b"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    const menu = root.querySelector('[data-pkc-region="context-menu"]');
    const mv = menu?.querySelector<HTMLElement>('[data-pkc-action="move-to-folder"]');
    expect(mv, '孫の行の右クリックに「移す…」が出ない').not.toBeNull();
    mv!.click();
    await tick();
    const list = openDialog()?.querySelector('[data-pkc-field="entry-pick-list"]');
    expect(list, '入れ先の窓が開かない').not.toBeNull();
    const pick = [...list!.querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith('t-f3'));
    expect(pick, '入れ先に f3 が無い').toBeDefined();
    (pick as HTMLElement).click();
    await tick();
    expect(parentCalls).toEqual([{ lid: 'b', parentLid: 'f3' }]);
  });
});

describe('🔴 平らに出している間の、印を付けた行への一括の操作(#813 段②)', () => {
  it('🔴 孫の行に印を付けて「タグを付ける」を押すと、その行に効く(階層どおりの行で数えない)', async () => {
    const { d, q, toggle } = setup();
    toggle()!.click();
    await tick();
    // 孫(b = f2 の中、c = f3 の中)に印 ── 直下の行(f1 / f3 / x)には居ない
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'b' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'c' });
    await tick();
    const sent: Array<{ type: string; lids?: string[] }> = [];
    const realDispatch = d.dispatch.bind(d);
    d.dispatch = ((a: { type: string; lids?: string[] }) => {
      sent.push(a);
      return realDispatch(a as never);
    }) as typeof d.dispatch;
    const field = q<HTMLInputElement>('input[data-pkc-field="bulk-tag"]');
    expect(field, '印を付けたのに一括の帯が出ない').not.toBeNull();
    field!.value = '#請求';
    q<HTMLElement>('[data-pkc-action="bulk-tag-add"]')!.click();
    await tick();
    const bulk = sent.find((a) => a.type === 'BULK_TAG');
    expect(d.getState().error ?? '', '「選んでいるものがありません」と断られた').not.toContain('選んでいるものがありません');
    expect(bulk?.lids?.slice().sort(), '孫の行に効いていない').toEqual(['b', 'c']);
  });
});

describe('🔴 スマートフォルダの中では出さない(押しても何も起きないボタンを作らない)', () => {
  it('現在地がスマートフォルダなら、ボタンは出ない(ルートに戻れば出る)', async () => {
    const { toggle, d } = setup([...METAS, meta('s', 8, 'smart')], RELS);
    expect(toggle(), '前提(ルートでは出ている)').not.toBeNull();
    d.dispatch({ type: 'SET_SCOPE', lid: 's' });
    await tick();
    expect(toggle(), 'スマートフォルダの中に出ている').toBeNull();
    d.dispatch({ type: 'SET_SCOPE', lid: null });
    await tick();
    expect(toggle()).not.toBeNull();
  });
});

describe('配線の pin(原文)', () => {
  it('起動で端末の保存を state へ写す(`SYS_BOOTED` の後)', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('src/main.ts', 'utf8');
    const boot = main.indexOf("type: 'SYS_BOOTED'");
    const restore = main.indexOf("type: 'SET_FILER_FLATTEN', on: true");
    expect(restore, '起動で写していない(次に開くと戻っている)').toBeGreaterThan(0);
    expect(restore, 'SYS_BOOTED より前に写している(boot が消す)').toBeGreaterThan(boot);
    expect(main).toContain('appFilerFlatten.enabled()');
    expect(main).toContain('rememberFilerFlatten');
  });
});
