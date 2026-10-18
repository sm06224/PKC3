/** @vitest-environment happy-dom */
/**
 * 🔴 **名前で呼べなかった「高」の 18 件を「操作を探す」に足した**(#582 段③ 第 1 群。
 * 🟣 Gemini の回答 = #1163 の依頼 16「場面ごとに 1 群ずつ足す」)。
 *
 * 守るもの(どれも「壊れたら鳴る」形にしてある):
 *  ① **命令 = 画面のボタン**:一覧から呼ぶと、そのボタンが 1 回押される(= ボタンと同じ action が走る)。
 *     ⚠ 「押された」だけでなく、**ボタンを直接押したときと同じ dispatch 列**になることを見る。
 *  ② **押せないときは灰色 + 理由の 1 行**:ボタンが無い間 / 行ごと隠してある間 / 編集中。
 *  ③ **欄が先に要る 4 件**は、欄が空なら欄へ移り(ボタンは押さない)、字が入っていれば押す。
 *  ④ **字は画面のボタンの字と同じ**(source から引く ── 期待値を手で書かない)。
 *  ⑤ **鍵は付けない**(`defaults: []`)・命令 id は押しボタンの `data-pkc-action` と同じ綴り。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  bindActions,
  commandRowsFor,
  runGlobalCommand,
  SHORTCUT_BUTTON,
} from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';
import { KEY_COMMANDS, findCommand } from '../../src/features/keymap';

/** 第 1 群の 18 件(「選択範囲をコピー」は足していない ── 下の test)。⚠ `keymap.ts` の並びと突き合わせる(足し忘れ / 余分で落ちる)。 */
const BATCH = [
  'add-relation', 'add-tag', 'append-entry', 'attach-file', 'clear-entry-date', 'open-today', 'refresh-query', 'stack-save',
  'copy-note-md', 'copy-note-rich', 'export-messages', 'export-settings',
  'schedule-quick-add', 'schedule-today', 'export-schedule-ics', 'toggle-show-done', 'toggle-show-archived', 'toggle-show-undated',
] as const;

/**
 * 画面のボタンをそのまま押して実行する 17 件(`export-messages` を除く)。
 * ⚠ 「メッセージを書き出す」は 2026-10-17(台帳 #1852 束 L1、依頼 92-1)から**どの画面からでも**撃てる ──
 *   ボタン(システムの画面の中)を介さず直に書き出すので、ここの「ボタンを押す」検査には載せない
 *   (`tests/adapter/export-messages-anywhere.test.ts` が単独で見る)。
 */
const BUTTON_BATCH = BATCH.filter((x) => x !== 'export-messages');

/** 欄が先に要る 4 件(`binder.ts` の `PALETTE_FIELD_FIRST`)と、その欄・親の組み方。 */
const FIELD_FIRST: Readonly<Record<string, string>> = {
  'add-tag': 'tag-add-input',
  'add-relation': 'relation-target',
  'append-entry': 'append-input',
  'schedule-quick-add': 'schedule-quick-text',
};

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

/** そのボタンを画面に組む。⚠ 欄が先に要る物は、押しボタンと**同じ親**に欄を置く(実物の作り)。 */
function mount(root: HTMLElement, id: string, opts: { value?: string; hidden?: boolean } = {}): HTMLElement {
  const wrap = document.createElement('div');
  if (opts.hidden === true) wrap.hidden = true;
  const field = FIELD_FIRST[id];
  if (field !== undefined) {
    const input = document.createElement(id === 'append-entry' ? 'textarea' : 'input');
    input.setAttribute('data-pkc-field', field);
    (input as HTMLInputElement).value = opts.value ?? '';
    wrap.append(input);
  }
  const b = document.createElement(id === 'toggle-show-done' || id === 'toggle-show-archived' || id === 'toggle-show-undated' ? 'input' : 'button');
  if (b instanceof HTMLInputElement) b.type = 'checkbox';
  b.setAttribute('data-pkc-action', id);
  wrap.append(b);
  root.append(wrap);
  return b;
}

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const said: string[] = [];
  const store = new KeymapStore();
  bindActions(root, d, { showStatus: (t) => said.push(t) }, store);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', '議事録'), meta('b', '資料 B')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  sent.length = 0;
  return { root, d, sent, said, store };
}

const noop = (): void => {};
const run = (env: ReturnType<typeof setup>, id: string, dry = false): boolean =>
  runGlobalCommand(id, env.root, env.d, env.store, noop, (t) => env.said.push(t), dry);
const rowOf = (env: ReturnType<typeof setup>, id: string) =>
  commandRowsFor(env.root, env.d, env.store, '', null).find((r) => r.id === id);
/** dispatch 列を比べられる形にする(連番の id や時刻は落とす)。 */
const shape = (xs: readonly Dispatchable[]): string[] => xs.map((a) => a.type);

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('第 1 群 18 件の登記(#582 段③)', () => {
  it('⑤ 全部が KEY_COMMANDS に在り、鍵を持たず、受け手は押しボタン(id = data-pkc-action)', () => {
    expect(BATCH.length).toBe(18);
    for (const id of BATCH) {
      const c = findCommand(id);
      expect(c, `${id} が KEY_COMMANDS に無い`).toBeDefined();
      // ⚠ 2026-10-12(#1087 流れ 29): 18 件のうち `open-today` だけは既定 Alt+T を持つ(他の 17 件は鍵なし)
      expect(c?.defaults, `${id} に鍵が付いている`).toEqual(id === 'open-today' ? ['Alt+T'] : []);
      expect(c?.contexts, `${id} は全域`).toEqual(['global']);
      expect(SHORTCUT_BUTTON[id], `${id} の受け手(押しボタン)が無い`).toBe(`[data-pkc-action="${id}"]`);
      expect((c?.note ?? '').length, `${id} に説明(押せない理由を兼ねる)が無い`).toBeGreaterThan(0);
    }
    // 重複して登記していない
    expect(new Set(KEY_COMMANDS.map((c) => c.id)).size).toBe(KEY_COMMANDS.length);
  });

  it('④ 一覧の字は、画面のボタンの字と同じ(source から引く ── 手で書いた期待値にしない)', () => {
    const SOURCE: Readonly<Record<string, string>> = {
      'add-relation': 'src/adapter/ui/render/inspector.ts',
      'add-tag': 'src/adapter/ui/render/inspector.ts',
      'append-entry': 'src/adapter/ui/render/append-box.ts',
      'attach-file': 'src/adapter/ui/render/shell.ts',
      'clear-entry-date': 'src/adapter/ui/render/inspector.ts',
      'open-today': 'src/adapter/ui/render/shell.ts',
      'refresh-query': 'src/adapter/ui/render/query.ts',
      'stack-save': 'src/adapter/ui/render/split-view.ts',
      'copy-note-md': 'src/adapter/ui/render/detail.ts',
      'copy-note-rich': 'src/adapter/ui/render/detail.ts',
      'export-messages': 'src/adapter/ui/render/settings/messages.ts',
      'export-settings': 'src/adapter/ui/render/commands.ts',
      'schedule-quick-add': 'src/adapter/ui/render/schedule.ts',
      'schedule-today': 'src/adapter/ui/render/schedule.ts',
      'export-schedule-ics': 'src/adapter/ui/render/schedule.ts',
    };
    for (const [id, file] of Object.entries(SOURCE)) {
      const label = findCommand(id)?.label ?? '';
      expect(label, `${id} の字が空`).not.toBe('');
      const src = readFileSync(file, 'utf-8');
      expect(src.includes(`'${label}'`), `${id}: 画面のボタン(${file})に「${label}」という字が無い`).toBe(true);
    }
    // 3 つの切替の字は件数つき(`済み(3)`)で組まれる。一覧の字は動詞つきだが、頭の語は画面と同じ
    const sched = readFileSync('src/adapter/ui/render/schedule.ts', 'utf-8');
    for (const [id, head] of [
      ['toggle-show-done', '済み'],
      ['toggle-show-archived', '片付けたもの'],
      ['toggle-show-undated', '日付のないもの'],
    ] as const) {
      expect(findCommand(id)?.label.startsWith(head), `${id} の頭の語`).toBe(true);
      expect(sched.includes('`' + head + '(${'), `画面の字「${head}(N)」が schedule.ts に無い`).toBe(true);
    }
  });

  it('① 一覧から呼ぶと、画面のボタンが 1 回押され、直接押したときと同じ dispatch 列になる', () => {
    // 欄が先に要る 4 件は字を入れた形で(空のときは③)
    for (const id of BUTTON_BATCH) {
      const viaBtn = setup();
      const b1 = mount(viaBtn.root, id, { value: 'x' });
      let n1 = 0;
      b1.addEventListener('click', () => n1++);
      b1.click();
      const direct = shape(viaBtn.sent);

      const viaPalette = setup();
      const b2 = mount(viaPalette.root, id, { value: 'x' });
      let n2 = 0;
      b2.addEventListener('click', () => n2++);
      expect(run(viaPalette, id), `${id}: 呼べなかった`).toBe(true);
      expect(n2, `${id}: ボタンが 1 回押されていない`).toBe(1);
      expect(n1).toBe(1);
      expect(shape(viaPalette.sent), `${id}: ボタンを直接押したときと違う`).toEqual(direct);
    }
  });

  it('① 空振り防止:dispatch するはずの物は、本当に何かを dispatch している', () => {
    // ⚠ 「空 = 空」で緑にならないよう、受け手が確実に撃つ 6 件は dispatch 列そのものを見る
    const EXPECT: Readonly<Record<string, string>> = {
      'clear-entry-date': 'SET_ENTRY_DATE',
      'refresh-query': 'REFRESH_QUERY',
      'schedule-today': 'SET_CALENDAR_MONTH',
      'toggle-show-done': 'TOGGLE_SHOW_DONE_TASKS',
      'toggle-show-archived': 'TOGGLE_SHOW_ARCHIVED',
      'toggle-show-undated': 'TOGGLE_SHOW_UNDATED_TASKS',
      'add-tag': 'BULK_TAG',
      'stack-save': 'OP_FAILED', // スタックが空なので理由を言う(黙らない)
    };
    for (const [id, type] of Object.entries(EXPECT)) {
      const env = setup();
      mount(env.root, id, { value: '#x' });
      expect(run(env, id)).toBe(true);
      expect(shape(env.sent), `${id}`).toContain(type);
    }
  });

  it('① 添付: 隠れた入力欄を開く(ファイルの選択画面の入口)', () => {
    const env = setup();
    mount(env.root, 'attach-file');
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-pkc-field', 'attach-input');
    let opened = 0;
    input.addEventListener('click', () => opened++);
    env.root.append(input);
    expect(run(env, 'attach-file')).toBe(true);
    expect(opened).toBe(1);
  });
});

describe('② 押せないときは灰色 + 理由の 1 行', () => {
  it('ボタンが画面に無い間は、18 件とも押せず、理由は説明の末尾(…のときだけ効きます)から引く', () => {
    const env = setup();
    const rows = commandRowsFor(env.root, env.d, env.store, '', null);
    for (const id of BUTTON_BATCH) {
      const r = rows.find((x) => x.id === id);
      expect(r, `${id} が一覧に無い`).toBeDefined();
      expect(r?.ready, `${id}: ボタンが無いのに押せる顔`).toBe(false);
      expect(r?.why.startsWith(NOT_READY_PREFIX), `${id}: 理由が無い`).toBe(true);
      expect(run(env, id, true), `${id}: dry が真`).toBe(false);
    }
    // 場面の分かる理由が出る(「押せません」だけにしない)
    const whyOf = (id: string): string => rows.find((x) => x.id === id)?.why ?? '';
    expect(whyOf('schedule-today')).toContain('予定の画面を開いているとき');
    expect(whyOf('add-tag')).toContain('ノートを選んでいるとき');
    expect(whyOf('refresh-query')).toContain('集計の画面を開いているとき');
    expect(whyOf('copy-note-md')).toContain('ノートを読んでいるとき');
  });

  it('ボタンが在れば、同じ 18 件が押せる(灰色が「在るのに押せない」になっていない)', () => {
    const env = setup();
    for (const id of BUTTON_BATCH) mount(env.root, id, { value: 'x' });
    const rows = commandRowsFor(env.root, env.d, env.store, '', null);
    for (const id of BUTTON_BATCH) expect(rows.find((x) => x.id === id)?.ready, id).toBe(true);
  });

  it('`hidden` の中に居るボタンは押せない ── 隠れた切替 / 別のタブへ移った後の予定の欄を「押せます」と言わない', () => {
    // 例外の 2 件(添付 / 今日のノート)以外は、全部この規則に掛かる
    const EXEMPT = ['attach-file', 'open-today'];
    for (const id of BUTTON_BATCH.filter((x) => !EXEMPT.includes(x))) {
      const env = setup();
      mount(env.root, id, { hidden: true, value: 'x' });
      expect(rowOf(env, id)?.ready, `${id}: 隠れているのに押せる顔`).toBe(false);
      expect(run(env, id), `${id}: 隠れているのに走った`).toBe(false);
      expect(env.sent, `${id}: 隠れた物が動いた`).toEqual([]);
      // 対照群:同じボタンを隠さなければ押せる(隠した効果であることを見る)
      const ok = setup();
      mount(ok.root, id, { value: 'x' });
      expect(rowOf(ok, id)?.ready, `${id}: 隠さなくても押せない(対照群が崩れている)`).toBe(true);
    }
    // ⚠ 例外:添付 / 今日は閉じたメニューの中にも同じボタンが居る ── 隠れたメニューの物でも撃てる
    for (const id of EXEMPT) {
      const env = setup();
      mount(env.root, id, { hidden: true });
      expect(rowOf(env, id)?.ready, `${id}: 閉じたメニューの中の物は押せる`).toBe(true);
    }
  });

  it('「選択範囲をコピー」は登記したが、押しボタンは受け手にしない(選択が消えると押せないので、控えた字を読む特例 ── tests/adapter/palette-copy-selection.test.ts)', () => {
    expect(findCommand('copy-selection-md')).not.toBeNull();
    expect(SHORTCUT_BUTTON['copy-selection-md']).toBeUndefined();
  });

  it('編集中は、ボタンの理由(押せない理由)をそのまま言う', () => {
    const env = setup();
    const b = mount(env.root, 'clear-entry-date') as HTMLButtonElement;
    b.disabled = true;
    b.setAttribute('data-pkc-blocked', '編集中です。保存かキャンセルをしてください');
    const r = rowOf(env, 'clear-entry-date');
    expect(r?.ready).toBe(false);
    expect(r?.why).toContain('編集中です');
  });
});

describe('③ 欄が先に要る 4 件:空なら欄へ移り、字が入っていれば押す', () => {
  it.each(Object.keys(FIELD_FIRST))('%s', (id) => {
    const env = setup();
    const btn = mount(env.root, id, { value: '' });
    let pressed = 0;
    btn.addEventListener('click', () => pressed++);
    expect(run(env, id)).toBe(true);
    const field = env.root.querySelector<HTMLElement>(`[data-pkc-field="${FIELD_FIRST[id]}"]`);
    expect(pressed, `${id}: 欄が空なのにボタンを押した(「入力してください」の空振りになる)`).toBe(0);
    expect(document.activeElement, `${id}: 欄に焦点が入っていない`).toBe(field);
    expect(env.said.length, `${id}: 何も言わない`).toBe(1);
    expect(env.said[0]).toContain(findCommand(id)?.label ?? '?');

    // 対照群:字が入っていれば押す
    const env2 = setup();
    const btn2 = mount(env2.root, id, { value: 'あ' });
    let pressed2 = 0;
    btn2.addEventListener('click', () => pressed2++);
    expect(run(env2, id)).toBe(true);
    expect(pressed2).toBe(1);
  });

  it.each(Object.keys(FIELD_FIRST))('%s: 別の面に同名の空の欄が先に居ても、押したボタンと同じ親の欄を見る', (id) => {
    // 予定の面は左のタブと中央の 2 つ在りうる ── 先に描かれた空の欄を読むと、字が入っているのに欄へ移ってしまう
    const env = setup();
    const decoy = document.createElement('input');
    decoy.setAttribute('data-pkc-field', FIELD_FIRST[id]!);
    env.root.append(decoy);
    const btn = mount(env.root, id, { value: 'あ' });
    let pressed = 0;
    btn.addEventListener('click', () => pressed++);
    expect(run(env, id)).toBe(true);
    expect(pressed, `${id}: 別の面の空の欄を読んで、ボタンを押さなかった`).toBe(1);
  });

  it.each([
    ['add-tag', 'inspector'],
    ['add-relation', 'inspector'],
    ['append-entry', 'append'],
  ] as const)('%s: 畳んでいる %s は、欄へ移る前に戻す(見えない欄に焦点を入れて無反応にしない)', (id, pane) => {
    const env = setup();
    const shell = document.createElement('div');
    shell.setAttribute('data-pkc-region', 'shell');
    env.root.append(shell);
    try {
      applyPaneVisibility(env.root, appPanes.setHidden([pane]));
      expect(appPanes.getHidden(), '前提:畳んである').toContain(pane);
      mount(env.root, id, { value: '' });
      expect(run(env, id)).toBe(true);
      expect(appPanes.getHidden(), `${pane} が畳んだまま`).not.toContain(pane);
      expect(shell.getAttribute('data-pkc-hidden-panes') ?? '').not.toContain(pane);
    } finally {
      applyPaneVisibility(env.root, appPanes.setHidden([]));
    }
    // 対照群:予定の欄は畳む対象が無いので、保存値に触らない
    const env2 = setup();
    applyPaneVisibility(env2.root, appPanes.setHidden(['sidebar']));
    try {
      mount(env2.root, 'schedule-quick-add', { value: '' });
      expect(run(env2, 'schedule-quick-add')).toBe(true);
      expect(appPanes.getHidden(), '予定の欄が左の列の畳みを触った').toEqual(['sidebar']);
    } finally {
      applyPaneVisibility(env2.root, appPanes.setHidden([]));
    }
  });
});
