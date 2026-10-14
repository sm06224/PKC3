/** @vitest-environment happy-dom */
/**
 * 🔴 **右の列は打つたびに描き直される ── 見た目の変わらない行は作り直さず、本文を読む計算は止まってから**(#1087)。
 *
 * 400KB の本文・5,000 件のノート・約 4,000 件のつながりで測ると、1 打鍵あたり
 * 「文字数の分数」と「外部画像の枚数」の 2 行だけで約 15ms、つながり・参照元・タグ・添付の行の作り直しで約 4ms 払っていた。
 *
 * ## 守る主張
 * 1. つながり / 参照元 / タグ / 添付の行は、入力(参照)が同じなら node を使い回す(= 作り直さない)
 * 2. 入力が 1 つ変われば、その行は新しい内容になる(入力ごとに 1 test)
 * 3. 編集中は、分数・外部画像の枚数・つながりの図の本文リンクが「前回のまま」で、打鍵が止まってから最新になる
 *    (文字数は毎回最新)。編集中でなければ同期
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
function rel(id: string, fromLid: string, toLid: string): Relation {
  return { id, fromLid, toLid, kind: 'related', createdAt: null, updatedAt: null };
}

const METAS = new Map<string, EntryMeta>([
  ['a', meta('a', '本体')],
  ['b', meta('b', '相手B')],
  ['c', meta('c', '相手C')],
]);
const RELS: Relation[] = [rel('r1', 'a', 'b')];
const BACK = { lid: 'a', lids: ['b'], truncated: false };
const BODY = '---\ntags: [t1]\n---\n![図](asset:ast-a)\n';

function stateOf(over: Partial<AppState>, body = BODY): AppState {
  return {
    ...initialState,
    phase: 'ready',
    entryMetas: METAS,
    relations: RELS,
    backlinks: BACK,
    selectedLid: 'a',
    openBody: { lid: 'a', body, baseline: body, persisted: body, diskAhead: false },
    ...over,
  } as AppState;
}

function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  const q = (sel: string): Element | null => regions.inspector.querySelector(sel);
  return { inspector, q };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('行を作り直さない(入力が同じなら node を使い回す)', () => {
  it('つながりの行: 本文だけが動いても同じ node。relations / entryMetas / 編集中かが変われば新しい内容', () => {
    const { inspector, q } = setup();
    const row = (): HTMLElement | null => q('[data-pkc-field="inspector-relation"]') as HTMLElement | null;
    inspector.render(stateOf({}, BODY));
    const first = row();
    expect(first?.textContent).toContain('相手B');
    inspector.render(stateOf({}, BODY + 'あ'));
    expect(row(), '本文だけが動いたのに作り直した').toBe(first);

    // 対照群: 入力を 1 つずつ動かす
    inspector.render(stateOf({ relations: [rel('r1', 'a', 'c')] }));
    expect(row()).not.toBe(first);
    expect(row()?.textContent).toContain('相手C');
    const second = row();
    inspector.render(stateOf({ relations: [rel('r1', 'a', 'c')], entryMetas: new Map(METAS).set('c', meta('c', '相手C(改)')) }));
    expect(row()).not.toBe(second);
    expect(row()?.textContent).toContain('相手C(改)');
    const third = row();
    inspector.render(
      stateOf({ relations: [rel('r1', 'a', 'c')], entryMetas: new Map(METAS).set('c', meta('c', '相手C(改)')), phase: 'editing' }),
    );
    expect(row()).not.toBe(third);
    expect(row()?.querySelector<HTMLButtonElement>('[data-pkc-action="remove-relation"]')?.disabled).toBe(true);
  });

  it('参照元の行: 本文だけが動いても同じ node。backlinks / entryMetas が変われば新しい内容', () => {
    const { inspector, q } = setup();
    const row = (): HTMLElement | null => q('[data-pkc-field="inspector-backlink"]') as HTMLElement | null;
    inspector.render(stateOf({}, BODY));
    const first = row();
    expect(first?.textContent).toBe('相手B');
    inspector.render(stateOf({}, BODY + 'あ'));
    expect(row(), '本文だけが動いたのに作り直した').toBe(first);

    inspector.render(stateOf({ backlinks: { lid: 'a', lids: ['c'], truncated: false } }));
    expect(row()).not.toBe(first);
    expect(row()?.textContent).toBe('相手C');
    inspector.render(stateOf({ backlinks: BACK }));
    const second = row();
    expect(second?.textContent).toBe('相手B');
    // backlinks の参照も lid も同じで、entryMetas だけが変わる
    inspector.render(stateOf({ backlinks: BACK, entryMetas: new Map(METAS).set('b', meta('b', '相手B(改)')) }));
    expect(row()).not.toBe(second);
    expect(row()?.textContent).toBe('相手B(改)');
  });

  it('タグの札: 本文の字が同じなら同じ node。タグが変われば / 書ける状態が変われば新しい内容', () => {
    const { inspector, q } = setup();
    const chip = (): HTMLElement | null => q('[data-pkc-field="inspector-tag"]') as HTMLElement | null;
    inspector.render(stateOf({}, BODY));
    const first = chip();
    expect(first?.getAttribute('data-pkc-tag')).toBe('t1');
    expect(first?.querySelector('[data-pkc-action="untag-entry"]'), '前提: ready なら外せる').not.toBeNull();
    // 本文の字が同じ別の state(openBody の器だけが作り直される)
    inspector.render(stateOf({}, BODY));
    expect(chip(), '字が同じなのに作り直した').toBe(first);

    inspector.render(stateOf({}, '---\ntags: [t2]\n---\n'));
    expect(chip()).not.toBe(first);
    expect(chip()?.getAttribute('data-pkc-tag')).toBe('t2');
    const second = chip();
    // 書けない状態(編集中)では「外す」が消える ── 本文の字が同じでも変わる
    inspector.render(stateOf({ phase: 'editing' }, '---\ntags: [t2]\n---\n'));
    expect(chip()).not.toBe(second);
    expect(chip()?.querySelector('[data-pkc-action="untag-entry"]')).toBeNull();
  });

  it('添付の行: 本文の字が同じなら同じ node。添付が変われば新しい内容', () => {
    const { inspector, q } = setup();
    const item = (): HTMLElement | null => q('[data-pkc-field="inspector-asset-item"]') as HTMLElement | null;
    inspector.render(stateOf({}, BODY));
    const first = item();
    expect(first?.querySelector('[data-pkc-asset-key]')?.getAttribute('data-pkc-asset-key')).toBe('ast-a');
    inspector.render(stateOf({}, BODY));
    expect(item(), '字が同じなのに作り直した').toBe(first);

    inspector.render(stateOf({}, '![図2](asset:ast-b)\n'));
    expect(item()).not.toBe(first);
    expect(item()?.querySelector('[data-pkc-asset-key]')?.getAttribute('data-pkc-asset-key')).toBe('ast-b');
    // 本文が閉じたら畳む(空の鍵も記憶に入っている)
    inspector.render(stateOf({ openBody: null }));
    expect(item()).toBeNull();
  });
});

describe('編集中は本文を読む計算が止まってから(文字数は毎回最新)', () => {
  function editing(body: string) {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((s) => inspector.render(s));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '一'), meta('c', '相手C')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集に入れていない').toBe('editing');
    const text = (field: string): string => root.querySelector(`[data-pkc-field="${field}"]`)?.textContent ?? '';
    return { d, root, text };
  }
  const type = (s: ReturnType<typeof editing>, body: string): void =>
    void s.d.dispatch({ type: 'UPDATE_OPEN_BODY', body });
  const jp = (n: number): string => 'あ'.repeat(n);

  it('分数: 字数は打つたび最新、分数は止まってから(それまでは前回のまま)', () => {
    const s = editing(jp(600));
    expect(s.text('inspector-stats')).toBe('600 文字 (読了 約 2 分)');
    type(s, jp(1600));
    expect(s.text('inspector-stats'), '字数は最新・分数は前回').toBe('1,600 文字 (読了 約 2 分)');
    vi.advanceTimersByTime(1000);
    expect(s.text('inspector-stats')).toBe('1,600 文字 (読了 約 4 分)');
  });

  it('対照群: 編集中でなければ分数も同期で最新', () => {
    const { inspector, q } = setup();
    inspector.render(stateOf({}, jp(600)));
    inspector.render(stateOf({}, jp(1600)));
    expect(q('[data-pkc-field="inspector-stats"]')?.textContent).toBe('1,600 文字 (読了 約 4 分)');
  });

  it('外部画像の枚数: 打った直後は前回のまま、止まってから最新', () => {
    const s = editing('本文\n');
    const btn = (): HTMLElement | null => s.root.querySelector('[data-pkc-action="adopt-external-images"]');
    expect(btn()?.hidden, '前提: 画像が無ければ畳む').toBe(true);
    type(s, '本文\n![x](https://example.com/a.png)\n');
    expect(btn()?.hidden, '止まる前は前回のまま').toBe(true);
    vi.advanceTimersByTime(1000);
    expect(btn()?.hidden).toBe(false);
  });

  it('つながりの図: 本文に足したリンクは、止まってから図に出る', () => {
    const s = editing('本文\n');
    const nodes = (): string[] =>
      [...s.root.querySelectorAll('[data-pkc-field="relation-map"] button')].map((b) => b.textContent ?? '');
    type(s, '本文 [c](entry:c)\n');
    expect(nodes(), '止まる前は前回のまま').not.toContain('相手C');
    vi.advanceTimersByTime(1000);
    expect(nodes()).toContain('相手C');
  });
});
