/** @vitest-environment happy-dom */
/**
 * 🔴 **一覧の `F2` / 右クリックの「名前を変える」でも、添付はファイル名が題名に揃う**(#1220 F2)。
 *
 * 直す前:添付の画面の改名欄は題名とダウンロードのファイル名を一緒に変えるが、一覧の `F2` /
 * 右クリックは**題名だけ**で、ファイル名(拡張子を除く部分)は旧いまま残っていた。
 *
 * 守る主張:
 * 1. 左の列の行の改名(右クリック / `F2` → `row-rename`)で、添付なら `新題名.pdf` に揃う(拡張子は保つ)
 * 2. 2 ペインの `F2`(`dual-rename`)でも同じ
 * 3. 🔴 **添付でないノートは今までどおり題名だけ**(本文を 1 回も書かない)── 対照群
 * 4. 題名が動かない確定(同じ字 / 空白だけ)では、ファイル名の書込を撃たない
 * 5. 🔴 **改名欄と F2 が同じ関数を通る**(撃つ action の並びが同じ / binder に直撃の行が残っていない)
 *
 * ⚠ 台は実物(shell + 描画器 + binder + effect 層)で組む ── 「欄が撃つ」と「受け手が書く」の
 *   合意は、片方の test には書けない(CLAUDE.md §7)。期待値は手で組んだ原文から作る。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, archetype: EntryMeta['archetype'], title: string, order: number): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 手で組んだ原文(`attachmentBody` を通さない)。 */
const ATT = [
  '---',
  'attachment.name: scan.pdf',
  'attachment.mime: application/pdf',
  'attachment.size: 12345',
  'attachment.asset_key: ast-keep-me',
  '---',
  '',
  '説明です。',
  '',
].join('\n');

const METAS = [meta('att', 'attachment', 'scan', 1), meta('txt', 'text', 'メモ', 2)];

let unbind: (() => void) | null = null;
beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});
afterEach(() => {
  unbind?.();
  unbind = null;
  document.body.textContent = '';
});

interface Rig {
  root: HTMLElement;
  d: Dispatcher;
  pane: HTMLElement;
  region: HTMLElement;
  disk: Record<string, string>;
  renames: { lid: string; title: string }[];
  persists: EntryUpsert[];
  types: string[];
}

function setup(): Rig {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  const region = document.createElement('div');
  root.append(region);
  const dual = new DualFilerRenderer(region);
  d.onState((s) => {
    browse.render(s, 'filer');
    detail.render(s);
    dual.render(s);
  });
  unbind = bindActions(root, d, {
    setBrowse: () => browse.render(d.getState(), 'filer'),
  });
  const types: string[] = [];
  const orig = d.dispatch.bind(d);
  d.dispatch = ((a: Parameters<typeof orig>[0]) => {
    types.push(a.type);
    return orig(a);
  }) as typeof d.dispatch;
  const disk: Record<string, string> = { att: ATT, txt: 'メモの本文\n' };
  const renames: { lid: string; title: string }[] = [];
  const persists: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? '',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (lid, title) => {
      renames.push({ lid, title });
      return stubStamps();
    },
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persists.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')?.click();
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  return { root, d, pane, region, disk, renames, persists, types };
}

const key = (el: Element, k: string): void => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};

/** 左の列の行で名前を打ち替えて Enter(右クリックの「名前を変える」/ `F2` と同じ確定)。 */
async function renameRow(r: Rig, lid: string, text: string): Promise<void> {
  r.d.dispatch({ type: 'ROW_RENAME_BEGIN', lid });
  const input = r.pane.querySelector<HTMLInputElement>('[data-pkc-field="row-rename"]');
  expect(input, '行の改名欄が出ていない(前提が崩れている)').not.toBeNull();
  input!.value = text;
  key(input!, 'Enter');
  await tick();
}

/** 2 ペインの `F2` で名前を打ち替えて Enter。 */
async function renameDual(r: Rig, lid: string, text: string): Promise<void> {
  r.d.dispatch({ type: 'DUAL_RENAME_BEGIN', side: 'left', lid });
  const input = r.region.querySelector<HTMLInputElement>(
    '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-field="dual-rename"]',
  );
  expect(input, '2 ペインの改名欄が出ていない(前提が崩れている)').not.toBeNull();
  input!.value = text;
  key(input!, 'Enter');
  await tick();
}

const ALIGNED = ATT.replace('attachment.name: scan.pdf', 'attachment.name: 請求書.pdf');

describe('🔴 左の列の改名(右クリック / F2)で、添付はファイル名も揃う', () => {
  it('題名は renameEntry、ファイル名は attachment.name の 1 行だけ(拡張子は保つ・ほかは 1 byte も動かない)', async () => {
    const r = setup();
    await renameRow(r, 'att', '請求書');
    expect(r.d.getState().entryMetas.get('att')?.title).toBe('請求書');
    expect(r.renames, '題名が disk へ届いていない').toEqual([{ lid: 'att', title: '請求書' }]);
    expect(r.persists, 'ファイル名の書込が 1 回でない').toHaveLength(1);
    expect(r.persists[0]!.body).toBe(ALIGNED);
    // 古い題名で戻さない
    expect(r.persists[0]!.title).toBe('請求書');
    // 知らせは添付の画面の改名欄と同じ字
    expect(r.d.getState().notice).toBe('ファイル名を scan.pdf → 請求書.pdf にしました');
  });

  it('🔴 対照群:添付でないノートは題名だけ(本文を 1 回も書かない)', async () => {
    const r = setup();
    await renameRow(r, 'txt', '新しいメモ');
    expect(r.renames).toEqual([{ lid: 'txt', title: '新しいメモ' }]);
    expect(r.persists, '添付でないのに本文を書いた').toHaveLength(0);
    expect(r.disk.txt).toBe('メモの本文\n');
    expect(r.types).not.toContain('SET_ATTACHMENT_NAME');
  });

  it.each([['同じ字', 'scan'], ['空白だけ', '   ']])(
    '題名が動かない確定(%s)では、ファイル名の書込を撃たない',
    async (_name, text) => {
      const r = setup();
      await renameRow(r, 'att', text);
      expect(r.renames).toEqual([]);
      expect(r.persists, '題名が動かないのに本文を書いた').toHaveLength(0);
      expect(r.types).not.toContain('SET_ATTACHMENT_NAME');
    },
  );
});

describe('🔴 2 ペインの F2 でも同じ', () => {
  it('添付: ファイル名が題名に揃う', async () => {
    const r = setup();
    await renameDual(r, 'att', '請求書');
    expect(r.renames).toEqual([{ lid: 'att', title: '請求書' }]);
    expect(r.persists).toHaveLength(1);
    expect(r.persists[0]!.body).toBe(ALIGNED);
  });

  it('🔴 対照群:添付でないノートは題名だけ', async () => {
    const r = setup();
    await renameDual(r, 'txt', '新しいメモ');
    expect(r.renames).toEqual([{ lid: 'txt', title: '新しいメモ' }]);
    expect(r.persists).toHaveLength(0);
  });
});

describe('🔴 改名欄と F2 は同じ関数を通る(判定・書き換えを 2 か所に書かない)', () => {
  it('撃つ action の並びが、添付の画面の改名欄と F2 で同じ(題名 → ファイル名)', async () => {
    const pick = (types: string[]): string[] =>
      types.filter((t) => t === 'RENAME_ENTRY_TITLE' || t === 'SET_ATTACHMENT_NAME');
    // F2(左の列)
    const f2 = setup();
    await renameRow(f2, 'att', '請求書');
    // 添付の画面の改名欄
    const field = setup();
    field.d.dispatch({ type: 'SELECT_ENTRY', lid: 'att' });
    await tick(40);
    const input = field.root.querySelector<HTMLInputElement>('[data-pkc-action="rename-attachment"]');
    expect(input, '改名欄が出ていない(前提が崩れている)').not.toBeNull();
    input!.value = '請求書';
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(pick(f2.types)).toEqual(['RENAME_ENTRY_TITLE', 'SET_ATTACHMENT_NAME']);
    expect(pick(field.types)).toEqual(pick(f2.types));
    // 結果の本文も同じ
    expect(field.persists.at(-1)!.body).toBe(f2.persists.at(-1)!.body);
  });

  it('binder は SET_ATTACHMENT_NAME を直に撃たず、1 本の関数(attachment-rename.ts)だけを呼ぶ', () => {
    const src = readFileSync('src/adapter/ui/actions/binder.ts', 'utf8');
    // 注釈を落としてから数える(自分の解説に満たされない)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'binder が題名とファイル名を 2 か所で撃っている').not.toContain(
      "type: 'SET_ATTACHMENT_NAME'",
    );
    expect(code).toContain('renameAttachmentAndFile(dispatcher, lid, title)');
    // F2 の 2 経路(左の列 / 2 ペイン)がどちらも通る
    const rowCommit = /const commitRowRename = [^{]*\{([\s\S]*?)\n {2}\};/.exec(code)?.[1] ?? '';
    const dualCommit = /const commitDualRename = [^{]*\{([\s\S]*?)\n {2}\};/.exec(code)?.[1] ?? '';
    expect(rowCommit, '左の列の確定を取り出せていない(前提が崩れている)').not.toBe('');
    expect(dualCommit, '2 ペインの確定を取り出せていない(前提が崩れている)').not.toBe('');
    expect(rowCommit).toContain('renameEntryFromRow(dispatcher, lid, value)');
    expect(dualCommit).toContain('renameEntryFromRow(dispatcher, lid, value)');
  });
});
