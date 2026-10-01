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
import { beforeEach, describe, expect, it } from 'vitest';
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
  d.onState((st) => browse.render(st, 'list'));
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
