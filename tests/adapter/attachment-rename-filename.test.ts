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
  o: { archetype?: EntryMeta['archetype']; conflict?: boolean; title?: string; busy?: boolean } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  d.onState((s) => detail.render(s));
  bindActions(root, d, { busy: () => o.busy === true });
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
    metas: [meta('a', o.archetype ?? 'attachment', o.title ?? 'scan.pdf')],
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

/** 撃たれた SET_ATTACHMENT_NAME を数える(効果層は同じ本文を書かないので、**撃ったか**はここでしか見えない)。 */
function spySetName(r: ReturnType<typeof setup>): { count: () => number } {
  let n = 0;
  const orig = r.d.dispatch.bind(r.d);
  r.d.dispatch = ((a: Parameters<typeof orig>[0]) => {
    if (a.type === 'SET_ATTACHMENT_NAME') n += 1;
    return orig(a);
  }) as typeof r.d.dispatch;
  return { count: () => n };
}

/** 欄を開いて(打たずに)確定する。`how` = 欄を離れる(blur)/ Enter。 */
async function commitUntouched(r: ReturnType<typeof setup>, how: 'blur' | 'enter'): Promise<HTMLInputElement> {
  r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await tick(20);
  const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]');
  expect(input, '改名欄が出ていない(前提が崩れている)').not.toBeNull();
  if (how === 'blur') input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  else input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(30);
  return input!;
}

describe('🔴 字が同じでも、欄を確定すればファイル名が題名に揃う(#1264 §1)', () => {
  // 前提:一覧の F2 で題名だけ「請求書」に変えた後(ファイル名は scan.pdf のまま)
  it.each(['blur', 'enter'] as const)('食い違っていれば揃える(%s)── 題名は変えず、ファイル名の 1 行だけ', async (how) => {
    const r = setup(ATT, { title: '請求書' });
    await commitUntouched(r, how);
    expect(r.renames, '題名は動かしていない').toEqual([]);
    expect(r.persists, 'ファイル名の書込が 1 回でない').toHaveLength(1);
    expect(r.persists[0]!.entry.body).toBe(
      ATT.replace('attachment.name: scan.pdf', 'attachment.name: 請求書.pdf'),
    );
  });

  it.each(['blur', 'enter'] as const)('🔴 対照群:すでに揃っていれば何も書かない(%s)', async (how) => {
    // 題名 `scan` / ファイル名 `scan.pdf` は揃っている(拡張子を除いた部分が同じ)
    const r = setup(ATT, { title: 'scan' });
    const spy = spySetName(r);
    await commitUntouched(r, how);
    expect(spy.count(), '揃っているのにファイル名の書換を撃った').toBe(0);
    expect(r.persists, '揃っているのに書いた(欄を離れるたびに書いている)').toHaveLength(0);
    expect(r.renames).toEqual([]);
  });

  it('🔴 冪等:続けて何度離れても書くのは 1 回(描き直しが来る前でも)', async () => {
    const r = setup(ATT, { title: '請求書' });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    const spy = spySetName(r);
    const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!;
    // ⚠ 描き直しが来る前に続けて撃つ(Enter → 欄を離れる → もう一度 Enter)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(spy.count(), '描き直しが来る前に離れるたび撃っている').toBe(1);
    await tick(40);
    expect(r.persists).toHaveLength(1);
    // 描き直しの後でも、もう一度離れて 1 回のまま
    r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true }),
    );
    await tick(30);
    expect(r.persists).toHaveLength(1);
  });

  it('🔴 揃っている欄に、字が変わらない change が来ても書かない(門は受け口の側にも在る)', async () => {
    const r = setup(ATT, { title: 'scan' });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    const spy = spySetName(r);
    const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(30);
    expect(spy.count(), '揃っているのにファイル名の書換を撃った').toBe(0);
    expect(r.persists, '揃っているのに書いた').toHaveLength(0);
    expect(r.renames).toEqual([]);
  });

  it('🔴 字を打ち替えた回は、change と blur が続いても 1 回だけ(二重に書かない)', async () => {
    const r = setup(ATT);
    await typeName(r, '請求書');
    const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!;
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await tick(30);
    expect(r.persists).toHaveLength(1);
    expect(r.renames).toEqual([{ lid: 'a', title: '請求書' }]);
  });

  it('🔴 日本語入力の変換を確定する Enter では撃たない(変換中は isComposing)── 確定後の Enter だけが確定', async () => {
    const r = setup(ATT, { title: '請求書' });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    const spy = spySetName(r);
    const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    await tick(30);
    expect(spy.count(), '変換の確定の Enter でファイル名を書いた').toBe(0);
    expect(r.persists).toHaveLength(0);
    // 対照群:同じ欄で、変換中でない Enter は撃つ(前提が空振りでない)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: false, bubbles: true }));
    await tick(30);
    expect(spy.count()).toBe(1);
    expect(r.persists).toHaveLength(1);
  });

  it('🔴 取り込み・書き出しの最中でも、揃っている欄を離れただけでは「実行中です」と言わない(食い違うときだけ断る)', async () => {
    // 揃っている ── 門を通さない(通すと、何も書かないのに断りの知らせが出る)
    const aligned = setup(ATT, { title: 'scan', busy: true });
    await commitUntouched(aligned, 'blur');
    expect(aligned.d.getState().error ?? '', '揃っているのに断りが出た').toBe('');
    // 対照群:食い違っていれば、他の書込と同じ門で断る(書込は走らない)
    const differs = setup(ATT, { title: '請求書', busy: true });
    await commitUntouched(differs, 'blur');
    expect(differs.d.getState().error ?? '').toContain('実行中');
    expect(differs.persists).toHaveLength(0);
  });

  it('ファイルを持たないタイル(いまのファイル名が無い)は、離れても何も書かない', async () => {
    const tile = '---\nattachment.launcher_url: https://example.com\n---\n';
    const r = setup(tile, { title: 'リンク集' });
    await commitUntouched(r, 'blur');
    expect(r.persists).toHaveLength(0);
  });
});

describe('🔴 ファイル名が変わった回は、元と新しい名前を状態の行へ言う(#1264 §1)', () => {
  it('食い違いを揃えた回: 「ファイル名を scan.pdf → 請求書.pdf にしました」(打っていなくても無言にしない)', async () => {
    const r = setup(ATT, { title: '請求書' });
    await commitUntouched(r, 'blur');
    expect(r.persists).toHaveLength(1);
    expect(r.d.getState().notice).toBe('ファイル名を scan.pdf → 請求書.pdf にしました');
  });

  it('対照群:すでに揃っていて名前が変わらない回は何も言わない', async () => {
    const r = setup(ATT, { title: 'scan' });
    await commitUntouched(r, 'blur');
    expect(r.persists).toHaveLength(0);
    expect(r.d.getState().notice ?? null, '変わっていないのに知らせた').toBeNull();
  });

  it('対照群:書けなかった回(別の窓が先に書いていた)に「にしました」と言わない', async () => {
    const r = setup(ATT, { title: '請求書', conflict: true });
    await commitUntouched(r, 'blur');
    expect(r.persists).toHaveLength(1);
    expect(r.d.getState().notice ?? null).toBeNull();
    expect(r.d.getState().error ?? '').toContain('ファイル名は変えられませんでした');
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
  it('🔴 1 行の中の「…」を、描いた改名欄の左の見える字(label)から引いて突き合わせる', async () => {
    const r = setup(ATT);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    const label = r.q<HTMLLabelElement>('[data-pkc-field="attachment-rename-label"]');
    expect(label, '改名欄の左に見える字が無い').not.toBeNull();
    const shown = label!.textContent;
    // 期待値を手で書かない ── 1 行から「…」を全部抜き、どれかが画面の字と一致すること
    const quoted = [...ATTACHMENT_FOLD_NOTE.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    expect(quoted.length, '畳みの 1 行が欄を名指ししていない').toBeGreaterThan(0);
    expect(quoted, `画面に無い欄を指している: ${quoted.join(' / ')}`).toContain(shown);
  });
});

describe('🔴 改名欄に、見える label と、下にダウンロードのファイル名(#1264 欠陥 7-b)', () => {
  async function shown(initial = ATT, title = 'scan') {
    const r = setup(initial, { title });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    const input = r.q<HTMLInputElement>('[data-pkc-action="rename-attachment"]');
    expect(input, '改名欄が出ていない(前提が崩れている)').not.toBeNull();
    const label = r.q<HTMLLabelElement>('[data-pkc-field="attachment-rename-label"]');
    const hint = r.q<HTMLElement>('[data-pkc-field="attachment-rename-hint"]');
    return { r, input: input!, label, hint };
  }

  it('欄の左に見える字「名前」が在り、label の for が欄の id に結ばれている', async () => {
    const { r, input, label } = await shown();
    expect(label, 'label 要素が無い').not.toBeNull();
    expect(label!.tagName).toBe('LABEL');
    expect(label!.textContent).toBe('名前');
    // 結び ── for が指す id が、欄そのもの(別の要素ではない)
    expect(label!.htmlFor, 'label の for が空').not.toBe('');
    expect(input.id).toBe(label!.htmlFor);
    expect(r.root.querySelector(`#${CSS.escape(label!.htmlFor)}`)).toBe(input);
    // label は欄と同じ行(欄の直前の兄弟)に在る ── 欄の下や別の所ではない
    expect(label!.nextElementSibling).toBe(input);
    // 欄の名前は label から決まる(見える字と聞こえる字が割れない)
    expect(input.hasAttribute('aria-label'), 'aria-label が見える字を上書きしている').toBe(false);
  });

  it('欄の下に「ダウンロードのファイル名: 請求書.pdf」(いまの値から組む)', async () => {
    const { hint } = await shown(ATT, '請求書');
    expect(hint, '下の 1 行が無い').not.toBeNull();
    expect(hint!.textContent).toBe('ダウンロードのファイル名: 請求書.pdf');
  });

  it('🔴 欄を打ち替えると追従する(拡張子は元のまま足される / 使えない字は _)', async () => {
    const { input, hint } = await shown();
    expect(hint!.textContent).toBe('ダウンロードのファイル名: scan.pdf');
    input.value = '見積書';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(hint!.textContent).toBe('ダウンロードのファイル名: 見積書.pdf');
    input.value = '年度/末';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(hint!.textContent).toBe('ダウンロードのファイル名: 年度_末.pdf');
    // 空にすると元の名前のまま(書く側と同じ規則 ── 空の名前を出さない)
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(hint!.textContent).toBe('ダウンロードのファイル名: scan.pdf');
  });

  it('欄は下の 1 行を説明として指す / ファイルを持たないタイルには下の 1 行を出さない(組む元が無い)', async () => {
    const { input, hint } = await shown();
    expect(input.getAttribute('aria-describedby')).toBe(hint!.id);
    const tile = await shown('---\nattachment.launcher_url: https://example.com\n---\n', 'リンク集');
    expect(tile.hint, '組む元の無いタイルに出ている').toBeNull();
    // 対照群:欄と label は出る(前提が空振りでない)
    expect(tile.label).not.toBeNull();
  });

  it('同じ添付を 2 枚描いても id が重ならない(留めた枠)', async () => {
    const a = await shown();
    const b = await shown();
    expect(a.input.id).not.toBe(b.input.id);
  });
});
