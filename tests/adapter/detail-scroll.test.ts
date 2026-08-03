/** @vitest-environment happy-dom */
/**
 * P8 段⑪: **描き直しでスクロールを殺さない**。
 *
 * > user 指示 2026-08-03「**レンダリングした後にスクロールがトップに戻る
 * > no-op も塞いでね**」
 *
 * 実機の観測は `tests/smoke/format-bar.smoke.spec.ts`。ここが見るのは
 * **実機では作れない窓** ── 「編集に入ったまま別のノートを開く」。
 */
import { describe, expect, it } from 'vitest';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
  };
}

/** `[data-pkc-region="detail"]`(スクロールする器)の中に pane を置く実構造。 */
function setup() {
  const scroller = document.createElement('div');
  scroller.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  scroller.append(pane);
  document.body.append(scroller);
  return { scroller, r: new DetailRenderer(pane) };
}

function state(lid: string, body: string, phase: AppState['phase'] = 'ready'): AppState {
  return {
    ...initialState,
    phase,
    selectedLid: lid,
    entryMetas: new Map([
      ['a', meta('a')],
      ['b', meta('b')],
    ]),
    openBody: { lid, body, baseline: body, persisted: body, diskAhead: false },
  };
}

const LONG = Array.from({ length: 40 }, (_, i) => `## 節 ${i}\n\n段落 ${i}。\n`).join('\n');

describe('本文ペインのスクロール', () => {
  it('🔴 同じノートの本文が変わっても位置を動かさない', () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    scroller.scrollTop = 500;
    r.render(state('a', `${LONG}\n\n足した段落。\n`));
    expect(scroller.scrollTop, '描き直しで先頭へ飛んだ').toBe(500);
  });

  it('別のノートを開いたら先頭から', () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    scroller.scrollTop = 500;
    r.render(state('b', LONG));
    expect(scroller.scrollTop).toBe(0);
  });

  it('編集して戻ってきたら元の位置へ', () => {
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    scroller.scrollTop = 500;
    r.render(state('a', LONG, 'editing'));
    scroller.scrollTop = 0; // 編集の面は別物(先頭から始まる)
    r.render(state('a', LONG));
    expect(scroller.scrollTop, '保存で戻ったら先頭へ飛んだ').toBe(500);
  });

  it('🔴 編集に入ったまま**別のノート**を開いたら、覚えた位置を持ち込まない', () => {
    // ⚠ ここは実機では作れない窓(編集中に一覧を押しても切り替わらない)。
    // 持ち込むと「B を途中から見せる」になる ── 変異試験で素通りしていた経路
    const { scroller, r } = setup();
    r.render(state('a', LONG));
    scroller.scrollTop = 500;
    r.render(state('a', LONG, 'editing'));
    scroller.scrollTop = 0;
    r.render(state('b', LONG));
    expect(scroller.scrollTop, '別のノートに前のノートの位置を持ち込んだ').toBe(0);
  });
});
