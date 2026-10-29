/** @vitest-environment happy-dom */
/**
 * 🔴 **「今日」で作る種類を選べる**(#1640 項 1。推薦 B)。
 * ▼ の「今日をログで開く」で textlog の日付ノートを作り、選んだ種類を覚えて、次の「今日」も同じ種類で作る。
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

  it('▼ に「今日をログで開く」と「今日をノートで開く」が在る', () => {
    const { root } = setup();
    const items = [
      ...root.querySelectorAll('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"]'),
    ];
    expect(items.map((e) => e.textContent?.trim())).toEqual(['今日をログで開く', '今日をノートで開く']);
  });

  it('何も選んでいなければ、今までどおりノートで作る', () => {
    const { sent, click } = setup();
    click('[data-pkc-field="open-today"]');
    expect(created(sent)?.archetype).toBe('text');
  });

  it('「今日をログで開く」はログで作り、次の「今日」もログで作る(覚える)', () => {
    const a = setup();
    a.click('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"][data-pkc-archetype="textlog"]');
    expect(created(a.sent)).toMatchObject({ archetype: 'textlog', title: '2026-10-29' });
    expect(appTodayKind.get()).toBe('textlog');
    const b = setup();
    b.click('[data-pkc-field="open-today"]');
    expect(created(b.sent)?.archetype).toBe('textlog');
  });

  it('「今日をノートで開く」で戻せる', () => {
    appTodayKind.set('textlog');
    const a = setup();
    a.click('[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"][data-pkc-archetype="text"]');
    expect(created(a.sent)?.archetype).toBe('text');
    expect(appTodayKind.get()).toBe('text');
  });
});
