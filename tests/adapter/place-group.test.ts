/** @vitest-environment happy-dom */
/**
 * 🔴 **板の付箋のグループ**(#530 段⑤b。Gemini 裁定 2026-10-11 依頼 19 Q3)── 画面側。
 *
 * 守る主張:
 * 1. 右クリックの項目: グループに入っていない付箋には「グループにする…」(まとめる相手が 2 枚以上あるときだけ)、
 *    入っている付箋には「グループを解く」。**片方だけ**が出る(押しても何も起きない口を作らない)。「消す」より前
 * 2. 窓: 付箋が最初の 1 行つきのチェックで並び、右クリックした付箋に最初から ✓。2 枚未満では閉じずに理由を出す。
 *    「やめる」/ Esc 相当(閉じる)は何も書かない。決めると `GROUP_PLACES` が行番号で飛ぶ。窓の間に本文が動いたら書かない
 * 3. 「グループを解く」は `UNGROUP_PLACE`。編集中は書かず理由を言う
 * 4. 描画: `group=` は `data-pkc-group` として焼かれる(ドラッグが拾う唯一の印)。書いていない付箋には焼かれない
 * 5. ドラッグ: グループの 1 枚の ⠿ を掴むと全員が同じだけ動き、離すと **1 回の書込**(`place-move-group`)。
 *    入っていない付箋・大きさの角は掴んだ 1 枚だけ(今までと同じ)。取りやめは何も書かない。断られたら全員が戻る。
 *    矢印キーも全員。下限(0)は全員で同じだけ手前で止める
 * 6. 線は付箋に追従する(グループとは関係なく、動かした付箋の辺から引き直される)
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { applyPlaceLayout } from '../../src/adapter/ui/render/place-board';
import { installPlaceDrag, NUDGE_SETTLE_MS } from '../../src/adapter/ui/render/place-drag';
import { pickPlaceGroupInApp, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { placeGroupAt } from '../../src/features/markdown/place-notation';
import { openDialog } from './dialog-helper';

const MENU = '[data-pkc-region="context-menu"]';

const meta = (lid: string): never =>
  ({
    lid, title: lid, archetype: 'text', created_at: null, updated_at: null, entry_order: 1,
    status: null, date: null, archived: 0,
  }) as never;

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetAppDialogForTest();
});
afterEach(() => {
  document.body.textContent = '';
  vi.useRealTimers();
});

function rig(body: string, withDrag = false) {
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
  const off = withDrag ? installPlaceDrag(root, d) : () => {};
  return { root, host, d, asks, off };
}

const rightClick = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
};
const items = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action]`),
];
const actionsOf = (root: Element): Array<string | null> => items(root).map((b) => b.getAttribute('data-pkc-action'));
const blockOf = (host: Element, id: string): HTMLElement => host.querySelector<HTMLElement>(`#${id}`)!;
function rewriteOf(asks: DomainEvent[], at: number) {
  const ev = asks[at]!;
  if (ev.type !== 'REQUEST_BODY_REWRITE') throw new Error('依頼ではない');
  return ev.rewrite;
}

const open = (id: string, x: number, extra = ''): string =>
  `:::format{#${id} .pkc-place x=${x} y=40 w=100 h=60${extra}}`;
const board = (...opens: string[]): string =>
  opens.flatMap((o, i) => [o, `付箋 ${i + 1} の一行目`, '二行目', ':::', '']).join('\n');
// 付箋 i 枚目(0 始まり)の開き行の行番号(1 枚 5 行)
const at = (i: number): number => i * 5;

const PLAIN = board(open('a', 100), open('b', 300), open('c', 500));
const GROUPED = board(open('a', 100, ' group=G1'), open('b', 300, ' group=G1'), open('c', 500));

describe('右クリックの項目', () => {
  it('🔴 入っていない付箋には「グループにする…」だけ(解くは出ない)。「消す」より前', () => {
    const { root, host } = rig(PLAIN);
    rightClick(blockOf(host, 'a'));
    const g = items(root).find((b) => b.getAttribute('data-pkc-action') === 'place-group');
    expect(g?.textContent).toBe('グループにする…');
    expect(actionsOf(root)).not.toContain('place-ungroup');
    const acts = actionsOf(root);
    expect(acts.indexOf('place-group')).toBeLessThan(acts.indexOf('remove-place'));
  });

  it('🔴 入っている付箋には「グループを解く」だけ(グループにするは出ない)', () => {
    const { root, host } = rig(GROUPED);
    rightClick(blockOf(host, 'a'));
    expect(items(root).find((b) => b.getAttribute('data-pkc-action') === 'place-ungroup')?.textContent).toBe('グループを解く');
    expect(actionsOf(root)).not.toContain('place-group');
  });

  it('🔴 まとめる相手が居ない板(入っていない付箋が 1 枚だけ)には、どちらも出ない', () => {
    const { root, host } = rig(board(open('a', 100)));
    rightClick(blockOf(host, 'a'));
    expect(actionsOf(root)).not.toContain('place-group');
    expect(actionsOf(root)).not.toContain('place-ungroup');
    // 対照群: 入っていない付箋が 2 枚になれば出る
    const two = rig(board(open('a', 100), open('b', 300)));
    rightClick(blockOf(two.host, 'a'));
    expect(actionsOf(two.root)).toContain('place-group');
  });

  it('グループが 1 つあって残りの入っていない付箋が 1 枚だけのときは、その 1 枚に「グループにする…」は出ない', () => {
    const { root, host } = rig(GROUPED);
    rightClick(blockOf(host, 'c'));
    expect(actionsOf(root)).not.toContain('place-group');
  });
});

describe('描画', () => {
  it('🔴 group= は data-pkc-group として焼かれ、書いていない付箋には焼かれない(対照群)', () => {
    const { host } = rig(GROUPED);
    expect(blockOf(host, 'a').getAttribute('data-pkc-group')).toBe('G1');
    expect(blockOf(host, 'b').getAttribute('data-pkc-group')).toBe('G1');
    expect(blockOf(host, 'c').hasAttribute('data-pkc-group')).toBe(false);
  });

  it('⚠ 板の付箋の data-pkc-group を読む口は、掴む口(place-drag)だけ ── closest("[data-pkc-group]") を書かない', () => {
    const code = readFileSync('src/adapter/ui/render/place-drag.ts', 'utf-8');
    expect(code).toContain('data-pkc-group');
    const others = ['place-board.ts', 'place-connect.ts', 'place-embed.ts'].map((f) =>
      readFileSync(`src/adapter/ui/render/${f}`, 'utf-8'),
    );
    for (const src of others) expect(src).not.toContain('data-pkc-group');
    // 全体では「closest で [data-pkc-group] を探す口」が板の付箋に当たらないよう、action 付きの要素だけを読む
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    expect(binder).not.toMatch(/closest\(\s*['"`]\[data-pkc-group\]/);
  });
});

describe('「グループにする…」の窓', () => {
  const pick = (root: Element, id: string): void => {
    rightClick(blockOf(root.querySelector('[data-pkc-field="detail-body"]')!, id));
    items(root).find((b) => b.getAttribute('data-pkc-action') === 'place-group')!.click();
  };
  const rows = (): HTMLInputElement[] => [
    ...openDialog()!.querySelectorAll<HTMLInputElement>('[data-pkc-field="place-group-check"]'),
  ];
  const ok = (): HTMLButtonElement => openDialog()!.querySelector('[data-pkc-field="dialog-ok"]')!;

  it('🔴 付箋が最初の 1 行つきで並び、右クリックした付箋にだけ最初から ✓', async () => {
    const { root } = rig(PLAIN);
    pick(root, 'b');
    await settle();
    const dlg = openDialog()!;
    expect(dlg.querySelector('[data-pkc-field="dialog-title"]')?.textContent).toBe('グループにする');
    const labels = [...dlg.querySelectorAll('[data-pkc-field="place-group-row"]')].map((r) => r.textContent);
    expect(labels).toEqual(['付箋 1 の一行目', '付箋 2 の一行目', '付箋 3 の一行目']);
    expect(rows().map((r) => r.checked)).toEqual([false, true, false]);
    expect(rows().map((r) => r.getAttribute('data-pkc-place-group-line'))).toEqual(['0', '5', '10']);
    // 最初の ✓ に焦点(キーボードだけで Space → Enter できる)
    expect(document.activeElement).toBe(rows()[1]);
    ok().click(); // 後始末
    await settle();
  });

  it('🔴 チェックを足して決める → GROUP_PLACES が行番号で飛び、適用すると全員に同じ group= が付く', async () => {
    const { root, asks } = rig(PLAIN);
    pick(root, 'a');
    await settle();
    rows()[2]!.checked = true;
    ok().click();
    await settle();
    expect(rewriteOf(asks, 0)).toMatchObject({
      kind: 'place-group',
      members: [{ line: at(0) }, { line: at(2) }],
    });
    const next = applyBodyRewrite(PLAIN, rewriteOf(asks, 0))!;
    expect(placeGroupAt(next.split('\n')[at(0)]!)).toBe('グループ1');
    expect(placeGroupAt(next.split('\n')[at(2)]!)).toBe('グループ1');
    expect(placeGroupAt(next.split('\n')[at(1)]!)).toBeNull();
  });

  it('🔴 1 枚だけでは決められない ── 閉じずに理由を出し、何も書かない。足せば決められる', async () => {
    const { root, asks } = rig(PLAIN);
    pick(root, 'a');
    await settle();
    ok().click();
    await settle();
    expect(openDialog(), '1 枚で閉じた').not.toBeNull();
    const err = openDialog()!.querySelector<HTMLElement>('[data-pkc-field="place-group-error"]')!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('2 枚以上');
    expect(asks).toHaveLength(0);
    rows()[1]!.checked = true;
    ok().click();
    await settle();
    expect(openDialog()).toBeNull();
    expect(asks).toHaveLength(1);
  });

  it('🔴 Enter で決められる(✓ に焦点があるまま)。IME の変換中は決めない', async () => {
    const { root, asks } = rig(PLAIN);
    pick(root, 'a');
    await settle();
    rows()[1]!.checked = true;
    rows()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    await settle();
    expect(asks).toHaveLength(0);
    rows()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(asks).toHaveLength(1);
  });

  it('🔴 やめる / 閉じる(Esc 相当)は何も書かない', async () => {
    const { root, asks } = rig(PLAIN);
    pick(root, 'a');
    await settle();
    rows()[1]!.checked = true;
    openDialog()!.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await settle();
    expect(asks).toHaveLength(0);
    pick(root, 'a');
    await settle();
    rows()[1]!.checked = true;
    openDialog()!.close(); // Esc は dialog を閉じる
    await settle();
    expect(asks).toHaveLength(0);
  });

  it('🔴 窓を開いている間に本文が動いたら書かず、理由を言う', async () => {
    const { root, d, asks } = rig(PLAIN);
    pick(root, 'a');
    await settle();
    rows()[1]!.checked = true;
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: PLAIN + '\n追記' });
    ok().click();
    await settle();
    expect(asks).toHaveLength(0);
  });

  it('⚠ グループに入っている付箋は窓に並ばない(黙って別のグループへ移さない)', async () => {
    const body = board(open('a', 100, ' group=G1'), open('b', 300, ' group=G1'), open('c', 500), open('d', 700));
    const { root } = rig(body);
    pick(root, 'c');
    await settle();
    expect(rows().map((r) => r.getAttribute('data-pkc-place-group-line'))).toEqual(['10', '15']);
    ok().click();
    await settle();
    openDialog()?.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')?.click();
    await settle();
  });

  it('窓そのもの(pickPlaceGroupInApp): 空の付箋は「(空の付箋)」と出し、返すのはチェックした行(並びは一覧の順)', async () => {
    resetAppDialogForTest();
    const host = document.createElement('div');
    document.body.append(host);
    const p = pickPlaceGroupInApp(host, [{ line: 0, label: '' }, { line: 5, label: 'x' }, { line: 9, label: 'y' }], 9);
    await settle();
    const dlg = openDialog()!;
    expect(dlg.querySelector('[data-pkc-field="place-group-row"]')?.textContent).toBe('(空の付箋)');
    const boxes = [...dlg.querySelectorAll<HTMLInputElement>('[data-pkc-field="place-group-check"]')];
    boxes[0]!.checked = true;
    dlg.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    expect(await p).toEqual([0, 9]);
  });
});

describe('「グループを解く」', () => {
  it('🔴 押すと UNGROUP_PLACE → 同じ名前の全員の札が消え、位置は動かない', () => {
    const { root, host, asks } = rig(GROUPED);
    rightClick(blockOf(host, 'a'));
    items(root).find((b) => b.getAttribute('data-pkc-action') === 'place-ungroup')!.click();
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-ungroup', line: at(0) });
    const next = applyBodyRewrite(GROUPED, rewriteOf(asks, 0))!;
    expect(next).toBe(PLAIN);
  });

  it('🔴 編集中は書かず、理由を言う', () => {
    const { root, host, d, asks } = rig(GROUPED);
    rightClick(blockOf(host, 'a'));
    d.dispatch({ type: 'START_EDIT' });
    items(root).find((b) => b.getAttribute('data-pkc-action') === 'place-ungroup')!.click();
    expect(asks).toHaveLength(0);
    expect(d.getState().error ?? '').toContain('グループ');
  });
});

describe('reducer の門 ── 1 枚でも読めなければ 1 枚も書かない', () => {
  it('🔴 MOVE_PLACES / GROUP_PLACES / UNGROUP_PLACE: 付箋でない行・2 枚未満・座標が不正は依頼を出さない(対照群: 正しい形は出る)', () => {
    const { d, asks } = rig(GROUPED);
    const ok = { type: 'MOVE_PLACES', lid: 'n1', moves: [{ line: at(0), x: 1, y: 1 }, { line: at(1), x: 2, y: 2 }] } as const;
    d.dispatch(ok);
    expect(asks, '対照群: 正しい形が出ていない').toHaveLength(1);
    asks.length = 0;
    d.dispatch({ ...ok, moves: [{ line: at(0), x: 1, y: 1 }, { line: 1, x: 2, y: 2 }] });
    d.dispatch({ ...ok, moves: [{ line: at(0), x: 1, y: 1 }, { line: at(1), x: -2, y: 2 }] });
    d.dispatch({ ...ok, moves: [] });
    d.dispatch({ type: 'GROUP_PLACES', lid: 'n1', lines: [at(0), 1] });
    d.dispatch({ type: 'GROUP_PLACES', lid: 'n1', lines: [at(0)] });
    d.dispatch({ type: 'UNGROUP_PLACE', lid: 'n1', line: 1 });
    expect(asks).toHaveLength(0);
    d.dispatch({ type: 'GROUP_PLACES', lid: 'n1', lines: [at(0), at(2)] });
    d.dispatch({ type: 'UNGROUP_PLACE', lid: 'n1', line: at(0) });
    expect(asks, '対照群: 正しい GROUP / UNGROUP が出ていない').toHaveLength(2);
  });

  it('🔴 編集中は 3 つとも断り、理由を言う', () => {
    const { d, asks } = rig(GROUPED);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'MOVE_PLACES', lid: 'n1', moves: [{ line: at(0), x: 1, y: 1 }] });
    expect(d.getState().error ?? '').toContain('動かして');
    d.dispatch({ type: 'GROUP_PLACES', lid: 'n1', lines: [at(0), at(2)] });
    expect(d.getState().error ?? '').toContain('グループにして');
    d.dispatch({ type: 'UNGROUP_PLACE', lid: 'n1', line: at(0) });
    expect(d.getState().error ?? '').toContain('グループを解いて');
    expect(asks).toHaveLength(0);
  });
});

describe('掴んで動かす ── グループは全員', () => {
  const opts = { bubbles: true, pointerId: 1, button: 0 };
  const grip = (host: Element, id: string): HTMLElement =>
    host.querySelector<HTMLElement>(`#${id} [data-pkc-field="place-grip"]`)!;
  const down = (g: HTMLElement): void => {
    g.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 0, clientY: 0 }));
  };
  const move = (x: number, y: number): void => {
    document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
  };
  const up = (x: number, y: number): void => {
    document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x, clientY: y }));
  };
  const pos = (host: Element, id: string): [string, string] => [blockOf(host, id).style.left, blockOf(host, id).style.top];

  it('🔴 1 枚を掴むと全員が同じだけ動く(掴んでいる間は見た目だけ。入っていない付箋は動かない)', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(30, 20);
    expect(pos(host, 'a')).toEqual(['130px', '60px']);
    expect(pos(host, 'b')).toEqual(['330px', '60px']);
    expect(pos(host, 'c')).toEqual(['500px', '40px']);
    expect(asks, '掴んでいる間に書いた').toHaveLength(0);
    off();
  });

  it('🔴 どのメンバーを掴んでも全員が動く(2 枚目を掴んでも同じ)', () => {
    const { host, off } = rig(GROUPED, true);
    down(grip(host, 'b'));
    move(-30, 10);
    expect(pos(host, 'a')).toEqual(['70px', '50px']);
    expect(pos(host, 'b')).toEqual(['270px', '50px']);
    off();
  });

  it('🔴 離すと 1 回の書込(place-move-group)で全員の位置が書かれ、適用すると全員の x= y= が動く', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(30, 20);
    up(30, 20);
    expect(asks).toHaveLength(1);
    const rw = rewriteOf(asks, 0);
    expect(rw).toMatchObject({
      kind: 'place-move-group',
      moves: [
        { line: at(0), x: 130, y: 60 },
        { line: at(1), x: 330, y: 60 },
      ],
    });
    const next = applyBodyRewrite(GROUPED, rw)!.split('\n');
    expect(next[at(0)]).toContain('x=130 y=60');
    expect(next[at(1)]).toContain('x=330 y=60');
    expect(next[at(2)]).toBe(open('c', 500));
    // 離した位置を維持する(再描画までの間も)
    expect(pos(host, 'b')).toEqual(['330px', '60px']);
    off();
  });

  it('🔴 左上より外へは出ない ── 全員で同じだけ手前で止まり、形が崩れない', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(-400, -400);
    // a は x=100,y=40 が下限 → 動かせる量は -100 / -40。b も同じだけ
    expect(pos(host, 'a')).toEqual(['0px', '0px']);
    expect(pos(host, 'b')).toEqual(['200px', '0px']);
    up(-400, -400);
    expect(rewriteOf(asks, 0)).toMatchObject({
      moves: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
    });
    off();
  });

  it('🔴 入っていない付箋は今までどおり 1 枚(place-move)', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'c'));
    move(10, 10);
    expect(pos(host, 'a')).toEqual(['100px', '40px']);
    up(10, 10);
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-move', line: at(2), x: 510, y: 50 });
    off();
  });

  it('🔴 大きさの角を掴んだときは 1 枚だけ(グループは位置だけ)', () => {
    const { host, asks, off } = rig(GROUPED, true);
    const handle = host.querySelector<HTMLElement>('#a [data-pkc-field="place-size"]')!;
    down(handle);
    move(20, 10);
    up(20, 10);
    expect(rewriteOf(asks, 0)).toMatchObject({ kind: 'place-size', line: at(0) });
    expect(pos(host, 'b')).toEqual(['300px', '40px']);
    off();
  });

  it('🔴 元の位置へ戻して離す(取りやめ)は何も書かず、全員が元の位置', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(30, 20);
    up(0, 0);
    expect(asks).toHaveLength(0);
    expect(pos(host, 'a')).toEqual(['100px', '40px']);
    expect(pos(host, 'b')).toEqual(['300px', '40px']);
    off();
  });

  it('🔴 書換が断られたとき(編集中)は、全員が元の位置へ戻る', () => {
    const { host, d, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(30, 20);
    d.dispatch({ type: 'START_EDIT' });
    up(30, 20);
    expect(pos(host, 'a')).toEqual(['100px', '40px']);
    expect(pos(host, 'b')).toEqual(['300px', '40px']);
    off();
  });

  it('🔴 途中で pointercancel されたら、全員が元の位置へ戻る', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(30, 20);
    document.dispatchEvent(new PointerEvent('pointercancel', { ...opts }));
    expect(pos(host, 'b')).toEqual(['300px', '40px']);
    expect(asks).toHaveLength(0);
    off();
  });

  it('🔴 掴んでいる最中に仲間の要素だけ作り直されても、新しい要素が手に付いて動く', () => {
    const { host, asks, off } = rig(GROUPED, true);
    down(grip(host, 'a'));
    move(30, 20);
    const b = blockOf(host, 'b');
    const fresh = b.cloneNode(true) as HTMLElement;
    fresh.removeAttribute('style');
    b.replaceWith(fresh);
    applyPlaceLayout(host, () => null, 0);
    move(40, 20);
    expect(fresh.style.left, '作り直された仲間が置き去り').toBe('340px');
    up(40, 20);
    expect(rewriteOf(asks, 0)).toMatchObject({ moves: [{ x: 140 }, { x: 340 }] });
    off();
  });

  it('🔴 矢印キーでも全員が動き、止まって 300ms で 1 回だけ place-move-group', () => {
    vi.useFakeTimers();
    const { host, asks, off } = rig(GROUPED, true);
    const g = grip(host, 'a');
    g.focus();
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(pos(host, 'a')).toEqual(['110px', '41px']);
    expect(pos(host, 'b')).toEqual(['310px', '41px']);
    expect(pos(host, 'c')).toEqual(['500px', '40px']);
    expect(asks).toHaveLength(0);
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    expect(asks).toHaveLength(1);
    expect(rewriteOf(asks, 0)).toMatchObject({
      kind: 'place-move-group',
      moves: [
        { line: at(0), x: 110, y: 41 },
        { line: at(1), x: 310, y: 41 },
      ],
    });
    off();
  });

  it('🔴 矢印キーの Esc は全員を戻す', () => {
    vi.useFakeTimers();
    const { host, asks, off } = rig(GROUPED, true);
    const g = grip(host, 'a');
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(NUDGE_SETTLE_MS * 2);
    expect(pos(host, 'b')).toEqual(['300px', '40px']);
    expect(asks).toHaveLength(0);
    off();
  });
});

describe('線は動いた付箋に追従する(グループとは関係なく)', () => {
  it('🔴 グループの中どうしを結ぶ線は、グループを動かした後の本文でも両端の付箋から引き直される', () => {
    const line = ':::format{.pkc-line from=a to=b}\n:::\n';
    const body = GROUPED + '\n' + line;
    const { host, asks, off } = rig(body, true);
    const g = host.querySelector<HTMLElement>('#a [data-pkc-field="place-grip"]')!;
    g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 50, clientY: 0 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 50, clientY: 0 }));
    const next = applyBodyRewrite(body, rewriteOf(asks, 0))!;
    // 線の行は 1 バイトも変わらない(from= to= は名前で指す ── 付箋が動いても線は書き換えない)
    expect(next).toContain(line.trim().split('\n')[0]!);
    // 動いた後の本文を描き直すと、線は新しい位置の付箋から引かれる(両端が同じだけ動くので、道は右へ 50px ずれる)
    const pathOf = (b: string): string => {
      const h = document.createElement('div');
      h.innerHTML = renderMarkdown(bodyBelowFrontmatter(b), { sourceLineAnchors: true });
      applyPlaceLayout(h, () => null, 0);
      return h.querySelector('[data-pkc-field="place-lines"] path')!.getAttribute('d')!;
    };
    const nums = (d: string): number[] => d.split(/[^\d.-]+/).filter((t) => t !== '').map(Number);
    const before = nums(pathOf(body));
    const after = nums(pathOf(next));
    expect(before.length, '前提: 線が引かれている').toBeGreaterThanOrEqual(4);
    expect(after.map((n, i) => (i % 2 === 0 ? n - 50 : n))).toEqual(before);
    off();
  });
});
