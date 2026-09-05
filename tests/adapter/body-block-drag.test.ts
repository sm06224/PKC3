/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の塊を、本文の中で掴んで並べ替える**(#684 段①)。
 *
 * ## 守る主張
 *
 * 1. 🔴 掴む口(⠿)は**面に 1 個**だけ在り、乗せた塊の範囲を**原文で**載せる
 *    (段落 = 刻印 / 見出し = 章 / `:::` = 開き〜閉じ)。畳まれた塊・板の面では出ない。
 *    **塊そのものには `draggable` を付けない**(字の選択を殺さない)
 * 2. 🔴 口を掴むと荷物は `lid start end`(生の body の行番号)
 * 3. 🔴 本文の上では塊の上半分 / 下半分で「前 / 後」の線が出る。**自分の中**には受けない
 * 4. 🔴 落とすと `REQUEST_BODY_REWRITE { kind: 'move-lines' }` になり、`toBefore` は
 *    前 = 開き行 / 後 = 終わり + 1(`:::` は閉じの次)── 生の body の座標
 * 5. 🔴 編集中は声に出して断る(reducer 1 か所)
 * 6. 🔴 横に留めた枠の口は**その枠のノート**へ書く
 * 7. 🔴 動かした直後は「元に戻す」が出て、押すと逆向きの `move-lines` が飛び、元の本文へ戻る。
 *    編集に入る / 別の書換で材料は捨てる
 *
 * ⚠ `DataTransfer` は happy-dom に無いが、実装が使うのは `types` / `getData` / `setData` /
 *   `dropEffect` / `effectAllowed` だけなので stub で回る(`dual-filer.test.ts` と同じ作法)。
 * ⚠ happy-dom は layout を持たないので、塊の矩形は `getBoundingClientRect` を差して与える。
 *   本物の座標・drag 像・字の選択が生きていることは `tests/smoke/body-block-drag.smoke.spec.ts`。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import {
  BLOCK_END_ATTR,
  BLOCK_GRIP_FIELD,
  BLOCK_LID_ATTR,
  BLOCK_START_ATTR,
  installBlockGrip,
} from '../../src/adapter/ui/render/block-grip';
import { PAINTED_ATTR } from '../../src/adapter/ui/render/detail';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { bodyBelowFrontmatter } from '../../src/features/markdown/frontmatter';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

const PKC_BLOCK = 'application/x-pkc-block';
const GRIP = `[data-pkc-field="${BLOCK_GRIP_FIELD}"]`;

/** frontmatter 3 行 + 本文(刻印は剥いだ側の行番号なので、生の body は +3)。 */
const RAW = [
  '---', //          0
  'title: x', //     1
  '---', //          2
  '# 題', //          3
  '', //             4
  '段落 A', //        5
  '', //             6
  '## 章 B', //       7
  '', //             8
  '本文 B', //        9
  '', //             10
  '```js', //        11
  'code', //         12
  '```', //          13
  '', //             14
  ':::note', //      15
  '中身', //          16
  ':::', //          17
  '', //             18
  '- い', //          19
  '- ろ', //          20
  '', //             21
  '## 章 C', //       22
  '', //             23
  '本文 C', //        24
  '', //             25
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

function dtStub(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types(): string[] {
      return [...data.keys()];
    },
    getData: (t: string) => data.get(t) ?? '',
    setData: (t: string, v: string) => void data.set(t, v),
    files: { length: 0, item: () => null },
    items: [] as unknown[],
  };
}

/** drag 系の event(座標つき)。⚠ `DragEvent` は happy-dom に無いので `MouseEvent` に荷物を載せる。 */
function dragEv(type: string, dt: ReturnType<typeof dtStub>, clientY = 0): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  return e;
}

/** 塊の矩形を与える(happy-dom は layout を持たない)。 */
function rect(el: Element, top: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ top, bottom: top + height, height, left: 40, right: 400, width: 360, x: 40, y: top }),
    configurable: true,
  });
}

/** 読む面の実構造 ── scroller > pane > 主の器(display: contents) > 本文の器。 */
function setup() {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  const scroller = document.createElement('div');
  scroller.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-view-pane', 'detail');
  const region = document.createElement('div');
  region.setAttribute('data-pkc-split-main', '');
  const host = document.createElement('div');
  host.className = 'pkc-md-rendered';
  host.setAttribute('data-pkc-field', 'detail-body');
  host.setAttribute(PAINTED_ATTR, 'n1');
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(RAW), { sourceLineAnchors: true });
  region.append(host);
  pane.append(region);
  scroller.append(pane);
  root.append(scroller);
  document.body.append(root);
  rect(pane, 0, 1000);

  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '本'), meta('n2', '相手')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: RAW });
  const said: string[] = [];
  const unbind = bindActions(root, d, { showStatus: (t) => said.push(t) });
  installBlockGrip(region, host, 'n1', RAW);
  events.length = 0;

  const block = (line: number): HTMLElement =>
    [...host.children].find(
      (c): c is HTMLElement => c instanceof HTMLElement && c.getAttribute('data-pkc-source-line') === String(line),
    )!;
  const hover = (el: Element): void => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  const grip = (): HTMLElement | null => pane.querySelector<HTMLElement>(GRIP);
  /** 段落 A(生の 5 行目)を掴む ── 荷物を積んだ stub を返す。 */
  const grab = (line = 2) => {
    hover(block(line));
    const dt = dtStub();
    grip()!.dispatchEvent(dragEv('dragstart', dt));
    return dt;
  };
  return { root, pane, region, host, d, events, said, unbind, block, hover, grip, grab };
}

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

describe('掴む口(block-grip)', () => {
  it('🔴 乗せた塊の横に口が出て、範囲を生の body の行番号で載せる(段落 = 刻印 + frontmatter)', () => {
    const s = setup();
    teardown = s.unbind;
    expect(s.grip(), '口は最初から在る(隠れている)').not.toBeNull();
    expect(s.grip()!.hidden, '乗せる前から出ている').toBe(true);
    s.hover(s.block(2));
    const g = s.grip()!;
    expect(g.hidden, '段落に乗せたのに出ない').toBe(false);
    expect(g.getAttribute(BLOCK_START_ATTR)).toBe('5');
    expect(g.getAttribute(BLOCK_END_ATTR)).toBe('5');
    expect(g.getAttribute(BLOCK_LID_ATTR)).toBe('n1');
    expect(g.getAttribute('draggable'), '口が掴めない').toBe('true');
    // ⚠ 口は**器の外**(applyBlocks が消さない所)
    expect(s.host.contains(g), '口が本文の器の中に在る(差分で消える)').toBe(false);
    expect(s.pane.contains(g)).toBe(true);
    // 文言は起きることで書く
    expect(g.getAttribute('aria-label')).toContain('掴んで動かす');
  });

  it('🔴 見出しは章ごと / ::: は閉じまで / fence・箇条書きは刻印どおり', () => {
    const s = setup();
    teardown = s.unbind;
    const range = (line: number): string => {
      s.hover(s.block(line));
      return `${s.grip()!.getAttribute(BLOCK_START_ATTR)}-${s.grip()!.getAttribute(BLOCK_END_ATTR)}`;
    };
    expect(range(4), '見出しの章が「次の同段の見出しの直前」まででない').toBe('7-21');
    expect(range(12), '::: の塊が閉じまでになっていない(刻印の -end は開き行)').toBe('15-17');
    expect(range(8), 'fence').toBe('11-13');
    expect(range(16), '箇条書き(刻印は直後の空行まで)').toBe('19-21');
    expect(range(0), 'h1 の章は末尾まで').toBe('3-25');
  });

  it('🔴 畳まれた塊・板の面では出ない / 塊そのものは draggable ではない / 何度当てても口は 1 個', () => {
    const s = setup();
    teardown = s.unbind;
    s.hover(s.block(2));
    expect(s.grip()!.hidden).toBe(false);
    s.block(6).hidden = true;
    s.hover(s.block(6));
    expect(s.grip()!.hidden, '畳まれた塊で出ている').toBe(true);
    s.hover(s.block(2));
    expect(s.grip()!.hidden).toBe(false);
    s.host.classList.add('pkc-board-host');
    s.hover(s.block(2));
    expect(s.grip()!.hidden, '板の面で出ている(板は自分の掴みを持つ)').toBe(true);
    s.host.classList.remove('pkc-board-host');
    // 🔴 字の選択を殺さない ── 塊に draggable を付けない
    expect(s.host.querySelectorAll('[draggable]'), '塊に draggable が付いた(字を選べなくなる)').toHaveLength(0);
    installBlockGrip(s.region, s.host, 'n1', RAW);
    installBlockGrip(s.region, s.host, 'n1', RAW);
    expect(s.pane.querySelectorAll(GRIP), '口が増えた').toHaveLength(1);
  });

  it('閉じていない ::: の塊には口を出さない(末尾まで飲んでいるので範囲が無い)', () => {
    const s = setup();
    teardown = s.unbind;
    const open = '# 題\n\n:::note\n中身だけ\n';
    s.host.innerHTML = renderMarkdown(open, { sourceLineAnchors: true });
    installBlockGrip(s.region, s.host, 'n1', open);
    s.hover(s.block(2));
    expect(s.grip()!.hidden, '閉じていない塊で出ている').toBe(true);
  });
});

describe('掴んで落とす(dragstart / dragover / drop)', () => {
  it('🔴 口を掴むと荷物は「lid start end」', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = s.grab();
    expect(dt.getData(PKC_BLOCK)).toBe('n1 5 5');
    expect(dt.effectAllowed).toBe('move');
  });

  it('🔴 塊の上半分は「前」、下半分は「後」の線。自分の中には受けない', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = s.grab();
    const target = s.block(19); // ## 章 C
    rect(target, 500, 40);
    const upper = dragEv('dragover', dt, 505);
    target.dispatchEvent(upper);
    expect(upper.defaultPrevented, '本文の上で受けていない').toBe(true);
    expect(dt.dropEffect).toBe('move');
    expect(target.getAttribute('data-pkc-drop-edge')).toBe('before');
    const lower = dragEv('dragover', dt, 535);
    target.dispatchEvent(lower);
    expect(target.getAttribute('data-pkc-drop-edge'), '下半分へ動いても線が動かない').toBe('after');
    expect(s.root.querySelectorAll('[data-pkc-drop-edge]'), '印が 2 か所に残っている').toHaveLength(1);
    // 自分の中 ── 受けない・印も消える
    const self = s.block(2);
    rect(self, 100, 20);
    const onSelf = dragEv('dragover', dt, 105);
    self.dispatchEvent(onSelf);
    expect(onSelf.defaultPrevented, '自分の中へ受けた').toBe(false);
    expect(s.root.querySelectorAll('[data-pkc-drop-edge]'), '前の印が消えていない').toHaveLength(0);
  });

  it('🔴 章を掴んだら、その章の中(下の段落)へは受けない', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = s.grab(4); // ## 章 B(7..21)
    const inside = s.block(6); // 本文 B
    rect(inside, 200, 20);
    const ev = dragEv('dragover', dt, 215);
    inside.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // 対照群 ── 章の外(章 C の後)には受ける
    const out = s.block(19);
    rect(out, 500, 40);
    const ok = dragEv('dragover', dt, 535);
    out.dispatchEvent(ok);
    expect(ok.defaultPrevented).toBe(true);
  });

  it('掴んでいないのに荷物だけ来た dragover は受けない(掴みは dragstart で決める)', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = dtStub({ [PKC_BLOCK]: 'n1 5 5' });
    const target = s.block(19);
    rect(target, 500, 40);
    const ev = dragEv('dragover', dt, 505);
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('🔴 落とすと move-lines になる ── 前 = 開き行 / 後 = 終わり + 1(生の body 座標)', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = s.grab();
    const target = s.block(19); // ## 章 C(生 22)
    rect(target, 500, 40);
    const drop = dragEv('drop', dt, 505);
    target.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'move-lines', start: 5, end: 5, toBefore: 22, lines: ['段落 A'] },
    });
    expect(s.root.querySelectorAll('[data-pkc-drop-edge]'), '落とした後に印が残っている').toHaveLength(0);
  });

  it('🔴 「後」は塊の終わりの次 ── ::: は閉じの次(開き行の次ではない)/ fence は閉じの次', () => {
    const s = setup();
    teardown = s.unbind;
    const toBeforeOf = (line: number): number => {
      s.events.length = 0;
      const dt = s.grab();
      const target = s.block(line);
      rect(target, 500, 40);
      target.dispatchEvent(dragEv('drop', dt, 535));
      const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
      expect(ev, `${String(line)} 行目の塊の後に落とせない`).toBeDefined();
      return (ev as { rewrite: { toBefore: number } }).rewrite.toBefore;
    };
    expect(toBeforeOf(12), '::: の後が閉じの次になっていない').toBe(18);
    expect(toBeforeOf(8), 'fence の後').toBe(14);
    expect(toBeforeOf(19), '見出しの後は見出しの次の行(章の終わりではない)').toBe(23);
    expect(toBeforeOf(16), '箇条書きの後(刻印は空行まで含む)').toBe(22);
  });

  it('🔴 編集中は声に出して断る(押した場所と文言が対)', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = s.grab();
    s.d.dispatch({ type: 'START_EDIT' });
    s.events.length = 0;
    const target = s.block(19);
    rect(target, 500, 40);
    target.dispatchEvent(dragEv('drop', dt, 505));
    expect(s.d.getState().error ?? '', '理由が出ていない').toContain('編集を終了');
    expect(s.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('塊');
    expect(s.events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('本文の器の外(添付の説明 / 描けていない器)には受けない', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = s.grab();
    s.host.removeAttribute(PAINTED_ATTR);
    const target = s.block(19);
    rect(target, 500, 40);
    const ev = dragEv('dragover', dt, 505);
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented, '描けた印の無い器で受けた').toBe(false);
  });

  it('🔴 横に留めた枠の口は、その枠のノートへ書く(主の枠ではない)', () => {
    const s = setup();
    teardown = s.unbind;
    const frame = document.createElement('div');
    frame.setAttribute('data-pkc-region', 'split-frame');
    frame.setAttribute('data-pkc-split-lid', 'n2');
    const host2 = document.createElement('div');
    host2.className = 'pkc-md-rendered';
    host2.setAttribute('data-pkc-field', 'split-body');
    host2.setAttribute(PAINTED_ATTR, 'n2');
    const body2 = 'あ\n\nい\n\nう\n';
    host2.innerHTML = renderMarkdown(body2, { sourceLineAnchors: true });
    frame.append(host2);
    s.pane.append(frame);
    rect(frame, 0, 1000);
    s.d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    s.d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: body2 });
    installBlockGrip(frame, host2, 'n2', body2);
    s.events.length = 0;
    const first = host2.children[0]!;
    first.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    const g = frame.querySelector<HTMLElement>(GRIP)!;
    expect(g, '留めた枠に口が無い').not.toBeNull();
    expect(g.getAttribute(BLOCK_LID_ATTR)).toBe('n2');
    const dt = dtStub();
    g.dispatchEvent(dragEv('dragstart', dt));
    expect(dt.getData(PKC_BLOCK)).toBe('n2 0 0');
    const last = host2.children[2]!;
    rect(last, 300, 20);
    last.dispatchEvent(dragEv('drop', dt, 315));
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev).toMatchObject({ lid: 'n2', rewrite: { kind: 'move-lines', start: 0, end: 0, toBefore: 5, lines: ['あ'] } });
  });
});

describe('元に戻す(UNDO_MOVE)', () => {
  const MOVE = { kind: 'move-lines' as const, start: 5, end: 5, toBefore: 22, lines: ['段落 A'] };
  const rewritten = (d: Dispatcher, body: string, rewrite = MOVE as Parameters<typeof applyBodyRewrite>[1]) =>
    d.dispatch({ type: 'BODY_REWRITTEN', lid: 'n1', body, rewrite, status: null, date: null, archived: false });

  it('🔴 動かした ack で材料と知らせが入り、押すと逆向きの move-lines が飛んで元の本文へ戻る', () => {
    const s = setup();
    teardown = s.unbind;
    const moved = applyBodyRewrite(RAW, MOVE)!;
    expect(moved, '前提: 動いている').not.toBe(RAW);
    rewritten(s.d, moved);
    const st = s.d.getState();
    expect(st.lastMove, '戻す材料が無い').not.toBeNull();
    expect(st.notice).toBe('本文の塊を動かしました');
    s.events.length = 0;
    s.d.dispatch({ type: 'UNDO_MOVE' });
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '戻す依頼が出ていない').toBeDefined();
    const inv = (ev as { rewrite: Parameters<typeof applyBodyRewrite>[1] }).rewrite;
    expect(inv.kind).toBe('move-lines');
    expect(applyBodyRewrite(moved, inv), '逆向きの指示で元へ戻らない').toBe(RAW);
    expect(s.d.getState().lastMove, '1 手で使い切っていない').toBeNull();
  });

  it('🔴 画面の本文から同じ結果が出ない ack(画面が古い)では材料を入れない', () => {
    const s = setup();
    teardown = s.unbind;
    rewritten(s.d, '# ぜんぜん別の本文\n');
    expect(s.d.getState().lastMove).toBeNull();
  });

  it('🔴 編集に入る / 同じノートの別の書換で材料を捨てる(行がずれる)', () => {
    const s = setup();
    teardown = s.unbind;
    const moved = applyBodyRewrite(RAW, MOVE)!;
    rewritten(s.d, moved);
    expect(s.d.getState().lastMove).not.toBeNull();
    s.d.dispatch({ type: 'START_EDIT' });
    expect(s.d.getState().lastMove, '編集に入っても残っている').toBeNull();
  });

  it('🔴 同じノートの別の書換(チェックの印)で材料を捨てる', () => {
    const s = setup();
    teardown = s.unbind;
    const moved = applyBodyRewrite(RAW, MOVE)!;
    rewritten(s.d, moved);
    expect(s.d.getState().lastMove, '前提: 材料が入っている').not.toBeNull();
    // ⚠ 画面の本文はもう `moved` ── 次の ack はそこからの書換として届く
    rewritten(s.d, `${moved}\n- [x] 済`, { kind: 'task', line: 0 });
    expect(s.d.getState().lastMove, '別の書換の後も残っている').toBeNull();
  });

  it('材料が無ければ何も撃たない / 編集中は撃たない', () => {
    const s = setup();
    teardown = s.unbind;
    s.d.dispatch({ type: 'UNDO_MOVE' });
    expect(s.events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('🔴 状態の行に「元に戻す」の口が在り、undo-move の受け手へ繋がる。材料と知らせが揃ったときだけ出る', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const btn = regions.statusUndo;
    expect(btn.getAttribute('data-pkc-field')).toBe('status-undo');
    expect(btn.getAttribute('data-pkc-action'), '受け手の無い口').toBe('undo-move');
    expect(btn.textContent).toBe('元に戻す');
    expect(btn.hidden).toBe(true);
    expect(regions.status.contains(btn), '状態の行の外に居る').toBe(true);
    const LINE = '本文の塊を動かしました';
    paintStatusUndo(btn, { lastMove: {}, notice: LINE }, LINE);
    expect(btn.hidden, '材料と知らせが揃っているのに出ない').toBe(false);
    paintStatusUndo(btn, { lastMove: {}, notice: LINE }, 'コピーしました');
    expect(btn.hidden, '別の知らせの隣に残っている').toBe(true);
    paintStatusUndo(btn, { lastMove: null, notice: LINE }, LINE);
    expect(btn.hidden, '材料が無いのに出ている').toBe(true);
  });
});

/**
 * 🔴 **一覧の行を本文へ落とすとリンクになる**(#684 段②)。
 *
 * 守る主張:
 * 1. 🔴 本文の上では `copy` で受け、段①と同じ「前 / 後」の線が出る
 * 2. 🔴 落とすと `REQUEST_BODY_REWRITE { kind: 'insert-lines' }` ── 字は `formatEntryLink` の綴り
 * 3. 🔴 複数の行は改行区切りの 1 塊 / 2 ペインの行も同じ経路
 * 4. 🔴 落とした後も掴んだ側の印(選択)は残る(移していない)
 * 5. 編集中は声に出して断る / 題名の無い lid は入れない
 */
describe('一覧の行を本文へ落とすとリンクになる(#684 段②)', () => {
  const PKC_LIDS = 'application/x-pkc-lids';

  it('🔴 本文の上は copy で受け、前 / 後の線が出る。落とすと insert-lines になる', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = dtStub({ [PKC_LIDS]: 'n2' });
    const target = s.block(19); // ## 章 C(生 22)
    rect(target, 500, 40);
    const over = dragEv('dragover', dt, 505);
    target.dispatchEvent(over);
    expect(over.defaultPrevented, '本文の上で受けていない').toBe(true);
    expect(dt.dropEffect, '移す顔(move)になっている').toBe('copy');
    expect(target.getAttribute('data-pkc-drop-edge')).toBe('before');
    target.dispatchEvent(dragEv('drop', dt, 505));
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev, '書換の依頼が出ていない').toBeDefined();
    expect(ev).toMatchObject({
      lid: 'n1',
      rewrite: { kind: 'insert-lines', toBefore: 22, lines: ['[相手](entry:n2)'] },
    });
    expect(s.root.querySelectorAll('[data-pkc-drop-edge]'), '落とした後に印が残っている').toHaveLength(0);
  });

  it('🔴 複数の行は 1 塊(改行区切り)。題名の無い lid は入れない', () => {
    const s = setup();
    teardown = s.unbind;
    const dt = dtStub({ [PKC_LIDS]: 'n2 ghost n1' });
    const target = s.block(2);
    rect(target, 100, 20);
    target.dispatchEvent(dragEv('drop', dt, 115));
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev).toMatchObject({
      rewrite: { kind: 'insert-lines', toBefore: 6, lines: ['[相手](entry:n2)', '[本](entry:n1)'] },
    });
  });

  it('🔴 2 ペインの行から掴んでも同じ経路で入り、掴んだ側の選択は残る', () => {
    const s = setup();
    teardown = s.unbind;
    // 2 ペインの行(左)── 掴む側は `data-pkc-entry` の行で、面は dual-pane
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-region', 'dual-pane');
    pane.setAttribute('data-pkc-side', 'left');
    pane.innerHTML =
      '<table data-pkc-region="dual-table"><tr data-pkc-entry="n2" draggable="true"><td>相手</td></tr></table>';
    s.root.append(pane);
    const before = s.d.getState().selection;
    expect(before, '前提: 一覧の選択が在る').toEqual(['n1']);
    const dt = dtStub();
    pane.querySelector('[data-pkc-entry="n2"]')!.dispatchEvent(dragEv('dragstart', dt));
    expect(dt.getData(PKC_LIDS), '2 ペインの行が荷物にならない').toBe('n2');
    const target = s.block(19);
    rect(target, 500, 40);
    target.dispatchEvent(dragEv('drop', dt, 535));
    const ev = s.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(ev).toMatchObject({ lid: 'n1', rewrite: { kind: 'insert-lines', toBefore: 23 } });
    expect(s.d.getState().selection, '落としたら選択が消えた(移していないのに)').toEqual(before);
    // 移す経路は走っていない ── 関係(親子)が 1 つも変わっていない
    expect(s.d.getState().relations, '本文へ落としたのにノートが移った').toEqual([]);
  });

  it('🔴 編集中は声に出して断る(押した場所と文言が対)', () => {
    const s = setup();
    teardown = s.unbind;
    s.d.dispatch({ type: 'START_EDIT' });
    s.events.length = 0;
    const dt = dtStub({ [PKC_LIDS]: 'n2' });
    const target = s.block(19);
    rect(target, 500, 40);
    target.dispatchEvent(dragEv('drop', dt, 505));
    expect(s.d.getState().error ?? '').toContain('編集を終了');
    expect(s.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('一覧の行');
    expect(s.events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toHaveLength(0);
  });

  it('フォルダの行の上では、これまでどおり移す(本文の線は出ない)', () => {
    const s = setup();
    teardown = s.unbind;
    const folder = document.createElement('div');
    folder.setAttribute('data-pkc-drop', 'folder');
    folder.setAttribute('data-pkc-entry', 'n1');
    s.root.append(folder);
    const dt = dtStub({ [PKC_LIDS]: 'n2' });
    const over = dragEv('dragover', dt, 5);
    folder.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('move');
    expect(folder.hasAttribute('data-pkc-dropping')).toBe(true);
    expect(s.root.querySelectorAll('[data-pkc-drop-edge]')).toHaveLength(0);
  });
});

/**
 * 🔴 見え方の規則(happy-dom は描画しないので構文で読む ── `css-blocks` の作法)。
 * ⚠ 線は `box-shadow: inset` で出す ── border だと塊の高さが変わり、狙いがずれる。
 * ⚠ 口の置き場は `position: relative` ── 無いと口が面の左上に固まる。
 */
describe('CSS ── 落とし先の線と口の置き場', () => {
  const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
  it('🔴 前 / 後の線は box-shadow inset(高さを変えない)', () => {
    expect(blocksFor(APP, "[data-pkc-drop-edge='before']").join(';')).toContain('box-shadow: inset 0 2px 0');
    expect(blocksFor(APP, "[data-pkc-drop-edge='after']").join(';')).toContain('box-shadow: inset 0 -2px 0');
  });
  it('🔴 口は絶対配置で、置き場(本文の面 / 留めた枠)は relative', () => {
    expect(blocksFor(APP, "[data-pkc-field='block-grip']").join(';')).toContain('position: absolute');
    expect(blocksFor(APP, "[data-pkc-view-pane='detail']").join(';')).toContain('position: relative');
    expect(blocksFor(APP, "[data-pkc-region='split-frame']").join(';')).toContain('position: relative');
  });
});
