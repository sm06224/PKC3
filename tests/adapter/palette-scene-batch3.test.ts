/** @vitest-environment happy-dom */
/**
 * 🔴 **「打っている場所に入れる」操作を「操作を探す」から呼ぶ**(#582 段③ 第 3 群。第 1・2 群は
 * `palette-scene-batch.test.ts` / `palette-scene-batch2.test.ts`、同じ作法)。
 *
 * ## 何が起きていたか
 *
 * 一覧を閉じた直後の本文の欄は、器が焦点を返す瞬間に選択が `0,0` へ戻っている。画面のボタン(日付 / ノートリンク /
 * テンプレート / 図 / アイコン)は**押した瞬間の `selectionStart` を読む**ので、戻さずに押すと**本文の先頭**に入る。
 * 実ブラウザで `hello world` の 5 字目から「日付を入れる」を呼ぶと `@2026-10-12hello world` になった
 * (1 面の行・2 列の欄とも。`insert-date` / `insert-snippet` は第 1 群から登記済みで、同じ穴を持っていた)。
 *
 * ## 守るもの(どれも「壊れたら鳴る」形にしてある)
 *  ① **範囲を戻してから押す**:caret が途中 → そこへ入る / 選んだ範囲 → 図は囲み、他は置き換えず caret の位置へ(ボタンの作りどおり)。
 *     ⚠ 焦点が返る瞬間に選択が `0,0` になる形を**手で作る**(happy-dom には競合が無い ── 作らないとこの次元を 1 度も通らない)。
 *  ② **小窓をまたいでも**(日付 / ノート / 図 / アイコンは自分の小窓を開く)先頭に入らない。
 *  ③ **欄が消えていたら押さない**(組み直された別の欄の先頭へ入れない)。
 *  ④ **押せないときは灰色 + 理由**・字は画面のボタンの字と同じ・鍵なし。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import {
  bindActions,
  CARET_TOOLS,
  commandRowsFor,
  runGlobalCommand,
  SHORTCUT_BUTTON,
} from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';
import { KEY_COMMANDS, findCommand } from '../../src/features/keymap';

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
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** 登記した 2 件(受け手 = 書式の帯のボタン)と、前から在って同じ穴を持っていた 3 件。 */
const NEW2 = ['insert-diagram', 'insert-icon'] as const;
const OLD3 = ['insert-date', 'insert-entry-link', 'insert-snippet'] as const;
const ALL5 = [...NEW2, ...OLD3];

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d, {}, new KeymapStore());
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも'), meta('n2', '議事録')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  sent.length = 0;
  return { root, d, sent };
}

/** 編集の面を 1 つ作る:本文の欄(`detail` の中)と、書式の帯の 5 つのボタン。 */
function editing(root: HTMLElement, text: string, start: number, end: number) {
  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', 'editor-body');
  ta.value = text;
  detail.append(ta);
  for (const id of ALL5) {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', id);
    detail.append(b);
  }
  root.append(detail);
  ta.focus();
  ta.setSelectionRange(start, end);
  return ta;
}

const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const rows = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')];
const rowOf = (id: string): HTMLButtonElement | undefined =>
  rows().find((b) => b.getAttribute('data-pkc-command') === id);

/** 「操作を探す」を開いて、その行を選ぶ。⚠ 開いたあと**焦点が返る瞬間の選択の潰れ**を手で作る。 */
async function pickFromPalette(root: HTMLElement, ta: HTMLTextAreaElement, id: string, collapse = true): Promise<void> {
  root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
  await tick();
  expect(rowOf(id), `${id} が一覧に出ていない`).toBeDefined();
  expect(rowOf(id)!.disabled, `${id} が灰色(本文の欄に居るのに押せない)`).toBe(false);
  // 焦点が返る瞬間に `0,0` へ戻る(実ブラウザで測った)── 手で作る
  if (collapse) ta.setSelectionRange(0, 0);
  rowOf(id)!.click();
  await tick();
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('④ 登記:2 件が一覧に居る(押しボタン = 命令 id、鍵なし、字は画面と同じ)', () => {
  const FORMAT_BAR = 'src/adapter/ui/render/format-bar.ts';

  it('KEY_COMMANDS に在り、鍵を持たず、受け手は押しボタン(id = data-pkc-action)', () => {
    for (const id of NEW2) {
      const c = findCommand(id);
      expect(c, `${id} が KEY_COMMANDS に無い`).not.toBeNull();
      expect(c?.defaults, `${id} に鍵が付いている`).toEqual([]);
      expect(c?.contexts, `${id} は全域`).toEqual(['global']);
      expect((c?.note ?? '').length, `${id} に説明(押せない理由を兼ねる)が無い`).toBeGreaterThan(0);
      expect(SHORTCUT_BUTTON[id], `${id} の受け手が無い`).toBe(`[data-pkc-action="${id}"]`);
    }
    expect(new Set(KEY_COMMANDS.map((c) => c.id)).size).toBe(KEY_COMMANDS.length);
  });

  it('字は、帯のボタンを組んでいる所の近くの字と同じ(source から引く ── 手で書いた期待値にしない)', () => {
    const src = readFileSync(FORMAT_BAR, 'utf-8');
    for (const id of NEW2) {
      const label = findCommand(id)?.label ?? '';
      const at = [...src.matchAll(new RegExp(`['"]${id}['"]`, 'g'))].map((m) => m.index!);
      expect(at.length, `${id}: 帯にボタンを組む所が無い`).toBeGreaterThan(0);
      const near = at.some((i) => src.slice(i, i + 700).includes(`'${label}'`));
      expect(near, `${id}: ボタンを組む所の近くに「${label}」が無い(画面の字と違う)`).toBe(true);
    }
  });

  it('「打っている場所に入れる」5 つは全部 CARET_TOOLS に居る(範囲を戻す門の集合 = 1 本)', () => {
    for (const id of ALL5) expect(CARET_TOOLS.has(id), `${id} が CARET_TOOLS に無い`).toBe(true);
  });

  it('押せないときは灰色 + 理由:ボタンが無い / 隠れている / disabled', () => {
    const { root, d } = setup();
    const store = new KeymapStore();
    const rowFor = (id: string) => commandRowsFor(root, d, store, '', null).find((r) => r.id === id);
    for (const id of NEW2) {
      const r = rowFor(id);
      expect(r, `${id} が一覧に無い`).toBeDefined();
      expect(r?.ready, `${id}: ボタンが無いのに押せる顔`).toBe(false);
      expect(r?.why.startsWith(NOT_READY_PREFIX), `${id}: 理由が無い`).toBe(true);
      expect(r?.why, `${id}: 場面の言葉が理由に無い`).toContain('本文の整形バーが出ているとき');
    }
    // 対照群:ボタンを組めば押せる。隠せば押せない。disabled も押せない
    const wrap = document.createElement('div');
    for (const id of NEW2) {
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', id);
      wrap.append(b);
    }
    root.append(wrap);
    for (const id of NEW2) expect(rowFor(id)?.ready, `${id}: 在るのに押せない`).toBe(true);
    wrap.hidden = true;
    for (const id of NEW2) expect(rowFor(id)?.ready, `${id}: 隠れているのに押せる顔`).toBe(false);
    wrap.hidden = false;
    wrap.querySelector<HTMLButtonElement>('[data-pkc-action="insert-icon"]')!.disabled = true;
    expect(rowFor('insert-icon')?.ready).toBe(false);
    expect(rowFor('insert-diagram')?.ready).toBe(true);
  });
});

describe('① 範囲を戻してから押す(焦点が返る瞬間に選択が 0,0 になっても、開いたときの位置へ入る)', () => {
  it('🔴 アイコンを入れる:caret が途中 → そこへ入る(小窓をまたいでも先頭に入らない)', async () => {
    const { root } = setup();
    const ta = editing(root, 'hello world', 5, 5);
    await pickFromPalette(root, ta, 'insert-icon');
    const pick = document.querySelector<HTMLElement>('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]');
    expect(pick, 'アイコンの小窓が開いていない').not.toBeNull();
    const name = pick!.getAttribute('data-pkc-icon-name') ?? '';
    expect(name, '押した物の名前が読めない(前提)').not.toBe('');
    // 小窓が開いている間に、また選択が潰れる(焦点が小窓へ移る)
    ta.setSelectionRange(0, 0);
    pick!.click();
    await tick();
    expect(ta.value, '先頭に入っている(範囲を戻していない)').toBe(`hello:${name}: world`);
  });

  it('🔴 図を入れる:選んだ範囲があれば、一覧を出さずにその範囲を図の囲みにする(他の字は動かない)', async () => {
    const { root } = setup();
    const ta = editing(root, 'あいうえお', 1, 4);
    await pickFromPalette(root, ta, 'insert-diagram');
    expect(document.querySelector('[data-pkc-field="pick-diagram"]'), '選んでいるのに種類を聞いている').toBeNull();
    expect(ta.value.startsWith('あ'), '先頭の字が動いた(先頭から囲んでいる)').toBe(true);
    expect(ta.value.endsWith('お') || ta.value.endsWith('お\n'), '末尾の字が動いた').toBe(true);
    expect(ta.value, '選んだ範囲が図の囲みの中に無い').toMatch(/```mermaid\nいうえ\n```/u);
  });

  it('🔴 図を入れる:caret が途中なら、種類を選んだあとそこへ入る', async () => {
    const { root } = setup();
    const ta = editing(root, 'hello world', 5, 5);
    await pickFromPalette(root, ta, 'insert-diagram');
    const pick = document.querySelector<HTMLElement>('[data-pkc-field="pick-diagram"]');
    expect(pick, '図の種類の小窓が開いていない').not.toBeNull();
    ta.setSelectionRange(0, 0);
    pick!.click();
    await tick();
    expect(ta.value.startsWith('hello'), '先頭に入っている(範囲を戻していない)').toBe(true);
    expect(ta.value, '図が入っていない').toContain('```mermaid');
    expect(ta.value.endsWith('world') || ta.value.endsWith('world\n'), '後ろの字が動いた').toBe(true);
  });

  it('🔴 日付を入れる(前から登記済み・同じ穴):caret が途中 → そこへ入る', async () => {
    const { root } = setup();
    const ta = editing(root, 'hello world', 5, 5);
    await pickFromPalette(root, ta, 'insert-date');
    const sc = document.querySelector<HTMLElement>('[data-pkc-field="pick-shortcut"]');
    expect(sc, '日付の小窓が開いていない').not.toBeNull();
    sc!.click();
    ta.setSelectionRange(0, 0);
    dialog()!.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')?.click();
    await tick();
    expect(ta.value, '先頭に入っている(範囲を戻していない)').toMatch(/^hello @\d{4}-\d{2}-\d{2} world$/u);
  });

  it('🔴 ノートリンクを入れる(前から登記済み・同じ穴):caret が途中 → そこへ入る', async () => {
    const { root } = setup();
    const ta = editing(root, 'hello world', 5, 5);
    await pickFromPalette(root, ta, 'insert-entry-link');
    const row = document.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="n2"]');
    expect(row, 'ノートを選ぶ小窓が開いていない').not.toBeNull();
    ta.setSelectionRange(0, 0);
    row!.click();
    await tick();
    expect(ta.value.startsWith('hello'), '先頭に入っている(範囲を戻していない)').toBe(true);
    expect(ta.value, 'リンクが入っていない').toContain('議事録');
    expect(ta.value.endsWith('world'), '後ろの字が動いた').toBe(true);
  });

  it('対照群:範囲を戻す門が無ければ先頭に入る(= この test の台は「潰れる瞬間」を作れている)', async () => {
    // 戻さずに画面のボタンを押す(パレットを通らない)と、潰れた位置 0 に入る ── 台が穴を再現していることを示す
    const { root } = setup();
    const ta = editing(root, 'hello world', 5, 5);
    ta.setSelectionRange(0, 0);
    expect(runGlobalCommand('insert-icon', root, new Dispatcher(), new KeymapStore(), () => {}, () => {}), '前提:押せる').toBe(true);
    await tick();
    const pick = document.querySelector<HTMLElement>('[data-pkc-field="pick-body-icon"] button[data-pkc-icon-name]');
    const name = pick!.getAttribute('data-pkc-icon-name') ?? '';
    pick!.click();
    await tick();
    expect(ta.value, '潰れた位置(先頭)に入るはず').toBe(`:${name}:hello world`);
  });
});

describe('③ 欄が消えていたら押さない(別の欄の先頭へ入れない)', () => {
  it.each([...ALL5])('%s:控えた欄が外れたら、小窓も開かず理由を出す', async (id) => {
    const { root, sent } = setup();
    const ta = editing(root, 'hello world', 5, 5);
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    expect(rowOf(id)).toBeDefined();
    // 待っている間に面ごと組み直された形:同じ綴りの新しい欄(選択は先頭)と帯が出来る
    ta.closest('[data-pkc-region="detail"]')!.remove();
    const again = editing(root, 'hello world', 0, 0);
    sent.length = 0;
    rowOf(id)!.click();
    await tick();
    const failed = sent.find((a) => a.type === 'OP_FAILED');
    expect(failed, `${id}: 無言で終えた`).toBeDefined();
    const msg = failed?.type === 'OP_FAILED' ? failed.error : '';
    expect(msg, `${id}: 断り文が空`).not.toBe('');
    expect(msg).toContain('欄');
    expect(again.value, `${id}: 別の欄へ書き込んだ`).toBe('hello world');
    expect(document.querySelector('[data-pkc-region="app-dialog"][open] [data-pkc-field^="pick-"]'), `${id}: 小窓を開いた`).toBeNull();
  });
});
