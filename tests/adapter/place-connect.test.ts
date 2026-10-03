/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋どうしを、掴んで繋ぐ**(#530 段③d。🟣 Gemini 裁定 2026-10-01 ── 設問 1 = A / 設問 2 = A)。
 *
 * ## 守る主張
 *
 * 1. 乗せた辺にだけ ● 1 つと両隣に ⊕ 2 つが出る。乗せていないときは 0 個、他の辺にも出ない
 * 2. ⊕ に乗せるとそこが ● になり、さらに細かい ⊕ が出る
 * 3. ● を掴んで別の付箋の上で離すと、**本文が期待の記法どおりに**書き換わる
 *    (掴んだ側は ● の位置、離した側は離した辺の中央。名前が無ければ `#板1` `#板2` が足される。
 *    名前が在る付箋は **1 byte も変わらない**)
 * 4. 付箋の外 / 自分自身の上 / `Esc` / 途中で切れた(pointercancel)なら**何も書かない**
 * 5. 掴んでいる間は仮の線(SVG 1 本)がマウスの位置まで引かれ、離したら消える
 * 6. 編集中は出さず、掴めない(掴んだ後に編集へ入っても書かない)
 * 7. 引いた線は右クリックで消せる(片道にしない)── 板の行・本文の行は消えない
 *
 * ## 🔑 本物の描画で台を組む
 *
 * 刻印(`data-pkc-source-line`)・大きさ(`data-pkc-w`)は `renderMarkdown` に焼かせる ──
 * 手で書くと、この test だけ都合のよい刻印を持って通る。書換の結果は
 * `applyBodyRewrite`(store-effects が書く当の関数)に通して**本文の字**で見る。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { installPlaceConnect } from '../../src/adapter/ui/render/place-connect';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

/** 左(0,0 / 100×60)と右(300,0 / 100×60)。名前は無い。 */
const TWO = [
  ':::format{.pkc-place x=0 y=0 w=100 h=60}', // 0
  '左', // 1
  ':::', // 2
  '', // 3
  ':::format{.pkc-place x=300 y=0 w=100 h=60}', // 4
  '右', // 5
  ':::', // 6
  '',
].join('\n');

const HANDLE = '[data-pkc-field="place-handle"]';
const GHOST = '[data-pkc-field="place-connect-ghost"]';
const MENU = '[data-pkc-region="context-menu"]';

const meta = (lid: string): never =>
  ({
    lid,
    title: lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
  }) as never;

const offs: Array<() => void> = [];
afterEach(() => {
  while (offs.length > 0) offs.pop()!();
  document.body.textContent = '';
});

function rig(body = TWO) {
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  asks.length = 0;
  offs.push(installPlaceConnect(root, d));
  // ⚠ 行番号で引かない(frontmatter を足した台でも同じ 2 枚が取れるように、並びで引く)
  const [left, right] = [...host.querySelectorAll<HTMLElement>('.pkc-place')] as [HTMLElement, HTMLElement];
  expect(left, '前提が崩れている: 左の付箋が描かれていない').not.toBeNull();
  expect(right, '前提が崩れている: 右の付箋が描かれていない').not.toBeNull();
  return { root, host, d, asks, left, right };
}

const opts = { bubbles: true, pointerId: 1, button: 0 };
function hover(el: Element, x: number, y: number): void {
  el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
}
function down(el: Element, x = 0, y = 0): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x, clientY: y }));
}
function move(x: number, y: number): void {
  document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
}
function up(x: number, y: number): void {
  document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x, clientY: y }));
}
const handles = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(HANDLE)];
const anchors = (host: HTMLElement, kind: 'dot' | 'plus'): string[] =>
  handles(host)
    .filter((h) => h.getAttribute('data-pkc-handle') === kind)
    .map((h) => h.getAttribute('data-pkc-anchor') ?? '');
const dot = (host: HTMLElement): HTMLElement =>
  handles(host).find((h) => h.getAttribute('data-pkc-handle') === 'dot')!;

describe('乗せると ● と ⊕ が出る(#530 段③d)', () => {
  it('🔴 乗せていないときは 0 個。乗せると、乗せた辺にだけ ● 1 つと ⊕ 2 つ', () => {
    const { host, left } = rig();
    expect(handles(host), '乗せていないのに出ている').toHaveLength(0);
    // 左の付箋(0,0 / 100×60)の右の辺のすぐ内側
    hover(left, 96, 30);
    expect(handles(host), '3 個出ていない').toHaveLength(3);
    expect(anchors(host, 'dot')).toEqual(['right']);
    expect(anchors(host, 'plus').sort()).toEqual(['right@1/4', 'right@3/4']);
    // 🔑 他の辺には 1 つも出ない(出ている全部が right)
    for (const h of handles(host)) {
      expect(h.getAttribute('data-pkc-anchor'), '別の辺に出ている').toMatch(/^right/);
    }
    // 🔑 位置は辺の上(右の辺 x=100、真ん中 y=30、1/4 = y=15、3/4 = y=45)
    expect([dot(host).style.left, dot(host).style.top]).toEqual(['100px', '30px']);
    const plus = handles(host).filter((h) => h.getAttribute('data-pkc-handle') === 'plus');
    expect(plus.map((h) => h.style.top).sort()).toEqual(['15px', '45px']);
  });

  it('🔴 乗せる辺が変われば、出る辺も変わる(上の辺 / 左の辺の対照群)', () => {
    const { host, left } = rig();
    hover(left, 50, 3);
    expect(anchors(host, 'dot')).toEqual(['top']);
    hover(left, 3, 30);
    expect(anchors(host, 'dot')).toEqual(['left']);
    hover(left, 50, 57);
    expect(anchors(host, 'dot')).toEqual(['bottom']);
    expect(handles(host), '辺を替えても 3 個のまま').toHaveLength(3);
  });

  it('🔴 付箋の外へ出ると消える', () => {
    const { host, left, root } = rig();
    hover(left, 96, 30);
    expect(handles(host)).toHaveLength(3);
    hover(root, 600, 400);
    expect(handles(host), '外へ出たのに残っている').toHaveLength(0);
  });

  it('🔴 ⊕ に乗せると、そこが ● になり、さらに細かい ⊕ が出る', () => {
    const { host, left } = rig();
    hover(left, 96, 30);
    const plus = handles(host).find((h) => h.getAttribute('data-pkc-anchor') === 'right@1/4')!;
    hover(plus, 100, 15);
    expect(anchors(host, 'dot'), '乗せた ⊕ が ● になっていない').toEqual(['right@1/4']);
    expect(anchors(host, 'plus').sort()).toEqual(['right@1/8', 'right@3/8']);
    expect(handles(host)).toHaveLength(3);
    // 🔑 ● に乗せても何も変わらない(作り直さない)
    const before = dot(host);
    hover(before, 100, 15);
    expect(dot(host), '● に乗せただけで作り直した').toBe(before);
    // 🔑 同じ付箋の同じ辺の上を動いているだけでも、選んだ ● は保たれる
    hover(left, 96, 20);
    expect(anchors(host, 'dot')).toEqual(['right@1/4']);
  });

  it('🔴 編集中は出さない(出ていた物も畳む)', () => {
    const { host, left, d } = rig();
    hover(left, 96, 30);
    expect(handles(host)).toHaveLength(3);
    d.dispatch({ type: 'START_EDIT' });
    hover(left, 96, 20);
    expect(handles(host), '編集中なのに出ている').toHaveLength(0);
    // ⚠ 空振り防止 ── 編集をやめれば出る(出さない理由が編集中だけである)
    d.dispatch({ type: 'CANCEL_EDIT' });
    hover(left, 96, 22);
    expect(handles(host), '編集を終えても出ない(前提が崩れている)').toHaveLength(3);
  });
});

describe('掴んで離すと、本文が書き換わる(#530 段③d)', () => {
  /** 依頼を実際の書換へ通した本文(store-effects が書く当の関数)。 */
  function wrote(asks: DomainEvent[], body = TWO): string {
    expect(asks, '書換の依頼が 1 回出ていない').toHaveLength(1);
    const ev = asks[0]!;
    if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
    const next = applyBodyRewrite(body, ev.rewrite);
    expect(next, '書換が断られた').not.toBeNull();
    return next!;
  }

  it('🔴 名前の無い 2 枚: ● を掴んで右の付箋の左の辺で離すと、名前が足され、線が書かれる', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    up(310, 32); // 右の付箋(300,0 / 100×60)の左の辺のすぐ内側
    expect(asks[0]).toMatchObject({
      lid: 'n1',
      rewrite: {
        kind: 'place-connect',
        from: { line: 0 },
        to: { line: 4 },
        fromAnchor: 'right',
        toAnchor: 'left',
      },
    });
    const next = wrote(asks);
    expect(next.split('\n')[0], '左に名前が足されていない').toBe(
      ':::format{#板1 .pkc-place x=0 y=0 w=100 h=60}',
    );
    expect(next.split('\n')[4], '右に名前が足されていない').toBe(
      ':::format{#板2 .pkc-place x=300 y=0 w=100 h=60}',
    );
    expect(next.endsWith(':::format{.pkc-line from=板1:right to=板2:left}\n:::\n')).toBe(true);
    // 中身の行は 1 byte も変わらない
    expect(next.split('\n')[1]).toBe('左');
    expect(next.split('\n')[5]).toBe('右');
  });

  it('🔴 ⊕ を掴む(= 細かい繋ぎ目)と、掴んだ側が `@1/4` の綴りで書かれる。落とした辺は中央', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    const plus = handles(host).find((h) => h.getAttribute('data-pkc-anchor') === 'right@1/4')!;
    hover(plus, 100, 15); // ⊕ が ● になる
    down(dot(host), 100, 15);
    move(350, 4);
    up(350, 4); // 右の付箋の上の辺
    const next = wrote(asks);
    expect(next.endsWith(':::format{.pkc-line from=板1:right@1/4 to=板2:top}\n:::\n')).toBe(true);
  });

  it('🔴 対照群: 名前が在る付箋は 1 byte も変わらず、無い側にだけ連番が付く(既に在る名前を避ける)', () => {
    const named = TWO.replace('{.pkc-place x=0', '{#今日 .pkc-place x=0');
    const { host, left, asks } = rig(named);
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    up(310, 32);
    const next = wrote(asks, named);
    expect(next.split('\n')[0], '名前が在る付箋を書き換えた').toBe(
      ':::format{#今日 .pkc-place x=0 y=0 w=100 h=60}',
    );
    expect(next.split('\n')[4]).toBe(':::format{#板1 .pkc-place x=300 y=0 w=100 h=60}');
    expect(next.endsWith('from=今日:right to=板1:left}\n:::\n')).toBe(true);
  });

  it('🔴 対照群: 2 枚とも名前が在れば、本文に足されるのは線の塊だけ(付箋の行は 1 byte も動かない)', () => {
    const named = TWO.replace('{.pkc-place x=0', '{#a .pkc-place x=0').replace(
      '{.pkc-place x=300',
      '{#b .pkc-place x=300',
    );
    const { host, left, asks } = rig(named);
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    up(310, 32);
    const next = wrote(asks, named);
    expect(next, '線の塊の他に何かが変わった').toBe(
      `${named}\n:::format{.pkc-line from=a:right to=b:left}\n:::\n`,
    );
  });

  it('🔴 付箋の外で離したら、何も書かない(仮の線も消える)', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(200, 200);
    expect(document.querySelector(GHOST), '掴んでいる間に仮の線が無い').not.toBeNull();
    up(200, 200);
    expect(asks, '外で離したのに書いた').toHaveLength(0);
    expect(document.querySelector(GHOST), '仮の線が残っている').toBeNull();
  });

  it('🔴 掴んだ付箋自身の上で離しても、何も書かない', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(40, 30);
    up(40, 30);
    expect(asks, '自分自身へ繋いだ').toHaveLength(0);
  });

  it('🔴 Esc で取りやめると、離しても書かない', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector(GHOST), 'Esc で仮の線が消えていない').toBeNull();
    up(310, 32);
    expect(asks, 'Esc の後に書いた').toHaveLength(0);
  });

  it('🔴 途中で切れた(pointercancel)ら、書かない・仮の線も消える', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    document.dispatchEvent(new PointerEvent('pointercancel', { ...opts }));
    expect(document.querySelector(GHOST)).toBeNull();
    up(310, 32);
    expect(asks).toHaveLength(0);
  });

  it('slop 未満(押しただけ)では何も書かず、仮の線も出ず、click も飲まない', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(101, 31);
    expect(document.querySelector(GHOST), '押しただけで仮の線が出た').toBeNull();
    up(101, 31);
    expect(asks).toHaveLength(0);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    left.dispatchEvent(click);
    expect(click.defaultPrevented, '押しただけの click まで飲んだ').toBe(false);
  });

  it('🔴 掴んで離した後の click は 1 回だけ飲む(離した指が付箋の押し物に落ちない)', () => {
    const { host, left, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    up(310, 32);
    expect(asks).toHaveLength(1);
    const click1 = new MouseEvent('click', { bubbles: true, cancelable: true });
    left.dispatchEvent(click1);
    expect(click1.defaultPrevented, '離した直後の click が素通りしている').toBe(true);
    const click2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    left.dispatchEvent(click2);
    expect(click2.defaultPrevented, '2 回目の click まで飲んでいる').toBe(false);
  });

  it('🔴 掴んでいる間、仮の線が ● からマウスの位置まで引かれ、乗せた付箋に予告が付く', () => {
    const { host, left, right } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(150, 80);
    const ghost = document.querySelector(GHOST)!;
    expect(ghost.querySelectorAll('path'), '仮の線は 1 本').toHaveLength(1);
    expect(ghost.querySelector('path')!.getAttribute('d')).toBe('M 100 30 L 150 80');
    expect(right.hasAttribute('data-pkc-connect-target'), '何も乗せていないのに予告が付いた').toBe(false);
    move(340, 30);
    expect(right.hasAttribute('data-pkc-connect-target'), '乗せた付箋に予告が付いていない').toBe(true);
    expect(left.hasAttribute('data-pkc-connect-target'), '掴んだ付箋自身に予告が付いた').toBe(false);
    move(200, 200);
    expect(right.hasAttribute('data-pkc-connect-target'), '外れたのに予告が残っている').toBe(false);
    // ⚠ 掴んだ付箋自身の上を通っても予告は付かない(自分へは繋がらない)
    move(40, 30);
    expect(left.hasAttribute('data-pkc-connect-target'), '掴んだ付箋自身に予告が付いた').toBe(false);
    up(40, 30);
  });

  it('🔴 編集中は掴めない(印を出した後に編集へ入っても、押して始まらず、書かない)', () => {
    const { host, left, d, asks } = rig();
    hover(left, 96, 30);
    const grab = dot(host);
    d.dispatch({ type: 'START_EDIT' });
    down(grab, 100, 30);
    move(310, 32);
    expect(document.querySelector(GHOST), '編集中なのに仮の線が出た').toBeNull();
    up(310, 32);
    expect(asks, '編集中に書いた').toHaveLength(0);
  });

  it('🔴 掴んだ後に編集へ入っても、離したときには書かない(取りこぼしの最後の門)', () => {
    const { host, left, d, asks } = rig();
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    d.dispatch({ type: 'START_EDIT' });
    up(310, 32);
    expect(asks, '編集へ入った後で書いた').toHaveLength(0);
    // 🔑 黙って返さない ── 離した user に「何も起きなかった」と見せず、理由を声に出す(reducer 1 か所)
    expect(d.getState().error ?? '', '理由が出ていない').toContain('編集を終了');
    expect(d.getState().error ?? '', '押した場所と文言が合っていない').toContain('線');
    expect(document.querySelector(GHOST)).toBeNull();
  });

  it('🔴 同じ 2 点をもう 1 度繋いでも、本文は変わらない(重なった線を作らない)', () => {
    const named = TWO.replace('{.pkc-place x=0', '{#a .pkc-place x=0').replace(
      '{.pkc-place x=300',
      '{#b .pkc-place x=300',
    );
    const once = `${named}\n:::format{.pkc-line from=a:right to=b:left}\n:::\n`;
    const { host, left, asks } = rig(once);
    hover(left, 96, 30);
    down(dot(host), 100, 30);
    move(310, 32);
    up(310, 32);
    // 依頼は出るが、書いても本文は 1 byte も変わらない
    expect(asks).toHaveLength(1);
    const ev = asks[0]!;
    if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
    expect(applyBodyRewrite(once, ev.rewrite)).toBe(once);
  });
});

describe('引いた線は、右クリックで消せる(片道にしない。#530 段③d)', () => {
  const LINED = [
    ':::format{#a .pkc-place x=0 y=0 w=100 h=60}', // 0
    '左', // 1
    ':::', // 2
    '', // 3
    ':::format{#b .pkc-place x=300 y=0 w=100 h=60}', // 4
    '右', // 5
    ':::', // 6
    '', // 7
    ':::format{.pkc-line from=a:right to=b:left}', // 8
    ':::', // 9
    '',
  ].join('\n');

  function rightClick(el: Element): void {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
  }
  const acts = (root: Element): string[] =>
    [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map(
      (b) => b.getAttribute('data-pkc-action') ?? '',
    );

  it('🔴 線の上で右クリックすると「この線を消す」が出て、押すと線の宣言だけが消える', () => {
    const { root, host, asks } = rig(LINED);
    const hit = host.querySelector<SVGElement>('[data-pkc-field="place-line-hits"] path');
    expect(hit, '前提が崩れている: 線を押さえる層が無い').not.toBeNull();
    expect(hit!.getAttribute('data-pkc-line-decl'), '線の開き行(生の body の 8 行目)を指していない').toBe('8');
    rightClick(hit!);
    // ⚠ 2026-10-03(#530 段④): 色と太さが並んだ。色なし・太さなしの線は「色…」「細く」「太く」+「消す」(最後)
    expect(acts(root), '色・太さ・「この線を消す」が並ぶ').toEqual([
      'place-color',
      'place-line-width',
      'place-line-width',
      'remove-place-line',
    ]);
    expect(root.querySelector(`${MENU} [data-pkc-action="remove-place-line"]`)!.textContent).toBe('この線を消す');
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="remove-place-line"]`)!.click();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'place-line-remove', line: 8, openLine: ':::format{.pkc-line from=a:right to=b:left}' },
    });
    const ev = asks[0]!;
    if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
    expect(applyBodyRewrite(LINED, ev.rewrite)).toBe(
      LINED.replace('\n:::format{.pkc-line from=a:right to=b:left}\n:::\n', '\n').replace(/\n+$/, '\n'),
    );
  });

  it('⚠ frontmatter が在っても、生の body の行を指す(座標の取り違えを止める)', () => {
    const fm = `---\nalign: left\n---\n${LINED}`;
    const { root, host, asks } = rig(fm);
    const hit = host.querySelector<SVGElement>('[data-pkc-field="place-line-hits"] path')!;
    expect(hit.getAttribute('data-pkc-line-decl'), '生の body の 11 行目').toBe('11');
    rightClick(hit);
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="remove-place-line"]`)!.click();
    expect(asks[0]).toMatchObject({ rewrite: { kind: 'place-line-remove', line: 11 } });
    const ev = asks[0]!;
    if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
    expect(applyBodyRewrite(fm, ev.rewrite), '線の宣言が消えていない').not.toContain('pkc-line');
  });

  it('🔴 対照群: 付箋の上・本文の上では「この線を消す」は出ない', () => {
    const { root, left } = rig(LINED);
    rightClick(left);
    expect(acts(root), '付箋の上に線の口が出た').not.toContain('remove-place-line');
    expect(acts(root), '付箋の上のメニューが出ていない(台の空振り)').toContain('copy-block-md');
  });

  it('🔴 編集中に押すと、理由を出して書かない', () => {
    const { root, host, d, asks } = rig(LINED);
    rightClick(host.querySelector('[data-pkc-field="place-line-hits"] path')!);
    d.dispatch({ type: 'START_EDIT' });
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="remove-place-line"]`)!.click();
    expect(asks, '編集中に書いた').toHaveLength(0);
    expect(d.getState().error ?? '', '理由が出ていない').toContain('線');
  });

  it('🔴 reducer: 板の行を渡しても線は消えない(押した物と効く先が食い違わない)', () => {
    const { d, asks } = rig(LINED);
    d.dispatch({ type: 'REMOVE_PLACE_LINE', lid: 'n1', line: 0 });
    expect(asks, '板の行で線を消す依頼を作った').toHaveLength(0);
    d.dispatch({ type: 'REMOVE_PLACE_LINE', lid: 'n1', line: 8 });
    expect(asks).toHaveLength(1);
  });
});

/**
 * 🔴 **見た目は CSS が持つ ── 規則が消えると、要素は在っても画面では押せない / 見分けられない**
 * (#530 段③d)。実ブラウザの計算後の値は smoke(`place-board.smoke.spec.ts`)が見る。
 *
 * 🔑 CSS は構文で読む(`css-blocks.ts`。CLAUDE.md §1 で 5 回踏んだ罠の正本)。
 */
describe('掴んで繋ぐ印と線の CSS(#530 段③d)', () => {
  const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
  const one = (sel: string): string => {
    const b = blocksFor(APP, sel);
    expect(b, `${sel} の規則が 1 つに決まらない`).toHaveLength(1);
    return b[0]!;
  };

  it('🔴 印の層は押しを通し、印そのものだけが押せる(層が付箋の押し物を塞がない)', () => {
    expect(one("[data-pkc-field='place-connect-handles']")).toMatch(decl('pointer-events', 'none'));
    expect(one("button[data-pkc-field='place-handle']")).toMatch(decl('pointer-events', 'auto'));
    expect(one("[data-pkc-field='place-connect-ghost']")).toMatch(decl('pointer-events', 'none'));
  });

  /**
   * 🔴 汎用の `button`(高さ・余白を `--row-h` に固定)に負けない ── 実ブラウザで 14×26 の縦長に
   * なって辺の上に中心が来なかった。⚠ 大きさの実測は smoke が持つ(ここは規則が在ること)。
   */
  /**
   * 🔴 **印の層は、`z=` を書いた板よりも手前**(板の `z-index` は本文の数をそのまま当てる)。
   * ⚠ 層が `z-index: auto` だと、`z=1` 以上の板に**印の内側の半分が隠れる**(`z=` を書かない
   *   板だけの台では、DOM の並びが救って見えない ── だから規則そのものを pin する)。
   */
  it('🔴 印の層・仮の線は、z= を書いた板より手前に居る', () => {
    expect(one("[data-pkc-field='place-connect-handles']")).toMatch(decl('z-index', '1000000'));
    expect(one("[data-pkc-field='place-connect-ghost']")).toMatch(decl('z-index', '1000000'));
  });

  it('🔴 掴んだまま乗せた付箋に、予告の枠が描かれる規則が在る', () => {
    expect(one('.pkc-place[data-pkc-connect-target]')).toMatch(decl('outline', '2px solid var\\(--accent\\)'));
  });

  it('🔴 印は汎用の button の高さ・余白を打ち消している(縦長の楕円にならない)', () => {
    const base = one("button[data-pkc-field='place-handle']");
    expect(base).toMatch(decl('min-height', '0'));
    expect(base).toMatch(decl('max-height', 'none'));
    expect(base).toMatch(decl('padding', '0'));
    expect(base).toMatch(decl('border-radius', '50%'));
  });

  it('🔴 ● と ⊕ は形で見分けられる(● = 塗りつぶし / ⊕ = 地の色に十字)', () => {
    const dotBg = one("button[data-pkc-field='place-handle'][data-pkc-handle='dot']");
    const plusBg = one("button[data-pkc-field='place-handle'][data-pkc-handle='plus']");
    expect(dotBg, '● の塗り').toMatch(decl('background', 'var\\(--accent\\)'));
    expect(plusBg, '⊕ に十字が無い').toContain('linear-gradient');
    expect(plusBg, '⊕ の地が塗りつぶし(● と見分けられない)').toContain('var(--surface)');
  });

  /**
   * 🔴 汎用の `button:hover:not(:disabled)`(0,2,1)が枠の色を `--muted` へ替える ── 印の `border`
   * (0,1,1)は負けるので、hover の分を別に持つ。⚠ 実ブラウザの計算後の値は smoke が見る。
   */
  it('🔴 乗せても印の枠の色は変わらない(hover の規則が在る)', () => {
    expect(one("button[data-pkc-field='place-handle']:hover:not(:disabled)")).toMatch(
      decl('border-color', 'var\\(--accent\\)'),
    );
  });

  it('🔴 線を押さえる層は、層そのものは押しを通し、道(stroke)の上だけが押せる', () => {
    expect(one("[data-pkc-field='place-line-hits']")).toMatch(decl('pointer-events', 'none'));
    const path = one("[data-pkc-field='place-line-hits'] path");
    expect(path).toMatch(decl('pointer-events', 'stroke'));
    // ⚠ 透明でも太い ── 見える線は 2px で押せない
    expect(path).toMatch(decl('stroke', 'transparent'));
    // 🔑 太さは変数(#530 段④)── 太い線の当たりも太くする。変数が無いときは今までの 12
    expect(path).toMatch(decl('stroke-width', 'var\\(--pkc-hit-width, 12\\)'));
  });
});

/** 🔴 main.ts の配線(main.ts は原文を読む test しか無い ── 配線を落としても unit は黙る)。 */
describe('配線(main.ts)', () => {
  it('🔴 起動時に掴んで繋ぐ配線が呼ばれている', () => {
    const src = stripComments(readFileSync('src/main.ts', 'utf-8')).replace(/\/\/.*$/gm, '');
    expect(src, '配線が呼ばれていない').toMatch(/installPlaceConnect\(root, dispatcher\)/);
    expect(src, '取り込みが無い').toMatch(/from '@adapter\/ui\/render\/place-connect'/);
  });
});
