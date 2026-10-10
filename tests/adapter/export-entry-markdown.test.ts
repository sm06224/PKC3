/** @vitest-environment happy-dom */
/**
 * 🔴 **このノートの本文を、そのまま 1 つの .md にして落とす**(#1440)。
 *
 * 守るもの:①落ちる file の**名前**(題名 + 今日、拡張子 `.md`)②**本文が 1 バイトも変わらない**
 * (日本語・frontmatter・コードの囲み・CRLF)③**入らない添付を数えて言う**(0 件なら黙る)
 * ④編集中は**読む前に**断る ⑤入口が右クリックと「操作を探す」だけ(右の列には無い)。
 *
 * ⚠ ②の観測点は**落ちた Blob の中身**(`text()`)── 「ダウンロードが始まった」だけを見ると、
 *   空の file でも本文を整形した file でも通る。
 */
import { describe, expect, it, vi } from 'vitest';
import { exportEntryMarkdown, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { dayStamp } from '../../src/features/datetime/date-math';
import { ENTRY_MENU_ACTIONS, entryMenuActions } from '../../src/features/entry-actions';
import { KEY_COMMANDS } from '../../src/features/keymap';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { reduce, initialState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const NOW = new Date(2026, 7, 2, 12, 0, 0); // 端末の暦日で 2026-08-02

function source(opts: {
  title?: string;
  body: string | null;
  assets?: string[];
  getBody?: (lid: string) => Promise<string | null>;
}): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: opts.title ?? '議事録',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    getBody: opts.getBody ?? (async () => opts.body),
    listBodies: async () => ({ rows: [], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () =>
      (opts.assets ?? []).map((key) => ({ key, mime: 'image/png', size: 1, hash: null })),
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  } as unknown as ArchiveSource;
}

function harness(src: ArchiveSource, phase = 'ready') {
  const files: Array<{ name: string; blob: Blob }> = [];
  const reported: string[][] = [];
  const told: string[] = [];
  const failed: string[] = [];
  const deps = {
    source: src,
    download: (name: string, blob: Blob) => files.push({ name, blob }),
    report: (notes: readonly string[]) => reported.push([...notes]),
    notify: (m: string) => told.push(m),
    settle: async () => {},
    now: () => NOW,
  } as unknown as ExportDeps;
  const dispatcher = {
    getState: () => ({ phase }),
    dispatch: (a: { type: string; error?: string }) => {
      if (a.type === 'OP_FAILED') failed.push(a.error ?? '');
    },
  } as unknown as Dispatcher;
  return { files, reported, told, failed, deps, dispatcher };
}

describe('exportEntryMarkdown(#1440)', () => {
  it('🔴 <題名>-<今日>.md で、本文が 1 バイトも変わらずに落ちる', async () => {
    // 日本語・frontmatter・コードの囲み(中に asset: 風の字)・CRLF・末尾の改行なし
    const body =
      '---\ntitle: 上書きされない\ntags: [a, b]\n---\r\n# 見出し\r\n\r\n日本語の本文 **太字**\r\n\r\n```md\n- [ ] 未完 ![x](asset:ast-zzz)\n```\n末尾';
    const h = harness(source({ body }));
    expect(await exportEntryMarkdown(h.dispatcher, h.deps, 'n1')).toBe(true);
    expect(h.files).toHaveLength(1);
    expect(h.files[0]!.name).toBe(`議事録-${dayStamp(NOW, '')}.md`);
    expect(await h.files[0]!.blob.text(), '本文が変わっている').toBe(body);
    expect(h.files[0]!.blob.type).toContain('markdown');
  });

  it('🔴 先頭と末尾の空白・空行も落とさない(整形しない)', async () => {
    const body = '\n\n    字下げのコード\n\n末尾の空行が 2 つ\n\n';
    const h = harness(source({ body }));
    await exportEntryMarkdown(h.dispatcher, h.deps, 'n1');
    expect(await h.files[0]!.blob.text(), '前後の空白が落ちている').toBe(body);
  });

  it('🔴 題名のファイル名に使えない字は、隣の書き出しと同じ規則で落ちる', async () => {
    const h = harness(source({ title: 'a/b:c?*d', body: 'x' }));
    await exportEntryMarkdown(h.dispatcher, h.deps, 'n1');
    expect(h.files[0]!.name).toBe(`a-b-c-d-${dayStamp(NOW, '')}.md`);
  });

  it('🔴 添付を指していなければ何も注意しない(0 件は黙る。一覧に添付が在っても)', async () => {
    const h = harness(source({ body: '本文だけ', assets: ['ast-1'] }));
    await exportEntryMarkdown(h.dispatcher, h.deps, 'n1');
    expect(h.reported).toEqual([[]]);
    expect(h.told.join('\n')).not.toContain('添付');
    expect(h.told.at(-1)).toBe('Markdown で書き出しました');
  });

  it('🔴 添付を指していれば「入っていません」を件数つきで言う(同じ添付を 2 か所で指しても 1 件、切れた参照は数えない)', async () => {
    const body = '![a](asset:ast-1)\n\nもう一度 ![a](asset:ast-1)\n\n![b](asset:ast-2)\n\n![c](asset:ast-gone)';
    const h = harness(source({ body, assets: ['ast-1', 'ast-2', 'ast-3'] }));
    await exportEntryMarkdown(h.dispatcher, h.deps, 'n1');
    const want = '添付 2 件は入っていません(バックアップなら入ります)';
    expect(h.reported).toEqual([[want]]);
    expect(h.told.at(-1), '画面下の知らせに添付の件数が出ていない').toContain(want);
    // 落ちた file の本文は書き換えていない(`asset:` はそのまま)
    expect(await h.files[0]!.blob.text()).toBe(body);
  });

  it('🔴 編集中は store を 1 度も読まずに断り、file も落とさない', async () => {
    const getBody = vi.fn(async () => 'x');
    const h = harness(source({ body: 'x', getBody }), 'editing');
    expect(await exportEntryMarkdown(h.dispatcher, h.deps, 'n1')).toBe(false);
    expect(getBody, '断る前に読んでいる').not.toHaveBeenCalled();
    expect(h.files).toHaveLength(0);
    expect(h.failed.join('\n')).toContain('書き出してください');
  });

  it('🔴 本文が読めなければ落とさずに理由を言う(空の .md を作らない)', async () => {
    const h = harness(source({ body: null }));
    expect(await exportEntryMarkdown(h.dispatcher, h.deps, 'n1')).toBe(false);
    expect(h.files).toHaveLength(0);
    expect(h.failed.join('\n')).toContain('本文を読めませんでした');
  });

  it('🔴 ノートが無ければ落とさずに理由を言う', async () => {
    const h = harness(source({ body: 'x' }));
    expect(await exportEntryMarkdown(h.dispatcher, h.deps, 'nope')).toBe(false);
    expect(h.files).toHaveLength(0);
    expect(h.failed.join('\n')).toContain('見つかりません');
  });
});

describe('入口(#1440)── 右クリックと「操作を探す」だけ', () => {
  const meta = (lid: string, archetype: string): EntryMeta => ({
    lid,
    title: 't',
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  });

  it('🔴 右クリックには、どの種類のノートでも「Markdown で書き出す」が出る', () => {
    for (const archetype of ['text', 'folder', 'attachment', 'stack']) {
      const items = entryMenuActions({ archetype, linkedFile: null });
      const found = items.find((a) => a.action === 'export-entry-markdown');
      expect(found, `${archetype} の右クリックに無い`).toBeDefined();
      expect(found!.label).toBe('Markdown で書き出す');
      expect(found!.hint, '説明が空').toContain('添付は入りません');
    }
  });

  it('🔴 右の列には出ない(menuOnly。実際に描いて確かめる)', () => {
    expect(ENTRY_MENU_ACTIONS.find((a) => a.action === 'export-entry-markdown')?.menuOnly).toBe(true);
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'text')],
      relations: [],
    }).state;
    inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    const all = [...root.querySelectorAll('[data-pkc-region="inspector"] [data-pkc-action]')].map((e) =>
      e.getAttribute('data-pkc-action'),
    );
    // 対照群:隣の書き出しは出ている(描けていることの証拠)
    expect(all, '右の列が描けていない(空振り)').toContain('export-entry-html');
    expect(all, '右の列に出てしまっている').not.toContain('export-entry-markdown');
  });

  it('🔴 「操作を探す」には鍵なしで 1 行出る', () => {
    const c = KEY_COMMANDS.find((k) => k.id === 'export-note-markdown');
    expect(c, '操作の表に無い').toBeDefined();
    expect(c!.defaults).toEqual([]);
    expect(c!.label).toBe('このノートを Markdown で書き出す');
  });
});
