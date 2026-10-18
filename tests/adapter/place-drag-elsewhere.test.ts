/** @vitest-environment happy-dom */
/**
 * 🔴 **別のタブ・ウィンドウが編集中のノートの付箋は、掴んで動かしても断る**(依頼 118-4。Gemini の回答「推薦どおり」= A)。
 *
 * 観測点: 離した後に撃たれる action の型(`MOVE_PLACE`)・付箋の見た目(断ったら元の位置へ戻る)・出た断りの字。
 * 対照群: 錠が取れたら撃つ / 錠の口を渡さない配線(unit)や自分で編集中のノートは同期のまま撃つ(離した直後の手応えを変えない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag, NUDGE_SETTLE_MS } from '../../src/adapter/ui/render/place-drag';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

const BOARD = [':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}', '### 買い出し', '- 牛乳', ':::'].join('\n');
const RENDERED =
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40" data-pkc-source-line="0" data-pkc-source-end="3"><h3>買い出し</h3></div>';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: '板',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  document.body.innerHTML = '';
});

function mounted(locks?: Parameters<typeof installPlaceDrag>[2]) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const host = document.createElement('div');
  host.innerHTML = RENDERED;
  root.append(host);
  applyPlaceLayout(host, () => null, 0);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
  events.length = 0;
  const off = installPlaceDrag(root, d, locks);
  const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
  const block = host.querySelector<HTMLElement>('#p1')!;
  return { d, events, off, grip, block };
}

const opts = { bubbles: true, pointerId: 1, button: 0 };
function drag(grip: HTMLElement, dx: number, dy: number): void {
  grip.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 0, clientY: 0 }));
  document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: dx, clientY: dy }));
  document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: dx, clientY: dy }));
}
const rewrites = (events: DomainEvent[]): DomainEvent[] => events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');

describe('付箋を掴んで動かす ── 別のタブが編集中なら断る(依頼 118-4)', () => {
  it('🔴 別のタブが握っていたら、書かずに元の位置へ戻し、理由を出す', async () => {
    const lock = { acquireEditLock: vi.fn(async () => 'denied' as const), releaseEditLock: vi.fn() };
    const { d, events, grip, block, off } = mounted(lock);
    drag(grip, 30, -10);
    expect(block.style.left, '離した直後は動いた先に見える(前提)').toBe('150px');
    await flush();
    expect(lock.acquireEditLock, '問い合わせていない(門が掛かっていない)').toHaveBeenCalledWith('n1');
    expect(rewrites(events), '断られたのに書換を頼んだ').toHaveLength(0);
    expect(d.getState().error).toContain(EDIT_ELSEWHERE_ERROR);
    expect(d.getState().error ?? '').toContain('元の位置に戻しました');
    expect(block.style.left, '元の位置へ戻っていない').toBe('120px');
    expect(block.style.top).toBe('40px');
    off();
  });

  it('対照群: 錠が取れたら書換を頼む(錠は握り続けず返す)', async () => {
    const lock = { acquireEditLock: vi.fn(async () => 'granted' as const), releaseEditLock: vi.fn() };
    const { events, grip, off } = mounted(lock);
    drag(grip, 30, -10);
    await flush();
    expect(rewrites(events)).toHaveLength(1);
    expect(events.find((e) => e.type === 'REQUEST_BODY_REWRITE')).toMatchObject({ rewrite: { kind: 'place-move', x: 150, y: 30 } });
    expect(lock.releaseEditLock).toHaveBeenCalledWith('n1');
    off();
  });

  it('対照群: 錠の口を渡さない配線は、離した瞬間に同期で書換を頼む(手応えを変えない)', () => {
    const { events, grip, off } = mounted();
    drag(grip, 30, -10);
    expect(rewrites(events)).toHaveLength(1);
    off();
  });

  it('🔴 矢印キーで動かした先も、手が止まった後に別のタブの編集を確かめる', async () => {
    vi.useFakeTimers();
    try {
      const lock = { acquireEditLock: vi.fn(async () => 'denied' as const), releaseEditLock: vi.fn() };
      const { d, events, grip, off } = mounted(lock);
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      vi.advanceTimersByTime(NUDGE_SETTLE_MS + 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(lock.acquireEditLock).toHaveBeenCalledWith('n1');
      expect(rewrites(events), '断られたのに書換を頼んだ').toHaveLength(0);
      expect(d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
      off();
    } finally {
      vi.useRealTimers();
    }
  });
});
