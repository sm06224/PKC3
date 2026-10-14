/** @vitest-environment happy-dom */
/**
 * 🔴 **章・コードの欄を開いたまま書き出すと、欄に打った字が入らないのに「書き出しました」と出る**(#1087)。
 *
 * 書き出しは保存済みの本文を読む。章の欄(`sectionDraft`)は `phase` を `ready` のまま保つので、
 * 入口が `phase !== 'ready'` だけを見ていると素通りした。判定は `exportBlockedNote`(`hasUnsavedTyping` と
 * 同じ見方)の 1 か所 ── 入口を全部ここで数える。
 *
 * 🔑 対照群:欄が無ければ同じ道で書き出される(断る門が常に真で空振りしていない)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  CODE_DRAFT_NOTE,
  SECTION_DRAFT_NOTE,
  exportBlockedNote,
  hasUnsavedTyping,
} from '../../src/adapter/state/app-state';
import {
  createMarkdownFolderFlow,
  exportArchive,
  exportEntry,
  exportEntryDocx,
  exportEntryMarkdown,
  exportEntryPptx,
  exportFolder,
  exportMarkdownToFolder,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import { exportPortable, type PortableExportDeps } from '../../src/adapter/ui/actions/export-portable';
import { printNote } from '../../src/adapter/platform/print-note';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const NOTE = '# 買い物\n牛乳\n\n## 予定\n会議\n\n```js\nlet a = 1;\n```\n';
const SECTION_LINE = 3;
const CODE_LINE = 6;

function boot(): { d: Dispatcher; errors: string[] } {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'n1', title: '買い物', archetype: 'text', createdAt: null, updatedAt: null,
        entryOrder: 1, status: null, date: null, archived: false, bodyChars: null,
      },
    ],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: NOTE });
  const errors: string[] = [];
  const orig = d.dispatch.bind(d);
  d.dispatch = (a: Parameters<typeof orig>[0]) => {
    if (a.type === 'OP_FAILED') errors.push((a as { error: string }).error);
    return orig(a);
  };
  return { d, errors };
}

function openSection(): ReturnType<typeof boot> {
  const h = boot();
  h.d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: SECTION_LINE });
  expect(h.d.getState().sectionDraft, '章の欄が開いていない(前提が崩れた)').not.toBeNull();
  expect(hasUnsavedTyping(h.d.getState())).toBe(true);
  return h;
}
function openCode(): ReturnType<typeof boot> {
  const h = boot();
  h.d.dispatch({ type: 'OPEN_CODE_DRAFT', lid: 'n1', line: CODE_LINE });
  expect(h.d.getState().sectionDraft, 'コードの欄が開いていない(前提が崩れた)').not.toBeNull();
  return h;
}

/** 読みに行ったか・落としたかを数える台。 */
function exportDeps(): ExportDeps & { files: string[]; reads: { n: number } } {
  const files: string[] = [];
  const reads = { n: 0 };
  const source = {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => {
      reads.n++;
      return [
        {
          lid: 'n1', title: 'ノート', archetype: 'text', created_at: null, updated_at: null,
          entry_order: 1, status: null, date: null, archived: 0,
        },
      ];
    },
    getBody: async () => 'x',
    listBodies: async () => ({ rows: [{ lid: 'n1', body: 'x' }], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  } as unknown as ArchiveSource;
  return {
    source,
    download: (name: string) => files.push(name),
    report: () => {},
    notify: () => {},
    settle: async () => {},
    renderFigureVector: async () => null,
    renderFigure: async () => null,
    askSql: async () => {
      throw new Error('引かない');
    },
    renderBody: (t: string) => `<p>${t}</p>`,
    now: () => new Date('2026-10-14T00:00:00Z'),
    files,
    reads,
  } as unknown as ExportDeps & { files: string[]; reads: { n: number } };
}

const SECTION_ENTRIES: ReadonlyArray<[string, (d: Dispatcher, x: ReturnType<typeof exportDeps>) => Promise<unknown>]> = [
  ['exportEntry(バックアップ 1 件)', (d, x) => exportEntry(d, x, 'n1', 'archive')],
  ['exportEntry(閲覧用 HTML 1 件)', (d, x) => exportEntry(d, x, 'n1', 'html')],
  ['exportFolder(フォルダごと)', (d, x) => exportFolder(d, x, 'n1')],
  ['exportArchive(バックアップ)', (d, x) => exportArchive(d, x, 'archive')],
  ['exportArchive(閲覧用 HTML)', (d, x) => exportArchive(d, x, 'html')],
  ['exportArchive(Markdown zip)', (d, x) => exportArchive(d, x, 'markdown')],
  ['exportEntryMarkdown(Markdown 1 件)', (d, x) => exportEntryMarkdown(d, x, 'n1')],
  ['exportEntryDocx(Word)', (d, x) => exportEntryDocx(d, x, 'n1')],
  ['exportEntryPptx(PowerPoint)', (d, x) => exportEntryPptx(d, x, 'n1')],
];

describe('🔴 章の欄が開いている間は、書き出しの入口が全部断る(#1087)', () => {
  for (const [name, run] of SECTION_ENTRIES) {
    it(`${name}:読みに行かず・何も落とさず、章の断り文を出す`, async () => {
      const { d, errors } = openSection();
      const x = exportDeps();
      await run(d, x);
      expect(x.files, '欄に打った字が入らないファイルが落ちた').toEqual([]);
      expect(x.reads.n, '断る前に読みに行った').toBe(0);
      expect(errors, '断り文が出ていない').toEqual([SECTION_DRAFT_NOTE]);
    });
  }

  it('コードの欄は「コード」の断り文になる(章の字を言わない)', async () => {
    const { d, errors } = openCode();
    const x = exportDeps();
    await exportEntryMarkdown(d, x, 'n1');
    expect(x.files).toEqual([]);
    expect(errors).toEqual([CODE_DRAFT_NOTE]);
    expect(CODE_DRAFT_NOTE).not.toBe(SECTION_DRAFT_NOTE);
  });

  it('Markdown をフォルダへ:選ぶ前の入口も、選んだ後の書く口も断る(選ぶ間に欄が開いても書かない)', async () => {
    const a = openSection();
    let picked = 0;
    await createMarkdownFolderFlow(a.d, (async () => {
      picked++;
      return null;
    }) as never, async () => {
      throw new Error('走らせない');
    })();
    expect(picked, '断るはずが、フォルダを選ばせた').toBe(0);
    expect(a.errors).toEqual([SECTION_DRAFT_NOTE]);

    const b = openSection();
    const root = new Proxy({}, {
      get() {
        throw new Error('フォルダに触った');
      },
    });
    const x = exportDeps();
    expect(await exportMarkdownToFolder(b.d, x, root as never)).toBeNull();
    expect(b.errors).toEqual([SECTION_DRAFT_NOTE]);
  });

  it('PDF(printNote):刷らず、章の断り文を出す', async () => {
    const { d, errors } = openSection();
    let printed = 0;
    const r = await printNote(
      {
        getState: () => d.getState(),
        dispatch: (a: Parameters<Dispatcher['dispatch']>[0]) => d.dispatch(a),
        onState: () => () => {},
        print: () => printed++,
      } as never,
      'n1',
    );
    expect(r).toBe('not-ready');
    expect(printed).toBe(0);
    expect(errors).toEqual([SECTION_DRAFT_NOTE]);
  });

  it('PKC3 入り HTML(exportPortable):雛形を取りに行かず、章の断り文を出す', async () => {
    const { d, errors } = openSection();
    let fetched = 0;
    const dp = {
      title: '器',
      fetchTemplate: async () => {
        fetched++;
        return '';
      },
      notify: () => {},
      report: () => {},
      settle: async () => {},
      insideBundle: () => false,
    } as unknown as PortableExportDeps;
    expect(await exportPortable(d, dp)).toBeNull();
    expect(fetched).toBe(0);
    expect(errors).toEqual([SECTION_DRAFT_NOTE]);
  });
});

describe('対照群:欄が無ければ書き出される', () => {
  it('欄を閉じれば、同じ入口が通る(断る門が常に真で空振りしていない)', async () => {
    const { d, errors } = openSection();
    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    expect(d.getState().sectionDraft, '欄が閉じていない(前提が崩れた)').toBeNull();
    const h = { d, errors };
    const x = exportDeps();
    await exportEntryMarkdown(h.d, x, 'n1');
    expect(h.errors).toEqual([]);
    expect(x.files.length, '欄が無いのに書き出されていない').toBe(1);
  });

  it('exportBlockedNote:ready で欄なし → null / 全文編集中 → 編集の断り / 欄 → 欄の断り', () => {
    const plain = boot().d.getState();
    expect(exportBlockedNote(plain, '書き出してください')).toBeNull();
    const ed = boot();
    ed.d.dispatch({ type: 'START_EDIT' });
    expect(ed.d.getState().phase).toBe('editing');
    expect(exportBlockedNote(ed.d.getState(), '書き出してください')).toBe(
      '編集を保存するか、編集をやめてから書き出してください',
    );
    expect(exportBlockedNote(openSection().d.getState(), '書き出してください')).toBe(SECTION_DRAFT_NOTE);
  });
});
