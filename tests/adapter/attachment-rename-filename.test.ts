/** @vitest-environment happy-dom */
/**
 * 🔴 **添付の画面の改名欄は、題名と一緒にダウンロードのファイル名も変える**
 * (#1220 穴②、裁定 A)。
 *
 * 守る主張:
 * 1. 題名は `renameEntry`(本文に触らない口)、ファイル名は本文の `attachment.name:` の
 *    **1 行だけ**(`persistEntry`)── 他の行・説明は 1 byte も動かない
 * 2. 🔴 **書く直前に disk から読み直す**(画面が持つ本文を基底にしない)
 * 3. `attachment.name` を持たない本文には**書かない**(対照群)
 * 4. ファイル名だけ書けなかったときは、題名を戻さず**ファイル名のことだけ**言う
 * 5. 畳みの 1 行が指す欄は、**描いた欄の字**から引いて実在する
 *
 * ⚠ 期待値は手で組んだ原文から作る(実装の規則を test 側で書き直さない)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';
import { ATTACHMENT_FOLD_NOTE } from '../../src/features/flavor/attachment-edit-fold';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, archetype: EntryMeta['archetype'], title: string): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
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

interface Persist {
  entry: EntryUpsert;
  expectHash: string | undefined;
}

function setup(
  initial: string,
  o: { archetype?: EntryMeta['archetype']; conflict?: boolean } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const disk = { body: initial };
  const renames: { lid: string; title: string }[] = [];
  const persists: Persist[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => disk.body,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (lid, title) => {
      renames.push({ lid, title });
      return stubStamps();
    },
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      persists.push({ entry: e, expectHash: opts?.expectHash });
      if (o.conflict === true) return { ...stubStamps(), conflict: true };
      disk.body = e.body;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', o.archetype ?? 'attachment', 'scan.pdf')],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, disk, renames, persists, q };
}

/** 画面で名前の欄に打って、欄の外を押す(`change`)。 */
async function typeName(r: ReturnType<typeof setup>, text: string): Promise<void> {
  r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await tick(20);
  const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]');
  expect(input, '改名欄が出ていない(前提が崩れている)').not.toBeNull();
  input!.value = text;
  input!.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(30);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('題名と一緒にファイル名が変わる', () => {
  it('🔴 題名は renameEntry、ファイル名は attachment.name の 1 行だけ(ほかは 1 byte も動かない)', async () => {
    const r = setup(ATT);
    await typeName(r, '請求書');
    expect(r.renames, '題名が変わっていない').toEqual([{ lid: 'a', title: '請求書' }]);
    expect(r.persists, 'ファイル名の書込が 1 回でない').toHaveLength(1);
    const written = r.persists[0]!;
    // 期待値は原文の 1 行を手で差し替えた物(mime / size / asset_key / 説明は原文のまま)
    expect(written.entry.body).toBe(
      ATT.replace('attachment.name: scan.pdf', 'attachment.name: 請求書.pdf'),
    );
    // 題名は新しい字のまま書かれる(古い題名で戻さない)
    expect(written.entry.title).toBe('請求書');
    // 読んだ本文と同じ版へ書く(別の窓が書いていたら断る門)
    expect(written.expectHash).toBe(contentHash64Hex(ATT));
  });

  it('画面の「ダウンロード」の名前も、書いた後の本文で新しい名前になる', async () => {
    const r = setup(ATT);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    expect(r.q('[data-pkc-action="download-asset"]')!.getAttribute('data-pkc-asset-name')).toBe(
      'scan.pdf',
    );
    await typeName(r, '請求書');
    expect(r.q('[data-pkc-action="download-asset"]')!.getAttribute('data-pkc-asset-name')).toBe(
      '請求書.pdf',
    );
  });

  it('使えない字は _ になって書かれる / 同じ拡張子で終えれば二重に付かない', async () => {
    const r = setup(ATT);
    await typeName(r, '年度/末:請求書.pdf');
    expect(r.persists[0]!.entry.body).toContain('attachment.name: 年度_末_請求書.pdf\n');
    // 題名のほうは打った字のまま(拡張子も使えない字も触らない)
    expect(r.renames[0]!.title).toBe('年度/末:請求書.pdf');
  });

  it('🔴 別の拡張子で終えても、元の拡張子を付け直す(題名は打った字のまま)', async () => {
    const r = setup(ATT);
    await typeName(r, '請求書.txt');
    expect(r.persists[0]!.entry.body).toContain('attachment.name: 請求書.txt.pdf\n');
    expect(r.renames[0]!.title).toBe('請求書.txt');
  });
});

describe('🔴 書く直前に disk から読み直す(画面の本文を基底にしない)', () => {
  it('別の窓が説明を足し、名前を変えていても、それが残る(拡張子も disk の名前から決まる)', async () => {
    const r = setup(ATT);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    // 画面が描いた後に、別の窓が disk を書き換えた
    r.disk.body = ATT.replace('scan.pdf', 'moved.zip') + '別の窓が足した行\n';
    const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!;
    input.value = '請求書';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(30);
    expect(r.persists).toHaveLength(1);
    expect(r.persists[0]!.entry.body).toBe(
      ATT.replace('attachment.name: scan.pdf', 'attachment.name: 請求書.zip') + '別の窓が足した行\n',
    );
  });
});

describe('🔴 attachment.name を持たない本文には書かない(対照群)', () => {
  it('ファイルを持たないリンクのタイル: 題名は変わるが、本文は 1 回も書かれない', async () => {
    const tile = '---\nattachment.launcher_url: https://example.com\n---\n';
    const r = setup(tile);
    await typeName(r, 'リンク集');
    expect(r.renames).toEqual([{ lid: 'a', title: 'リンク集' }]);
    expect(r.persists, '設定の行を生やす書込が走った').toHaveLength(0);
    expect(r.disk.body).toBe(tile);
    // 黙って終わる(知らせを出さない)
    expect(r.d.getState().error ?? null).toBeNull();
  });

  it('対照群:同じ手順で attachment.name を持つ本文は書かれる(前提が空振りでない)', async () => {
    const r = setup(ATT);
    await typeName(r, 'リンク集');
    expect(r.persists).toHaveLength(1);
  });
});

describe('ファイル名だけ書けなかったとき', () => {
  it('🔴 別の窓が先に書いていた(衝突): 題名は戻さず、ファイル名のことだけ言う', async () => {
    const r = setup(ATT, { conflict: true });
    await typeName(r, '請求書');
    expect(r.persists).toHaveLength(1);
    expect(r.d.getState().entryMetas.get('a')!.title, '題名まで戻った').toBe('請求書');
    const error = r.d.getState().error ?? '';
    expect(error).toContain('ファイル名は変えられませんでした');
  });

  it('編集中の同じノートでは書かず、ファイル名を変えられないことを言う', async () => {
    const r = setup(ATT);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    r.q('[data-pkc-action="start-edit"]')!.click();
    await tick(20);
    r.d.dispatch({ type: 'SET_ATTACHMENT_NAME', lid: 'a', name: '請求書' });
    await tick(30);
    expect(r.persists).toHaveLength(0);
    expect(r.d.getState().error ?? '').toContain('ファイル名を変えてください');
  });
});

describe('畳みの 1 行は、実在する欄を指す', () => {
  it('🔴 1 行の中の「…」を、描いた改名欄の字(aria-label)から引いて突き合わせる', async () => {
    const r = setup(ATT);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    const label = r
      .q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!
      .getAttribute('aria-label');
    expect(label, '改名欄に字が無い').toBeTruthy();
    // 期待値を手で書かない ── 1 行から「…」を全部抜き、どれかが欄の字と一致すること
    const quoted = [...ATTACHMENT_FOLD_NOTE.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    expect(quoted.length, '畳みの 1 行が欄を名指ししていない').toBeGreaterThan(0);
    expect(quoted, `画面に無い欄を指している: ${quoted.join(' / ')}`).toContain(label);
  });
});
