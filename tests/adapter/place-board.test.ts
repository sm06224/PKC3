/** @vitest-environment happy-dom */
/**
 * 🔴 **自由配置の板**(#283 P4)── 位置を当てる(place-board)/ 掴んで動かす
 * (place-drag)/ 書換の門(MOVE_PLACE)。
 *
 * ## 守る主張
 *
 * 1. `.pkc-place` の塊が **本文の記法の位置**に置かれる(x= y= w= h= z=)
 * 2. `entry=` の塊は**題名の札**になり、押すとそのノートへ飛ぶ(展開はしない)
 * 3. 🔴 掴んで離すと `MOVE_PLACE` が飛び、**開き行を捕えた** REQUEST_BODY_REWRITE になる
 * 4. 🔴 編集中は声に出して断る(reducer 1 か所 ── 掴む口を足しても取りこぼさない)
 * 5. 動かしていない(slop 未満)なら書かない
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag } from '../../src/adapter/ui/render/place-drag';

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
  ':::',
].join('\n');

/** 描画が吐く形(place-probe で実測した属性の並び)を模す。 */
const RENDERED = [
  '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-h="200" data-pkc-w="320" data-pkc-x="120" data-pkc-y="40"><h3>買い出し</h3></div>',
  '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-entry="n2" data-pkc-x="460" data-pkc-y="40"></div>',
].join('\n');

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

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('位置を当てる(applyPlaceLayout)', () => {
  function mounted() {
    const host = document.createElement('div');
    host.className = 'pkc-md-rendered';
    host.innerHTML = RENDERED;
    document.body.append(host);
    const titles = new Map([['n2', '相手のノート']]);
    const n = applyPlaceLayout(host, (l) => titles.get(l) ?? null);
    return { host, n };
  }

  it('🔴 本文の記法の位置に置かれる(x= y= w= h=)', () => {
    const { host, n } = mounted();
    expect(n).toBe(2);
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    expect(p1.style.left).toBe('120px');
    expect(p1.style.top).toBe('40px');
    expect(p1.style.width).toBe('320px');
    expect(p1.style.height).toBe('200px');
    expect(host.classList.contains('pkc-board-host'), '器に板の印が無い').toBe(true);
    // いちばん下の塊(40+200)まで scroll で届く高さ
    expect(host.style.minHeight).toBe('280px');
  });

  it('🔑 何番目の塊かが焼かれる(掴んで離したとき本文の開き行を指す番号)', () => {
    const { host } = mounted();
    expect(
      [...host.querySelectorAll('.pkc-place')].map((el) => el.getAttribute('data-pkc-place-ordinal')),
    ).toEqual(['0', '1']);
  });

  it('掴む口が 1 つずつ出る(2 回呼んでも増えない・見出しの字を汚さない)', () => {
    const { host } = mounted();
    applyPlaceLayout(host, () => null);
    const grips = host.querySelectorAll('[data-pkc-field="place-grip"]');
    expect(grips).toHaveLength(2);
    expect(grips[0]!.textContent, '印が字として入っている(写しが汚れる)').toBe('');
    expect(host.querySelector('h3')!.textContent).toBe('買い出し');
  });

  it('🔴 entry= の塊は題名の札になり、押す先が select-entry(展開はしない)', () => {
    const { host } = mounted();
    const card = host.querySelector<HTMLButtonElement>('#p2 [data-pkc-field="place-card"]')!;
    expect(card.textContent).toBe('相手のノート');
    expect(card.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(card.getAttribute('data-pkc-entry')).toBe('n2');
  });

  it('相手が消えていても黙って空にしない', () => {
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    document.body.append(host);
    applyPlaceLayout(host, () => null);
    expect(host.querySelector('#p2 [data-pkc-field="place-card"]')!.textContent).toBe(
      '(見つかりません)',
    );
  });

  it('板の塊が無ければ器の印も外す(戻り道)', () => {
    const { host } = mounted();
    host.innerHTML = '<p>ただの本文</p>';
    expect(applyPlaceLayout(host, () => null)).toBe(0);
    expect(host.classList.contains('pkc-board-host')).toBe(false);
    expect(host.style.minHeight).toBe('');
  });

  it('読めない値(x="abc")は 0 扱い(黙って落ちない)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="pkc-format-block pkc-place" data-pkc-x="abc"></div>';
    document.body.append(host);
    applyPlaceLayout(host, () => null);
    expect(host.querySelector<HTMLElement>('.pkc-place')!.style.left).toBe('0px');
  });
});

describe('書換の門(MOVE_PLACE)', () => {
  function booted() {
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    events.length = 0;
    return { d, events };
  }

  it('🔴 開き行を捕えた REQUEST_BODY_REWRITE になる', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', ordinal: 1, x: 10, y: 20 });
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: {
        kind: 'place-move',
        ordinal: 1,
        openLine: ':::format{#p2 .pkc-place entry=n2 x=460 y=40}',
        x: 10,
        y: 20,
      },
    });
  });

  it('🔴 編集中は声に出して断る(掴む口を足しても取りこぼさない ── reducer 1 か所)', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', ordinal: 0, x: 1, y: 2 });
    expect(d.getState().error ?? '', '理由が出ていない').toContain('編集を終了');
    expect(d.getState().error ?? '', '押した場所と文言が合っていない').toContain('板');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('開いているノートと違う lid / 居ない番目は書かない', () => {
    const { d, events } = booted();
    d.dispatch({ type: 'MOVE_PLACE', lid: 'nX', ordinal: 0, x: 1, y: 2 });
    d.dispatch({ type: 'MOVE_PLACE', lid: 'n1', ordinal: 9, x: 1, y: 2 });
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });
});

describe('掴んで動かす(place-drag)', () => {
  function mounted() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const host = document.createElement('div');
    host.innerHTML = RENDERED;
    root.append(host);
    applyPlaceLayout(host, () => null);
    const d = new Dispatcher();
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '板')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BOARD });
    events.length = 0;
    const off = installPlaceDrag(root, d);
    const grip = host.querySelector<HTMLElement>('#p1 [data-pkc-field="place-grip"]')!;
    const block = host.querySelector<HTMLElement>('#p1')!;
    return { root, host, d, events, off, grip, block };
  }

  const opts = { bubbles: true, pointerId: 1, button: 0 };

  function drag(grip: HTMLElement, dx: number, dy: number): void {
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: dx, clientY: dy }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: dx, clientY: dy }));
  }

  it('🔴 掴んで離すと、動いた先の位置で MOVE_PLACE → 書換の依頼が飛ぶ', () => {
    const { events, grip, block, off } = mounted();
    drag(grip, 30, -10);
    // 掴んでいる間に見た目が動いている(離す前に 1 回は move が効いた)
    expect(block.style.left).toBe('150px');
    expect(block.style.top).toBe('30px');
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({ rewrite: { kind: 'place-move', ordinal: 0, x: 150, y: 30 } });
    off();
  });

  it('slop 未満(押しただけ)では動かさず、書かない', () => {
    const { events, grip, block, off } = mounted();
    drag(grip, 2, 2);
    expect(block.style.left).toBe('120px');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    off();
  });

  it('左上より外へは出さない(負の座標を書かない)', () => {
    const { events, grip, off } = mounted();
    drag(grip, -500, -500);
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev).toMatchObject({ rewrite: { kind: 'place-move', x: 0, y: 0 } });
    off();
  });
});
