import { logSegments } from './log-order';

/**
 * 🔴 **ログの「1 件 = 1 カード」の区切り**(B 試作。user 裁定 2026-11-22 =「包む div を足さない CSS 方式」)── pure。
 *
 * 本文は平らな DOM のまま(並べ替え・畳み・移動・差分描画がこの前提で動いている)なので、カードは**塊ごとの印**で描く。
 * この関数は、塊ごとに「その記録のカードの中で、どの位置か」を返す。
 *
 * - `first` / `mid` / `last` / `solo`: 記録(段 1〜2 の見出し〜次の段 1〜2 の見出しの手前。入れ子 `###`〜 を含む)の先頭 / 途中 / 末尾 / 単独
 * - `none`: 記録の外(最初の見出しより前の前置き)── カードにしない
 *
 * 🔑 **見えている塊だけで数える**: 畳んだ記録(見出しだけが見える)は `solo`、中身の一部が隠れても見えている最後の塊が `last`。
 *   でないと、隠れた塊に「末尾」が付いて、カードの下の角丸・余白が消える。
 * 🔑 記録の区切りは `logSegments`(並べ替え・日の行と同じ 1 つの数え方)。降順(CSS の `order`)でも記録内の DOM の並びは
 *   見た目と同じなので、先頭 / 末尾は DOM のままで正しい。
 *
 * @param levels 塊ごとの見出しの段(見出しでなければ 0)
 * @param hidden 塊ごとに「隠れているか」(省略 = 全部見えている)
 */
export type LogCardEdge = 'none' | 'solo' | 'first' | 'mid' | 'last';

export function logCardEdges(levels: readonly number[], hidden?: readonly boolean[]): LogCardEdge[] {
  const { seg } = logSegments(levels);
  const out: LogCardEdge[] = new Array<LogCardEdge>(levels.length).fill('none');
  let i = 0;
  while (i < levels.length) {
    const s = seg[i] ?? 0;
    let j = i;
    while (j < levels.length && (seg[j] ?? 0) === s) j += 1;
    if (s > 0) {
      const visible: number[] = [];
      for (let k = i; k < j; k += 1) if (hidden?.[k] !== true) visible.push(k);
      if (visible.length === 1) out[visible[0]!] = 'solo';
      else if (visible.length > 1) {
        visible.forEach((k, n) => {
          out[k] = n === 0 ? 'first' : n === visible.length - 1 ? 'last' : 'mid';
        });
      }
    }
    i = j;
  }
  return out;
}
