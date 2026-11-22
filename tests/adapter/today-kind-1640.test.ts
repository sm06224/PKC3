/** @vitest-environment happy-dom */
/**
 * 🔴 **「今日」で作る種類を選べる**(#1640 項 1。推薦 B)。
 * ▼ の「今日のログ」で textlog の日付ノートを作り、選んだ種類を覚えて、次の「今日」も同じ種類で作る。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appTodayKind } from '../../src/adapter/ui/render/create-kind';

function setup() {
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  sent.length = 0;
  const click = (sel: string): void => root.querySelector<HTMLElement>(sel)!.click();
  return { root, d, sent, click };
}
const created = (sent: Dispatchable[]) =>
  sent.find((a) => a.type === 'CREATE_ENTRY') as { archetype: string; title: string } | undefined;

describe('「今日」で作る種類 (#1640 項 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 29, 10, 0));
    appTodayKind.set(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    appTodayKind.set(null);
  });

  it('▼ に「今日のログ」と「今日のノート」が在り、いまの既定に印(aria-checked)', () => {
    const { root } = setup();
    const items = [
      ...root.querySelectorAll('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"]'),
    ];
    expect(items.map((e) => e.textContent?.trim())).toEqual(['今日のログ', '今日のノート']);
    expect(items.map((e) => e.getAttribute('aria-checked')), '何も選んでいなければノートが既定').toEqual(['false', 'true']);
  });

  it('🔴 ログを覚えている端末で開いたら、印は「今日のログ」に付いている(起動のときに読む)', () => {
    appTodayKind.set('textlog');
    const { root } = setup();
    const items = [...root.querySelectorAll('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"]')];
    expect(items.map((e) => e.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('何も選んでいなければ、今までどおりノートで作る', () => {
    const { sent, click } = setup();
    click('[data-pkc-field="open-today"]');
    expect(created(sent)?.archetype).toBe('text');
  });

  it('「今日のログ」はログで作り、次の「今日」もログで作る(覚える)── 印もログへ移る', () => {
    const a = setup();
    a.click('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"][data-pkc-archetype="textlog"]');
    expect(created(a.sent)).toMatchObject({ archetype: 'textlog', title: '2026-10-29' });
    expect(appTodayKind.get()).toBe('textlog');
    expect(
      a.root.querySelector('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"][data-pkc-archetype="textlog"]')?.getAttribute('aria-checked'),
      '押した方へ印が移らない',
    ).toBe('true');
    const b = setup();
    b.click('[data-pkc-field="open-today"]');
    expect(created(b.sent)?.archetype).toBe('textlog');
  });

  it('「今日のノート」で戻せる', () => {
    appTodayKind.set('textlog');
    const a = setup();
    a.click('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"][data-pkc-archetype="text"]');
    expect(created(a.sent)?.archetype).toBe('text');
    expect(appTodayKind.get()).toBe('text');
  });
});
