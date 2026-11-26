/**
 * CSS の色の値(テーマの変数など)を `#rrggbb` に揃える ── canvas / WebGL へ渡す色の 1 か所
 * (3D ビューア `viewer-3d.ts` と関係グラフの GPU 表示 `graph-gpu.ts` が共有する)。
 */
/** CSS の色の値を `#rrggbb` にする(読めなければ `null`)。 */
export function cssColorToHex(doc: Document, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  // ⚠ canvas の fillStyle は色を `#rrggbb` / `rgba(…)` に揃えて返す(oklch などの新しい書き方も)
  try {
    const ctx = doc.createElement('canvas').getContext('2d');
    if (ctx === null) return null;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = v;
    const out = String(ctx.fillStyle);
    if (/^#[0-9a-f]{6}$/i.test(out)) return out.toLowerCase();
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(out);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    /* 読めない ── 既定の色にする */
  }
  return null;
}
