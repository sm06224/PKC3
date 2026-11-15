/** @vitest-environment happy-dom */
/**
 * #1163 依頼 369(推薦 A): 大きすぎる mermaid 図に「書き方を確かめて」ではなく正しい理由を出す。
 *
 * ⚠ mermaid 本体を happy-dom で通して、**実物の上限の振る舞い**(線は投げる / 字は代わりの図を返す)を
 *   見分けられるかを確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  configFor,
  diagramTooLargeText,
  isEdgeLimitError,
  isTextLimitSvg,
  MERMAID_MAX_EDGES,
  MERMAID_MAX_TEXT,
} from '../../src/adapter/ui/render/mermaid-raster';

const palette = { bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false };

describe('大きすぎる図の理由(依頼 369)', () => {
  it('画面の字は定数から組む(線 500 本 / 原文 5 万字)', () => {
    expect(diagramTooLargeText()).toBe('図が大きすぎて描けません(線は 500 本、原文は 5 万字まで)');
    expect(diagramTooLargeText()).toContain(String(MERMAID_MAX_EDGES));
  });
  it('mermaid に渡す上限は同じ定数', () => {
    const c = configFor(palette) as { maxEdges?: number; maxTextSize?: number };
    expect(c.maxEdges).toBe(MERMAID_MAX_EDGES);
    expect(c.maxTextSize).toBe(MERMAID_MAX_TEXT);
  });
  it('線の上限: mermaid の投げる字を見分ける(構文エラーは見分けない)', () => {
    expect(isEdgeLimitError(new Error('Edge limit exceeded. 501 edges found, but the limit is 500.'))).toBe(true);
    expect(isEdgeLimitError(new Error('Parse error on line 1'))).toBe(false);
    expect(isEdgeLimitError('Edge limit exceeded.')).toBe(false);
  });
  it('字の上限: 原文が上限を超え、代わりの図が返ったときだけ', () => {
    const fake = '<svg><text>Maximum text size in diagram exceeded</text></svg>';
    expect(isTextLimitSvg('x'.repeat(MERMAID_MAX_TEXT + 1), fake)).toBe(true);
    // 対照群: 原文が短いのに同じ字を図に書いた(user が書いた字)なら止めない
    expect(isTextLimitSvg('graph TD; a[Maximum text size in diagram exceeded]', fake)).toBe(false);
    expect(isTextLimitSvg('x'.repeat(MERMAID_MAX_TEXT + 1), '<svg><text>ok</text></svg>')).toBe(false);
  });

  it('実物の mermaid: 線が上限を超えると Edge limit exceeded を投げる', async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ ...configFor(palette), startOnLoad: false });
    const lines = ['graph TD'];
    for (let i = 0; i <= MERMAID_MAX_EDGES; i += 1) lines.push(`  n${String(i)} --> n${String(i + 1)}`);
    let err: unknown = null;
    try {
      await mermaid.render('t369', lines.join('\n'));
    } catch (e) {
      err = e;
    }
    expect(err, '上限を超えても投げなかった(mermaid の振る舞いが変わった)').not.toBeNull();
    expect(isEdgeLimitError(err), String(err)).toBe(true);
  }, 30_000);
});
