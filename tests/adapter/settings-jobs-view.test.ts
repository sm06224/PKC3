/**
 * user 報告(2026-08-05)「**ワーカー状態とワーカーログが何も表示されない**」の pin。
 * 調査 doc: `docs/development/user-reports-2026-08-05.md` §1-3
 *
 * 🔴 **直す前も `npm test` と `npm run test:smoke` は全部緑だった。**
 * 唯一の守り手 `tests/smoke/preview.smoke.spec.ts:108` は
 * 「仕事 → **はじめて**設定を開く」という、**壊れた実装で唯一正しく動く順序**しか
 * 踏んでいなかった。user が自然にやる順序(設定を覗く → 仕事 → 戻る)では、
 * 表が「まだ動いていません」・ログが 0 件のまま**永久に固定**される。
 *
 * ⚠ ここは happy-dom で完全に再現できる ── pane に `hidden` を付け外しして
 * `monitor.record()` を呼ぶだけ。実ブラウザ smoke に頼る必要は無い
 * (CLAUDE.md「CI を長くしない」にも合う)。
 */
/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { JobMonitor } from '@adapter/platform/job-monitor';
import { initialState } from '@adapter/state/app-state';

/** `CenterRouter` と同じ形の pane を作る(切替は `hidden` の付け外しだけ)。 */
function mountPane(): { pane: HTMLElement; region: HTMLElement } {
  document.body.textContent = '';
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'settings');
  document.body.append(pane);
  return { pane, region: pane };
}

const rowsOf = (): string[] =>
  Array.from(document.querySelectorAll('[data-pkc-region="jobs"] tbody tr')).map(
    (tr) => tr.textContent ?? '',
  );
const logLines = (): string[] =>
  Array.from(document.querySelectorAll('[data-pkc-field="job-log"] li')).map(
    (li) => li.textContent ?? '',
  );

/** 仕事を 1 件流す(spawn → enqueue → dispatch → done)。 */
function runJob(m: JobMonitor, id: number): void {
  m.record('markdown', 'spawn');
  m.record('markdown', 'enqueue', { id });
  m.record('markdown', 'dispatch', { id });
  m.record('markdown', 'done', { id, ms: 12 });
}

describe('設定のワーカー表 / ログ', () => {
  let monitor: JobMonitor;
  let renderer: SettingsRenderer;
  let pane: HTMLElement;

  beforeEach(() => {
    const m = mountPane();
    pane = m.pane;
    monitor = new JobMonitor(() => 0);
    renderer = new SettingsRenderer(m.region, monitor);
  });

  it('🔴 隠れている間に起きた仕事が、戻ったときに出る(凍らない)', () => {
    // ① user がまず設定を覗く ── まだ何も動いていない
    pane.hidden = false;
    renderer.render(initialState);
    expect(rowsOf(), '初回は空状態が出る').toEqual(['まだ動いていません']);
    expect(logLines()).toEqual(['まだ記録がありません']);

    // ② 設定を離れてノートを書く(= 仕事は必ず detail 面で起きる)
    pane.hidden = true;
    runJob(monitor, 1);
    runJob(monitor, 2);

    // ③ 設定へ戻る
    pane.hidden = false;
    renderer.render(initialState);

    // 🔴 ここが本題 ── 戻ったら追いついていること
    const rows = rowsOf();
    expect(rows, '表が「まだ動いていません」のまま凍っている').not.toEqual([
      'まだ動いていません',
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0], 'lane が出ていない').toContain('markdown');
    expect(rows[0], '完了件数が届いていない').toContain('2');
    expect(logLines().length, 'ログが 0 件のまま').toBeGreaterThan(0);
    expect(logLines().join(' '), 'ログの中身が届いていない').toContain('markdown');
  });

  it('🔴 表示中に起きた仕事は、そのまま出る(既存の経路を壊していない)', () => {
    pane.hidden = false;
    renderer.render(initialState);
    runJob(monitor, 1);
    // ⚠ 購読は 400ms 間引くので、タイマを待たずに `render()` で拾えることを見る
    //    (面の再表示と同じ経路 ── ここが効かないと戻っても凍る)
    renderer.render(initialState);
    expect(rowsOf()[0]).toContain('markdown');
  });

  it('🔴 ログが 0 件でも器が空にならない(2px の線にしない)', () => {
    // 実測で高さ 2px(上下の border だけ)になり、「壊れている」と読まれていた
    pane.hidden = false;
    renderer.render(initialState);
    expect(logLines()).toEqual(['まだ記録がありません']);
    expect(document.querySelector('[data-pkc-field="job-log-empty"]')).not.toBeNull();
  });

  it('隠れている間は描き直さない(本来のガードは残っている)', () => {
    // ⚠ ここを壊すと「隠れた面を 400ms ごとに作り直す」P8 段⑰ の問題が戻る
    pane.hidden = false;
    renderer.render(initialState);
    pane.hidden = true;
    runJob(monitor, 1);
    // hidden のまま render を呼んでも、隠れた面は組み直さない
    renderer.render(initialState);
    expect(rowsOf(), '隠れている面を描き直している').toEqual(['まだ動いていません']);
  });
});
