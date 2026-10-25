/**
 * 🔴 **本文のアイコン(`:home:`)を PNG に焼く**(#853。Word に画像で埋める)。
 *
 * 画面の絵は「書体(`PKC Symbols`)+ `icons.generated.css` の符号位置(`::before` = 下地 / `::after` = 線)」
 * なので、**同じ書体・同じ符号位置**から描く(別の絵を持たない)。符号位置は実 DOM の
 * `getComputedStyle(…, '::before').content` から読む ── 生成 CSS が 1 本の正本のまま。
 * ⚠ 紙(Word)は白地なので、黒の線と薄い黒の下地で描く(画面の配色には依らない)。
 * ⚠ 生成物(canvas / 器の span)はこの関数の中で手放す(呼び側へ渡すのは PNG の Blob だけ)。
 */

/** `getComputedStyle(…, '::before').content` の値(`""` の引用符つき)から字を取る。無ければ `null`。 */
export function glyphOfContent(content: string): string | null {
  const c = content.trim();
  if (c === '' || c === 'none' || c === 'normal') return null;
  const q = c[0];
  const inner = (q === '"' || q === "'") && c.length >= 2 && c.endsWith(q) ? c.slice(1, -1) : c;
  return inner === '' ? null : inner;
}

const FAMILY = "'PKC Symbols'";

export async function rasterizeIcon(
  name: string,
  /** 文書に置く 1 辺(CSS px)。 */
  px = 18,
  /** 画素の倍率(紙に載るので端末によらず固定)。 */
  scale = 4,
): Promise<{ blob: Blob; px: number } | null> {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const host = document.createElement('span');
  host.setAttribute('data-pkc-icon', '');
  host.setAttribute('data-pkc-symbol', name);
  host.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);
  let under: string | null;
  let line: string | null;
  try {
    under = glyphOfContent(getComputedStyle(host, '::before').content);
    line = glyphOfContent(getComputedStyle(host, '::after').content);
  } finally {
    host.remove();
  }
  if (under === null || line === null) return null;
  // ⚠ 書体が届く前に描くと豆腐になる(`font-display: block` と同じ理由) ── 読み込みを待つ
  try {
    await document.fonts.load(`16px ${FAMILY}`, under + line);
  } catch {
    return null;
  }
  if (!document.fonts.check(`16px ${FAMILY}`, under + line)) return null;
  const size = Math.round(px * scale);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  try {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.font = `${Math.round(size * 0.9)}px ${FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.globalAlpha = 0.2;
    ctx.fillText(under, size / 2, size / 2);
    ctx.globalAlpha = 1;
    ctx.fillText(line, size / 2, size / 2);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    return blob === null ? null : { blob, px };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
