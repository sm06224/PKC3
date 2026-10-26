/** @vitest-environment happy-dom */
/**
 * 🔴 **右クリックしたチェック項目 1 つに、今日 / 明日 / 日付を外す**(#426 段②)── binder / reducer の側。
 * 面は本物の描画(`renderMarkdown`)から組む。日付の書き換え規則そのものは `body-rewrite` の仕事。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { frontmatterLineCount, bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';
import { shortcutDate } from '../../src/features/schedule/date-shortcuts';

const MENU = '[data-pkc-region="context-menu"]';

function setup(body: string, phase: AppState['phase'] = 'ready') {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = '<div data-pkc-region="detail"><div data-pkc-field="detail-body"></div></div>';
  document.body.append(root);
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
    interactiveTasks: true,
  } as never);
  const metas = new Map<string, never>([
    ['n1', { lid: 'n1', title: 'n1', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false } as never],
  ]);
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase,
    selectedLid: 'n1',
    entryMetas: metas as never,
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  bindActions(root, d, {});
  const rightClickAt = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  };
  const labels = (): string[] =>
    [...(root.querySelector(MENU)?.querySelectorAll('button[data-pkc-action^="task-item-date"]') ?? [])].map(
      (b) => `${b.getAttribute('data-pkc-action')}:${b.textContent}`,
    );
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    if (b === null) throw new Error(`前提が崩れている: ${action} が出ていない`);
    b.click();
  };
  const item = (n: number): Element => host.querySelectorAll('li.pkc-task-item')[n]!;
  return { d, events, host, rightClickAt, labels, press, item };
}

// 行: 0 見出し / 2 日付なし / 3 日付あり / 4 親 / 5 子
const BODY = ['# 今週', '', '- [ ] 見積を送る', '- [ ] 会議 @2026-09-07 10:00', '- [ ] 親', '  - [ ] 子'].join('\n');

describe('チェック項目 1 つの日付(#426 段②)', () => {
  it('日付なしの項目では 今日 / 明日 の 2 つ。「日付を外す」は出ない', () => {
    const s = setup(BODY);
    s.rightClickAt(s.item(0));
    expect(s.labels()).toEqual([
      'task-item-date-today:この項目を今日の予定にする',
      'task-item-date-tomorrow:この項目を明日の予定にする',
    ]);
  });

  it('日付ありの項目では「日付を外す」も出る(置けるなら外せる)', () => {
    const s = setup(BODY);
    s.rightClickAt(s.item(1));
    expect(s.labels().map((l) => l.split(':')[0])).toEqual([
      'task-item-date-today',
      'task-item-date-tomorrow',
      'task-item-date-clear',
    ]);
  });

  it('今日 → その項目の行だけに、今日の日付を書く(frontmatter ぶんの行ずれ込み)', () => {
    const body = `---\ntags: [x]\n---\n${BODY}`;
    const s = setup(body);
    s.rightClickAt(s.item(0));
    s.press('task-item-date-today');
    expect(s.events).toEqual([
      expect.objectContaining({
        type: 'REQUEST_BODY_REWRITE',
        lid: 'n1',
        rewrite: expect.objectContaining({
          kind: 'line-date',
          line: 5,
          openLine: '- [ ] 見積を送る',
          date: shortcutDate('today', new Date()),
        }),
      }),
    ]);
  });

  it('明日 → 明日の日付。入れ子の子の項目は、親ではなく子の行', () => {
    const s = setup(BODY);
    s.rightClickAt(s.item(3));
    s.press('task-item-date-tomorrow');
    expect(s.events).toEqual([
      expect.objectContaining({
        rewrite: expect.objectContaining({ line: 5, openLine: '  - [ ] 子', date: shortcutDate('tomorrow', new Date()) }),
      }),
    ]);
  });

  it('日付を外す → date: null(期間も外す)', () => {
    const s = setup(BODY);
    s.rightClickAt(s.item(1));
    s.press('task-item-date-clear');
    expect(s.events).toEqual([
      expect.objectContaining({
        rewrite: expect.objectContaining({ kind: 'line-date', line: 3, date: null, until: null }),
      }),
    ]);
  });

  it('編集中は断る(理由が出て、書換は頼まない)', () => {
    const s = setup(BODY, 'editing');
    s.rightClickAt(s.item(0));
    s.press('task-item-date-today');
    expect(s.d.getState().error).not.toBeNull();
    expect(s.events).toEqual([]);
  });

  it('項目でない所(見出し)・箱そのものの上では出ない', () => {
    const s = setup(BODY);
    s.rightClickAt(s.host.querySelector('h1')!);
    expect(s.labels()).toEqual([]);
    s.rightClickAt(s.host.querySelector('.pkc-task-checkbox')!);
    expect(s.labels()).toEqual([]);
  });
});
