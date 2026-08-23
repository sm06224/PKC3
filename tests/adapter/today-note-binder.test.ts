/** @vitest-environment happy-dom */
/**
 * 🔴 **「今日」を押すと、その日のノートが開く**(#348、user 裁定 2026-08-23)。
 *
 * ⚠ 規則(題名の作り方 / 何を今日のノートと見なすか)は
 * `tests/features/today-note.test.ts`。**ここが見るのは繋がり**である ──
 * 押した所から dispatch まで届くか、無ければ作るか、在れば**作らない**か。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, title: string, over: Partial<EntryMeta> = {}): EntryMeta {
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
    bodyChars: 0,
    ...over,
  };
}

function setup(metas: EntryMeta[]) {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  sent.length = 0;
  const press = (): void => {
    root.querySelector<HTMLElement>('[data-pkc-action="open-today"]')!.click();
  };
  return { root, d, sent, press };
}

/** 今日を固定する(この test は「今日が何日か」に依存してはいけない)。 */
const FIXED = new Date(2026, 7, 23, 10, 0);
afterEach(() => vi.useRealTimers());
const freeze = (): void => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED);
};

describe('「今日」を押す (#348)', () => {
  it('🔴 押す口が画面に在る', () => {
    const { root } = setup([]);
    const btn = root.querySelector<HTMLElement>('[data-pkc-action="open-today"]');
    expect(btn, '押す口が無い').not.toBeNull();
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    expect(btn!.title).toContain('今日の日付のノート');
  });

  it('🔴 無ければ、今日の日付で作る', () => {
    freeze();
    const { sent, press } = setup([meta('other', 'ほかのノート')]);
    press();
    const created = sent.find((a) => a.type === 'CREATE_ENTRY');
    expect(created, '作っていない').toBeDefined();
    expect((created as { title: string }).title, '題名が今日の日付でない').toBe('2026-08-23');
    expect((created as { archetype: string }).archetype, '新しい種類を作った').toBe('text');
  });

  /**
   * 🔴 **在れば作らない** ── 押すたびに増えると、その日の入れ物が 1 つに決まらず、
   * user は「どっちが本物か」を追う羽目になる。
   */
  it('🔴 在れば、それを選ぶ(2 つ目を作らない)', () => {
    freeze();
    const { sent, press } = setup([meta('t', '2026-08-23')]);
    press();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), '在るのに作った').toBe(false);
    expect(sent).toContainEqual({ type: 'SELECT_ENTRY', lid: 't' });
  });

  /**
   * ⚠ **対照群 ── 2 度押しても 1 件のまま。**
   *
   * 🔴 ⚠ **1 度目の直後は編集に入っている**(作成 → 即編集)ので、そのまま押しても
   *   何も起きない ── `phase !== 'ready'` の門である。⚠ この形を知らずに書いた
   *   1 稿目は落ちた。**それが正しい振る舞い**なので、両方 pin する:
   *   ①編集中は押しても増えない ②編集を出れば、在るほうを選ぶ。
   */
  /**
   * 🔴 **別のノートを編集している最中に押しても、何も起きない**(変異試験 T7 が
   * SURVIVED で教えた、2026-08-23)。
   *
   * ⚠ 下の「2 度目で 2 件目を作らない」は**門が無くても通る** ── 1 度目で作った
   *   ノートが既に在るので、「在れば選ぶ」のほうに救われる(CLAUDE.md §1
   *   「救い手が変わっただけ」の論理式版)。
   * 🔑 **門が本当に守っているのはここ**である:別のノートを書いている最中に押すと、
   *   今日のノートがまだ無ければ**編集の裏で 1 件できる**。
   */
  it('🔴 別のノートの編集中に押しても、作らない(門が守っているのはここ)', () => {
    freeze();
    const { d, sent, press } = setup([meta('other', 'ほかのノート')]);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'other' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'other', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提: 編集に入れていない').toBe('editing');
    sent.length = 0;
    press();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), '編集の裏で今日のノートを作った').toBe(
      false,
    );
    expect(sent.some((a) => a.type === 'SELECT_ENTRY'), '編集中に選択を動かした').toBe(false);
  });

  it('🔴 編集中は押しても増えない(2 度目で 2 件目を作らない)', () => {
    freeze();
    const { d, sent, press } = setup([]);
    press();
    expect(d.getState().phase, '前提: 作成の直後は編集に入る').toBe('editing');
    sent.length = 0;
    press();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), '編集中なのに 2 件目を作った').toBe(false);
    expect(d.getState().entryMetas.size, 'ノートが増えた').toBe(1);
  });

  /**
   * 🔴 **作ってすぐ取り消したら、そのノートは残らない**(この repo の既存の作法 ──
   * 「まだ一度も commit / rename されていない新規」は取り消しで消える)。
   * ⚠ だから次に押したときは**作り直すのが正しい** ── 1 稿目はここを
   * 「在るほうを選ぶ」と書いて落ちた。**実装ではなく私の読みが間違っていた**。
   */
  it('🔴 作ってすぐ取り消したら、次に押すと作り直す', () => {
    freeze();
    const { d, sent, press } = setup([]);
    press();
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(d.getState().entryMetas.size, '前提: 取り消しで消えていない').toBe(0);
    sent.length = 0;
    press();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), '消えたのに作り直さない').toBe(true);
  });

  /**
   * 🔴 **別の面を見ていたら、中央の面へ戻してから** ── 非 detail で作ると
   * editor が出ない(PKC2 由来の罠)。`create-entry` と同じ順序である。
   */
  it('🔴 別の面を見ていたら、中央の面へ戻す', () => {
    freeze();
    const { d, sent, press } = setup([]);
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    sent.length = 0;
    press();
    const iView = sent.findIndex((a) => a.type === 'SET_VIEW_MODE');
    const iMake = sent.findIndex((a) => a.type === 'CREATE_ENTRY');
    expect(iView, '面を戻していない').toBeGreaterThanOrEqual(0);
    expect(iMake, '作っていない').toBeGreaterThanOrEqual(0);
    expect(iView, '作ってから面を戻した(editor が出ない順序)').toBeLessThan(iMake);
  });

  /** ⚠ ゴミ箱の中の同名は拾わない(開いたのに一覧に無い、を作らない)。 */
  it('⚠ ゴミ箱の中の同名は拾わず、作り直す', () => {
    freeze();
    const { sent, press } = setup([meta('gone', '2026-08-23', { archived: true })]);
    press();
    expect(sent.some((a) => a.type === 'CREATE_ENTRY'), 'ゴミ箱の中を開いた').toBe(true);
  });
});
