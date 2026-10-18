/** @vitest-environment happy-dom */
/**
 * 🔴 **本文のブロックを、長押し(右クリック)のメニューから 1 つ上・1 つ下へ動かす**
 * (台帳 #1852 束 S1、依頼 238 の案 B)+ **指で触ったあと、つまみ(⠿)が消えない**(案 A)。
 *
 * 画面の起きること: スマホには段落をドラッグして並べ替える道が無かった。長押しのメニューに
 * 「このブロックを上へ移す / 下へ移す」が出て、押すと本文のブロックが 1 つ動く。
 *
 * ## 守る主張
 * 1. 項目が出る。いちばん上のブロックには「上へ」を、いちばん下には「下へ」を出さない(押しても何も起きない口を作らない)
 * 2. 押すと `move-lines`(本文を書く)になり、**書いた結果の本文**で上下が入れ替わる(座標を別の観測から検算する)
 * 3. 章(見出し)は章ごと動く / `:::` の囲みの中へは入れない
 * 4. 指で触って離してもつまみが残る。マウスは今までどおり面を出たら隠れる(対照群)
 * 5. 編集中は声に出して断る(ドラッグで落としたときと同じ門)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState, type DomainEvent } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { BLOCK_GRIP_FIELD, blockStepsAt, installBlockGrip } from '../../src/adapter/ui/render/block-grip';
import { PAINTED_ATTR } from '../../src/adapter/ui/render/detail';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { bodyBelowFrontmatter, frontmatterLineCount } from '../../src/features/markdown/frontmatter';
import { BLOCK_STEP_DIR_ATTR, blockStepMenuActions } from '../../src/features/entry-actions';

const MENU = '[data-pkc-region="context-menu"]';
const GRIP = `[data-pkc-field="${BLOCK_GRIP_FIELD}"]`;

/** frontmatter 3 行 + 本文(生の body の行番号 = 刻印 + 3)。 */
const RAW = [
  '---', //                0
  'title: x', //           1
  '---', //                2
  '# 題', //               3
  '', //                   4
  '段落 A', //             5
  '', //                   6
  '段落 B', //             7
  '', //                   8
  ':::note', //             9
  '中身', //               10
  ':::', //                11
  '',
  '段落 C', //             13
  '',
].join('\n');

function metasOf(lids: readonly string[]): AppState['entryMetas'] {
  const m = new Map<string, AppState['entryMetas'] extends Map<string, infer V> ? V : never>();
  for (const [i, lid] of lids.entries()) {
    m.set(lid, {
      lid,
      title: lid,
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: i + 1,
      status: null,
      date: null,
      archived: false,
    } as never);
  }
  return m as AppState['entryMetas'];
}

function setup(body: string = RAW, phase: AppState['phase'] = 'ready', services: Parameters<typeof bindActions>[2] = {}) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML =
    '<div data-pkc-region="detail"><div data-pkc-view-pane="detail"><div data-pkc-field="detail-body"></div></div></div>';
  document.body.append(root);
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!;
  const host = root.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
  host.className = 'pkc-md-rendered';
  host.setAttribute(PAINTED_ATTR, 'n1');
  host.innerHTML = renderMarkdown(bodyBelowFrontmatter(body), {
    sourceLineAnchors: true,
    taskLineOffset: frontmatterLineCount(body),
  } as never);
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase,
    selectedLid: 'n1',
    entryMetas: metasOf(['n1', 'n2']),
    openBody: { lid: 'n1', body, baseline: body, persisted: body, diskAhead: false },
  });
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  const unbind = bindActions(root, d, services);
  installBlockGrip(pane, host, 'n1', body);
  const blockAt = (needle: string): HTMLElement => {
    const el = [...host.children].find((c) => c.textContent?.includes(needle));
    if (!(el instanceof HTMLElement)) throw new Error(`前提が崩れている: ${needle} の塊が無い`);
    return el;
  };
  const longPress = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  };
  const items = (): string[] =>
    [...root.querySelectorAll(`${MENU} button[data-pkc-action="move-block-step"]`)].map((b) => b.textContent ?? '');
  const press = (label: string): void => {
    const b = [...root.querySelectorAll<HTMLElement>(`${MENU} button[data-pkc-action="move-block-step"]`)].find(
      (x) => x.textContent === label,
    );
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  };
  return { root, pane, host, d, events, unbind, blockAt, longPress, items, press };
}

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
});

/** 書かれた `move-lines` を本文へ当てた結果。 */
function appliedBody(events: DomainEvent[], body: string): string {
  const w = events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
  if (w === undefined || w.type !== 'REQUEST_BODY_REWRITE') throw new Error('本文の書換が撃たれていない');
  const out = applyBodyRewrite(body, w.rewrite);
  if (out === null) throw new Error('書換が断られた(座標か行が食い違っている)');
  return out;
}

describe('ブロックを 1 つ上・下へ動かす項目(依頼 238 の案 B)', () => {
  it('🔴 長押し(右クリック)で出る。真ん中のブロックには「上へ」と「下へ」の両方', () => {
    const s = setup();
    teardown = s.unbind;
    s.longPress(s.blockAt('段落 B'));
    expect(s.items()).toEqual(['このブロックを上へ移す', 'このブロックを下へ移す']);
  });

  it('🔴 いちばん上には「上へ」を出さず、いちばん下には「下へ」を出さない(押しても何も起きない口を作らない)', () => {
    const body = ['段落 X', '', '段落 Y', '', '段落 Z', ''].join('\n');
    const s = setup(body);
    teardown = s.unbind;
    s.longPress(s.blockAt('段落 X'));
    expect(s.items(), 'いちばん上に「上へ」が出ている').toEqual(['このブロックを下へ移す']);
    s.root.querySelector(MENU)?.remove();
    s.longPress(s.blockAt('段落 Z'));
    expect(s.items(), 'いちばん下に「下へ」が出ている').toEqual(['このブロックを上へ移す']);
  });

  it('対照群: 文書全体が 1 つの章(見出し 1 つ)なら、動かす先が無いので何も出ない', () => {
    const s = setup();
    teardown = s.unbind;
    s.longPress(s.blockAt('題'));
    expect(s.items(), '動かす先が無いのに項目が出ている').toEqual([]);
  });

  it('🔴 「下へ」を押すと、書いた結果の本文で段落 A と段落 B が入れ替わる', () => {
    const s = setup();
    teardown = s.unbind;
    s.longPress(s.blockAt('段落 A'));
    s.press('このブロックを下へ移す');
    const out = appliedBody(s.events, RAW);
    const lines = out.split('\n');
    expect(lines.indexOf('段落 B'), '段落 B が上へ来ていない').toBeLessThan(lines.indexOf('段落 A'));
    expect(lines.indexOf('段落 A'), '段落 A が下へ動いていない').toBeLessThan(lines.indexOf(':::note'));
    // 失われた字が無い(動かしただけ)
    expect([...lines].sort(), '行が増減した').toEqual([...RAW.split('\n')].sort());
  });

  it('🔴 「上へ」を押すと、段落 B が段落 A の前へ来る', () => {
    const s = setup();
    teardown = s.unbind;
    s.longPress(s.blockAt('段落 B'));
    s.press('このブロックを上へ移す');
    const lines = appliedBody(s.events, RAW).split('\n');
    expect(lines.indexOf('段落 B')).toBeLessThan(lines.indexOf('段落 A'));
    expect(lines.indexOf('# 題'), '見出しより上へ出てしまった').toBeLessThan(lines.indexOf('段落 B'));
  });

  it('🔴 囲み(:::note)は開きから閉じまで 1 つのブロックとして動く', () => {
    const s = setup();
    teardown = s.unbind;
    s.longPress(s.blockAt('段落 C'));
    s.press('このブロックを上へ移す');
    const lines = appliedBody(s.events, RAW).split('\n');
    expect(lines.indexOf('段落 C'), '囲みの後ろに居る').toBeLessThan(lines.indexOf(':::note'));
    // 囲みは中身ごと残っている(囲みの中へ入っていない)
    const open = lines.indexOf(':::note');
    expect(lines.slice(open, open + 3), '囲みが割れた').toEqual([':::note', '中身', ':::']);
  });

  it('🔴 章(見出し)は章ごと動く ── 次の章の後ろへ', () => {
    const body = ['# 一', '', '本文 1', '', '# 二', '', '本文 2', ''].join('\n');
    const s = setup(body);
    teardown = s.unbind;
    s.longPress(s.blockAt('一'));
    s.press('このブロックを下へ移す');
    const lines = appliedBody(s.events, body).split('\n');
    expect(lines.indexOf('# 二'), '章 二 が上へ来ていない').toBeLessThan(lines.indexOf('# 一'));
    expect(lines.indexOf('本文 1'), '章の本文が置き去りになった').toBeGreaterThan(lines.indexOf('# 一'));
    expect(lines.indexOf('本文 2'), '章 二 の本文が章から離れた').toBeLessThan(lines.indexOf('# 一'));
  });

  it('🔴 編集中は断る(ドラッグで落としたときと同じ門)。本文は書かれず、理由が画面に出る', () => {
    const s = setup(RAW, 'editing');
    teardown = s.unbind;
    // 台の前提: 編集中でも(器が残っていれば)項目は出る ── 出なければ下の「書かれない」は空振りになる
    s.longPress(s.blockAt('段落 B'));
    expect(s.items().length, '前提が崩れている: 項目が出ていない').toBeGreaterThan(0);
    s.press('このブロックを上へ移す');
    expect(s.events.some((e) => e.type === 'REQUEST_BODY_REWRITE'), '編集中なのに本文が書かれた').toBe(false);
    expect(s.d.getState().error, '断りの理由が出ていない(無言の dead click)').not.toBeNull();
  });
});

describe('blockStepsAt / blockStepMenuActions', () => {
  it('座標は生の body の行番号(frontmatter ぶんを足す)。上は前のブロックの先頭、下は次のブロックの終わりの次', () => {
    const s = setup();
    teardown = s.unbind;
    const st = blockStepsAt(s.host, s.blockAt('段落 B'), RAW)!;
    expect(st.start, '段落 B は生の 7 行目').toBe(7);
    expect(st.end).toBe(7);
    expect(st.up, '段落 A の先頭').toBe(5);
    expect(st.down, '囲みの閉じ(11 行目)の次').toBe(12);
  });

  it('動かせない向きは null / 項目を作らない', () => {
    expect(blockStepMenuActions({ up: false, down: false })).toEqual([]);
    const only = blockStepMenuActions({ up: true, down: false });
    expect(only.map((a) => a.attrs?.[BLOCK_STEP_DIR_ATTR])).toEqual(['up']);
    expect(only[0]!.hint, '説明が空').not.toBe('');
  });
});

describe('指で触ったあとも、つまみ(⠿)が残る(依頼 238 の案 A)', () => {
  const leave = (el: Element, pointerType: string): void => {
    const e = new MouseEvent('pointerleave', { bubbles: false });
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    el.dispatchEvent(e);
  };
  const grip = (s: ReturnType<typeof setup>): HTMLElement => s.pane.querySelector<HTMLElement>(GRIP)!;

  it('🔴 触れて離す(touch の pointerleave)とき、つまみは出たまま', () => {
    const s = setup();
    teardown = s.unbind;
    s.blockAt('段落 A').dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(grip(s).hidden, '前提: 触れたらつまみが出る').toBe(false);
    leave(s.pane, 'touch');
    expect(grip(s).hidden, '指を離したらつまみが消えた(掴む前に消える)').toBe(false);
  });

  it('対照群: マウスが面を出たときは今までどおり隠れる', () => {
    const s = setup();
    teardown = s.unbind;
    s.blockAt('段落 A').dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(grip(s).hidden).toBe(false);
    leave(s.pane, 'mouse');
    expect(grip(s).hidden, 'マウスが出たのに残っている').toBe(true);
  });
});
