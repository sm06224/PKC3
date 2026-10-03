/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列の探す欄に `>` を打つと、一覧が操作に替わる**(#274 段①。姿 = D)。
 *
 * ⚠ 絞り込みの**規則**は `tests/features/palette-rows.test.ts`、`>` の**判定**は
 *   `tests/features/command-query.test.ts`。ここが見るのは**繋がり** ──
 *   打つと一覧が替わるか / 戻れるか / 押すと本当に実行されるか / 操作のパレットと
 *   同じ答えか。
 * 🔑 **本物どうしを繋ぐ**(CLAUDE.md §7)── 描く器(`BrowseRouter`)と読む側(`binder`)を
 *   同じ画面に立てる。⚠ 片方を stub にすると、出し入れの食い違いが両方緑のまま通る。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import {
  COMMAND_WITH_ENTRY,
  bindActions,
  commandRowsFor,
  repaintCommandList,
  runCommandRow,
  type CommandWithEntry,
} from '../../src/adapter/ui/actions/binder';
import { paintCommandList } from '../../src/adapter/ui/render/command-list';
import { DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { appSearchHistory } from '../../src/adapter/platform/search-history-store';
import { appRecentCommands } from '../../src/adapter/platform/recent-commands-store';
import { appMessagePost } from '../../src/adapter/platform/message-post';
import { SYSTEM_MESSAGE_LID } from '../../src/features/message/message-log';
import { appKeymap } from '../../src/adapter/ui/render/keymap';
import { KEY_COMMANDS, type KeyCommand } from '../../src/features/keymap';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';

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
    bodyChars: 0,
  };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  appSearchHistory.clear();
  // ⚠ 端末の記録(localStorage)は test をまたぐ ── 空から始める
  appRecentCommands.clear();
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  // 🔑 描く器が先、読む側が後(本番の `main.ts` と同じ順 ── 押せるかは描き終えた画面で決まる)
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((st) => browse.render(st, 'filer'));
  // 🔑 本番(`main.ts` の描画の最後)と同じ位置・同じ呼び方。⚠ ここを外すと、下の
  //   「状態が動いたら描き直す」が落ちる(配線を落とした日に静かに壊れない)
  d.onState(() => repaintCommandList(root, d, appKeymap));
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも')], relations: [] });
  sent.length = 0;
  return { root, d, sent };
}

const field = (root: HTMLElement): HTMLInputElement =>
  root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
const listOf = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-region="command-list"]')!;
const hostOf = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-region="browse-host"]')!;
const rows = (root: HTMLElement): HTMLButtonElement[] => [
  ...listOf(root).querySelectorAll<HTMLButtonElement>('[data-pkc-field="command-row"]'),
];
const rowOf = (root: HTMLElement, id: string): HTMLButtonElement | undefined =>
  rows(root).find((b) => b.getAttribute('data-pkc-command') === id);

/** 欄へ打つ(本物の経路: `input` event)。 */
function type(root: HTMLElement, text: string): void {
  const f = field(root);
  f.value = text;
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

const keydown = (el: HTMLElement, init: KeyboardEventInit): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('`>` で一覧が操作に替わり、消すとノートに戻る', () => {
  it('🔴 打つと、ノートの一覧の場所に操作の一覧が出る(対照群: 打つ前はノートの一覧)', () => {
    const { root } = setup();
    // 対照群 ── 打つ前
    expect(listOf(root).hidden, '前提が崩れている(最初から操作の一覧が出ている)').toBe(true);
    expect(hostOf(root).hidden, '前提が崩れている(ノートの一覧が隠れている)').toBe(false);

    type(root, '>');
    expect(listOf(root).hidden, '`>` を打っても操作の一覧が出ない').toBe(false);
    expect(hostOf(root).hidden, '操作の一覧と、ノートの一覧が同時に出ている').toBe(true);
    expect(rows(root).length, '操作の一覧が空').toBeGreaterThan(0);
  });

  it('🔴 欄を空にする / 先頭の `>` を消すと、ノート探しに戻る', () => {
    const { root } = setup();
    type(root, '>ノート');
    expect(listOf(root).hidden).toBe(false);
    type(root, '');
    expect(listOf(root).hidden, '欄を空にしても操作の一覧が残る').toBe(true);
    expect(hostOf(root).hidden, '欄を空にしてもノートの一覧が戻らない').toBe(false);

    type(root, '>ノート');
    type(root, 'ノート'); // 先頭の `>` だけ消した
    expect(listOf(root).hidden, '`>` を消しても操作の一覧が残る').toBe(true);
    expect(hostOf(root).hidden).toBe(false);
  });

  it('🔴 全角の `＞` でも替わる(日本語入力のまま打った形)', () => {
    const { root } = setup();
    type(root, '＞ノート');
    expect(listOf(root).hidden).toBe(false);
    expect(rowOf(root, 'create-entry'), '全角の `＞` で絞れていない').toBeDefined();
  });

  it('🔴 途中の `>` では替わらない(検索語である)', () => {
    const { root } = setup();
    type(root, 'a > b');
    expect(listOf(root).hidden).toBe(true);
    expect(hostOf(root).hidden).toBe(false);
  });

  it('🔴 `>` に続けた字で絞る ── 操作のパレットと同じ行・同じ並び・同じ押せるか', async () => {
    const { root } = setup();
    for (const q of ['', 'ノート', 'ヘルプ', '集計', 'ぬるぽ']) {
      type(root, `>${q}`);
      // 🔑 比べる相手は**もう 1 つの出口**(パレットの小窓)── 同じ口(`commandRowsFor`)を
      //   呼び直すだけでは、2 本目の判定が生えても気づけない
      root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
      await tick();
      const input = document.querySelector<HTMLInputElement>('[data-pkc-field="palette-filter"]')!;
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const dialogRows = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]'),
      ].map((b) => [b.getAttribute('data-pkc-command'), b.disabled] as const);
      document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
      await tick();
      const sideRows = rows(root).map((b) => [b.getAttribute('data-pkc-command'), b.disabled] as const);
      expect(sideRows, `「${q}」で左の列とパレットの答えが違う`).toEqual(dialogRows);
      if (q === 'ぬるぽ') {
        expect(sideRows).toEqual([]);
        expect(
          listOf(root).querySelector('[data-pkc-field="command-empty"]')?.textContent ?? '',
          '空を黙って出している',
        ).toContain('操作はありません');
      } else {
        expect(sideRows.length, `前提が崩れている(「${q}」が 0 件)`).toBeGreaterThan(0);
      }
    }
  });

  it('🔴 `>` の後ろ全部が探し語 ── 名前に空白を含む操作も、名前のまま絞れる(割る解釈器は無い)', () => {
    const { root } = setup();
    const withSpace = KEY_COMMANDS.find((c) => c.label.includes(' '));
    expect(withSpace, '前提が崩れている(空白を含む名前が無い)').toBeDefined();
    type(root, `>${withSpace!.label}`);
    expect(rowOf(root, withSpace!.id), '空白を含む名前で絞れていない').toBeDefined();
  });
});

describe('行を押す / Enter で、その操作が実行される', () => {
  it('🔴 行を押すと、鍵・パレットと同じ道で実行され、一覧はノートに戻る', async () => {
    const { root, d, sent } = setup();
    type(root, '>集計');
    const row = rowOf(root, 'view-query');
    expect(row, '前提が崩れている(集計へ移るが出ていない)').toBeDefined();
    expect(row!.disabled, '前提が崩れている(押せない)').toBe(false);
    sent.length = 0;
    row!.click();
    await tick();
    expect(
      sent.some((a) => a.type === 'SET_VIEW_MODE' && a.mode === 'query'),
      '押したのに操作が走っていない',
    ).toBe(true);
    // 済んだら欄を空にして、ノートの一覧へ戻す
    expect(d.getState().filterQuery, '実行したのに `>` が残っている').toBe('');
    expect(field(root).value).toBe('');
    expect(listOf(root).hidden).toBe(true);
    expect(hostOf(root).hidden).toBe(false);
  });

  it('🔴 押せない操作は、理由つきで出る(隠さない)・押しても何も起きない', async () => {
    const { root, sent } = setup();
    type(root, '>編集');
    const row = rowOf(root, 'edit-entry');
    expect(row, '押せない操作が隠されている').toBeDefined();
    expect(row!.disabled, '選んでいないのに押せることになっている').toBe(true);
    expect(
      row!.querySelector('[data-pkc-field="command-why"]')?.textContent ?? '',
      '理由が出ていない',
    ).toContain(NOT_READY_PREFIX);
    sent.length = 0;
    row!.click();
    await tick();
    expect(sent, '押せない行を押したら何かが走った').toEqual([]);
  });

  it('🔴 対照群 ── 押しボタンが画面に在れば押せる行になる(状態が動いたら描き直す)', () => {
    const { root, d } = setup();
    type(root, '>編集');
    expect(rowOf(root, 'edit-entry')!.disabled).toBe(true);
    const edit = document.createElement('button');
    edit.setAttribute('data-pkc-action', 'start-edit');
    root.append(edit);
    // ⚠ 画面のボタンが変わっただけでは state は動かない ── 状態を 1 つ動かす
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(rowOf(root, 'edit-entry')!.disabled, '状態が動いたのに押せる行へ描き直されない').toBe(false);
  });

  it('🔴 Enter は「押せる先頭の行」を実行する(変換確定の Enter では実行しない)', async () => {
    const { root, sent } = setup();
    type(root, '>集計');
    expect(rows(root)[0]?.getAttribute('data-pkc-command'), '前提が崩れている').toBe('view-query');
    sent.length = 0;
    keydown(field(root), { key: 'Enter', isComposing: true });
    await tick();
    expect(sent, '変換確定の Enter で実行された').toEqual([]);
    keydown(field(root), { key: 'Enter' });
    await tick();
    expect(
      sent.some((a) => a.type === 'SET_VIEW_MODE' && a.mode === 'query'),
      'Enter で先頭の行が走っていない',
    ).toBe(true);
  });

  it('🔴 押せる行が無ければ Enter は何もしない', async () => {
    const { root, sent } = setup();
    // 「確定」は 2 列の編集の操作 ── 全域では押せない(行は出るが全部押せない)
    type(root, '>確定');
    expect(rows(root).length, '前提が崩れている').toBeGreaterThan(0);
    expect(rows(root).every((b) => b.disabled), '前提が崩れている').toBe(true);
    sent.length = 0;
    keydown(field(root), { key: 'Enter' });
    await tick();
    expect(sent.filter((a) => a.type !== 'SET_ENTRY_FILTER'), '押せない行を Enter が拾った').toEqual(
      [],
    );
    expect(listOf(root).hidden, '勝手に戻った').toBe(false);
  });

  it('🔴 `↓` で行へ降り、行の上で `↑` `↓` で動き、先頭から `↑` で欄へ戻る', () => {
    const { root } = setup();
    type(root, '>');
    const enabled = rows(root).filter((b) => !b.disabled);
    expect(enabled.length, '前提が崩れている').toBeGreaterThan(2);
    keydown(field(root), { key: 'ArrowDown' });
    expect(document.activeElement, '`↓` で先頭の行へ降りていない').toBe(enabled[0]);
    keydown(enabled[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(enabled[1]);
    keydown(enabled[1]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(enabled[0]);
    keydown(enabled[0]!, { key: 'ArrowUp' });
    expect(document.activeElement, '先頭から `↑` で欄へ戻れない').toBe(field(root));
  });
});

/**
 * 🔴 **#1206 の動線の直し**(`>` の一覧まわりの 4 件)。
 *
 * user から見た物語:探す欄に `>` を打つ → 下のタブや並び順を押す → 色だけ動いて一覧は操作のまま
 * (D2)/ `>` だけ打って Enter → 打った覚えのないノートの編集に入る(D8)/ 一覧へ `↓` で降りて
 * `Esc` → 探す欄へ戻らず開いている本文が閉じる(D4)/ `>ルビ` の灰色の理由が、左では作れない状態を
 * 言う(D3)。
 */
describe('#1206 `>` の一覧の動線', () => {
  const tabsOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-pkc-region="browse-tabs"]')!;
  const sortOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-pkc-field="entry-sort"]')!;
  const createBarOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-pkc-region="create-bar"]')!;

  it('🔴 D2: `>` の間はタブ・並び順・作る帯を出さない / 消すと戻る(対照群: 打つ前は 3 つとも出ている)', () => {
    const { root } = setup();
    const three = [tabsOf(root), sortOf(root), createBarOf(root)];
    expect(three.every((el) => el !== null), '前提: 3 つの器が在る').toBe(true);
    expect(three.map((el) => el.hidden), '前提: 打つ前は 3 つとも出ている').toEqual([false, false, false]);
    type(root, '>');
    expect(three.map((el) => el.hidden), '`>` の間もタブ・並び順・作る帯が出ている').toEqual([true, true, true]);
    type(root, '>ノート');
    expect(three.map((el) => el.hidden), '字を足したら戻った').toEqual([true, true, true]);
    type(root, '');
    expect(three.map((el) => el.hidden), '`>` を消しても 3 つが戻らない').toEqual([false, false, false]);
    // 隠すのは 3 つだけ ── 探す欄は残る(消すと `>` を直せなくなる)
    type(root, '>');
    expect(field(root).hidden, '探す欄まで隠れた').toBe(false);
    expect(field(root).closest('[hidden]'), '探す欄が隠れた器の中に在る').toBeNull();
  });

  it('🔴 D8: `>` だけ(後ろが 0 文字)の Enter は何もしない ── 一覧は出したまま(対照群: 1 文字以上なら実行する)', async () => {
    const { root, sent } = setup();
    type(root, '>');
    expect(rows(root).some((b) => !b.disabled), '前提: 押せる行が在る(先頭は「ノートを作る」)').toBe(true);
    sent.length = 0;
    keydown(field(root), { key: 'Enter' });
    await tick();
    expect(sent.filter((a) => a.type !== 'SET_ENTRY_FILTER'), '`>` だけの Enter で先頭の行が走った').toEqual([]);
    expect(listOf(root).hidden, '一覧が消えた').toBe(false);
    // 空白だけも「名前が無い」
    type(root, '>  ');
    sent.length = 0;
    keydown(field(root), { key: 'Enter' });
    await tick();
    expect(sent.filter((a) => a.type !== 'SET_ENTRY_FILTER'), '`>` + 空白だけの Enter で走った').toEqual([]);
    // 対照群: 1 文字でも打てば、そこから実行できる
    type(root, '>集');
    sent.length = 0;
    keydown(field(root), { key: 'Enter' });
    await tick();
    expect(
      sent.some((a) => a.type === 'SET_VIEW_MODE' && a.mode === 'query'),
      '1 文字以上なら実行されるはず(門が広すぎる)',
    ).toBe(true);
  });

  it('🔴 D4: 一覧の行の上の Esc は探す欄へ焦点を戻すだけ ── 本文は閉じず、`>` の字も残る', () => {
    const { root, d } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(d.getState().selectedLid, '前提: ノートを開いている').toBe('n1');
    type(root, '>');
    keydown(field(root), { key: 'ArrowDown' });
    const row = rows(root).find((b) => !b.disabled)!;
    expect(document.activeElement, '前提: 行へ降りている').toBe(row);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(document.activeElement, '探す欄へ焦点が戻っていない').toBe(field(root));
    expect(d.getState().selectedLid, '本文が閉じた').toBe('n1');
    expect(field(root).value, '`>` の字が消えた').toBe('>');
    expect(listOf(root).hidden, '一覧が消えた').toBe(false);
    expect(ev.defaultPrevented, 'Esc の既定動作を止めていない(他の受け手へ落ちる)').toBe(true);
  });

  it('🔴 D3: 左の `>` では「本文の欄が要る操作」の理由が、呼べる場所を言う(行は隠さない)', () => {
    const { root, d } = setup();
    const left = commandRowsFor(root, d, appKeymap, 'ルビ', null);
    const ruby = left.find((r) => r.id === 'format-ruby');
    expect(ruby, '行を隠した').toBeDefined();
    expect(ruby!.ready).toBe(false);
    expect(ruby!.why).toBe(`${NOT_READY_PREFIX}本文の欄で Ctrl + Shift + P の『操作を探す』から呼べます`);
    // 対照群 1: 本文の欄から開いたパレット(宛先が在る)は押せる ── 理由は要らない
    const ta = document.createElement('textarea');
    document.body.append(ta);
    const fromEditor = commandRowsFor(root, d, appKeymap, 'ルビ', ta);
    expect(fromEditor.find((r) => r.id === 'format-ruby')!.ready, 'パレットの小窓では押せるはず').toBe(true);
    expect(fromEditor.find((r) => r.id === 'format-ruby')!.why).not.toContain('操作を探す');
    // 対照群 2: 「本文の欄が要る」わけではない操作(2 ペインの編集の確定)は今までの理由のまま
    const commit = (rs: readonly { id: string; why: string }[]) => rs.find((r) => r.id === 'commit-edit')!.why;
    expect(commit(commandRowsFor(root, d, appKeymap, '', null))).toContain('にいるときだけ効きます');
    expect(commit(commandRowsFor(root, d, appKeymap, '', ta))).toContain('にいるときだけ効きます');
  });
});

describe('種類の札', () => {
  it('🔴 札を押して絞っているとき、`>` を打つ間だけ札を出さない(押しても見えている物が変わらない)', () => {
    const { root, d } = setup();
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="kind-bar"]')!;
    // 対照群 ── `>` を打つ前は、絞っている札(解除の口)が出ている
    expect(bar.hidden, '前提が崩れている(絞っているのに札が出ていない)').toBe(false);
    type(root, '>');
    expect(bar.hidden, '操作の一覧の間も、ノートの種類の札が出ている').toBe(true);
    type(root, '');
    expect(bar.hidden, '`>` を消しても札が戻らない').toBe(false);
  });
});

describe('操作の一覧の描き直し', () => {
  it('🔴 並び・押せるか・理由が同じなら、行に触らない(矢印で動かしている焦点を消さない)', () => {
    const host = document.createElement('div');
    const mk = (ready: boolean) =>
      [
        { id: 'a', label: 'A', keys: ['Ctrl+A'], ready, why: ready ? '' : `${NOT_READY_PREFIX}理由` },
      ] as const;
    expect(paintCommandList(host, mk(true))).toBe(true);
    const first = host.querySelector('button');
    expect(paintCommandList(host, mk(true)), '同じなのに組み直した').toBe(false);
    expect(host.querySelector('button')).toBe(first);
    // 対照群 ── 押せるかが変われば組み直す
    expect(paintCommandList(host, mk(false))).toBe(true);
    expect(host.querySelector('button')!.disabled).toBe(true);
  });
});

/**
 * 🔴 **`>` だけのとき、先頭に「最近使った操作」が出る**(#274。🟣 Gemini 裁定 A)。
 *
 * user から見た物語:探す欄に `>` を打つ → 前に使った操作が上に並んでいる → 押す。
 * 名前を打ち始めたら、いつもの絞り込みだけ。
 */
describe('最近使った操作(`>` だけのとき)', () => {
  const headingOf = (root: HTMLElement) =>
    listOf(root).querySelectorAll('[data-pkc-field="command-recent-heading"]');
  const orderOf = (root: HTMLElement) => rows(root).map((b) => b.getAttribute('data-pkc-command'));
  /** 押せる行の id を上から n 個(空の記録での並び)。 */
  function readyIds(root: HTMLElement, n: number): string[] {
    type(root, '>');
    const ids = rows(root)
      .filter((b) => !b.disabled)
      .map((b) => b.getAttribute('data-pkc-command')!);
    type(root, '');
    expect(ids.length, '前提が崩れている(押せる操作が足りない)').toBeGreaterThanOrEqual(n);
    return ids.slice(0, n);
  }

  it('🔴 この一覧から実行すると憶え、次に `>` だけを打つと先頭に出る(同じ操作は 1 行)', async () => {
    const { root } = setup();
    // 対照群 ── 何も使っていないうちは節が無い
    type(root, '>');
    expect(headingOf(root).length, '前提が崩れている(使っていないのに節が出ている)').toBe(0);
    const before = orderOf(root);
    type(root, '>集計');
    rowOf(root, 'view-query')!.click();
    await tick();
    expect(appRecentCommands.list(), '実行したのに憶えていない').toEqual(['view-query']);
    expect(field(root).value, '前提が崩れている(実行したのに `>` が残っている)').toBe('');
    type(root, '>');
    expect(headingOf(root).length, '見出しが 1 行でない').toBe(1);
    expect(headingOf(root)[0]!.textContent).toBe('最近使った操作');
    expect(orderOf(root)[0], '最近使った操作が先頭に出ていない').toBe('view-query');
    expect(
      orderOf(root).filter((id) => id === 'view-query').length,
      '同じ操作が 2 行並んでいる',
    ).toBe(1);
    // 普通の一覧がその下に続く(全部の操作が 1 行ずつ残っている)。
    // ⚠ 並びは比べない ── 実行で画面の状態が動き、「いま押せるか」が変わる操作が在る
    expect([...orderOf(root)].sort(), '普通の一覧が下に続いていない').toEqual([...before].sort());
  });

  it('🔴 5 件まで・新しい順(6 件目を憶えると最古が落ちる)', () => {
    const { root } = setup();
    const ids = readyIds(root, 6);
    for (const id of ids) appRecentCommands.push(id); // 最後に push した = 6 番目が最新
    type(root, '>');
    const shown = orderOf(root).slice(0, 5);
    expect(shown, '新しい順に 5 件').toEqual([ids[5], ids[4], ids[3], ids[2], ids[1]]);
    // 最古は節から落ちる(普通の一覧には残る)
    expect(orderOf(root).slice(5).includes(ids[0]!), '最古の操作が一覧から消えた').toBe(true);
    expect(headingOf(root).length).toBe(1);
  });

  it('🔴 名前を 1 字でも打ち始めたら、節は出ず、いつもの絞り込みだけ', () => {
    const { root } = setup();
    appRecentCommands.push('view-query');
    type(root, '>');
    expect(headingOf(root).length, '前提が崩れている(`>` だけで節が出ていない)').toBe(1);
    type(root, '>ヘ');
    expect(headingOf(root).length, '打ち始めたのに節が出ている').toBe(0);
    const typed = orderOf(root);
    appRecentCommands.clear();
    type(root, '>ヘ');
    expect(typed, '記録の有無で絞り込みの結果が変わった').toEqual(orderOf(root));
    // 空白だけは「名前が無い」のまま
    appRecentCommands.push('view-query');
    type(root, '>  ');
    expect(headingOf(root).length, '空白だけでは節が出るはず').toBe(1);
  });

  it('🔴 行の形は普通の行と同じ(部品を作り足していない)', () => {
    const { root } = setup();
    type(root, '>');
    const normal = rowOf(root, 'view-query')!.outerHTML;
    appRecentCommands.push('view-query');
    type(root, '');
    type(root, '>');
    expect(orderOf(root)[0], '前提が崩れている').toBe('view-query');
    expect(rows(root)[0]!.outerHTML, '節の行が普通の行と違う形で描かれている').toBe(normal);
  });

  it('🔴 消えた操作の id は出さない(出す物が 1 つも無ければ見出しも出さない)', () => {
    const { root } = setup();
    appRecentCommands.push('no-such-operation');
    type(root, '>');
    expect(headingOf(root).length, '無い操作だけなのに見出しが出ている').toBe(0);
    expect(
      orderOf(root).includes('no-such-operation'),
      '消えた操作が行として出ている',
    ).toBe(false);
    appRecentCommands.push('view-query');
    type(root, '');
    type(root, '>');
    expect(orderOf(root)[0]).toBe('view-query');
    expect(orderOf(root).includes('no-such-operation')).toBe(false);
  });

  /**
   * 🔴 **断られた回は憶えない**(着地後レビューの変異 B2)。
   * ⚠ `onDone` の契約(済んだときだけ呼ぶ)の test はあるが、**binder の押しから記録まで**は通っていなかった ──
   *   押した行が実行を断ったとき(描いた後に状態が動いて押せなくなった回)に `appRecentCommands.push` が
   *   `onDone` の外へ出ても気づけない。押せない行は `disabled` なので、**描いた後に状態が動いた形**を
   *   `disabled` を外して作る(対照:押せる行の実行は憶える)。
   */
  it('🔴 実行を断られた行は、押しても憶えず、欄の `>` も残す(対照:押せる行は憶える)', async () => {
    const { root } = setup();
    type(root, '>ルビ');
    const refused = rowOf(root, 'format-ruby');
    expect(refused, '前提が崩れている(行が無い)').toBeDefined();
    expect(refused!.disabled, '前提が崩れている(押せる行だった)').toBe(true);
    refused!.disabled = false; // 描いた後に状態が動いた形
    refused!.click();
    await tick();
    expect(appRecentCommands.list(), '断られたのに憶えた').toEqual([]);
    expect(field(root).value, '断られたのに欄が空に戻った').toBe('>ルビ');
    // 対照:押せる行は憶える(= 憶える道そのものは生きている)
    type(root, '>集計');
    rowOf(root, 'view-query')!.click();
    await tick();
    expect(appRecentCommands.list()).toEqual(['view-query']);
  });

  /**
   * 🔴 **`>` だけの `Enter` は、実行せずに先頭の行へ焦点を移す**(#1206 D8 は守る → #274 Q2 = C、2026-10-03)。
   * user から見た物語:`>` だけ打って Enter → 何も起きないように見えていた → 先頭の行(最近使った操作が
   * あればその先頭)に焦点が移る → もう一度 Enter(行はボタンなので既定が実行する)。
   */
  it('🔴 `>` だけの Enter は、最近使った操作が先頭にあっても実行せず、その行へ焦点を移す(`↓` と同じ)', async () => {
    const { root, sent } = setup();
    appRecentCommands.push('view-query');
    type(root, '>');
    expect(orderOf(root)[0], '前提が崩れている').toBe('view-query');
    field(root).focus();
    sent.length = 0;
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field(root).dispatchEvent(ev);
    await tick();
    expect(sent.filter((a) => a.type !== 'SET_ENTRY_FILTER'), '`>` だけの Enter で走った').toEqual([]);
    // 🔴 既定動作を止める ── 実ブラウザでは keydown で焦点を移した先の button に Enter の既定(click)が届き、
    //   「打っていない操作が走る」(D8 が守る形)に戻る。happy-dom は keydown から click を作らないので字で pin する
    expect(ev.defaultPrevented, 'Enter の既定動作を止めていない(焦点先の行が実行されうる)').toBe(true);
    expect(document.activeElement, 'Enter で先頭の行へ焦点が移っていない').toBe(rowOf(root, 'view-query'));
    expect(field(root).value, '焦点を移しただけなのに欄が変わった').toBe('>');
    // 次の Enter = 行(ボタン)の既定の実行。⚠ 実ブラウザでは Enter が click を起こす ── ここでは click で代える
    (document.activeElement as HTMLButtonElement).click();
    await tick();
    expect(sent.some((a) => a.type === 'SET_VIEW_MODE'), '焦点が移った行を押しても実行されない').toBe(true);
    // 対照群 `↓` も同じ行へ降りる(Enter はそれと同じ動きになった)
    type(root, '>');
    field(root).focus();
    keydown(field(root), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowOf(root, 'view-query'));
  });

  it('🔴 `>` だけ(空白だけ含む)の Enter も同じ。記録が無ければ「押せる先頭の行」へ(押せない行は飛ばす)', async () => {
    const { root, sent } = setup();
    type(root, '>  ');
    const firstReady = rows(root).find((b) => !b.disabled);
    expect(firstReady, '前提が崩れている(押せる行が無い)').toBeDefined();
    field(root).focus();
    sent.length = 0;
    keydown(field(root), { key: 'Enter' });
    expect(document.activeElement).toBe(firstReady);
    expect(sent.filter((a) => a.type !== 'SET_ENTRY_FILTER'), '空白だけの Enter で走った').toEqual([]);
  });

  it('🔴 変換確定の Enter では焦点を動かさない(日本語入力のまま `＞` を打つ人)', () => {
    const { root } = setup();
    type(root, '＞');
    field(root).focus();
    keydown(field(root), { key: 'Enter', isComposing: true });
    expect(document.activeElement, '変換確定の Enter で焦点が動いた').toBe(field(root));
  });

  it('🔴 名前を 1 字でも打った後の Enter は、今までどおり先頭の押せる行を実行する(対照群)', async () => {
    const { root, sent } = setup();
    type(root, '>集計');
    field(root).focus();
    sent.length = 0;
    keydown(field(root), { key: 'Enter' });
    await tick();
    expect(sent.some((a) => a.type === 'SET_VIEW_MODE'), '名前を打った後の Enter が実行しなくなった').toBe(true);
  });

  /**
   * 🔴 **いま押せない操作は「最近使った操作」の節から外す**(#274 Q1 = A、2026-10-03)。
   * ⚠ 記録は消さない(押せるようになれば戻る)。⚠ 押せる物だけで 5 件まで。
   */
  it('🔴 押せない操作は節に出ず、普通の一覧に灰色で残る。記録は消えない(押せる物は出る = 対照群)', () => {
    const { root } = setup();
    // `format-ruby` は本文の欄が要る操作 ── 左の欄からは押せない(上の「断られた回」の test と同じ前提)
    appRecentCommands.push('format-ruby');
    appRecentCommands.push('view-query');
    type(root, '>');
    expect(orderOf(root)[0], '押せる操作が節の先頭に出ていない').toBe('view-query');
    expect(orderOf(root).indexOf('format-ruby'), '押せない操作が節に居る').toBeGreaterThan(1);
    expect(rowOf(root, 'format-ruby')!.disabled, '前提が崩れている(押せる行だった)').toBe(true);
    expect(appRecentCommands.list(), '押せないからといって記録まで消した').toEqual(['view-query', 'format-ruby']);
    // 押せない物しか憶えていなければ、見出しごと出ない
    appRecentCommands.clear();
    appRecentCommands.push('format-ruby');
    type(root, '');
    type(root, '>');
    expect(headingOf(root).length, '押せない物だけなのに見出しが出ている').toBe(0);
  });

  it('🔴 描き直しの指紋に節が入っている(同じ行が節へ動いたら組み直す)', () => {
    const host = document.createElement('div');
    const row = (id: string) => ({ id, label: id, keys: [], ready: true, why: '' });
    expect(paintCommandList(host, [row('a'), row('b')])).toBe(true);
    expect(paintCommandList(host, [row('a'), row('b')])).toBe(false);
    // 残りの行は変えずに、節だけが変わる回 ── 残りの指紋だけ見ていると組み直されない
    expect(paintCommandList(host, [row('a')])).toBe(true);
    expect(paintCommandList(host, [row('a')], [row('b')]), '節だけ変わったのに組み直さない').toBe(true);
    expect(host.querySelector('[data-pkc-field="command-recent-heading"]')).not.toBeNull();
    expect(paintCommandList(host, [row('a')], [row('b')]), '同じなのに組み直した').toBe(false);
    // 節が空に戻ると見出しも消える
    expect(paintCommandList(host, [row('b'), row('a')])).toBe(true);
    expect(host.querySelector('[data-pkc-field="command-recent-heading"]')).toBeNull();
  });
});

describe('検索語の記録に、操作の名前は入らない', () => {
  it('🔴 `>` で始まる字を確定(change)しても憶えない(対照群: 普通の語は憶える)', () => {
    const { root } = setup();
    field(root).value = '会議メモ';
    field(root).dispatchEvent(new Event('change', { bubbles: true }));
    expect(appSearchHistory.list(), '対照群が崩れている').toEqual(['会議メモ']);

    for (const v of ['>ノートを作る', '＞ノートを作る']) {
      field(root).value = v;
      field(root).dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(appSearchHistory.list(), '操作の名前が検索語として憶えられた').toEqual(['会議メモ']);
    expect(
      [...root.querySelectorAll<HTMLOptionElement>('datalist#pkc-search-history option')].map(
        (o) => o.value,
      ),
      '候補に操作の名前が載っている',
    ).toEqual(['会議メモ']);
  });
});

describe('探す欄が `>` を名乗る', () => {
  it('🔴 hover に「`>` を打つと操作を探せます」が出る', () => {
    const { root } = setup();
    expect(field(root).title).toContain('先頭に > を打つと、操作を探せます');
    // ⚠ 既存の説明(Esc で消す)を押しのけていない
    expect(field(root).title).toContain('Esc で、打った字を消します');
  });

  it('🔴 既存のパレット(左下の「操作を探す」)はそのまま残る', () => {
    const { root } = setup();
    expect(root.querySelector('[data-pkc-action="open-palette"]')).not.toBeNull();
  });
});

describe('相手が要る操作(`KeyCommand.needs`)', () => {
  /** 宣言のある操作の fixture(本物の表には 0 件 ── 欄と配線だけを見る)。 */
  const WITH: KeyCommand = {
    id: 'fixture-with-entry',
    label: '相手を選ぶ操作',
    contexts: ['global'],
    defaults: [],
    needs: 'entry',
  };
  const PLAIN: KeyCommand = {
    id: 'view-query',
    label: '集計へ移る',
    contexts: ['global'],
    defaults: [],
  };

  function envOf(root: HTMLElement, d: Dispatcher) {
    const said: string[] = [];
    return { env: { root, dispatcher: d, keymap: appKeymap, notify: (t: string) => said.push(t) }, said };
  }
  const pickRows = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="entry-pick-row"]'),
  ];

  it('🔴 宣言のある操作は、相手を選ぶ小窓が開き、選んだ相手で実行される', async () => {
    const { root, d } = setup();
    const { env } = envOf(root, d);
    const calls: string[] = [];
    const exec: CommandWithEntry = (lid) => calls.push(lid);
    let done = 0;
    const started = runCommandRow(WITH.id, env, {
      commands: [WITH],
      withEntry: { [WITH.id]: exec },
      onDone: () => done++,
    });
    await tick();
    expect(started).toBe(true);
    expect(pickRows().length, '相手を選ぶ小窓が開いていない').toBeGreaterThan(0);
    expect(calls, '選ぶ前に実行された').toEqual([]);
    pickRows()[0]!.click();
    await tick();
    expect(calls, '選んだ相手で実行されていない').toEqual(['n1']);
    expect(done, '済んだのに onDone が呼ばれない').toBe(1);
  });

  it('🔴 相手を選ばずにやめたら、実行されず、`>` の字も残る(onDone を呼ばない)', async () => {
    const { root, d } = setup();
    const { env } = envOf(root, d);
    const calls: string[] = [];
    let done = 0;
    runCommandRow(WITH.id, env, {
      commands: [WITH],
      withEntry: { [WITH.id]: (lid) => calls.push(lid) },
      onDone: () => done++,
    });
    await tick();
    document.querySelector<HTMLButtonElement>(`[data-pkc-field="dialog-cancel"]`)!.click();
    await tick();
    expect(calls, 'やめたのに実行された').toEqual([]);
    expect(done, 'やめたのに済んだことになっている').toBe(0);
    expect(document.querySelector(`[data-pkc-region="${DIALOG_REGION}"]`)).not.toBeNull();
  });

  it('🔴 対照群 ── 宣言の無い操作は、小窓を出さずに押した瞬間に走る', async () => {
    const { root, d, sent } = setup();
    const { env } = envOf(root, d);
    sent.length = 0;
    let done = 0;
    expect(
      runCommandRow(PLAIN.id, env, { commands: [PLAIN], withEntry: {}, onDone: () => done++ }),
    ).toBe(true);
    await tick();
    expect(pickRows(), '宣言が無いのに相手を聞いた').toEqual([]);
    expect(sent.some((a) => a.type === 'SET_VIEW_MODE' && a.mode === 'query')).toBe(true);
    expect(done).toBe(1);
  });

  it('🔴 宣言はあるのに実体が無い操作は、黙らず断る(実行しない・onDone を呼ばない)', async () => {
    const { root, d } = setup();
    const { env, said } = envOf(root, d);
    let done = 0;
    expect(runCommandRow(WITH.id, env, { commands: [WITH], withEntry: {}, onDone: () => done++ })).toBe(
      false,
    );
    expect(said.length, '黙って終わった').toBe(1);
    expect(done).toBe(0);
    expect(pickRows()).toEqual([]);
  });

  it('🔴 本物の表 ── 宣言(`needs`)と実体(`COMMAND_WITH_ENTRY`)が 1:1 で揃っている', () => {
    const declared = KEY_COMMANDS.filter((c) => c.needs === 'entry')
      .map((c) => c.id)
      .sort();
    expect(Object.keys(COMMAND_WITH_ENTRY).sort(), '宣言と実体が食い違っている').toEqual(declared);
    // 🔑 2026-10-01 時点の事実 ── 増やしたら、ここを直して何が +1 かを書く
    expect(declared, '宣言のある操作が 0 件でなくなった(+N の中身を書くこと)').toEqual([]);
  });

  it('🔴 存在しない操作は何もしない(`false`)', () => {
    const { root, d } = setup();
    const { env } = envOf(root, d);
    expect(runCommandRow('no-such-command', env)).toBe(false);
  });
});

describe('commandRowsFor は 2 つの出口が同じ口', () => {
  it('🔴 `target` が `null` のとき、記法は押せない(左の列は本文の欄に居ない)', () => {
    const { root, d } = setup();
    const r = commandRowsFor(root, d, appKeymap, 'ルビ', null);
    const ruby = r.find((x) => x.id === 'format-ruby');
    expect(ruby, '前提が崩れている').toBeDefined();
    expect(ruby!.ready).toBe(false);
  });
});

/**
 * 🔴 **本番の配線は `main.ts` に在る**(描画の最後で `repaintCommandList`)。
 *
 * ⚠ `main.ts` は原文を読む test しか届かない(弱い ── 呼ぶ位置と引数だけを見る)。
 *   本物どうしの通し(打つ → 一覧が替わる → 押す → 効く)は
 *   `tests/smoke/organize.smoke.spec.ts` の ⑧ が実ブラウザで見る。
 * 🔑 見るのは**描画する `onState` の中で、全部の面を描いた後**に呼んでいること ──
 *   先に呼ぶと「いま押せるか」が 1 手古い答えになる。
 */
describe('main.ts の配線(#274 段①)', () => {
  const main = readFileSync('src/main.ts', 'utf-8');

  it('🔴 描画の onState の中で、全部の面を描いた後に呼ぶ', () => {
    const start = main.indexOf('dispatcher.onState((state) => {\n    browse.render(state, browseMode);');
    expect(start, '描画する onState が見つからない(前提が崩れている)').toBeGreaterThan(0);
    const block = main.slice(start, main.indexOf('// status: provenance', start));
    const at = block.indexOf('repaintCommandList(root, dispatcher, appKeymap);');
    expect(at, '描画の onState から呼んでいない').toBeGreaterThan(0);
    for (const painted of ['browse.render(', 'center.render(', 'inspector.render(', 'appPhone.render(']) {
      expect(block.indexOf(painted), `${painted} が無い`).toBeGreaterThanOrEqual(0);
      expect(block.indexOf(painted), `${painted} より前に呼んでいる`).toBeLessThan(at);
    }
  });
});

/**
 * 🔴 **左の `>` の一覧にも「メッセージを開く」が出る**(#1017 C5。🟣 Gemini 裁定 B、2026-10-03)。
 * ⚠ 開く実体は「システム → メッセージ」の押しボタンと同じ 1 本(開く + 既読の 2 手)。
 */
describe('メッセージを開く(`>` の一覧)', () => {
  it('🔴 `>メッセージ` で出て、押すとメッセージのノートが開き、既読にする(押しボタンと同じ 2 手)', async () => {
    const { root, sent } = setup();
    const mark = vi.spyOn(appMessagePost, 'markRead').mockImplementation(() => undefined);
    try {
      type(root, '>メッセージ');
      const row = rowOf(root, 'open-messages');
      expect(row, '「メッセージを開く」が `>` の一覧に出ていない').toBeDefined();
      expect(row!.disabled, '押せるはずの行が押せない').toBe(false);
      row!.click();
      await tick();
      expect(
        sent.some((a) => a.type === 'MESSAGES_READ' && a.lid === SYSTEM_MESSAGE_LID),
        'メッセージのノートが開かない',
      ).toBe(true);
      expect(mark, '開いたのに既読にしていない(押しボタンと食い違う)').toHaveBeenCalledTimes(1);
      expect(appRecentCommands.list(), '実行したのに「最近使った操作」へ積んでいない').toEqual(['open-messages']);
    } finally {
      mark.mockRestore();
    }
  });
});
