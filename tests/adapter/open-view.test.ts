/**
 * 🔴 **面を開く口は 1 つ**(#300 段②のレビュー)。
 *
 * ここで守るのは **「開けたかを正直に返す」** ことである(#300 段③ の直し、
 * 2026-08-22)。⚠ 別窓が塞がれたときの退避はこの返り値を読んで文言を分ける ──
 * 読まないと、**編集中でどこにも開かなかった回に「この画面で開きました」**と
 * 言うことになる(着地前レビュー 6)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { openView, openViewHere } from '../../src/adapter/ui/render/open-view';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: lid,
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

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  return d;
}

describe('openView は「開けたか」を返す', () => {
  it('🔴 開けたら true', () => {
    const d = booted();
    expect(openView(d, 'query')).toBe(true);
    expect(d.getState().viewMode).toBe('query');
  });

  /**
   * 🔴 **編集中は断られる** ── `app-state.ts` が「編集中はカレンダーを開けません」
   * を立てて面は動かさない。⚠ ここで `true` を返すと、退避の文言が嘘になる。
   */
  it('🔴 編集中に断られたら false(面も動かない)', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている(編集に入れていない)').toBe('editing');
    expect(openView(d, 'query'), '断られたのに「開いた」と返した').toBe(false);
    expect(d.getState().viewMode, '編集中なのに面が変わった').toBe('detail');
  });

  /** ⚠ 本文へ戻る道は編集中でも塞がない(2026-08-19)── そちらは true。 */
  it('⚠ 編集中でも本文へは戻れる', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    expect(openView(d, 'detail')).toBe(true);
  });
});

/**
 * 🔴 **予定表を開いたら、その場で集める**(#673 段②)。
 *
 * ⚠ 左の列の「予定」タブは `main.ts` の `setBrowse` が集めを頼むが、中央の面
 *   (別窓のディープリンク / 塞がれたときの退避)は **`openView` しか通らない**。
 *   頼まないと別窓は「集めています…」で**永久に止まる**(観測点は event ──
 *   `REFRESH_TASK_SCAN` は reducer で `REQUEST_TASK_SCAN` に変わる)。
 */
describe('予定表を開く(#673 段②)', () => {
  const events = (d: Dispatcher): string[] => {
    const seen: string[] = [];
    d.onEvent((e) => seen.push(e.type));
    return seen;
  };

  it('🔴 schedule を開くと、予定の走査が頼まれる', () => {
    const d = booted();
    const seen = events(d);
    expect(openView(d, 'schedule')).toBe(true);
    expect(d.getState().viewMode).toBe('schedule');
    expect(seen, '走査が頼まれない(別窓は「集めています…」で止まる)').toContain(
      'REQUEST_TASK_SCAN',
    );
  });

  /** ⚠ 対照群 ── 集計を開いても予定の走査は走らせない(無関係な全件走査を負わせない)。 */
  it('⚠ 対照群: 集計を開いても予定の走査は頼まない', () => {
    const d = booted();
    const seen = events(d);
    expect(openView(d, 'query')).toBe(true);
    expect(seen).not.toContain('REQUEST_TASK_SCAN');
  });

  /** 🔴 編集中に断られた回は、面も動かず走査も頼まない(開けたときだけの後始末)。 */
  it('🔴 編集中に断られたら走査も頼まない', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    const seen = events(d);
    expect(openView(d, 'schedule'), '断られたのに「開いた」と返した').toBe(false);
    expect(seen, '断られたのに走査だけ走った').not.toContain('REQUEST_TASK_SCAN');
  });
});

/**
 * 🔴 **別窓が塞がれたときの退避先**(#673 段②)。
 *
 * ⚠ 予定表は中央の面ではなく**左の列の「予定」タブ**へ ── 中央に開くと本文が消える
 *   (#292 段⑤ で左へ移した当の理由)。左に無い面(2 ペイン)は今までどおり中央へ。
 */
describe('openViewHere ── 塞がれたときの退避先', () => {
  it('🔴 予定表は左の列の「予定」タブへ送り、中央の面を占有しない', () => {
    const d = booted();
    const tabs: string[] = [];
    expect(openViewHere(d, 'schedule', (t) => tabs.push(t))).toBe(true);
    expect(tabs, '左の「予定」タブが開かれない').toEqual(['schedule']);
    expect(d.getState().viewMode, '中央の面を占有した(本文が消える)').toBe('detail');
  });

  /** ⚠ 対照群 ── 左に無い面は中央の面へ(この振り分けが「全部左へ」になっていないこと)。 */
  it('⚠ 対照群: 2 ペインは中央の面へ(左のタブは開かない)', () => {
    const d = booted();
    const tabs: string[] = [];
    expect(openViewHere(d, 'dual', (t) => tabs.push(t))).toBe(true);
    expect(tabs, '左に無い面まで左へ送った').toEqual([]);
    expect(d.getState().viewMode).toBe('dual');
  });

  /**
   * 🔑 左のタブは**編集中でも開ける**(`setBrowse` は phase を見ない)── だから
   * 予定表の退避は編集中でも `true`(「この画面で開きました」が嘘にならない)。
   * ⚠ 対照群: 中央へ退避する面は編集中は断られる(`openView` の規則のまま)。
   */
  it('🔴 編集中でも予定表の退避は通り、中央へ退避する面は断られる', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    const tabs: string[] = [];
    expect(openViewHere(d, 'schedule', (t) => tabs.push(t))).toBe(true);
    expect(tabs).toEqual(['schedule']);
    expect(openViewHere(d, 'query', (t) => tabs.push(t)), '編集中に集計が開いた').toBe(false);
    expect(d.getState().viewMode).toBe('detail');
  });
});
