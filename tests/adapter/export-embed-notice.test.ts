/** @vitest-environment happy-dom */
/**
 * Word / PowerPoint の書き出しで、別のノートの内容の埋め込みが説明の字だけになることを件数で言う(#1648 の 3)。
 * 閲覧用 HTML と同じ文面を使う(`embedSourceNotice`)。
 */
import { describe, expect, it } from 'vitest';
import {
  exportEntryDocx,
  exportEntryPptx,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import { embedSourceNotice } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';

function source(body: string): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      { lid: 'n1', title: 'ノート', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 },
    ],
    listBodies: async () => ({ rows: [{ lid: 'n1', body }], done: true }),
    getBody: async () => body,
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

const dispatcher = {
  getState: () => ({ phase: 'ready' }),
  dispatch: () => undefined,
} as unknown as Dispatcher;

function deps(src: ArchiveSource, reports: string[][]): ExportDeps {
  return {
    source: src,
    download: () => undefined,
    report: (n) => reports.push([...n]),
    askSql: async () => ({ columns: [], rows: [], truncated: false }),
    settle: async () => {},
    renderFigureVector: async () => null,
    renderFigure: async () => null,
    renderBody: async (t, o) => renderMarkdown(t, o),
    now: () => new Date('2026-10-02T00:00:00Z'),
  };
}

describe('別のノートの内容の埋め込みの注意', () => {
  const BODY = '# 題\n\n![議事録](entry:abc#h/x)\n\n![予定](entry:def#h/y)\n';
  it('🔴 Word: 埋め込み 2 件が説明の字だけになることを、閲覧用 HTML と同じ文面で言う', async () => {
    const reports: string[][] = [];
    expect(await exportEntryDocx(dispatcher, deps(source(BODY), reports), 'n1')).toBe(true);
    expect(reports.flat()).toContain(embedSourceNotice(2));
    expect(embedSourceNotice(2)).toBe('別のノートの内容の埋め込み 2 件は、開いた先では説明の字だけで出ます');
  });

  it('🔴 PowerPoint も同じ', async () => {
    const reports: string[][] = [];
    expect(await exportEntryPptx(dispatcher, deps(source(BODY), reports), 'n1')).toBe(true);
    expect(reports.flat()).toContain(embedSourceNotice(2));
  });

  it('対照群:埋め込みの無い本文には言わない', async () => {
    const reports: string[][] = [];
    expect(await exportEntryDocx(dispatcher, deps(source('# 題\n\n本文\n'), reports), 'n1')).toBe(true);
    expect(reports.flat().some((m) => m.includes('埋め込み'))).toBe(false);
  });
});
