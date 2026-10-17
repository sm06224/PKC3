/** @vitest-environment happy-dom */
/**
 * Word / PowerPoint の書き出しで、数式が「打った字のまま」入ることを言う(#1087 E12)。
 * 閲覧用 HTML と同じ文面を使う(`mathSourceNotice`)。
 */
import { describe, expect, it } from 'vitest';
import {
  exportEntryDocx,
  exportEntryPptx,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import { mathSourceNotice } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';

function source(body: string): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: 'ノート',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
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

const fakeDispatcher = (phase: string) => {
  const dispatched: Array<{ type: string; error?: string }> = [];
  return {
    dispatched,
    dispatcher: {
      getState: () => ({ phase }),
      dispatch: (a: { type: string; error?: string }) => dispatched.push(a),
    } as unknown as Dispatcher,
  };
};

function deps(
  src: ArchiveSource,
  reports: string[][],
): { d: ExportDeps; got: Array<{ name: string; blob: Blob }> } {
  const got: Array<{ name: string; blob: Blob }> = [];
  const d: ExportDeps = {
    source: src,
    download: (name, blob) => got.push({ name, blob }),
    report: (n) => reports.push([...n]),
    askSql: async () => ({ columns: [], rows: [], truncated: false }),
    settle: async () => {},
    renderFigureVector: async () => null,
    renderFigure: async () => null,
    renderBody: async (t, o) => renderMarkdown(t, o),
    now: () => new Date('2026-10-02T00:00:00Z'),
  };
  return { d, got };
}

describe('数式の注意', () => {
  const BODY = '# 題\n\n式 $x^2$ と\n\n$$a+b$$\n';
  it('🔴 Word: 数式 2 件が打った字のままになることを、閲覧用 HTML と同じ文面で言う', async () => {
    const reports: string[][] = [];
    const { d } = deps(source(BODY), reports);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(reports.flat()).toContain(mathSourceNotice(2));
    expect(mathSourceNotice(2)).toBe('数式 2 件は、開いた先では打った字のまま出ます');
  });

  it('🔴 PowerPoint も同じ', async () => {
    const reports: string[][] = [];
    const { d } = deps(source(BODY), reports);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryPptx(dispatcher, d, 'n1')).toBe(true);
    expect(reports.flat()).toContain(mathSourceNotice(2));
  });

  it('対照群:数式の無い本文には言わない', async () => {
    const reports: string[][] = [];
    const { d } = deps(source('# 題\n\n本文\n'), reports);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(reports.flat().some((m) => m.includes('数式'))).toBe(false);
  });
});
