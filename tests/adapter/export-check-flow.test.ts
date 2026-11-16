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
import {
  bindActions,
  EXPORT_CHECK_CHUNK,
  guardExport,
  makeShellOps,
  resetExportCheckForTest,
  runGlobalCommand,
} from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { mergeExportFindings, exportFindings } from '../../src/features/export/export-check';
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

const ALL_SERVICES = (exported: string[]) => ({
  exportEntryHtml: (lid: string) => exported.push(`html:${lid}`),
  exportEntryMarkdown: (lid: string) => exported.push(`md:${lid}`),
  exportEntryDocx: (lid: string) => exported.push(`docx:${lid}`),
  exportEntryPptx: (lid: string) => exported.push(`pptx:${lid}`),
  printNote: (lid: string) => exported.push(`pdf:${lid}`),
  copyEntryMail: (lid: string) => exported.push(`mail:${lid}`),
  exportSelectionHtml: (lids: readonly string[]) => exported.push(`sel-html:${lids.join(',')}`),
  exportSelectionPortable: (lids: readonly string[]) => exported.push(`sel-portable:${lids.join(',')}`),
  exportHtml: () => exported.push('html:all'),
  exportMarkdown: () => exported.push('md:all'),
  exportMarkdownFolder: () => exported.push('md-folder:all'),
  exportPortable: () => exported.push('portable:all'),
});

function setup(bodies: Record<string, string>, opts: { noReader?: boolean; folder?: string; readDelay?: number } = {}) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  resetExportCheckForTest();
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
            if (opts.readDelay !== undefined) await new Promise((r) => setTimeout(r, opts.readDelay));
            return new Map(lids.filter((l) => bodies[l] !== undefined).map((l) => [l, bodies[l]!] as const));
          },
        }),
    ...ALL_SERVICES(exported),
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((l) => (l === opts.folder ? { ...meta(l, `題-${l}`), archetype: 'folder' } : meta(l, `題-${l}`))),
    relations: [],
  });
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
  resetExportCheckForTest();
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

describe('🔴 外へ渡す書き出しは全部、点検を通る(着地前レビュー 🔴1 / ⚠5)', () => {
  const ENTRY: Array<[string, string]> = [
    ['export-entry-html', 'html:n1'],
    ['export-entry-markdown', 'md:n1'],
    ['export-entry-docx', 'docx:n1'],
    ['export-entry-pptx', 'pptx:n1'],
    ['export-entry-pdf', 'pdf:n1'],
    ['copy-entry-mail', 'mail:n1'],
  ];
  const ALL: Array<[string, string]> = [
    ['export-html', 'html:all'],
    ['export-markdown', 'md:all'],
    ['export-markdown-folder', 'md-folder:all'],
    ['export-portable', 'portable:all'],
  ];
  for (const [action, want] of [...ENTRY, ...ALL]) {
    it(`${action}: 社外秘のノートがあれば確認を出し、やめれば書き出さない / 書き出すなら書き出す`, async () => {
      const t = setup({ n1: '#社外秘' });
      t.press(action, ENTRY.some(([a]) => a === action) ? 'n1' : undefined);
      await tick();
      expect(t.dialog(), `${action} が点検を素通りした`).not.toBeNull();
      expect(t.exported).toEqual([]);
      t.answer('ok');
      await tick();
      expect(t.exported).toEqual([want]);
    });
  }

  it('export-selection-html / export-selection-portable: 選んだノートを点検する', async () => {
    for (const [action, want] of [
      ['export-selection-html', 'sel-html:n1'],
      ['export-selection-portable', 'sel-portable:n1'],
    ] as const) {
      const t = setup({ n1: '#社外秘', n2: 'ふつう' });
      t.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n1' });
      t.press(action);
      await tick();
      expect(t.dialog(), `${action} が点検を素通りした`).not.toBeNull();
      t.answer('ok');
      await tick();
      expect(t.exported).toEqual([want]);
    }
  });

  it('⚠ メール下書きは画像を運ばない(画像の添付も数える)/ PDF は運ぶ', async () => {
    const mail = setup({ n1: '![図](asset:k1)' });
    mail.press('copy-entry-mail', 'n1');
    await tick();
    expect(mail.dialog()?.textContent ?? '').toContain('開けない添付へのリンク 1 か所');
    const pdf = setup({ n1: '![図](asset:k1)' });
    pdf.press('export-entry-pdf', 'n1');
    await tick();
    expect(pdf.dialog()).toBeNull();
    expect(pdf.exported).toEqual(['pdf:n1']);
  });

  it('🔴 操作を探す(ショートカットキー)の「Markdown / PDF で書き出す」も同じ点検を通る', async () => {
    for (const [cmd, want] of [
      ['export-note-markdown', 'md:n1'],
      ['export-note-pdf', 'pdf:n1'],
    ] as const) {
      const t = setup({ n1: '#社外秘' });
      t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      runGlobalCommand(cmd, t.root, t.d, new KeymapStore(), () => {}, () => {});
      await tick();
      expect(t.dialog(), `${cmd} が点検を素通りした`).not.toBeNull();
      t.answer('ok');
      await tick();
      expect(t.exported).toEqual([want]);
    }
  });

  it('🔴 コマンドシェルの書き出しも同じ点検を通る', async () => {
    const t = setup({ n1: '#社外秘' });
    const services = { readBodies: async (lids: readonly string[]) => new Map(lids.map((l) => [l, '#社外秘'] as const)), ...ALL_SERVICES(t.exported) };
    const ops = makeShellOps({ dispatcher: t.d, services, root: t.root, surface: 'shell', where: 'pane' });
    ops.exportNote('n1', 'md');
    await tick();
    expect(t.dialog(), 'シェルの書き出しが点検を素通りした').not.toBeNull();
    t.answer('cancel');
    await tick();
    expect(t.exported).toEqual([]);
  });
});

describe('着地前レビューの指摘', () => {
  it('🔴 フォルダ 1 件の書き出しは、点検の確認を出さずに書き出す側へ渡す(書き出す側が断る)', async () => {
    const t = setup({ f1: '#社外秘' }, { folder: 'f1' });
    t.press('export-entry-html', 'f1');
    await tick();
    expect(t.dialog(), 'フォルダなのに点検の確認を出した').toBeNull();
    expect(t.exported).toEqual(['html:f1']);
  });

  it('⚠ 点検の最中にもう一度押しても、確認は 1 枚・書き出しは 1 回', async () => {
    const t = setup({ n1: '#社外秘' }, { readDelay: 30 });
    t.press('export-entry-html', 'n1');
    t.press('export-entry-html', 'n1');
    await tick(80);
    expect(document.querySelectorAll('[data-pkc-field="dialog-list"]').length).toBe(1);
    expect(t.reads, '二度押しで本文を 2 回読んだ(点検が 2 本走った)').toEqual([1]);
    t.answer('ok');
    await tick(60);
    expect(t.exported).toEqual(['html:n1']);
    // ⚠ 確認は 1 枚ずつ出る ── 答えた後に 2 枚目が出てこないことまで見る
    const dlg = document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]');
    expect(dlg?.open ?? false, '答えた後に 2 枚目の確認が出た').toBe(false);
  });

  it('⚠ フォルダを選ぶ書き出しは、点検が長引いたら問題が無くても 1 度聞く(押した直後しか窓を開けない)', async () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'メモ')], relations: [] });
    document.body.innerHTML = '';
    resetAppDialogForTest();
    const root = document.createElement('div');
    document.body.append(root);
    let went = 0;
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const p = guardExport(
        d,
        { readBodies: async () => ((now += 5000), new Map([['n1', 'ふつう']])) },
        root,
        'all',
        'images',
        () => (went += 1),
        { needsGesture: true },
      );
      await tick();
      expect(went, '点検が長引いたのに聞かずに書き出した(窓が開けない)').toBe(0);
      const dlg = document.querySelector<HTMLDialogElement>('[data-pkc-region="app-dialog"]')!;
      expect(dlg.textContent).toContain('点検が終わりました');
      dlg.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
      await p;
      expect(went).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('塊を足し合わせる(mergeExportFindings ── 着地前レビュー ⚠6)', () => {
  const f = (body: string, title: string) =>
    exportFindings({ notes: [{ lid: title, title, body }], exists: () => false, watchTags: ['private'], carry: 'images' });
  it('🔴 同じタグが前後の塊の両方に在れば、題名をつなぐ。リンクと添付の数も足す', () => {
    const m = mergeExportFindings(f('#private\n\n[x](entry:a)', 'A'), f('#private\n\n[y](asset:k)', 'B'));
    expect(m.tagged).toEqual([{ tag: 'private', titles: ['A', 'B'] }]);
    expect(m.missingLinks).toEqual({ count: 1, titles: ['A'] });
    expect(m.assets).toEqual({ count: 1, titles: ['B'] });
    expect(mergeExportFindings(null, f('#private', 'C')).tagged).toEqual([{ tag: 'private', titles: ['C'] }]);
  });
});
