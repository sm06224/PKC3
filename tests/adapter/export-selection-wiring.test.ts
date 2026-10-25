/** @vitest-environment happy-dom */
/**
 * #1038 A1: **一覧で選んだ N 件だけの書き出しが、押した所から届くまで**(`export-folder-wiring` と同じ作法)。
 *
 * 見るのは 4 点:
 * ① 選んだ件数が字に出る(1 件でも出る)/ 選んでいないときは帯ごと無い
 * ② 押すと、選んだ lid の全部で呼ばれる(🔴 選んでいない行は混ざらない)
 * ③ 閲覧用 HTML とバックアップは別の口へ行く(取り違えない)
 * ④ 実行部 `exportSelection`: 選んだ分だけが 1 つのファイルになり、フォルダだけの閲覧用 HTML は断られる
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { exportSelection, type ExportDeps } from '../../src/adapter/ui/actions/export-archive';
import { FOLDER_EXPORT_NOTE } from '../../src/features/entry-actions';
import { readArchive, type ArchiveSource } from '../../src/features/export/pkc3-archive';

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

function rig() {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const host = document.createElement('div');
  root.append(host);
  const filer = new FilerRenderer(host);
  const d = new Dispatcher();
  d.onState((s) => filer.render(s));
  const html: string[][] = [];
  const archive: string[][] = [];
  bindActions(root, d, {
    exportSelectionHtml: (l) => void html.push(l),
    exportSelectionArchive: (l) => void archive.push(l),
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', 1), meta('n2', 2), meta('n3', 3), meta('f1', 4, 'folder')],
    relations: [],
  });
  const q = (action: string): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>(`[data-pkc-action="${action}"]`);
  return { d, html, archive, q };
}

describe('#1038 A1 選んだノートの書き出しの配線', () => {
  it('① 選んでいないときは出ない / 1 件でも「書き出す ▾」が出て、押すと件数つきの 2 項目が出る', () => {
    const r = rig();
    expect(r.q('open-selection-export'), '選んでいないのに出ている').toBeNull();
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n1' });
    expect(r.q('open-selection-export')?.textContent).toBe('書き出す ▾');
    expect(r.q('export-selection-html'), '押す前から 2 つ並んでいる(バーが伸びる)').toBeNull();
    r.q('open-selection-export')!.click();
    expect(r.q('export-selection-html')?.textContent).toContain('閲覧用 HTML(選んだ 1 件)');
    expect(r.q('export-selection-archive')?.textContent).toContain('選んだノートのバックアップ');
  });

  it('🔴 ② メニューから押すと選んだ lid の全部で呼ばれ、選んでいない行は混ざらない / ③ 2 つの口は別', () => {
    const r = rig();
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n1' });
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n3' });
    r.q('open-selection-export')!.click();
    expect(r.q('export-selection-html')?.textContent).toContain('選んだ 2 件');
    r.q('export-selection-html')!.click();
    expect(r.html).toHaveLength(1);
    expect([...r.html[0]!].sort()).toEqual(['n1', 'n3']);
    expect(r.archive, '閲覧用 HTML がバックアップの口を叩いた').toHaveLength(0);
    r.q('open-selection-export')!.click();
    r.q('export-selection-archive')!.click();
    expect(r.archive).toHaveLength(1);
    expect([...r.archive[0]!].sort()).toEqual(['n1', 'n3']);
    expect(r.html, '2 回目が HTML の口にも届いた').toHaveLength(1);
  });

  it('全件の「閲覧用 HTML で書き出す」と字が違う(取り違えない)', () => {
    const r = rig();
    r.d.dispatch({ type: 'TOGGLE_SELECT', lid: 'n1' });
    r.q('open-selection-export')!.click();
    expect(r.q('export-selection-html')!.textContent).not.toBe('閲覧用 HTML で書き出す');
  });
});

describe('#1038 A1 実行部 exportSelection', () => {
  function deps(d: Dispatcher) {
    const files: Array<{ name: string; blob: Blob }> = [];
    const reports: string[][] = [];
    const rows = [
      { lid: 'n1', title: '見積', body: '見積の本文' },
      { lid: 'n2', title: '議事録', body: '議事録の本文' },
      { lid: 'n3', title: '秘密', body: '渡してはいけない' },
      { lid: 'f1', title: '案件', body: '', archetype: 'folder' },
    ];
    const source: ArchiveSource = {
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
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    };
    void d;
    const x: ExportDeps = {
      source,
      settle: async () => undefined,
      download: (name: string, blob: Blob) => void files.push({ name, blob }),
      report: (n: readonly string[]) => void reports.push([...n]),
      notify: () => undefined,
      now: () => new Date(2026, 9, 25),
      askSql: async () => ({ ok: false, reason: 'x' }) as never,
      renderBody: async (t: string) => `<p>${t}</p>`,
      renderFigure: async () => null,
      renderFigureVector: async () => null,
      renderIcon: async () => null,
    } as unknown as ExportDeps;
    return { x, files, reports };
  }

  it('🔴 バックアップ: 選んだ分だけが 1 つの .pkc3-notes.zip になる', async () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 1)], relations: [] });
    const { x, files } = deps(d);
    const n = await exportSelection(d, x, ['n1', 'n2'], 'archive');
    expect(n).toBe(2);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toMatch(/選んだノート2件-.*\.pkc3-notes\.zip$/);
    const got = await readArchive(files[0]!.blob);
    expect(got.entries.map((e) => e.lid).sort()).toEqual(['n1', 'n2']);
    expect(JSON.stringify(got.entries)).not.toContain('渡してはいけない');
  });

  it('閲覧用 HTML: 選んだ分だけの .html になり、選んでいない本文は入らない', async () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 1)], relations: [] });
    const { x, files } = deps(d);
    await exportSelection(d, x, ['n1', 'n2'], 'html');
    expect(files[0]!.name).toMatch(/\.html$/);
    const text = await files[0]!.blob.text();
    expect(text).toContain('見積の本文');
    expect(text).not.toContain('渡してはいけない');
  });

  it('フォルダだけを選んだ閲覧用 HTML は、1 件のときと同じ字で断る(ファイルは作らない)', async () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 1)], relations: [] });
    const { x, files } = deps(d);
    const n = await exportSelection(d, x, ['f1'], 'html');
    expect(n).toBeNull();
    expect(files).toHaveLength(0);
    expect(d.getState().error).toBe(FOLDER_EXPORT_NOTE);
  });
});
