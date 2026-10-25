/** @vitest-environment happy-dom */
/**
 * 閲覧用 HTML の書き出し: 図(mermaid)とグラフは絵にして埋め込む(#1648 の 4)。
 * Word / PowerPoint / PDF では絵で出るのに、閲覧用 HTML だけ原文のコードで出ていた。
 */
import { describe, expect, it } from 'vitest';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { FigureBakers } from '../../src/features/export/figure-bake';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const NOW = '2026-10-17T00:00:00.000Z';

function source(body: string): ArchiveSource {
  const meta = {
    lid: 'n1', title: 'n1', archetype: 'text', created_at: null, updated_at: null,
    entry_order: 1, status: null, date: null, archived: 0,
  };
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => [meta],
    listBodies: async () => ({ rows: [{ lid: 'n1', body }], done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
  } as unknown as ArchiveSource;
}

async function entryHtml(body: string, figures?: FigureBakers) {
  const out = await writePortableHtml(
    source(body), NOW, (t, o) => renderMarkdown(t, o), false, undefined, undefined, undefined, figures,
  );
  const text = await out.blob.text();
  const data = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(text)![1]!;
  const html = (JSON.parse(data) as { entries: Array<{ html: string }> }).entries[0]!.html;
  return { html, warnings: out.warnings, whole: text };
}

const BODY = '図\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nグラフ\n\n```chart\n{"type":"bar"}\n```\n';

const bakers = (log: string[]): FigureBakers => ({
  vector: async (kind, src) => {
    log.push(`vector:${kind}:${src.length > 0 ? 'ok' : 'empty'}`);
    return kind === 'mermaid' ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>' : null;
  },
  raster: async (kind) => {
    log.push(`raster:${kind}`);
    return { blob: new Blob([new Uint8Array([137, 80, 78, 71])]), cssWidth: 100 };
  },
});

describe('閲覧用 HTML の図とグラフ(#1648)', () => {
  it('🔴 図は SVG の img、グラフは PNG の img として焼かれ、原文の器ではなくなる', async () => {
    const log: string[] = [];
    const { html, warnings } = await entryHtml(BODY, bakers(log));
    expect(html).toContain('<img alt="図" src="data:image/svg+xml;base64,');
    expect(html).toContain('<img alt="グラフ" src="data:image/png;base64,');
    // 閲覧側の script は、この属性を持つ器の中身を原文に戻す ── 絵にした器には残さない
    expect(html).not.toContain('data-pkc-mermaid-src');
    expect(html).not.toContain('data-pkc-chart-src');
    expect(log).toEqual(['vector:mermaid:ok', 'raster:chart']);
    // 原文の字で出る件数の注意は出ない
    expect(warnings.some((w) => w.includes('原文の字で出ます'))).toBe(false);
  });

  it('🔴 描けなかった図は器のまま残り、原文の字で出る件数に数えられる(黙って消さない)', async () => {
    const failing: FigureBakers = { vector: async () => null, raster: async () => null };
    const { html, warnings } = await entryHtml(BODY, failing);
    expect(html).toContain('data-pkc-mermaid-src');
    expect(html).toContain('data-pkc-chart-src');
    expect(html).not.toContain('<img alt="図"');
    expect(warnings).toContain('図(mermaid)1 件は、開いた先では原文の字で出ます');
    expect(warnings).toContain('グラフ 1 件は、開いた先では原文の字で出ます');
  });

  it('対照群:産出器を渡さなければ従来どおり原文の器(1 バイトも変わらない)', async () => {
    const { html } = await entryHtml(BODY);
    expect(html).toContain('data-pkc-mermaid-src');
    expect(html).not.toContain('data:image/');
  });

  it('図の無いノートでは産出器を 1 度も呼ばない', async () => {
    const log: string[] = [];
    const { html } = await entryHtml('ただの本文\n', bakers(log));
    expect(log).toEqual([]);
    expect(html).not.toContain('data:image/');
  });

  it('同じ原文の図は 1 回しか描かない', async () => {
    const log: string[] = [];
    const twice = '```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n';
    const { html } = await entryHtml(twice, bakers(log));
    expect(log).toEqual(['vector:mermaid:ok']);
    expect(html.match(/<img alt="図"/g)?.length).toBe(2);
  });

  it('🔴 plotly は chart と同じく絵に焼かれる / React は焼かず原文の字で出て、件数が注意に出る(#528)', async () => {
    const log: string[] = [];
    const body =
      '```plotly\n{"data":[{"y":[1]}]}\n```\n\n```react\nexport default function App(){ return <b>x</b>; }\n```\n';
    const { html, warnings, whole } = await entryHtml(body, bakers(log));
    // plotly は PNG の絵。属性は器から外れる(閲覧側の script が原文へ戻さない)
    expect(html).toContain('<img alt="グラフ" src="data:image/png;base64,');
    expect(html).not.toContain('data-pkc-plotly-src');
    expect(log).toEqual(['raster:plotly']);
    // React は閲覧側に React を積まないので、焼かない ── 器のまま残り、原文の字で出る件数に数える
    expect(html).toContain('data-pkc-react-src');
    expect(warnings).toContain('React のコード 1 件は、開いた先では原文の字で出ます');
    expect(warnings.some((w) => w.includes('plotly'))).toBe(false);
    // 閲覧側の script は plotly / React の器も原文へ戻す(焼けなかったときの受け皿)
    expect(whole).toContain("'data-pkc-plotly-src'");
    expect(whole).toContain("'data-pkc-react-src'");
  });

  it('🔴 描けなかった plotly は器のまま残り、件数が注意に出る', async () => {
    const { html, warnings } = await entryHtml(
      '```plotly\n{"data":[{"y":[1]}]}\n```\n',
      { vector: async () => null, raster: async () => null },
    );
    expect(html).toContain('data-pkc-plotly-src');
    expect(warnings).toContain('グラフ(plotly)1 件は、開いた先では原文の字で出ます');
  });

  it('閲覧側の script が、絵にした器を原文へ戻さない(器から印の属性が無い)', async () => {
    const { whole } = await entryHtml(BODY, bakers([]));
    // 閲覧側は属性の有無で拾う。焼いた器の側に無いことは上で見た ── ここでは絵の幅の規則が配られることを見る
    expect(whole).toContain('[data-pkc-figure-baked] img{max-width:100%');
  });
});
