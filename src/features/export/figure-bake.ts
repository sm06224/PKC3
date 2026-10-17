/**
 * 🔴 **閲覧用 HTML に、図とグラフを絵として埋め込む**(#1648 の 4。Gemini 裁定 = 推薦 B)。
 *
 * Word / PowerPoint / PDF では絵で出るのに、閲覧用 HTML だけ原文のコードで出ていた
 * (開く側に mermaid / chart.js を積まないため)。同じノートを 3 通りで渡したとき、
 * 受け取る人には HTML だけ見え方が違う理由が分からない ── 書き出すときに絵にして埋め込む。
 *
 * ## 作り
 *
 * - 図(mermaid)は SVG、グラフは PNG を **`<img src="data:…">` 1 枚**にして置く。
 *   🔑 inline の `<svg>` にしない ── 図ごとの id・style が他の図や本文に漏れず、
 *   絵の中に script が入っていても動かない(`<img>` は script を走らせない)。
 * - 描くのは**画面と同じ産出器**(`ExportDeps.renderFigureVector` / `renderFigure`)── 別に描かない。
 * - 描けなかった図・グラフは**器をそのまま残す**(= 閲覧側が原文の字で出し、件数も注意に数える)。
 *   黙って消さない。
 * - 同じ原文は 1 回しか描かない。描くのは直列(メインスレッドを奪い合わない)。
 * - 器が 0 個なら**何も呼ばない**(図の無いノートの書き出しは 1 バイトも変わらない)。
 *
 * ⚠ 絵にした器からは `data-pkc-mermaid-src` / `data-pkc-chart-src` を**外す**。閲覧側の script は
 *   この 2 つの属性を持つ器の中身を原文に戻すので、残すと絵が消える。原文は `data-pkc-figure-src` に残す。
 */

export interface FigureBakers {
  /** 図(mermaid)を SVG の字にする。`null` = 描けない。 */
  readonly vector: (kind: string, source: string) => Promise<string | null>;
  /** グラフ等を PNG にする。`null` = 描けない。 */
  readonly raster: (kind: string, source: string) => Promise<{ blob: Blob; cssWidth: number } | null>;
}

/** `markdown-render.ts` が出す器(mermaid / chart)。属性の値は HTML の escape 済み。 */
const FIGURE_RE =
  /<div class="pkc-(mermaid|chart)-placeholder" data-pkc-(?:mermaid|chart)-src="([^"]*)" data-pkc-md-block-kind="(?:mermaid|chart)"><pre[^>]*><code[^>]*>[\s\S]*?<\/code><\/pre><\/div>/g;

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

function utf8Base64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/** 描いた絵の `<img>`(原文は `alt` に入れない ── 長いので `data-pkc-figure-src` へ)。 */
async function bakeOne(kind: 'mermaid' | 'chart', source: string, bakers: FigureBakers): Promise<string | null> {
  if (kind === 'mermaid') {
    const svg = await bakers.vector('mermaid', source).catch(() => null);
    if (svg !== null && svg.trim() !== '') {
      return `<img alt="図" src="data:image/svg+xml;base64,${utf8Base64(svg)}">`;
    }
  }
  // グラフ(chart.js は canvas に描くのでベクタ源が無い)と、SVG にできなかった図は PNG で
  const drawn = await bakers.raster(kind, source).catch(() => null);
  if (drawn === null) return null;
  const bytes = new Uint8Array(await drawn.blob.arrayBuffer());
  if (bytes.length === 0) return null;
  const alt = kind === 'chart' ? 'グラフ' : '図';
  return `<img alt="${alt}" src="data:image/png;base64,${toBase64(bytes)}">`;
}

/**
 * 本文の HTML の中の図・グラフの器を、絵にして置き換える。
 * @param cache 呼び出しをまたいで使い回す(同じ原文を 1 回しか描かない)。⚠ 値は絵の `<img>` か、描けなかった印(`null`)
 */
export async function bakeFigures(
  html: string,
  bakers: FigureBakers,
  cache: Map<string, string | null>,
): Promise<string> {
  if (!html.includes('-placeholder')) return html;
  const hits = [...html.matchAll(FIGURE_RE)];
  if (hits.length === 0) return html;
  for (const m of hits) {
    const kind = m[1] as 'mermaid' | 'chart';
    const source = unescapeAttr(m[2] ?? '');
    const key = `${kind}\n${source}`;
    if (cache.has(key)) continue;
    cache.set(key, await bakeOne(kind, source, bakers));
  }
  return html.replace(FIGURE_RE, (whole, kind: string, escaped: string) => {
    const img = cache.get(`${kind}\n${unescapeAttr(escaped)}`);
    if (img === undefined || img === null) return whole;
    return `<div class="pkc-${kind}-placeholder" data-pkc-figure-src="${escaped}" data-pkc-md-block-kind="${kind}" data-pkc-figure-baked="${kind}">${img}</div>`;
  });
}
