/** @vitest-environment happy-dom */
/**
 * 🔴 **添付ノートの編集は、設定の行(`attachment.*`)を畳んで説明だけ書かせる**
 * (#1220 穴②)。
 *
 * 報告:添付ノートを「ノートを編集する」で開くと、`attachment.name / mime / size /
 * asset_key` の行がそのまま編集欄に出て、1 文字消すだけで種類が変わり画面の見せ方が
 * 変わった(穴①の入り口)。
 *
 * ⚠ 期待値は**実際の原文**(`attachmentBody` が作った本文)から切り出す ── 畳む関数の
 *   出力を期待値にすると、同じ誤りを共有する(CLAUDE.md §1「同じ文法の別の綴り」)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { foldAttachmentHead, joinHiddenHead } from '../../src/features/flavor/attachment-edit-fold';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, archetype: EntryMeta['archetype']): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const HEAD = attachmentBody({
  name: '報告 書.pdf',
  mime: 'application/pdf',
  size: 12345,
  assetKey: 'ast-keep-me',
});
const DESC = '最初の説明です。\n\n二段落目。\n';
/**
 * ⚠ **`attachmentBody` が作る本文は、閉じの `---` で終わる(末尾の改行なし)**。
 *   取り込んだだけの添付はこの形 ── 説明を書くと、閉じの次の行から始まる。
 */
const HEAD_NL = HEAD + '\n';
const ORIG = HEAD_NL + DESC;

function setup(body: string, archetype: EntryMeta['archetype'] = 'attachment') {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  // ⚠ 位置引数 ── `region, assets, markdown, onBodyChange`(4 番目)。live は
  //   本文の書込を `onBodyChange` で外へ返すので、アプリと同じ配線を再現する
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => body,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', archetype)], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, persisted, q };
}

/** 編集を開く(帯の「ノートを編集する」と同じ口 ── 押して開く)。 */
async function openEdit(r: ReturnType<typeof setup>): Promise<void> {
  r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  await tick(20);
  r.q('[data-pkc-action="start-edit"]')!.click();
  await tick(20);
}

afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

describe('畳む / 戻す の純関数(features/flavor/attachment-edit-fold)', () => {
  it('🔴 head + rest は常に原文と一致する(LF・CRLF・空行・末尾の改行なし)', () => {
    const cases: Record<string, string> = {
      LF: ORIG,
      CRLF: ORIG.replace(/\n/g, '\r\n'),
      '閉じの直後が空行': HEAD_NL + '\n' + DESC,
      '説明が空(閉じの改行あり)': HEAD_NL,
      '閉じで本文が終わる(取り込んだだけの添付の形)': HEAD,
      '先頭の開きの直後が空行': '---\n\nattachment.name: a.pdf\n---\n説明',
    };
    for (const [name, body] of Object.entries(cases)) {
      const f = foldAttachmentHead(body);
      expect(f, `${name}: 畳めていない`).not.toBeNull();
      expect(f!.head + f!.rest, `${name}: 原文と一致しない`).toBe(body);
      // 畳んだ側に説明が混ざっていない / 説明の側に設定が残っていない
      expect(f!.rest, `${name}: 設定の行が欄に残った`).not.toContain('attachment.');
    }
  });

  it('畳めない本文は null(情報の塊が無い / 読めていない塊は出して直せるようにする)', () => {
    expect(foldAttachmentHead('')).toBeNull();
    expect(foldAttachmentHead('# ただの本文\n')).toBeNull();
    expect(foldAttachmentHead('---\nattachment.name: a.pdf\n本文(閉じが無い)\n')).toBeNull();
    // 先頭の `---` が水平線なだけの普通の文書
    expect(foldAttachmentHead('---\n\n本文\n')).toBeNull();
  });

  it('joinHiddenHead: 説明が空なら畳んだ側そのまま / 改行なしの塊には改行を 1 つだけ足す', () => {
    expect(joinHiddenHead(HEAD_NL, '')).toBe(HEAD_NL);
    expect(joinHiddenHead(HEAD_NL, '新')).toBe(HEAD_NL + '新');
    const bare = HEAD;
    expect(joinHiddenHead(bare, '')).toBe(bare); // 説明を書かないなら 1 byte も変わらない
    expect(joinHiddenHead(bare, '新')).toBe(bare + '\n新'); // 閉じの --- にくっつけない
  });
});

describe('🔴 2 列の編集(設定 split)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });

  it('編集欄に attachment. が出ず、畳んだことが 1 行で言われ、説明は出る', async () => {
    const r = setup(ORIG);
    await openEdit(r);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value).toBe(DESC);
    expect(ta.value).not.toContain('attachment.');
    expect(r.q('[data-pkc-region="editor-split"]')!.textContent ?? '').not.toContain('attachment.');
    const note = r.q('[data-pkc-field="attachment-fold-note"]');
    expect(note, '畳んだことが言われていない').not.toBeNull();
    expect(note!.textContent).toContain('説明だけ');
  });

  it('🔴 説明を書いて保存すると、設定の行は 1 byte も変わらず、説明だけ入れ替わる', async () => {
    const r = setup(ORIG);
    await openEdit(r);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '書き直した説明。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 打っている最中の state も、設定の行を持ったまま
    expect(r.d.getState().openBody?.body).toBe(HEAD_NL + '書き直した説明。\n');
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted).toHaveLength(1);
    // ⚠ 期待値は**元の原文の頭**(`attachmentBody` が作った物)── 畳む関数の出力ではない
    expect(r.persisted[0]!.body).toBe(ORIG.slice(0, ORIG.indexOf('最初の説明')) + '書き直した説明。\n');
    expect(r.persisted[0]!.body.startsWith(HEAD_NL)).toBe(true);
  });

  it('🔴 取り込んだだけの添付(説明なし・閉じの改行なし)に説明を書いても、閉じの --- に付かない', async () => {
    const r = setup(HEAD);
    await openEdit(r);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value).toBe('');
    // 何も打たずに保存 ── 設定の行へ 1 byte も触らない(書かない)
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted).toHaveLength(0);
    // 打てば、閉じの次の行から入る
    r.q('[data-pkc-action="start-edit"]')!.click();
    await tick(20);
    const ta2 = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta2.value = '初めての説明';
    ta2.dispatchEvent(new Event('input', { bubbles: true }));
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted).toHaveLength(1);
    expect(r.persisted[0]!.body).toBe(HEAD + '\n初めての説明');
  });

  it('説明を全部消しても、設定の行は残る(欄が空 = 設定だけの本文)', async () => {
    const r = setup(ORIG);
    await openEdit(r);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted).toHaveLength(1);
    expect(r.persisted[0]!.body).toBe(HEAD_NL);
  });

  it('何も打たずに保存しても書かない(変わっていないのに設定の行を書き直さない)', async () => {
    const r = setup(ORIG);
    await openEdit(r);
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted).toHaveLength(0);
  });

  it('CRLF の原文でも、設定の行の改行は 1 byte も変わらない', async () => {
    const crlf = ORIG.replace(/\n/g, '\r\n');
    const r = setup(crlf);
    await openEdit(r);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '新\r\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted[0]!.body).toBe(crlf.slice(0, crlf.indexOf('最初の説明')) + '新\r\n');
  });

  it('🔴 「ここから編集」の行は、畳んだぶんをずらさずに説明の中の行へ当たる', async () => {
    const desc = ['# 題', '', '前置き', '', '## 決定事項', '', '内容', ''].join('\n');
    const r = setup(HEAD_NL + desc);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(20);
    // ⚠ 行は frontmatter を外した側の数え方(説明の 5 行目 = index 4)
    r.d.dispatch({ type: 'START_EDIT', atLine: 4 });
    await tick(20);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value.slice(ta.selectionStart).startsWith('## 決定事項'), 'ずれた行が開いた').toBe(
      true,
    );
  });

  it('🔴 畳んだ塊に書いた文書の寄せ(align)も、プレビューには届く(畳んでも見え方が変わらない)', async () => {
    const withAlign = '---\nattachment.name: a.pdf\nalign: right\n---\n説明\n';
    const r = setup(withAlign);
    await openEdit(r);
    await tick(30);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value).toBe('説明\n'); // 畳んでいる(前提)
    expect(
      r.q('[data-pkc-region="editor-preview"]')!.getAttribute('data-pkc-doc-align'),
      '畳んだ側の宣言がプレビューに届いていない',
    ).toBe('right');
  });

  it('対照群:普通のノートの情報の塊は畳まない(今までどおり欄に出る)', async () => {
    const text = '---\ntags: [あ]\n---\n本文\n';
    const r = setup(text, 'text');
    await openEdit(r);
    expect(r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!.value).toBe(text);
    expect(r.q('[data-pkc-field="attachment-fold-note"]')).toBeNull();
    expect(r.q('[data-pkc-field="editor-body"]')!.hasAttribute('data-pkc-hidden-head')).toBe(
      false,
    );
  });

  it('対照群:情報の塊が無い添付(説明だけ)は何も畳まない', async () => {
    const r = setup('説明だけ\n', 'attachment');
    await openEdit(r);
    expect(r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!.value).toBe('説明だけ\n');
    expect(r.q('[data-pkc-field="attachment-fold-note"]')).toBeNull();
  });
});

describe('🔴 1 画面の編集(既定)', () => {
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'live');
  });

  it('札に設定の行も「情報を編集」も出ず、畳んだことが 1 行で言われる', async () => {
    const r = setup(ORIG);
    await openEdit(r);
    const card = r.q('[data-pkc-region="live-frontmatter"]')!;
    expect(card.textContent).toContain('説明だけ');
    expect(card.textContent ?? '').not.toContain('attachment.');
    // ⚠ 札の「情報を編集」は設定の行を原文のまま開く ── 穴になるので置かない
    expect(card.querySelector('[data-pkc-field="fm-edit"]'), '編集の口が残っている').toBeNull();
    expect(card.querySelector('[data-pkc-field="fm-source"]')).toBeNull();
    expect(r.q('[data-pkc-region="editor-live"]')!.textContent ?? '').not.toContain('attachment.');
    expect(r.q('[data-pkc-region="editor-live"]')!.textContent).toContain('最初の説明です');
  });

  it('🔴 「全文を編集」でも設定の行は出ず、確定すると設定の行は 1 byte も変わらない', async () => {
    const r = setup(ORIG);
    await openEdit(r);
    r.q<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta.value).not.toContain('attachment.');
    ta.value = '全文を書き直した';
    ta.blur();
    await tick(20);
    expect(r.d.getState().openBody?.body).toBe(HEAD_NL + '全文を書き直した\n'); // 末尾の改行は元の本文の物(行の差し替えの規則)
    r.q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(r.persisted[0]!.body.startsWith(HEAD_NL)).toBe(true);
    expect(r.persisted[0]!.body).toBe(ORIG.slice(0, ORIG.indexOf('最初の説明')) + '全文を書き直した\n');
  });

  it('🔴 行ごとに編集できない説明(退避)でも設定の行は出ず、打っても戻る', async () => {
    // 行ごとの分割が組めない本文(`live-editor.test.ts` の退避と同じ形)
    const desc = [':::figure{id="あ い"}', '', '本文', '', ':::', '', 'あと', ''].join('\n');
    const r = setup(HEAD_NL + desc);
    await openEdit(r);
    await tick(20);
    const ta = r.q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta, '退避の欄が出ていない(前提が崩れている)').not.toBeNull();
    expect(ta!.value, '退避の欄に設定の行が出た').toBe(desc);
    expect(r.q('[data-pkc-field="attachment-fold-note"]'), '畳んだ 1 行が消えた').not.toBeNull();
    ta!.value = desc + '追記\n';
    ta!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(r.d.getState().openBody?.body).toBe(HEAD_NL + desc + '追記\n');
  });

  it('対照群:普通のノートの札には今までどおり「情報を編集」が出る', async () => {
    const r = setup('---\ntags: [あ]\n---\n本文\n', 'text');
    await openEdit(r);
    const card = r.q('[data-pkc-region="live-frontmatter"]')!;
    expect(card.querySelector('[data-pkc-field="fm-edit"]')).not.toBeNull();
    expect(card.querySelector('[data-pkc-field="attachment-fold-note"]')).toBeNull();
  });
});
