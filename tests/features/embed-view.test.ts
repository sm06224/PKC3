/** @vitest-environment happy-dom */
/**
 * 🔴 **既製の表(` ```embed `)**(#1966 4-2。user 裁定 2026-11-17 = 案 A+B)── 綴りの読み方・表の組み立て。
 *
 * ⚠ 札は本物の読み方(`taskCardsOf`)で作る ── 手で組んだ札だと、予定表と同じ読み方をしているかを見られない。
 */
import { describe, expect, it } from 'vitest';
import {
  embedViewSource,
  embedViewTextOf,
  embedViewTitle,
  findSmartFolder,
  isEmbedViewInfo,
  openTasksAnswer,
  parseEmbedView,
  recentAnswer,
  smartAnswer,
} from '../../src/features/markdown/embed-view';
import {
  EMBED_VIEW_FIND_ATTR,
  isSqlEmbedInfo,
  SQL_EMBED_ATTR,
  SQL_EMBED_FETCH_ROWS,
  SQL_EMBED_SRC_ATTR,
  bakeSqlEmbeds,
  sqlEmbedAnswerHtml,
  sqlEmbedFailureHtml,
} from '../../src/features/markdown/sql-embed';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { checkReadOnlySql } from '../../src/features/query/sql-guard';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

describe('綴り', () => {
  it('🔴 見出しの先頭語が embed なら既製の表。sql embed とは重ならない', () => {
    expect(isEmbedViewInfo('embed open-tasks')).toBe(true);
    expect(isEmbedViewInfo('EMBED recent')).toBe(true);
    expect(isEmbedViewInfo('sql embed')).toBe(false);
    expect(isSqlEmbedInfo('embed open-tasks')).toBe(false);
    expect(isEmbedViewInfo('embedded')).toBe(false);
    expect(isEmbedViewInfo(null)).toBe(false);
  });

  it('🔴 3 つの表と既定値を読む', () => {
    expect(parseEmbedView('open-tasks')).toEqual({ ok: true, spec: { view: 'open-tasks', range: 'week' } });
    expect(parseEmbedView('open-tasks range=today')).toEqual({ ok: true, spec: { view: 'open-tasks', range: 'today' } });
    expect(parseEmbedView('OPEN-TASKS range=ALL')).toEqual({ ok: true, spec: { view: 'open-tasks', range: 'all' } });
    expect(parseEmbedView('recent')).toEqual({ ok: true, spec: { view: 'recent', days: 7 } });
    expect(parseEmbedView('recent days=30')).toEqual({ ok: true, spec: { view: 'recent', days: 30 } });
    expect(parseEmbedView('smart=週次レビュー')).toEqual({ ok: true, spec: { view: 'smart', name: '週次レビュー' } });
    expect(parseEmbedView('smart name=週次レビュー')).toEqual({ ok: true, spec: { view: 'smart', name: '週次レビュー' } });
    // ⚠ 引用符の中の空白は語を切らない
    expect(parseEmbedView('smart="週次 レビュー"')).toEqual({ ok: true, spec: { view: 'smart', name: '週次 レビュー' } });
  });

  it('⚠ 打ち間違いは黙って既定へ寄せず、理由を言って断る', () => {
    const why = (t: string): string => {
      const r = parseEmbedView(t);
      return r.ok ? '' : r.why;
    };
    expect(why('')).toContain('表の名前がありません');
    expect(why('todo')).toContain('「todo」という表はありません');
    expect(why('todo')).toContain('open-tasks / recent / smart');
    expect(why('open-tasks range=month')).toContain('range は today / week / all');
    expect(why('open-tasks days=3')).toContain('「days」は使えません');
    expect(why('recent days=0')).toContain('1〜365');
    expect(why('recent days=1.5')).toContain('1〜365');
    expect(why('recent days=366')).toContain('1〜365');
    expect(why('smart')).toContain('smart=<スマートフォルダの題名>');
    expect(why('recent 7')).toContain('名前=値');
  });

  it('🔴 器の字は @ で始まる ── SQL の字の門を通らない(sql embed の枠と取り違えない)', () => {
    const src = embedViewSource('open-tasks range=week');
    expect(src.startsWith('@')).toBe(true);
    expect(checkReadOnlySql(src).ok).toBe(false);
    expect(embedViewTextOf(src)).toBe('open-tasks range=week');
    expect(embedViewTextOf('SELECT 1')).toBeNull();
  });

  it('🔴 描くと、コード枠を出さずに器だけを置く(見出しの後ろと中身の行の両方を読む)', () => {
    const html = renderMarkdown('```embed open-tasks\nrange=today\n```\n');
    const div = document.createElement('div');
    div.innerHTML = html;
    const host = div.querySelector(`.pkc-embed-view [${SQL_EMBED_ATTR}]`);
    expect(host, '器が無い').not.toBeNull();
    expect(host!.getAttribute(SQL_EMBED_SRC_ATTR)).toBe('@pkc-view open-tasks range=today');
    expect(div.querySelector('pre'), 'コード枠が出ている').toBeNull();
  });

  it('名前の行の字', () => {
    expect(embedViewTitle({ view: 'open-tasks', range: 'week' })).toBe('今週までの未完了');
    expect(embedViewTitle({ view: 'recent', days: 3 })).toBe('直近 3 日に更新したノート');
    expect(embedViewTitle({ view: 'smart', name: 'A' })).toBe('スマートフォルダ「A」');
  });
});

describe('open-tasks(未完了)', () => {
  // 2026-11-18 は水曜。日曜始まりの週 = 11/15〜11/21、月曜始まり = 11/16〜11/22
  const TODAY = '2026-11-18';
  const cards = [
    ...taskCardsOf(
      'n1',
      [
        '- [ ] 過ぎた @2026-11-10',
        '- [ ] 今日 @2026-11-18 10:00',
        '- [ ] 土曜 @2026-11-21',
        '- [ ] 日曜 @2026-11-22',
        '- [ ] 来週 @2026-11-25',
        '- [x] 済み @2026-11-18',
        '- [ ] 日付なし',
        '- [ ] 期間 @2026-11-17..2026-11-19',
      ].join('\n'),
    ),
    ...taskCardsOf('arch', '- [ ] しまったノート @2026-11-18\n'),
  ];
  const titleOf = (lid: string): string | null => (lid === 'n1' ? '仕事' : null);
  const items = (range: 'today' | 'week' | 'all', weekStart: 0 | 1 = 0): string[] =>
    openTasksAnswer({ cards, titleOf, today: TODAY, weekStart, range }).rows.map((r) => `${String(r[0])} | ${String(r[1])}`);

  it('🔴 today = 今日まで(過ぎた物を含む)。済んだ物・出さないノートの物は出ない。期間は 1 行だけ', () => {
    expect(items('today')).toEqual([
      '2026-11-10(過ぎています) | 過ぎた',
      '2026-11-17 | 期間',
      '2026-11-18 10:00 | 今日',
    ]);
  });

  it('🔴 week = 今週の終わりまで。週の始まりは予定表の設定に従う', () => {
    expect(items('week')).toEqual([
      '2026-11-10(過ぎています) | 過ぎた',
      '2026-11-17 | 期間',
      '2026-11-18 10:00 | 今日',
      '2026-11-21 | 土曜',
    ]);
    // 月曜始まりなら日曜(11/22)も今週
    expect(items('week', 1)).toContain('2026-11-22 | 日曜');
  });

  it('🔴 all = 期日のある物すべて + 日付なし(末尾)', () => {
    const all = items('all');
    expect(all).toContain('2026-11-25 | 来週');
    expect(all.at(-1)).toBe('日付なし | 日付なし');
  });

  it('🔴 項目の升はそのノートへのリンクで、項目の字を塗る印を運ぶ', () => {
    const a = openTasksAnswer({ cards, titleOf, today: TODAY, weekStart: 0, range: 'today' });
    expect(a.columns).toEqual(['期日', '項目', 'ノート']);
    expect(a.links?.[0]).toEqual([
      { col: 1, lid: 'n1', find: '過ぎた' },
      { col: 2, lid: 'n1' },
    ]);
    const div = document.createElement('div');
    div.innerHTML = sqlEmbedAnswerHtml(a, 200, true);
    const link = div.querySelector('tbody tr td:nth-child(2) a')!;
    expect(link.getAttribute('data-pkc-action')).toBe('navigate-entry-ref');
    expect(link.getAttribute('data-pkc-entry-ref')).toBe('entry:n1');
    expect(link.getAttribute(EMBED_VIEW_FIND_ATTR)).toBe('過ぎた');
    // ⚠ 書き出し(画面でない)は塗る印を持たない(受け手が無い)── リンクは残す
    div.innerHTML = sqlEmbedAnswerHtml(a, 200, false);
    expect(div.querySelector(`[${EMBED_VIEW_FIND_ATTR}]`)).toBeNull();
    expect(div.querySelector('tbody a')!.getAttribute('href')).toBe('entry:n1');
  });

  it('⚠ 未完了が 0 件なら「該当する行はありません」(黙って空にしない)', () => {
    const a = openTasksAnswer({ cards: [], titleOf, today: TODAY, weekStart: 0, range: 'week' });
    expect(a.rows).toEqual([]);
    expect(sqlEmbedAnswerHtml({ ...a, title: '今週までの未完了' }, 200, true)).toContain('該当する行はありません');
  });

  it('⚠ 多すぎる行は受け取りの天井で切り、切ったと言う', () => {
    const many = taskCardsOf('n1', Array.from({ length: SQL_EMBED_FETCH_ROWS + 5 }, (_, i) => `- [ ] t${String(i)} @2026-11-18`).join('\n'));
    const a = openTasksAnswer({ cards: many, titleOf, today: TODAY, weekStart: 0, range: 'today' });
    expect(a.rows).toHaveLength(SQL_EMBED_FETCH_ROWS);
    expect(a.links).toHaveLength(SQL_EMBED_FETCH_ROWS);
    expect(a.truncated).toBe(true);
  });
});

describe('recent / smart', () => {
  // 2026-11-18 00:00 UTC
  const NOW = Date.UTC(2026, 10, 18, 0, 0, 0);
  const titleOf = (lid: string): string | null => (lid === 'gone' ? null : `題-${lid}`);

  it('🔴 recent = 直近 N 日に更新したノートを新しい順。境目より古い物・出さないノートは出ない', () => {
    const a = recentAnswer({
      notes: [
        { lid: 'a', updatedAt: '2026-11-17 10:00:00' },
        { lid: 'b', updatedAt: '2026-11-11 00:00:01' },
        { lid: 'old', updatedAt: '2026-11-10 23:59:59' },
        { lid: 'gone', updatedAt: '2026-11-17 12:00:00' },
        { lid: 'none', updatedAt: null },
      ],
      titleOf,
      nowMs: NOW,
      days: 7,
    });
    expect(a.rows.map((r) => r[1])).toEqual(['題-a', '題-b']);
    expect(a.links).toEqual([[{ col: 1, lid: 'a' }], [{ col: 1, lid: 'b' }]]);
  });

  it('🔴 smart = 走査が返した順。出さないノートは飛ばす', () => {
    const a = smartAnswer({ lids: ['x', 'gone', 'y'], titleOf, updatedOf: () => null });
    expect(a.rows.map((r) => r[0])).toEqual(['題-x', '題-y']);
    expect(a.links).toEqual([[{ col: 0, lid: 'x' }], [{ col: 0, lid: 'y' }]]);
  });

  it('スマートフォルダは題名で探す(前後の空白・大小は問わない / アーカイブとほかの種類は見ない)', () => {
    const notes = [
      { lid: 'n', title: 'Weekly', archetype: 'text', archived: false },
      { lid: 'arch', title: 'Weekly', archetype: 'smart', archived: true },
      { lid: 's', title: ' weekly ', archetype: 'smart', archived: false },
    ];
    expect(findSmartFolder(notes, 'WEEKLY', 'smart')).toBe('s');
    expect(findSmartFolder(notes, 'none', 'smart')).toBeNull();
  });
});

describe('書き出しへの焼き込み', () => {
  it('🔴 既製の表も書き出した時点の答えを焼く(名前の行つき・「更新」は無い)/ 作れなければ表の言葉で断る', async () => {
    const html = renderMarkdown('```embed recent\n```\n\n```embed nope\n```\n');
    const out = await bakeSqlEmbeds(html, async (src) => {
      if (src.includes('nope')) throw new Error('「nope」という表はありません');
      return { columns: ['更新', 'ノート'], rows: [['2026-11-17 10:00', 'A']], truncated: false, title: '直近 7 日に更新したノート' };
    });
    expect(out).toContain('直近 7 日に更新したノート');
    expect(out).not.toContain('embed-view-refresh');
    expect(out).toContain('表を作れませんでした: 「nope」という表はありません');
    expect(out).not.toContain('SQL を実行できませんでした');
  });

  it('⚠ 断りの字: 表は SQL の言葉を使わない / SQL は今までどおり', () => {
    expect(sqlEmbedFailureHtml('x', true, null, true)).toContain('表を作れませんでした: x');
    expect(sqlEmbedFailureHtml('x', true, null, true)).not.toContain('SQL');
    expect(sqlEmbedFailureHtml('x', true)).toContain('SQL を実行できませんでした: x');
  });
});
