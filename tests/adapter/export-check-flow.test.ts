/** @vitest-environment happy-dom */
/**
 * 🔴 **外へ書き出す前の点検の流れ**(#1966 4-5。🟣 Gemini の裁定 = 案 ①)。
 *
 * - 問題が見つかったときだけ、一覧と「このまま書き出す / やめる」を出す(何も無ければ黙って書き出す)
 * - 「やめる」なら書き出さない / 「このまま書き出す」なら書き出す
 * - 確かめるタグはシステムの欄で決める(初期値 private, 社外秘。空なら確かめない)
 * - 全件の書き出しは 200 件ずつ読み、後ろの塊で見つかった物も一覧に出る
 * - 本文を読めない版では点検せずに書き出す
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, EXPORT_CHECK_CHUNK } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { appExportWatchTags, EXPORT_WATCH_TAGS_KEY } from '../../src/adapter/ui/render/export-watch-tags';
import { createExportWatchTagsSection } from '../../src/adapter/ui/render/settings/export-watch-tags';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    bodyChars: null,
  };
}

function setup(bodies: Record<string, string>, opts: { noReader?: boolean } = {}) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const exported: string[] = [];
  const reads: number[] = [];
  bindActions(root, d, {
    ...(opts.noReader === true
      ? {}
      : {
          readBodies: async (lids: readonly string[]) => {
            reads.push(lids.length);
            return new Map(lids.filter((l) => bodies[l] !== undefined).map((l) => [l, bodies[l]!] as const));
          },
        }),
    exportEntryHtml: (lid: string) => exported.push(`html:${lid}`),
    exportEntryMarkdown: (lid: string) => exported.push(`md:${lid}`),
    exportHtml: () => exported.push('html:all'),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: Object.keys(bodies).map((l) => meta(l, `題-${l}`)), relations: [] });
  const press = (action: string, lid?: string): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    if (lid !== undefined) b.setAttribute('data-pkc-entry', lid);
    root.append(b);
    b.click();
  };
  const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-pkc-field="dialog-list"]');
  const answer = (which: 'ok' | 'cancel'): void => {
    const dlg = document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]')!;
    dlg.querySelector<HTMLButtonElement>(`[data-pkc-field="dialog-${which}"]`)!.click();
  };
  return { d, root, exported, reads, press, dialog, answer };
}

beforeEach(() => {
  localStorage.clear();
});

describe('見つかったときだけ確かめる', () => {
  it('🔴 何も無ければ、確認を出さずにそのまま書き出す', async () => {
    const t = setup({ n1: 'ただの本文' });
    t.press('export-entry-html', 'n1');
    await tick();
    expect(t.dialog(), '問題が無いのに確認を出した').toBeNull();
    expect(t.exported).toEqual(['html:n1']);
  });

  it('🔴 確かめるタグ(初期値 社外秘)が付いていれば一覧を出し、「やめる」なら書き出さない', async () => {
    const t = setup({ n1: '本文\n\n#社外秘' });
    t.press('export-entry-html', 'n1');
    await tick();
    expect(t.dialog(), '社外秘が付いているのに確認が出ない').not.toBeNull();
    expect(t.dialog()!.textContent).toContain('タグ「社外秘」が付いたノート: 「題-n1」');
    expect(t.exported, '答える前に書き出した').toEqual([]);
    t.answer('cancel');
    await tick();
    expect(t.exported, '「やめる」なのに書き出した').toEqual([]);
  });

  it('🔴 「このまま書き出す」なら書き出す', async () => {
    const t = setup({ n1: '[x](entry:gone)' });
    t.press('export-entry-html', 'n1');
    await tick();
    expect(t.dialog()!.textContent).toContain('見つからないノートへのリンク 1 か所');
    t.answer('ok');
    await tick();
    expect(t.exported).toEqual(['html:n1']);
  });

  it('⚠ ノート 1 件の Markdown は画像も運ばないので、画像の添付も一覧に出る(閲覧用 HTML では出ない)', async () => {
    const body = '![図](asset:k1)';
    const md = setup({ n1: body });
    md.press('export-entry-markdown', 'n1');
    await tick();
    expect(md.dialog()?.textContent ?? '').toContain('書き出した先では開けない添付へのリンク 1 か所');
    const html = setup({ n1: body });
    html.press('export-entry-html', 'n1');
    await tick();
    expect(html.dialog(), '画像を運ぶ形なのに確認を出した').toBeNull();
    expect(html.exported).toEqual(['html:n1']);
  });
});

describe('確かめるタグの欄', () => {
  it('🔴 空にするとタグは確かめない / 別のタグを入れればそれを確かめる', async () => {
    appExportWatchTags.set('');
    const off = setup({ n1: '#社外秘' });
    off.press('export-entry-html', 'n1');
    await tick();
    expect(off.dialog(), '空にしたのにタグを確かめた').toBeNull();
    appExportWatchTags.set('下書き');
    const on = setup({ n1: '#下書き' });
    on.press('export-entry-html', 'n1');
    await tick();
    expect(on.dialog()?.textContent ?? '').toContain('タグ「下書き」');
  });

  it('🔴 システムの欄: 初期値を映し、打って Enter で保存する(保存の形は文字列の配列の JSON)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const sec = createExportWatchTagsSection(region, appExportWatchTags);
    region.append(...(sec.build() as Node[]));
    sec.sync({} as never);
    const input = region.querySelector<HTMLInputElement>('[data-pkc-field="export-watch-tags"]')!;
    expect(input.value).toBe('private, 社外秘');
    input.value = '極秘、 下書き';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(localStorage.getItem(EXPORT_WATCH_TAGS_KEY)).toBe('["極秘","下書き"]');
    expect(input.value).toBe('極秘, 下書き');
  });
});

describe('全件の書き出し', () => {
  it(`🔴 ${EXPORT_CHECK_CHUNK} 件ずつ読み、後ろの塊で見つかった物も一覧に出る`, async () => {
    const bodies: Record<string, string> = {};
    for (let i = 0; i < EXPORT_CHECK_CHUNK + 5; i++) bodies[`n${i}`] = 'ふつう';
    bodies[`n${EXPORT_CHECK_CHUNK + 3}`] = '#private';
    const t = setup(bodies);
    t.press('export-html');
    await tick(60);
    expect(t.reads, '一度に全部読んだ / 塊に分けていない').toEqual([EXPORT_CHECK_CHUNK, 5]);
    expect(t.dialog()?.textContent ?? '', '後ろの塊のタグが一覧に出ない').toContain(`タグ「private」が付いたノート: 「題-n${EXPORT_CHECK_CHUNK + 3}」`);
  });

  it('⚠ 在るノートへのリンクは問題にしない(1 件の書き出しでも)', async () => {
    const one = setup({ n1: '[a](entry:n2)', n2: 'b' });
    one.press('export-entry-html', 'n1');
    await tick();
    expect(one.dialog(), '普通のリンクで確認を出した').toBeNull();
    expect(one.exported).toEqual(['html:n1']);
  });

  it('⚠ 全部書き出すときも、在るノートへのリンクは問題にしない', async () => {
    const t = setup({ n1: '[a](entry:n2)', n2: 'b' });
    t.press('export-html');
    await tick();
    expect(t.dialog()).toBeNull();
    expect(t.exported).toEqual(['html:all']);
  });
});

it('⚠ 本文を読めない版では、点検せずに書き出す(点検のせいで書き出せない、を作らない)', async () => {
  const t = setup({ n1: '#社外秘' }, { noReader: true });
  t.press('export-entry-html', 'n1');
  await tick();
  expect(t.exported).toEqual(['html:n1']);
});
