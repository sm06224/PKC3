/** @vitest-environment happy-dom */
/**
 * 🔴 **Word・PowerPoint に書き出す図は、画面の配色によらず明るい配色で描く**(#1163 依頼 233。Gemini の裁定 = 案どおり)。
 *
 * 画面の物語:ダークの配色のまま Word に書き出すと、白いページの上に明るい線と字の図が載って読みにくかった。
 * いまは Word・PowerPoint に載せる図だけ紙の配色(`paper`)で描く。閲覧用 HTML は今までどおり画面と同じ配色
 * (開く先の配色は閲覧側が決める)── 依頼 233 は Word・PowerPoint だけを言っている。
 *
 * ⚠ 配色を決める本体(`main.ts` の `renderFigure`)はどの test からも実行されない file にあるので、ここが見るのは
 *   **書き出しが紙の配色を求めているか**(`paper` を渡すか)。紙の配色そのものは `diagram-print.test.ts` が
 *   `tokens.css` と突き合わせている。
 */
import { describe, expect, it } from 'vitest';
import {
  exportEntry,
  exportEntryDocx,
  exportEntryPptx,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';

const BODY = '# 題\n\n```mermaid\ngraph TD\n A-->B\n```\n';

function source(): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      { lid: 'n1', title: 'ノート', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 },
    ],
    listBodies: async () => ({ rows: [{ lid: 'n1', body: BODY }], done: true }),
    getBody: async () => BODY,
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

interface Call {
  readonly via: 'vector' | 'raster';
  readonly paper: boolean | undefined;
}

function deps(calls: Call[]): ExportDeps {
  return {
    source: source(),
    download: () => undefined,
    report: () => undefined,
    askSql: async () => ({ columns: [], rows: [], truncated: false }),
    settle: async () => {},
    renderIcon: async () => null,
    // 描けた SVG を返す(ベクタの道を通す)── 対照群として、返さない回も下で作る
    renderFigureVector: async (_k, _s, paper) => {
      calls.push({ via: 'vector', paper });
      return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    },
    renderFigure: async (_k, _s, paper) => {
      calls.push({ via: 'raster', paper });
      return null;
    },
    renderBody: async (t, o) => renderMarkdown(t, o),
    now: () => new Date('2026-10-02T00:00:00Z'),
  };
}

describe('Word・PowerPoint の図は紙の配色で描く(#1163 依頼 233)', () => {
  it('🔴 Word: 図を描くとき、紙の配色を求める', async () => {
    const calls: Call[] = [];
    expect(await exportEntryDocx(dispatcher, deps(calls), 'n1')).toBe(true);
    expect(calls.length, '図を 1 度も描いていない(前提が崩れている)').toBeGreaterThan(0);
    for (const c of calls) expect(c.paper, `${c.via}: 紙の配色を求めていない`).toBe(true);
  });

  it('🔴 PowerPoint も同じ', async () => {
    const calls: Call[] = [];
    expect(await exportEntryPptx(dispatcher, deps(calls), 'n1')).toBe(true);
    expect(calls.length, '図を 1 度も描いていない').toBeGreaterThan(0);
    for (const c of calls) expect(c.paper).toBe(true);
  });

  it('🔴 ベクタに起こせないときの PNG も、紙の配色を求める', async () => {
    const calls: Call[] = [];
    const d = deps(calls);
    d.renderFigureVector = async (_k, _s, paper) => {
      calls.push({ via: 'vector', paper });
      return null;
    };
    await exportEntryDocx(dispatcher, d, 'n1');
    expect(calls.map((c) => c.via)).toEqual(['vector', 'raster']);
    for (const c of calls) expect(c.paper).toBe(true);
  });

  it('対照群: 閲覧用 HTML は今までどおり画面の配色(紙の配色を求めない)', async () => {
    const calls: Call[] = [];
    expect(await exportEntry(dispatcher, deps(calls), 'n1', 'html'), '前提: 書き出せた').toBeGreaterThan(0);
    expect(calls.length, '閲覧用 HTML が図を描いていない(対照群が成り立たない)').toBeGreaterThan(0);
    for (const c of calls) expect(c.paper, `${c.via}: 閲覧用 HTML まで紙の配色にした`).toBeUndefined();
  });
});

describe('```svg の囲みは Word に図として入る(#1163 依頼 235)', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect x="2" y="2" width="36" height="16" fill="#336699"/></svg>';
  const bodyWithSvg = (): ArchiveSource => {
    const src = source();
    const body = '# 題\n\n```svg\n' + SVG + '\n```\n';
    return { ...src, listBodies: async () => ({ rows: [{ lid: 'n1', body }], done: true }), getBody: async () => body };
  };

  it('🔴 原文が SVG そのものなので描き器は呼ばず、書き出した文書に図(EMF)が入る', async () => {
    const calls: Call[] = [];
    const files: Array<{ name: string; blob: Blob }> = [];
    const d = { ...deps(calls), source: bodyWithSvg(), download: (name: string, blob: Blob) => void files.push({ name, blob }) };
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(calls.filter((c) => c.via === 'vector'), '原文が SVG なのに描き器を呼んだ').toEqual([]);
    expect(files, '書き出していない').toHaveLength(1);
    // zip の中の名前は圧縮されない ── 図の EMF が入っていること(「埋め込み枠」の 1 行だけになっていない)
    const bytes = new Uint8Array(await files[0]!.blob.arrayBuffer());
    const names = new TextDecoder('latin1').decode(bytes);
    expect(names, '図が文書に入っていない').toContain('media/figure1.emf');
  });
});
