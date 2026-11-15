/** @vitest-environment happy-dom */
/**
 * #1163 依頼 369: `renderWith` が mermaid の上限の 2 つの止まり方を `DiagramTooLargeError` へ変えるか
 * (着地前レビュー ⚠1 ── 述語だけを見て、変える 2 行がどの test からも通っていなかった)。
 * 🔑 mermaid を差し替えて `renderToSvg`(= `renderWith` を通る口)を直に呼ぶ。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const render = vi.fn<(id: string, src: string) => Promise<{ svg: string }>>();
vi.mock('mermaid', () => ({ default: { initialize: () => undefined, render: (id: string, src: string) => render(id, src) } }));

import {
  DiagramTooLargeError,
  MERMAID_MAX_TEXT,
  renderToSvg,
} from '../../src/adapter/ui/render/mermaid-raster';

const palette = { bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false };
const MARKER_SVG = '<svg><text>Maximum text size in diagram exceeded</text></svg>';

describe('renderWith の上限の変換(依頼 369)', () => {
  beforeEach(() => render.mockReset());

  it('🔴 原文が上限を超え、代わりの図が返ったら DiagramTooLargeError(英語の箱を焼かない)', async () => {
    render.mockResolvedValueOnce({ svg: MARKER_SVG });
    await expect(renderToSvg('x'.repeat(MERMAID_MAX_TEXT + 1), palette)).rejects.toBeInstanceOf(DiagramTooLargeError);
  });

  it('🔴 線の上限で投げられたら DiagramTooLargeError(「書き方を確かめて」にしない)', async () => {
    render.mockRejectedValueOnce(new Error('Edge limit exceeded. 501 edges found, but the limit is 500.'));
    await expect(renderToSvg('graph TD\n a-->b', palette)).rejects.toBeInstanceOf(DiagramTooLargeError);
  });

  it('⚠ 対照群 ── ふつうの図は素通り / 構文エラーはそのまま投げる', async () => {
    render.mockResolvedValueOnce({ svg: '<svg><text>ok</text></svg>' });
    await expect(renderToSvg('x'.repeat(MERMAID_MAX_TEXT + 1), palette)).resolves.toContain('ok');
    render.mockRejectedValueOnce(new Error('Parse error on line 1'));
    const e = await renderToSvg('graph TD\n a--', palette).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DiagramTooLargeError);
  });
});
