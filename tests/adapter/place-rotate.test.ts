/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋の回転**(#530 段⑤d。Gemini 裁定 2026-10-11 依頼 19 Q2「推薦どおり」)── 画面側。
 *
 * 守る主張:
 * 1. 右クリックに「右に回す」「左に回す」がいつも出て、「回転を解く」は回した付箋にだけ出る。項目が運ぶのは押した結果の角度
 * 2. 押すと `rotate=` が開き行に書かれ、0 へ戻る(= 解く / 345 から右)と札が消える。他の札・他の行は 1 字も動かない
 * 3. 描画: `transform: rotate(θdeg)` が当たる。札が無い付箋は `transform` を持たない(今までと同じ)。`rotate=` だけ変えた再描画が飛ばされない
 * 4. 線の端: 回した付箋につないだ線は、回した辺の上で止まる(浮かない)。辺の判定・追記欄も回した外接四角に従う
 * 5. 角の伸縮: 回した付箋は `SET_PLACE_RECT`(x y w h)で書き、反対側の角が動かない。回していない付箋は今までの `RESIZE_PLACE`
 * 6. グループ: 回すのはその 1 枚だけ。グループの移動は回した仲間を位置だけ動かす
 * 7. 編集中は書かず理由を言う / 読めない値は書かない
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout, rectOf } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag } from '../../src/adapter/ui/render/place-drag';
import { openPlaceInline } from '../../src/adapter/ui/render/place-inline';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { rotatedCorners } from '../../src/features/markdown/place-rotate';

const MENU = '[data-pkc-region="context-menu"]';

const meta = (lid: string): never =>
  ({
    lid, title: lid, archetype: 'text', created_at: null, updated_at: null, entry_order: 1,
    status: null, date: null, archived: 0,
  }) as never;

/** 配線した drag の外し方 ── 外さないと、前の test の掴み(離した後の click を飲む)が次の test に残る */
const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.textContent = '';
});

function rig(body: string) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), { sourceLineAnchors: true });
  applyPlaceLayout(host, () => null, frontmatterLineCount(body));
  root.append(host);
  document.body.append(root);
  const d = new Dispatcher();
  const asks: DomainEvent[] = [];
  d.onEvent((e) => {
    if (e.type === 'REQUEST_BODY_REWRITE') asks.push(e);
  });
  bindActions(root, d, { showStatus: () => {} });
  const off = installPlaceDrag(root, d);
  offs.push(off);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  asks.length = 0;
  return { root, host, d, asks, off };
}

const rightClick = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
};
const items = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action]`),
];
const rotateItems = (root: Element): HTMLElement[] =>
  items(root).filter((b) => b.getAttribute('data-pkc-action') === 'place-rotate');
const labels = (root: Element): string[] => rotateItems(root).map((b) => b.textContent ?? '');
const carried = (root: Element): string[] =>
  rotateItems(root).map((b) => b.getAttribute('data-pkc-style-rotate') ?? '');
function rewriteOf(asks: DomainEvent[], at: number) {
  const ev = asks[at]!;
  if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
  return ev.rewrite;
}

const OPEN = ':::format{#a .pkc-place x=0 y=0 w=100 h=60}';
const withOpen = (open: string): string =>
  [open, '左', ':::', '', ':::format{#b .pkc-place x=300 y=0 w=100 h=60}', '右', ':::', ''].join('\n');
const BOARD = withOpen(OPEN);
const withRot = (extra: string): string => withOpen(OPEN.replace('}', ` ${extra}}`));

describe('付箋の右クリック ── 回す', () => {
  it('🔴 回していない付箋: 「右に回す」「左に回す」の 2 つだけ(「回転を解く」は出ない)。運ぶ角度は 15 / 345', () => {
    const { root, host } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    expect(labels(root)).toEqual(['右に回す', '左に回す']);
    expect(carried(root)).toEqual(['15', '345']);
  });

  it('🔴 回した付箋: 「回転を解く」が加わり、右・左は「いまの角度から 15°」を運ぶ', () => {
    const { root, host } = rig(withRot('rotate=45'));
    rightClick(host.querySelector('.pkc-place')!);
    expect(labels(root)).toEqual(['右に回す', '左に回す', '回転を解く']);
    expect(carried(root)).toEqual(['60', '30', '0']);
  });

  it('🔴 回転の項目は「消す」より前に並ぶ(確認を挟む物を真ん中に置かない)', () => {
    const { root, host } = rig(withRot('rotate=45'));
    rightClick(host.querySelector('.pkc-place')!);
    const acts = items(root).map((b) => b.getAttribute('data-pkc-action'));
    expect(acts.lastIndexOf('place-rotate')).toBeLessThan(acts.indexOf('remove-place'));
  });

  it.each([
    ['rotate=-15', ['15', '345']], // 読めない値は 0 から数える
    ['rotate=abc', ['15', '345']],
    ['rotate=360', ['15', '345']],
  ])('読めない字(%s)は回していない扱い ── ただし札は書かれているので「回転を解く」で外せる', (extra, nums) => {
    const { root, host } = rig(withRot(extra));
    rightClick(host.querySelector('.pkc-place')!);
    expect(carried(root).slice(0, 2)).toEqual(nums);
    expect(labels(root)).toContain('回転を解く');
  });

  it('🔴 rotate=0 と書いてある付箋にも「回転を解く」が出る(押せば札が消える ── 置けるなら外せる)', () => {
    const { root, host, asks } = rig(withRot('rotate=0'));
    rightClick(host.querySelector('.pkc-place')!);
    rotateItems(root).find((b) => b.textContent === '回転を解く')!.click();
    const next = applyBodyRewrite(withRot('rotate=0'), rewriteOf(asks, 0))!;
    expect(next).toBe(BOARD);
  });

  it('🔴 線の右クリックには回転が出ない(付箋だけの札)', () => {
    const body = [
      OPEN, '左', ':::', '', ':::format{#b .pkc-place x=300 y=0 w=100 h=60}', '右', ':::', '',
      ':::format{.pkc-line from=a to=b}', ':::', '',
    ].join('\n');
    const { root, host } = rig(body);
    rightClick(host.querySelector('.pkc-line')!);
    expect(rotateItems(root)).toHaveLength(0);
  });

  it('🔴 右に回す → rotate=15 が書かれる。他の札・他の行は 1 字も動かない', () => {
    const body = withOpen(OPEN.replace('}', ' fill=#ffe08a}'));
    const { root, host, asks } = rig(body);
    rightClick(host.querySelector('.pkc-place')!);
    rotateItems(root).find((b) => b.textContent === '右に回す')!.click();
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-style', line: 0, style: { rotate: 15 } });
    const next = applyBodyRewrite(body, rewriteOf(asks, 0))!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a rotate=15}');
    expect(next.split('\n').slice(1)).toEqual(body.split('\n').slice(1));
  });

  it('🔴 左に回す(回していない付箋) → rotate=345(負の値は書かない)', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    rotateItems(root).find((b) => b.textContent === '左に回す')!.click();
    const next = applyBodyRewrite(BOARD, rewriteOf(asks, 0))!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 rotate=345}');
  });

  it('🔴 345 から右に回す → 0 になり札が消える(rotate=0 と書き足さない)', () => {
    const { root, host, asks } = rig(withRot('rotate=345'));
    rightClick(host.querySelector('.pkc-place')!);
    rotateItems(root).find((b) => b.textContent === '右に回す')!.click();
    expect(rewriteOf(asks, 0)).toMatchObject({ style: { rotate: null } });
    const next = applyBodyRewrite(withRot('rotate=345'), rewriteOf(asks, 0))!;
    expect(next).toBe(BOARD);
  });

  it('🔴 回転を解く → 札が消えて元の本文と 1 バイトも違わない', () => {
    const { root, host, asks } = rig(withRot('rotate=90'));
    rightClick(host.querySelector('.pkc-place')!);
    rotateItems(root).find((b) => b.textContent === '回転を解く')!.click();
    expect(applyBodyRewrite(withRot('rotate=90'), rewriteOf(asks, 0))).toBe(BOARD);
  });

  it('🔴 編集中は書かず、理由を言う', () => {
    const { root, host, d, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    d.dispatch({ type: 'START_EDIT' });
    rotateItems(root).find((b) => b.textContent === '右に回す')!.click();
    expect(asks).toHaveLength(0);
    expect(d.getState().error ?? '').toContain('回転');
  });

  it('⚠ 属性を書き換えられて読めない角度になっても書かない', () => {
    const { root, host, asks } = rig(BOARD);
    rightClick(host.querySelector('.pkc-place')!);
    for (const bad of ['-15', '7.5', '360', 'x', '']) {
      const btn = rotateItems(root)[0]!;
      btn.setAttribute('data-pkc-style-rotate', bad);
      btn.click();
      rightClick(host.querySelector('.pkc-place')!);
    }
    expect(asks).toHaveLength(0);
  });

  it('🔴 reducer: 線の行に rotate は書かない(付箋だけの札)', () => {
    expect(
      applyBodyRewrite(
        ':::format{.pkc-line from=a to=b}\n:::\n',
        { kind: 'place-style', line: 0, openLine: ':::format{.pkc-line from=a to=b}', style: { rotate: 15 } },
      ),
    ).toBeNull();
  });
});

describe('描画 ── transform と、測り直し', () => {
  it('🔴 rotate=45 → transform: rotate(45deg)。書いていない付箋は transform を持たない(対照群)', () => {
    const { host } = rig(withRot('rotate=45'));
    const [a, b] = [...host.querySelectorAll<HTMLElement>('.pkc-place')] as [HTMLElement, HTMLElement];
    expect(a.style.transform).toBe('rotate(45deg)');
    expect(b.style.transform).toBe('');
    // 回しても left / top / width / height は回す前のまま
    expect([a.style.left, a.style.top, a.style.width, a.style.height]).toEqual(['0px', '0px', '100px', '60px']);
  });

  it('読めない字(rotate=-15 / 15deg)は回さない(本文は消さない)', () => {
    for (const bad of ['rotate=-15', 'rotate=15deg', 'rotate=360']) {
      const { host } = rig(withRot(bad));
      expect(host.querySelector<HTMLElement>('.pkc-place')!.style.transform, bad).toBe('');
    }
  });

  it('🔴 rotate= だけ変えた再描画が差分判定で飛ばされない(位置・大きさは同じ)', () => {
    const { host } = rig(withRot('rotate=45'));
    const a = host.querySelector<HTMLElement>('#a')!;
    expect(a.style.transform).toBe('rotate(45deg)');
    // 同じ要素の属性がその場で書き換わった回
    a.setAttribute('data-pkc-rotate', '90');
    applyPlaceLayout(host, () => null, 0);
    expect(a.style.transform).toBe('rotate(90deg)');
    // 解くと transform が消える
    a.removeAttribute('data-pkc-rotate');
    applyPlaceLayout(host, () => null, 0);
    expect(a.style.transform).toBe('');
  });

  it('rectOf: 回した付箋だけ rot を添える(w h は回す前のまま)。回していなければ rot の key 自体が無い', () => {
    const { host } = rig(withRot('rotate=45'));
    expect(rectOf(host.querySelector<HTMLElement>('#a')!)).toEqual({ x: 0, y: 0, w: 100, h: 60, rot: 45 });
    expect(Object.keys(rectOf(host.querySelector<HTMLElement>('#b')!))).toEqual(['x', 'y', 'w', 'h']);
  });

  it('🔴 板の高さ: 回した付箋は外接四角の下端で見積もる(90° で縦に伸びる分、器が伸びる)', () => {
    const tall = [
      ':::format{#a .pkc-place x=0 y=0 w=300 h=40 rotate=90}', '長い', ':::', '',
    ].join('\n');
    const flat = tall.replace(' rotate=90', '');
    const a = rig(flat).host;
    const b = rig(tall).host;
    // 回していない: 40 + 40。90° で幅 300 が縦になる: 中心 20 + 150 = 170 + 40
    expect(a.style.minHeight).toBe('80px');
    expect(b.style.minHeight).toBe('210px');
  });
});

describe('線の端 ── 回した付箋の辺に付く', () => {
  const lineHost = (aExtra: string) => {
    const body = [
      `:::format{#a .pkc-place x=0 y=0 w=100 h=100${aExtra}}`, '左', ':::', '',
      ':::format{#b .pkc-place x=300 y=0 w=100 h=100}', '右', ':::', '',
      ':::format{.pkc-line from=a:right to=b:left}', ':::', '',
    ].join('\n');
    return rig(body).host;
  };
  const startOf = (host: HTMLElement): number[] => {
    const d = host.querySelector('[data-pkc-field="place-lines"] path')!.getAttribute('d')!;
    return d.split(/[^\d.-]+/).filter((t) => t !== '').map(Number).slice(0, 2);
  };

  it('🔴 a:right を 90° 回すと、線は a の画面の下側(中心の真下 w/2)から出る', () => {
    expect(startOf(lineHost(''))).toEqual([100, 50]);
    expect(startOf(lineHost(' rotate=90'))).toEqual([50, 100]);
  });

  it('🔴 45° 回した端点は、回した四角の右辺の真ん中(浮いていない)', () => {
    const [x, y] = startOf(lineHost(' rotate=45'));
    const mid = rotatedCorners({ x: 0, y: 0, w: 100, h: 100 }, 45);
    // 右辺 = 右上の角と右下の角の中点
    const ex = (mid[1]!.x + mid[2]!.x) / 2;
    const ey = (mid[1]!.y + mid[2]!.y) / 2;
    expect(Math.abs(x! - ex)).toBeLessThan(0.01);
    expect(Math.abs(y! - ey)).toBeLessThan(0.01);
  });
});

describe('追記欄 ── 回した付箋の外接四角に重なる', () => {
  const open = (extra: string) => {
    const body = [`:::format{#a .pkc-place x=100 y=100 w=300 h=40${extra}}`, '長い', ':::', ''].join('\n');
    const { host } = rig(body);
    const block = host.querySelector<HTMLElement>('#a')!;
    // 欄の位置は style(left / top / width / height)から引く ── happy-dom は offset* が 0 なので置いた値へ落ちる
    const field = openPlaceInline(host, block, 'append', 'n1', '');
    return field;
  };

  it('🔴 回していない付箋: 追記欄は付箋の左端・下端(今までと同じ)', () => {
    const f = open('');
    expect([f.style.left, f.style.top, f.style.width]).toEqual(['100px', '140px', '300px']);
  });

  it('🔴 90° 回した 300×40: 外接四角(幅 40・高さ 300・中心 (250,120))の下端 270 に、その左端 230 で出る', () => {
    const f = open(' rotate=90');
    // 回す前の四角の下端(140)でも左端(100)でも、幅 300 でもない
    expect([f.style.left, f.style.top, f.style.width]).toEqual(['230px', '270px', '40px']);
  });
});

describe('角の伸縮 ── 付箋の向きで効く', () => {
  const RENDERED = [
    '<div class="pkc-format-block pkc-place" id="p1" data-pkc-format-block data-pkc-w="200" data-pkc-h="100" data-pkc-x="100" data-pkc-y="100" data-pkc-rotate="90" data-pkc-source-line="0" data-pkc-source-end="1"></div>',
    '<div class="pkc-format-block pkc-place" id="p2" data-pkc-format-block data-pkc-w="200" data-pkc-h="100" data-pkc-x="500" data-pkc-y="100" data-pkc-source-line="4" data-pkc-source-end="5"></div>',
  ].join('\n');
  const BODY = [
    ':::format{#p1 .pkc-place x=100 y=100 w=200 h=100 rotate=90}', 'a', ':::', '',
    ':::format{#p2 .pkc-place x=500 y=100 w=200 h=100}', 'b', ':::', '',
  ].join('\n');

  function mounted() {
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
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: BODY });
    events.length = 0;
    const off = installPlaceDrag(root, d);
    offs.push(off);
    return { host, events, off };
  }
  const opts = { bubbles: true, pointerId: 1, button: 0 };
  const down = (el: HTMLElement): void => {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 0, clientY: 0 }));
  };
  const move = (x: number, y: number): void => {
    document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
  };
  const up = (x: number, y: number): void => {
    document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x, clientY: y }));
  };

  it('🔴 90° の付箋: 画面の下へ 40 引くと幅が 40 伸びる(付箋の向き)。見た目も SET_PLACE_RECT も同じ値', () => {
    const { host, events, off } = mounted();
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    down(p1.querySelector<HTMLElement>('[data-pkc-field="place-size"]')!);
    move(0, 40);
    expect(p1.style.width).toBe('240px');
    expect(p1.style.height).toBe('100px');
    // 左上の角が動かないよう、位置も動く(中心が付箋の向きへ 20 動く = 画面の下へ 20、幅が増えた分の左右 −20)
    expect(p1.style.left).toBe('80px');
    expect(p1.style.top).toBe('120px');
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE'), '離す前に書いた').toHaveLength(0);
    up(0, 40);
    const asks = events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ rewrite: { kind: 'place-rect', line: 0, rect: { x: 80, y: 120, w: 240, h: 100 } } });
    off();
  });

  it('🔴 反対側の角(回した後の左上)が、書く前と書いた後で画面の同じ点にある', () => {
    const { host, events, off } = mounted();
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    const before = rotatedCorners({ x: 100, y: 100, w: 200, h: 100 }, 90)[0]!;
    down(p1.querySelector<HTMLElement>('[data-pkc-field="place-size"]')!);
    move(-25, 37);
    up(-25, 37);
    const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as Extract<DomainEvent, { type: 'REQUEST_BODY_REWRITE' }>;
    const r = (ev.rewrite as { rect: { x: number; y: number; w: number; h: number } }).rect;
    const after = rotatedCorners(r, 90)[0]!;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1); // 整数へ丸めた分
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    off();
  });

  it('🔑 元の大きさへ戻して離す(取りやめ)── 何も書かず、位置も大きさも戻る', () => {
    const { host, events, off } = mounted();
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    down(p1.querySelector<HTMLElement>('[data-pkc-field="place-size"]')!);
    move(0, 40);
    move(0, 0);
    up(0, 0);
    expect(events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
    expect(p1.style.left).toBe('100px');
    expect(p1.style.top).toBe('100px');
    expect(p1.style.width).toBe('200px');
    off();
  });

  it('🔴 途中で切れたら(pointercancel)位置も大きさも戻す', () => {
    const { host, off } = mounted();
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    down(p1.querySelector<HTMLElement>('[data-pkc-field="place-size"]')!);
    move(0, 40);
    document.dispatchEvent(new PointerEvent('pointercancel', { ...opts }));
    expect([p1.style.left, p1.style.top, p1.style.width, p1.style.height]).toEqual(['100px', '100px', '200px', '100px']);
    off();
  });

  it('🔴 対照群: 回していない付箋は今までどおり RESIZE_PLACE(w h だけ。位置は動かない)', () => {
    const { host, events, off } = mounted();
    const p2 = host.querySelector<HTMLElement>('#p2')!;
    down(p2.querySelector<HTMLElement>('[data-pkc-field="place-size"]')!);
    move(40, 30);
    expect(p2.style.width).toBe('240px');
    expect(p2.style.left).toBe('500px');
    up(40, 30);
    const asks = events.filter((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(asks[0]).toMatchObject({ rewrite: { kind: 'place-size', line: 4, w: 240, h: 130 } });
    off();
  });

  it('🔴 下限で止まる: 引き過ぎても幅・高さは 120 × 40', () => {
    const { host, off } = mounted();
    const p1 = host.querySelector<HTMLElement>('#p1')!;
    down(p1.querySelector<HTMLElement>('[data-pkc-field="place-size"]')!);
    move(2000, -2000);
    expect(p1.style.width).toBe('120px');
    expect(p1.style.height).toBe('40px');
    up(2000, -2000);
    off();
  });
});

describe('グループとの関係 ── 回すのはその 1 枚だけ', () => {
  const G = [
    ':::format{#a .pkc-place x=0 y=0 w=100 h=60 group=G1}', 'a', ':::', '',
    ':::format{#b .pkc-place x=300 y=0 w=100 h=60 group=G1}', 'b', ':::', '',
  ].join('\n');

  it('🔴 グループの 1 枚を右に回すと、書くのは開き行 1 本・その 1 枚の rotate= だけ(仲間は 1 字も動かない)', () => {
    const { root, host, asks } = rig(G);
    rightClick(host.querySelector('#a')!);
    rotateItems(root).find((b) => b.textContent === '右に回す')!.click();
    expect(asks).toHaveLength(1);
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-style', line: 0, style: { rotate: 15 } });
    const next = applyBodyRewrite(G, rewriteOf(asks, 0))!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 group=G1 rotate=15}');
    expect(next.split('\n').slice(1)).toEqual(G.split('\n').slice(1));
  });

  it('🔴 回したメンバーも、グループの移動では位置だけ動き、回転の見た目はそのまま', () => {
    const body = G.replace('w=100 h=60 group=G1}', 'w=100 h=60 group=G1 rotate=30}');
    const { host, asks, off } = rig(body);
    const a = host.querySelector<HTMLElement>('#a')!;
    const b = host.querySelector<HTMLElement>('#b')!;
    const grip = a.querySelector<HTMLElement>('[data-pkc-field="place-grip"]')!;
    const o = { bubbles: true, pointerId: 1, button: 0 };
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 20, clientY: 30 }));
    expect(a.style.left).toBe('20px');
    expect(b.style.left).toBe('320px');
    expect(a.style.transform).toBe('rotate(30deg)'); // 動かしても回転は外れない
    document.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 20, clientY: 30 }));
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-move-group' });
    const next = applyBodyRewrite(body, rewriteOf(asks, 0))!;
    expect(next).toContain('x=20 y=30 w=100 h=60 group=G1 rotate=30}');
    off();
  });
});
