/** @vitest-environment happy-dom */
/**
 * 🔴 **名前で呼べなかった「高」の 26 件を「操作を探す」に足した**(#582 段③ 第 2 群。第 1 群は
 * `palette-scene-batch.test.ts`、同じ作法)。
 *
 * 守るもの(どれも「壊れたら鳴る」形にしてある):
 *  ① **命令 = 画面のボタン**:一覧から呼ぶと、そのボタンが 1 回押され、直接押したときと同じ dispatch 列になる。
 *  ② **押せないときは灰色 + 理由の 1 行**:ボタンが無い間 / `hidden` の中 / `disabled`。
 *  ③ **欄が先に要る 3 件**(置換・連絡先・リンク)は、欄が空なら欄へ移り、字が入っていれば押す。
 *  ④ **字は画面のボタンの字と同じ**(source から引く ── 期待値を手で書かない)。
 *  ⑤ **鍵は付けない**・命令 id は押しボタンの `data-pkc-action` と同じ綴り。
 *  ⑥ **特例 2 件**:`open-system-notices`(押しボタンが無い ── ヘルプの押し口と同じ実体)/ `dual-tab-add`(焦点の側)。
 *  ⑦ **足さなかった 1 件**(第 3 群で他の 2 件は登記した)は登記されていない(実ブラウザで撃てないと測った理由が消えるまで)。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';
import { KEY_COMMANDS, findCommand } from '../../src/features/keymap';
import { DB_CHECK_LABEL } from '../../src/features/storage/rescue-labels';

interface Row {
  readonly id: string;
  /** 画面のボタンの字が書いてある source。 */
  readonly source: string;
  /** 一覧の字の代わりに source に在るべき字(画面の字が組み立てだったり、頭の語だけが同じ物)。 */
  readonly screenText?: string;
  /** 「押せない間」の理由に含まれるべき場面の言葉。 */
  readonly scene: string;
  /** 欄が先に要る物の欄(`data-pkc-field`)。 */
  readonly field?: string;
}

const R = 'src/adapter/ui/render/';
const BATCH2: readonly Row[] = [
  { id: 'run-sql', source: R + 'sql.ts', scene: 'SQL の画面を開いているとき' },
  { id: 'sql-er-toggle', source: R + 'sql.ts', scene: 'SQL の画面を開いているとき' },
  { id: 'sql-schema-to-note', source: R + 'sql.ts', scene: 'SQL の画面を開いているとき' },
  { id: 'sql-to-note', source: R + 'sql.ts', scene: 'SQL の画面を開いていて、結果が出ているとき' },
  { id: 'renumber-lists', source: R + 'format-bar.ts', scene: '本文の整形バーが出ているとき' },
  { id: 'sort-tasks', source: R + 'format-bar.ts', scene: '本文の整形バーが出ているとき' },
  { id: 'start-audio-capture', source: R + 'shell.ts', scene: 'ノートを開いていないとき' },
  { id: 'start-screen-capture', source: R + 'shell.ts', scene: 'ノートを開いていないとき' },
  { id: 'start-timer', source: R + 'shell.ts', scene: 'ノートを開いていないとき' },
  { id: 'clear-selection', source: R + 'filer.ts', scene: '2 件以上選んでいるとき' },
  { id: 'show-trash', source: R + 'filer.ts', scene: 'ゴミ箱が閉じているとき' },
  { id: 'hide-trash', source: R + 'filer.ts', scene: 'ゴミ箱を開いているとき' },
  { id: 'replace-all', source: R + 'shell.ts', scene: '置換の欄を開いているとき', field: 'replace-find' },
  { id: 'search-jump-next', source: R + 'search-jump.ts', scene: '一致した所を巡っているとき' },
  { id: 'search-jump-prev', source: R + 'search-jump.ts', scene: '一致した所を巡っているとき' },
  { id: 'dual-tab-add', source: R + 'dual-filer.ts', screenText: 'にタブを足す', scene: '2 ペインを開いていて' },
  { id: 'clear-kind-filter', source: R + 'kind-bar.ts', scene: '種類で絞っているとき' },
  { id: 'toggle-filer-flatten', source: R + 'filer.ts', scene: 'フォルダの一覧を開いているとき' },
  { id: 'db-check', source: R + 'commands.ts', screenText: 'textContent = DB_CHECK_LABEL', scene: '「保存領域」を開いているとき' },
  { id: 'storage-profile', source: R + 'commands.ts', scene: '「保存領域」を開いているとき' },
  { id: 'contacts-quick-add', source: R + 'contacts.ts', scene: '連絡先の画面を開いているとき', field: 'contacts-quick-name' },
  { id: 'export-vcards', source: R + 'contacts.ts', scene: '連絡先の画面を開いていて' },
  { id: 'open-system-notices', source: R + 'help.ts', scene: '「設定」のボタンが出ているとき' },
  { id: 'add-url-tile', source: R + 'launcher.ts', scene: 'アプリの画面を開いているとき', field: 'launcher-add-url' },
  { id: 'pc-pick-folder', source: R + 'pc-folder.ts', scene: 'PC のフォルダの画面を開いているとき' },
  { id: 'hide-history', source: R + 'detail.ts', scene: 'ノートの履歴を開いているとき' },
];
/** 押しボタンが無い / 引き方が特別な 2 件(⑥)。 */
const SPECIAL = ['open-system-notices', 'dual-tab-add'];
const PLAIN = BATCH2.filter((r) => !SPECIAL.includes(r.id));
const FIELD_FIRST = BATCH2.filter((r) => r.field !== undefined);

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
function mount(root: HTMLElement, row: Row, opts: { value?: string; hidden?: boolean } = {}): HTMLButtonElement {
  const wrap = document.createElement('div');
  if (opts.hidden === true) wrap.hidden = true;
  if (row.field !== undefined) {
    const input = document.createElement('input');
    input.setAttribute('data-pkc-field', row.field);
    input.value = opts.value ?? '';
    wrap.append(input);
  }
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', row.id);
  wrap.append(b);
  root.append(wrap);
  return b;
}

function setup(editing = false) {
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', '議事録')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  if (editing) {
    // ⚠ 編集に入れるのは「本文が読めている選択中のノート」だけ ── 3 手要る
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
    if (d.getState().phase !== 'editing') throw new Error('前提が崩れている(編集に入れていない)');
  }
  sent.length = 0;
  return { root, d, sent, said, store };
}

/** 編集中にしか効かない物(置換)は、編集中の台で組む。 */
const ed = (id: string): boolean => id === 'replace-all';
const noop = (): void => {};
const run = (env: ReturnType<typeof setup>, id: string, dry = false): boolean =>
  runGlobalCommand(id, env.root, env.d, env.store, noop, (t) => env.said.push(t), dry);
const rowOf = (env: ReturnType<typeof setup>, id: string) =>
  commandRowsFor(env.root, env.d, env.store, '', null).find((r) => r.id === id);
const shape = (xs: readonly Dispatchable[]): string[] => xs.map((a) => a.type);

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('第 2 群 26 件の登記(#582 段③)', () => {
  it('⑤ 全部が KEY_COMMANDS に在り、鍵を持たず、受け手は押しボタン(id = data-pkc-action)', () => {
    expect(BATCH2.length).toBe(26);
    for (const { id } of BATCH2) {
      const c = findCommand(id);
      expect(c, `${id} が KEY_COMMANDS に無い`).toBeDefined();
      expect(c?.defaults, `${id} に鍵が付いている`).toEqual([]);
      expect(c?.contexts, `${id} は全域`).toEqual(['global']);
      expect((c?.note ?? '').length, `${id} に説明(押せない理由を兼ねる)が無い`).toBeGreaterThan(0);
    }
    for (const { id } of PLAIN) {
      expect(SHORTCUT_BUTTON[id], `${id} の受け手(押しボタン)が無い`).toBe(`[data-pkc-action="${id}"]`);
    }
    // 特例 2 件の受け手:お知らせは押しボタンの表に無い(特例で直に呼ぶ)/ 2 ペインは焦点の側に絞る
    expect(SHORTCUT_BUTTON['open-system-notices']).toBeUndefined();
    expect(SHORTCUT_BUTTON['dual-tab-add']).toBe(
      '[data-pkc-region="dual-pane"][data-pkc-focused] [data-pkc-action="dual-tab-add"]',
    );
    expect(new Set(KEY_COMMANDS.map((c) => c.id)).size).toBe(KEY_COMMANDS.length);
  });

  it('⑦ 足さなかった 1 件は登記していない(撃てないと測った理由が残っている間は足さない)', () => {
    // ⚠ 2026-10-12(第 3 群):`insert-diagram` / `insert-icon` は、一覧を開いたときの範囲を戻す経路を足して登記した
    //   (`palette-scene-batch3.test.ts`)。残るのは `dual-delete`(`filer-trash` が同じ実体を通している)だけ。
    for (const id of ['dual-delete']) {
      expect(findCommand(id), `${id} を登記した(理由は operation-unregistered 表)`).toBeNull();
      expect(SHORTCUT_BUTTON[id], `${id} の受け手を足した`).toBeUndefined();
    }
  });

  /**
   * 画面のボタンを**組んでいる所**(その action を属性として置く行の近く)を全部返す。
   * ⚠ file 全体の `includes` にしない ── 別のボタンの字や注釈に満たされて、字が違っても緑になる。
   * 組み方は 4 通り:`setAttribute('data-pkc-action', 'x')` / `action: 'x'` / `iconButton('x', …)` / `button('x', …)`。
   */
  const NEAR = 700;
  const builtAt = (src: string, id: string): string[] => {
    const re = new RegExp(`(?:data-pkc-action['"\`],\\s*|action:\\s*|iconButton\\(\\s*|button\\(\\s*)['"]${id}['"]`, 'g');
    return [...src.matchAll(re)].map((m) => src.slice(Math.max(0, m.index! - NEAR), m.index! + NEAR));
  };

  it('④ 一覧の字は、そのボタンを組んでいる所の近くに在る画面の字と同じ(source から引く ── 手で書いた期待値にしない)', () => {
    for (const r of BATCH2) {
      const label = findCommand(r.id)?.label ?? '';
      expect(label, `${r.id} の字が空`).not.toBe('');
      const src = readFileSync(r.source, 'utf-8');
      const spots = builtAt(src, r.id);
      expect(spots.length, `${r.id}: 画面(${r.source})に、この action のボタンを組む所が無い`).toBeGreaterThan(0);
      const needle = r.screenText ?? label;
      // 組み立てる字(vCard は件数つき / 2 ペインは「左に」「右に」が前に付く / 点検は定数)は語そのもので見る。それ以外は引用符で囲んだ字そのもの
      const loose = r.id === 'export-vcards' || r.id === 'dual-tab-add' || r.id === 'db-check';
      const hit = spots.some((w) => (loose ? w.includes(needle) : w.includes(`'${needle}'`)));
      // 点検のボタンの字は定数から引かれる ── 一覧の字も同じ定数でなければならない
      if (r.id === 'db-check') expect(label, '点検の字が画面の定数と違う').toBe(DB_CHECK_LABEL);
      expect(hit, `${r.id}: そのボタンを組む所の近く(${r.source})に「${needle}」という字が無い`).toBe(true);
    }
  });

  it('④ 空振り防止:近くの字で見る門は、別のボタンの字では満たされない', () => {
    // 同じ file の別のボタンの字(実在する)を、この action の字として渡すと外れる
    const src = readFileSync(R + 'filer.ts', 'utf-8');
    const spots = builtAt(src, 'show-trash');
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.some((w) => w.includes("'ゴミ箱を開く'")), '前提:自分の字は近くに在る').toBe(true);
    expect(spots.some((w) => w.includes("'選択を解除'")), '離れた別のボタンの字に満たされている').toBe(false);
  });

  it('D 欄の綴りと action の綴りは、画面を組む所に在る(binder の表と画面の食い違いで dead click にならない)', () => {
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    for (const r of FIELD_FIRST) {
      // binder の表(PALETTE_FIELD_FIRST)に、この欄の綴りが書いてある
      expect(binder.includes(`'${r.id}': { field: '[data-pkc-field="${r.field}"]'`), `${r.id}: binder の表の欄が違う`).toBe(true);
      // 画面を組む所に、同じ綴りの欄が在る(contacts は `contacts-quick-${field}` + `input('name'` で組む)
      const src = readFileSync(r.source, 'utf-8');
      const literal = new RegExp(`data-pkc-field['"\`],\\s*['"]${r.field}['"]`).test(src) ||
        (src.includes(`'${r.field}'`) && src.includes('data-pkc-field'));
      const m = /^(.+)-(name)$/.exec(r.field!);
      const templated = m !== null && src.includes('`' + m[1] + '-${field}`') && src.includes(`input('${m[2]}'`);
      expect(literal || templated, `${r.id}: 画面(${r.source})に欄 ${r.field} を組む所が無い`).toBe(true);
    }
    // 受け手の action も、画面で置いている(PLAIN は表と綴りが同じ ── ⑤ が見る)
    for (const r of PLAIN) {
      expect(builtAt(readFileSync(r.source, 'utf-8'), r.id).length, `${r.id}: 画面に action の綴りが無い`).toBeGreaterThan(0);
    }
  });

  it('① 一覧から呼ぶと、画面のボタンが 1 回押され、直接押したときと同じ dispatch 列になる', () => {
    for (const r of PLAIN) {
      const viaBtn = setup(ed(r.id));
      const b1 = mount(viaBtn.root, r, { value: 'x' });
      let n1 = 0;
      b1.addEventListener('click', () => n1++);
      b1.click();
      const direct = shape(viaBtn.sent);

      const viaPalette = setup(ed(r.id));
      const b2 = mount(viaPalette.root, r, { value: 'x' });
      let n2 = 0;
      b2.addEventListener('click', () => n2++);
      expect(run(viaPalette, r.id), `${r.id}: 呼べなかった`).toBe(true);
      expect(n2, `${r.id}: ボタンが 1 回押されていない`).toBe(1);
      expect(n1).toBe(1);
      expect(shape(viaPalette.sent), `${r.id}: ボタンを直接押したときと違う`).toEqual(direct);
    }
  });

  it('① 空振り防止:dispatch するはずの物は、本当に何かを dispatch している', () => {
    // ⚠ 「空 = 空」で緑にならないよう、受け手が確実に撃つ物は dispatch 列そのものを見る
    const EXPECT: Readonly<Record<string, string>> = {
      'run-sql': 'RUN_SQL',
      'sql-er-toggle': 'SQL_ER_TOGGLE',
      'clear-selection': 'CLEAR_SELECTION',
      'show-trash': 'SHOW_TRASH',
      'hide-trash': 'HIDE_TRASH',
      'search-jump-next': 'SEARCH_JUMP_STEP',
      'search-jump-prev': 'SEARCH_JUMP_STEP',
      'clear-kind-filter': 'CLEAR_KIND_FILTER',
      'hide-history': 'HIDE_HISTORY',
      'replace-all': 'REPLACE_IN_BODY',
      'start-timer': 'OP_FAILED', // 配線が無い環境では理由を言う(黙らない)
      'start-audio-capture': 'OP_FAILED',
      'start-screen-capture': 'OP_FAILED',
    };
    for (const [id, type] of Object.entries(EXPECT)) {
      const row = BATCH2.find((x) => x.id === id)!;
      const env = setup(ed(id));
      mount(env.root, row, { value: 'x' });
      expect(run(env, id)).toBe(true);
      expect(shape(env.sent), `${id}`).toContain(type);
    }
    // 向きの違う 2 件は引数まで見る(次 = +1 / 前 = −1。入れ替えたら鳴る)
    for (const [id, by] of [['search-jump-next', 1], ['search-jump-prev', -1]] as const) {
      const env = setup();
      mount(env.root, BATCH2.find((x) => x.id === id)!);
      run(env, id);
      expect(env.sent.find((a) => a.type === 'SEARCH_JUMP_STEP'), id).toMatchObject({ by });
    }
  });
});

describe('② 押せないときは灰色 + 理由の 1 行', () => {
  it('ボタンが画面に無い間は、26 件とも押せず、理由は説明の末尾から引く(場面の言葉が出る)', () => {
    const env = setup();
    const rows = commandRowsFor(env.root, env.d, env.store, '', null);
    for (const r of BATCH2) {
      const row = rows.find((x) => x.id === r.id);
      expect(row, `${r.id} が一覧に無い`).toBeDefined();
      expect(row?.ready, `${r.id}: ボタンが無いのに押せる顔`).toBe(false);
      expect(row?.why.startsWith(NOT_READY_PREFIX), `${r.id}: 理由が無い`).toBe(true);
      expect(row?.why, `${r.id}: 場面の言葉が理由に無い`).toContain(r.scene);
      expect(run(env, r.id, true), `${r.id}: dry が真`).toBe(false);
    }
  });

  it('ボタンが在れば、押せるもの(PLAIN 24 件)が押せる(灰色が「在るのに押せない」になっていない)', () => {
    const env = setup(true);
    for (const r of PLAIN) mount(env.root, r, { value: 'x' });
    const rows = commandRowsFor(env.root, env.d, env.store, '', null);
    for (const r of PLAIN) expect(rows.find((x) => x.id === r.id)?.ready, r.id).toBe(true);
  });

  it('`hidden` の中に居るボタンは押せない ── 隠れた切替 / 別のタブへ移った後の面を「押せます」と言わない', () => {
    for (const r of PLAIN) {
      const env = setup(ed(r.id));
      mount(env.root, r, { hidden: true, value: 'x' });
      expect(rowOf(env, r.id)?.ready, `${r.id}: 隠れているのに押せる顔`).toBe(false);
      expect(run(env, r.id), `${r.id}: 隠れているのに走った`).toBe(false);
      expect(env.sent, `${r.id}: 隠れた物が動いた`).toEqual([]);
      // 対照群:同じボタンを隠さなければ押せる(隠した効果であることを見る)
      const ok = setup(ed(r.id));
      mount(ok.root, r, { value: 'x' });
      expect(rowOf(ok, r.id)?.ready, `${r.id}: 隠さなくても押せない(対照群が崩れている)`).toBe(true);
    }
  });

  it('すべて置換は編集中にしか効かない ── 置換の欄が開いたまま残っていても、編集中でなければ灰色(REPLACE_IN_BODY が黙って捨てる)', () => {
    const row = BATCH2.find((x) => x.id === 'replace-all')!;
    const idle = setup(false);
    mount(idle.root, row, { value: 'a' });
    const r = rowOf(idle, 'replace-all');
    expect(r?.ready, '編集中でないのに押せる顔').toBe(false);
    expect(r?.why, '真の理由(編集中に使う)が出ていない').toContain('編集中に');
    expect(run(idle, 'replace-all'), '編集中でないのに走った').toBe(false);
    expect(idle.sent, '編集中でないのに何かを撃った').toEqual([]);
    // 対照群:同じ台で編集に入れば押せて、置換の action が出る
    const editing = setup(true);
    mount(editing.root, row, { value: 'a' });
    expect(rowOf(editing, 'replace-all')?.ready).toBe(true);
    expect(run(editing, 'replace-all')).toBe(true);
    expect(shape(editing.sent)).toContain('REPLACE_IN_BODY');
  });

  it('`disabled` のボタンは押せない(理由はボタン自身が持つ)', () => {
    const env = setup();
    const row = BATCH2.find((x) => x.id === 'sql-to-note')!;
    const b = mount(env.root, row);
    b.disabled = true;
    b.setAttribute('data-pkc-blocked', '編集中です。保存かキャンセルをしてください');
    const r = rowOf(env, 'sql-to-note');
    expect(r?.ready).toBe(false);
    expect(r?.why).toContain('編集中です');
  });
});

describe('③ 欄が先に要る 3 件:空なら欄へ移り、字が入っていれば押す', () => {
  it('3 件(置換の探す語 / 連絡先の名前 / リンクのアドレス)だけが欄を持つ', () => {
    expect(FIELD_FIRST.map((r) => r.id).sort()).toEqual(['add-url-tile', 'contacts-quick-add', 'replace-all']);
  });

  it.each(FIELD_FIRST.map((r) => r.id))('%s', (id) => {
    const row = BATCH2.find((x) => x.id === id)!;
    const env = setup(ed(id));
    const btn = mount(env.root, row, { value: '' });
    let pressed = 0;
    btn.addEventListener('click', () => pressed++);
    expect(run(env, id)).toBe(true);
    const field = env.root.querySelector<HTMLElement>(`[data-pkc-field="${row.field}"]`);
    expect(pressed, `${id}: 欄が空なのにボタンを押した`).toBe(0);
    expect(document.activeElement, `${id}: 欄に焦点が入っていない`).toBe(field);
    expect(env.said.length, `${id}: 何も言わない`).toBe(1);
    expect(env.said[0]).toContain(findCommand(id)?.label ?? '?');

    const env2 = setup(ed(id));
    const btn2 = mount(env2.root, row, { value: 'あ' });
    let pressed2 = 0;
    btn2.addEventListener('click', () => pressed2++);
    expect(run(env2, id)).toBe(true);
    expect(pressed2).toBe(1);
  });

  it.each(FIELD_FIRST.map((r) => r.id))('%s: 別の面に同名の空の欄が先に居ても、押したボタンと同じ親の欄を見る', (id) => {
    const row = BATCH2.find((x) => x.id === id)!;
    const env = setup(ed(id));
    const decoy = document.createElement('input');
    decoy.setAttribute('data-pkc-field', row.field!);
    env.root.append(decoy);
    const btn = mount(env.root, row, { value: 'あ' });
    let pressed = 0;
    btn.addEventListener('click', () => pressed++);
    expect(run(env, id)).toBe(true);
    expect(pressed, `${id}: 別の面の空の欄を読んで、ボタンを押さなかった`).toBe(1);
  });
});

describe('⑥ 特例 2 件', () => {
  it('お知らせを開く:押しボタンが無くても、「システム」を開いてお知らせの節へ送る(ヘルプの押し口と同じ実体)', () => {
    // 前提:ヘルプの押し口を直接押したときの dispatch 列(= 同じ実体の基準)
    const viaHelp = setup();
    const helpBtn = document.createElement('button');
    helpBtn.setAttribute('data-pkc-action', 'open-system-notices');
    viaHelp.root.append(helpBtn);
    const sec1 = document.createElement('section');
    sec1.setAttribute('data-pkc-region', 'settings-notices-section');
    const scroll1 = vi.fn();
    sec1.scrollIntoView = scroll1;
    viaHelp.root.append(sec1);
    helpBtn.click();
    expect(shape(viaHelp.sent), '前提:ヘルプの押し口が「システム」を開く').toContain('SET_VIEW_MODE');
    expect(scroll1).toHaveBeenCalledTimes(1);

    // 「システム」を開く門 = 設定のボタン。無い間 / 押せない間は押せない
    const env = setup();
    expect(rowOf(env, 'open-system-notices')?.ready, '設定のボタンが無いのに押せる顔').toBe(false);
    const gate = document.createElement('button');
    gate.setAttribute('data-pkc-action', 'set-view');
    gate.setAttribute('data-pkc-view', 'settings');
    env.root.append(gate);
    const sec = document.createElement('section');
    sec.setAttribute('data-pkc-region', 'settings-notices-section');
    const scroll = vi.fn();
    sec.scrollIntoView = scroll;
    env.root.append(sec);
    expect(rowOf(env, 'open-system-notices')?.ready).toBe(true);
    expect(run(env, 'open-system-notices')).toBe(true);
    expect(shape(env.sent), '一覧から呼んだ列が、ヘルプの押し口と違う').toEqual(shape(viaHelp.sent));
    expect(scroll, 'お知らせの節へ送っていない').toHaveBeenCalledTimes(1);
  });

  it('タブを足す:焦点の在る側のボタンを押す(左右に同じボタンが居ても、いつも左にならない)', () => {
    const env = setup();
    const mk = (side: 'left' | 'right', focused: boolean): HTMLButtonElement => {
      const pane = document.createElement('div');
      pane.setAttribute('data-pkc-region', 'dual-pane');
      pane.setAttribute('data-pkc-side', side);
      if (focused) pane.setAttribute('data-pkc-focused', '');
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'dual-tab-add');
      b.setAttribute('data-pkc-side', side);
      pane.append(b);
      env.root.append(pane);
      return b;
    };
    mk('left', false);
    mk('right', true);
    expect(run(env, 'dual-tab-add')).toBe(true);
    expect(env.sent.find((a) => a.type === 'DUAL_TAB_ADD'), '焦点の側(右)に足していない').toMatchObject({ side: 'right' });

    // 対照群:焦点の側が無ければ押せない(「左だけ押せる」にしない)
    const none = setup();
    const p = document.createElement('div');
    p.setAttribute('data-pkc-region', 'dual-pane');
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'dual-tab-add');
    b.setAttribute('data-pkc-side', 'left');
    p.append(b);
    none.root.append(p);
    expect(rowOf(none, 'dual-tab-add')?.ready).toBe(false);
  });
});
