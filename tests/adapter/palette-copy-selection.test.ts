/** @vitest-environment happy-dom */
/**
 * 🔴 **「選択範囲をコピー」を「操作を探す」から呼ぶ**(#582 段③。🟣 Gemini の回答 = #1163 の依頼 22 の Q3 = A)。
 *
 * 第 1 群で見送った理由は「一覧を開いた瞬間に、読む面の選択が消える」だった。
 * 解いたのは、開く前に選択を**字として**控え、選んだらその字をコピーすること。
 *
 * 守るもの(どれも外すと落ちる形にしてある ── 変異は報告に書いた):
 *  ① 選択してから開いて選ぶと、**開く前の選択**が Markdown の原文のままコピーされる
 *  ② 一覧を開いている間に選択が消えても(実ブラウザでは開いた瞬間に消える)、控えた字がコピーされる
 *  ③ 選択が無いまま開くと、その行は灰色 + 理由「本文の中を選択してから呼んでください」
 *  ④ 閉じたら控えは捨てる ── 次に開かずに呼んでも(左の `>` の一覧 / 鍵)コピーされない
 *  ⑤ 控えているのは字であって、描き直しで消える節点を持たない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions, commandRowsFor, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';
import * as clipboard from '../../src/adapter/platform/clipboard';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

const tick = async (ms = 10): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

const DOC = 'あいう**かき**くけこ\n\n次の段落です。';

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  const store = new KeymapStore();
  bindActions(root, d, {}, store);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => DOC,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  return { root, d, store };
}

/** 読む面の「い」から <strong> を跨いで「く」までを選ぶ(原文では `いう**かき**く`)。 */
function selectInBody(root: HTMLElement): void {
  const p = root.querySelector('[data-pkc-field="detail-body"] p')!;
  const r = document.createRange();
  r.setStart(p.firstChild!, 1);
  r.setEnd(p.lastChild!, 1);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

const rowOf = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')].find(
    (b) => b.getAttribute('data-pkc-command') === 'copy-selection-md',
  );
const openPalette = async (root: HTMLElement): Promise<void> => {
  root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
  await tick();
};
const cancel = async (): Promise<void> => {
  document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
  await tick();
};
const listRow = (e: ReturnType<typeof setup>) =>
  commandRowsFor(e.root, e.d, e.store, '', null).find((r) => r.id === 'copy-selection-md');

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
  document.getSelection()?.removeAllRanges();
});
afterEach(() => {
  spy.mockRestore();
  document.getSelection()?.removeAllRanges();
});

describe('「選択範囲をコピー」を「操作を探す」から呼ぶ(#582 段③ Q3 = A)', () => {
  it('① 選択してから開いて選ぶと、開く前の選択が Markdown の原文でコピーされる', async () => {
    const e = setup();
    await tick(30);
    selectInBody(e.root);
    await openPalette(e.root);
    const row = rowOf();
    expect(row, '一覧に行が無い').toBeDefined();
    expect(row!.disabled, '選択してあるのに灰色').toBe(false);
    row!.click();
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0], '原文(記号つき)でコピーされていない').toBe('いう**かき**く');
  });

  it('② 一覧を開いている間に選択が消えても、控えた字がコピーされる(実ブラウザは開いた瞬間に消える)', async () => {
    const e = setup();
    await tick(30);
    selectInBody(e.root);
    await openPalette(e.root);
    // 実ブラウザで起きること ── 一覧が開くと読む面の選択は消える
    document.getSelection()!.removeAllRanges();
    expect(rowOf()!.disabled, '選択が消えた後に灰色になった(開いた瞬間に控えていない)').toBe(false);
    rowOf()!.click();
    await tick();
    expect(spy.mock.calls[0]![0]).toBe('いう**かき**く');
  });

  it('③ 選択が無いまま開くと、行は灰色 + 理由「本文の中を選択してから呼んでください」。押しても何も起きない', async () => {
    const e = setup();
    await tick(30);
    await openPalette(e.root);
    const row = rowOf();
    expect(row, '一覧に行が無い(隠している)').toBeDefined();
    expect(row!.disabled).toBe(true);
    const why = row!.querySelector('[data-pkc-field="palette-why"]')?.textContent ?? '';
    expect(why).toBe(`${NOT_READY_PREFIX}本文の中を選択してから呼んでください`);
    row!.click();
    await tick();
    expect(spy).not.toHaveBeenCalled();
    // 対照群:選択を作って開き直すと押せる(上の灰色が選択の有無で決まっていること)
    await cancel();
    selectInBody(e.root);
    await openPalette(e.root);
    expect(rowOf()!.disabled, '対照群が崩れている(選択があっても灰色)').toBe(false);
  });

  it('④ 閉じたら控えは捨てる ── 開かずに呼んでも(左の `>` の一覧 / 鍵)コピーされない', async () => {
    const e = setup();
    await tick(30);
    selectInBody(e.root);
    await openPalette(e.root);
    expect(listRow(e)?.ready, '前提が崩れている(開いている間は控えが見える)').toBe(true);
    await cancel();
    expect(listRow(e)?.ready, '閉じたのに控えが残っている').toBe(false);
    expect(runGlobalCommand('copy-selection-md', e.root, e.d, e.store, () => {}, () => {})).toBe(false);
    await tick();
    expect(spy).not.toHaveBeenCalled();
    // 選んで閉じた場合も同じ
    selectInBody(e.root);
    await openPalette(e.root);
    rowOf()!.click();
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(listRow(e)?.ready, '選んだ後に控えが残っている').toBe(false);
  });

  it('④b 左の `>` の一覧では、選択を控えられないので灰色。理由は呼べる道を言う', () => {
    const e = setup();
    const r = listRow(e);
    expect(r?.ready).toBe(false);
    expect(r?.why).toContain(`${NOT_READY_PREFIX}本文の中を選択してから呼んでください`);
    expect(r?.why, '左の一覧の理由は「操作を探す」から呼ぶ道を言う').toContain('操作を探す');
  });

  it('⑤ 控えているのは字 ── 本文が描き直されて選択の節点が消えても、コピーされる', async () => {
    const e = setup();
    await tick(30);
    selectInBody(e.root);
    await openPalette(e.root);
    // 開いている間に本文が描き直される(節点が作り直される)
    e.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: DOC + '\n\n追記。' });
    await tick(30);
    rowOf()!.click();
    await tick();
    expect(spy.mock.calls[0]![0]).toBe('いう**かき**く');
  });
});
