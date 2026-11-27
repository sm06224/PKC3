/** @vitest-environment happy-dom */
/**
 * 配布パッケージ(`.pkc3-site.zip`、#2098 後半)── **押した所から届くまで**の配線。
 *
 * ① 3 つの入り口(全体 / 選んだノート / フォルダ)の押し所が、それぞれ専用の口を正しい lid で叩く(他の口は叩かない)
 * ② 実行部(`exportArchive` / `exportSelection` / `exportFolder`)が `writePortableSiteZip` を通った zip を `.pkc3-site.zip` の名前で落とす
 *    (中身は zip の読み手で開いて確かめる ── 名前だけでは「別の writer を通った」を見分けられない)
 * ③ 落とす口(`downloadBlob`)が作った ObjectURL を解放する
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions, siteCheckScope, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { readFileSync } from 'node:fs';
import {
  EXPORT_STARTING,
  exportArchive,
  exportFolder,
  exportSelection,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { readZipDirectory, readZipText } from '../../src/features/import/zip-reader';
import { downloadBlob } from '../../src/adapter/platform/download';
import { COLLECTION_PANE_COMMANDS } from '../../src/adapter/ui/render/commands';
import { ENTRY_MENU_ACTIONS } from '../../src/features/entry-actions';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

beforeEach(() => {
  document.body.textContent = '';
});

describe('配布パッケージの押し所', () => {
  function rig(extra: Partial<BinderServices> = {}) {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const host = document.createElement('div');
    root.append(host);
    const filer = new FilerRenderer(host);
    const d = new Dispatcher();
    d.onState((s) => filer.render(s));
    const calls: string[] = [];
    bindActions(root, d, {
      exportSite: () => void calls.push('site'),
      exportSelectionSite: (l) => void calls.push(`sel:${[...l].sort().join(',')}`),
      exportFolderSite: (l) => void calls.push(`folder:${l}`),
      exportSelectionHtml: (l) => void calls.push(`html:${l.join(',')}`),
      exportFolder: (l) => void calls.push(`backup:${l}`),
      ...extra,
    });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 1), meta('n2', 2), meta('n3', 3), meta('f1', 4, 'folder')],
      relations: [],
    });
    const q = (action: string): HTMLButtonElement | null =>
      root.querySelector<HTMLButtonElement>(`[data-pkc-action="${action}"]`);
    return { d, root, calls, q };
  }

  it('🔴 全体: 右の列の一覧に「配布パッケージで書き出す」が在り、押すと専用の口だけを叩く', () => {
    const cmd = COLLECTION_PANE_COMMANDS.find((c) => c.action === 'export-site');
    expect(cmd?.label).toBe('配布パッケージで書き出す');
    expect(cmd?.title).toContain('index.html');
    const r = rig();
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'export-site');
    r.root.append(b);
    b.click();
    expect(r.calls).toEqual(['site']);
  });

  it('🔴 選んだノート: 「書き出す ▾」に件数つきで並び、選んだ lid の全部で専用の口を叩く', () => {
    const r = rig();
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n1' });
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n3' });
    r.q('open-selection-export')!.click();
    expect(r.q('export-selection-site')?.textContent).toContain('配布パッケージ(選んだ 2 件)');
    r.q('export-selection-site')!.click();
    expect(r.calls).toEqual(['sel:n1,n3']);
  });

  it('🔴 フォルダ: 右クリックの表に在り(フォルダのときだけ)、押すとその行のフォルダで専用の口を叩く', () => {
    const def = ENTRY_MENU_ACTIONS.find((a) => a.action === 'export-folder-site');
    expect(def?.when).toBe('folder');
    expect(def?.group).toBe('this-folder');
    const r = rig();
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const row = document.createElement('div');
    row.setAttribute('data-pkc-entry', 'f1');
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'export-folder-site');
    row.append(b);
    r.root.append(row);
    b.click();
    expect(r.calls, '選択中の lid を使ってしまった / バックアップの口を叩いた').toEqual(['folder:f1']);
  });
});

describe('配布パッケージの実行部', () => {
  const rows = [
    { lid: 'n1', title: '手順書', body: '# 手順\n\n![](asset:ast-csv)\n' },
    { lid: 'n2', title: '別件', body: '別件の本文' },
    { lid: 't1', title: 'tool.html', archetype: 'attachment', body: '---\nattachment.name: tool.html\nattachment.mime: text/html\nattachment.asset_key: ast-tool\n---\n' },
    { lid: 'f1', title: '案件', body: '', archetype: 'folder' },
  ];
  const assets: Record<string, { mime: string; text: string }> = {
    'ast-csv': { mime: 'text/csv', text: 'a,b\n1,2\n' },
    'ast-tool': { mime: 'text/html', text: '<p>tool</p>' },
  };
  function src(): ArchiveSource {
    return {
      cid: 'c1',
      title: 'コンテナ',
      listEntryMetas: async () =>
        rows.map((r, i) => ({
          lid: r.lid,
          title: r.title,
          archetype: r.archetype ?? 'text',
          created_at: null,
          updated_at: null,
          entry_order: i + 1,
          status: null,
          date: null,
          archived: 0,
        })),
      getBody: async (lid) => rows.find((r) => r.lid === lid)?.body ?? null,
      listBodies: async () => ({ rows: rows.map((r) => ({ lid: r.lid, body: r.body })), done: true }),
      listRelations: async () => [
        { id: 's1', from_lid: 'f1', to_lid: 'n1', kind: 'structural', created_at: null, updated_at: null },
        { id: 's2', from_lid: 'f1', to_lid: 't1', kind: 'structural', created_at: null, updated_at: null },
      ],
      listAssetMetas: async () =>
        Object.entries(assets).map(([key, a]) => ({ key, mime: a.mime, size: a.text.length, hash: null })),
      getAssetBlob: async (k) => (assets[k] ? new Blob([assets[k]!.text]) : null),
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    };
  }
  function deps(): { deps: ExportDeps; files: Array<{ name: string; blob: Blob }>; notices: string[] } {
    const files: Array<{ name: string; blob: Blob }> = [];
    const notices: string[] = [];
    return {
      files,
      notices,
      deps: {
        source: src(),
        download: (name, blob) => void files.push({ name, blob }),
        report: () => {},
        settle: async () => {},
        renderFigure: async () => null,
        renderFigureVector: async () => null,
        renderIcon: async () => null,
        askSql: async () => {
          throw new Error('引かない');
        },
        notify: (m) => void notices.push(m),
        now: () => new Date('2026-11-27T00:00:00.000Z'),
        toolTheme: { tone: 'dark', tokens: { '--pkc-bg': '#111111' } },
      },
    };
  }
  function ready(): Dispatcher {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    return d;
  }
  async function manifestOf(blob: Blob): Promise<{ notes: Array<{ lid: string }>; tools: Array<{ path: string }> }> {
    const dir = await readZipDirectory(blob);
    const e = dir.find((x) => x.name === 'manifest.js')!;
    const code = await readZipText(blob, e);
    const w: Record<string, unknown> = {};
    new Function('window', code)(w);
    expect(dir.some((x) => x.name === 'index.html')).toBe(true);
    return w['__PKC_SITE_MANIFEST__'] as never;
  }

  it('🔴 全体: .pkc3-site.zip で落ち、全ノートと HTML のツールが入り、開始と完了を知らせる', async () => {
    const x = deps();
    expect(await exportArchive(ready(), x.deps, 'site')).toBe(4);
    expect(x.files).toHaveLength(1);
    expect(x.files[0]!.name).toBe('コンテナ-20261127.pkc3-site.zip');
    const m = await manifestOf(x.files[0]!.blob);
    expect(m.notes.map((n) => n.lid)).toEqual(['n1', 'n2', 't1', 'f1']);
    expect(m.tools.map((t) => t.path)).toEqual(['tools/tool.html']);
    expect(x.notices[0]).toBe(EXPORT_STARTING.site);
    expect(x.notices.at(-1)).toContain('「コンテナ-20261127.pkc3-site.zip」');
    expect(x.notices.at(-1)).toContain('ツール 1');
    // ツールを単体で開いたときの配色は、書き出した時点の画面の配色(toolTheme)
    const dir = await readZipDirectory(x.files[0]!.blob);
    const tool = await readZipText(x.files[0]!.blob, dir.find((e) => e.name === 'tools/tool.html')!);
    expect(tool).toContain('data-pkc-tone="dark"');
    expect(tool).toContain('--pkc-bg:#111111');
  });

  it('🔴 選んだノート: 選んだ物だけが入る', async () => {
    const x = deps();
    await exportSelection(ready(), x.deps, ['n2'], 'site');
    expect(x.files[0]!.name.endsWith('.pkc3-site.zip')).toBe(true);
    const m = await manifestOf(x.files[0]!.blob);
    expect(m.notes.map((n) => n.lid)).toEqual(['n2']);
    expect(m.tools).toEqual([]);
  });

  it('🔴 フォルダ: 中のノートとツールだけが入る(外のノートは入らない)', async () => {
    const x = deps();
    await exportFolder(ready(), x.deps, 'f1', 'site');
    expect(x.files[0]!.name.endsWith('.pkc3-site.zip')).toBe(true);
    const m = await manifestOf(x.files[0]!.blob);
    expect(m.notes.map((n) => n.lid).sort()).toEqual(['f1', 'n1', 't1']);
    expect(m.tools.map((t) => t.path)).toEqual(['tools/tool.html']);
  });

  // ⚠ 編集中に断ることは `export-draft-gate.test.ts` が 'site' の 2 経路(全体・フォルダ)を含めて見る

  it('🔴 落とす口は ObjectURL を解放する(ゼロコピー・即破棄)', () => {
    vi.useFakeTimers();
    try {
      const made: string[] = [];
      const revoked: string[] = [];
      const c = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        made.push('blob:x');
        return 'blob:x';
      });
      const r = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      downloadBlob('a.pkc3-site.zip', new Blob(['x']));
      vi.runAllTimers();
      expect(made).toEqual(['blob:x']);
      expect(revoked).toEqual(['blob:x']);
      c.mockRestore();
      r.mockRestore();
      click.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('配布パッケージの点検の範囲と、アプリの配線', () => {
  it('🔴 フォルダを選んだら、点検するのは中のノート(フォルダの行のままだと点検が素通りする)', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 1), meta('n2', 2), meta('f1', 3, 'folder'), meta('f2', 4, 'folder')],
      relations: [
        { id: 'r1', fromLid: 'f1', toLid: 'n2', kind: 'structural', createdAt: null, updatedAt: null },
      ],
    });
    const st = d.getState();
    expect(siteCheckScope(st, ['f1']).sort()).toEqual(['n2']);
    expect(siteCheckScope(st, ['n1', 'f1']).sort()).toEqual(['n1', 'n2']);
    // 空のフォルダはフォルダの行のまま(書き出す側が断る)
    expect(siteCheckScope(st, ['f2'])).toEqual(['f2']);
  });

  it('🔴 アプリの services は 3 つの入り口を配布パッケージの実行部へ繋ぐ(取り違えない)', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain("exportSite: () => void runExport('site')");
    expect(main).toContain("exportSelectionSite: (lids) => void runExport({ selection: lids, as: 'site' })");
    expect(main).toContain("exportFolderSite: (lid) => void runExport({ entryLid: lid, as: 'folder-site' })");
    expect(main).toMatch(/kind\.as === 'folder-site'\) await exportFolder\(dispatcher, deps, kind\.entryLid, 'site'\)/);
  });
});
