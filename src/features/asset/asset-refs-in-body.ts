/**
 * 🔴 **本文が使っている添付を、本文に出てくる順に数え上げる**(#1170)。
 *
 * 右の列(情報)の「添付」の行の元になる。押すと本文のその位置へ飛ぶので、
 * **「どの添付が、本文のどこで使われているか」**を返す。
 *
 * ## `asset-ref-scan.ts` との違い(役割が逆)
 *
 * | | 走査(`assetRefsIn`) | ここ |
 * |---|---|---|
 * | 問い | 「この key を**含むか**」(候補を渡す) | 「**何を**、**どこで**使っているか」(候補が無い) |
 * | 誤差の向き | **keep 側**(広く拾う) | **描かれる物だけ**(狭く拾う) |
 *
 * ⚠ 走査の規則(substring)をここへ流用してはならない ── 散文の中に key が偶然現れた
 *   だけの場所に「飛び先の行」を作ってしまい、押しても何も光らない。
 * 🔑 だから**描く側と同じ読み手**(markdown-it)に token へ割らせ、
 *   描かれる 3 形(画像 / リンク / 囲みの見出し)だけを拾う。
 *   **コードの囲み・インラインコードの中の `asset:` は参照ではない**(描かれない)ので入らない。
 * ⚠ `asset:` の綴りは `fence-asset.ts` の `FENCE_ASSET_PREFIX` が**正本**(本文の画像 /
 *   リンクの描画も同じ綴り)── ここで 2 つ目を書かない。
 *
 * ⚠ **pure module**。
 */
import { FENCE_ASSET_PREFIX } from '../markdown/fence-asset';
import { fenceAssetOfInfo, parseMarkdownTokens } from '../markdown/markdown-render';

export type AssetUseKind = 'image' | 'link' | 'fence';

export interface AssetUse {
  readonly key: string;
  /** 本文に書かれた表示名(画像の alt / リンクの字 / 囲みの見出しの残り)。空なら呼び側が key で代える。 */
  readonly label: string;
  /** **最初の**出現の 1 始まりの行(前処理前の原文)。 */
  readonly line: number;
  /** **最初の**出現の形。 */
  readonly kind: AssetUseKind;
  /** 本文での出現数(同じ key を何度使っているか)。 */
  readonly count: number;
}

/**
 * 本文の添付参照を **key ごとに 1 件**、**最初に出てくる順**で返す。
 * 同じ key を何度使っていても 1 行(`count` に回数)。参照が無ければ `[]`。
 */
export function listAssetUses(body: string): AssetUse[] {
  // ⚠ 早い切り上げ ── `asset:` の字が 1 つも無い本文(大半)で token へ割らない
  if (!body.includes(FENCE_ASSET_PREFIX)) return [];
  const order: string[] = [];
  const byKey = new Map<
    string,
    { label: string; line: number; kind: AssetUseKind; count: number }
  >();
  const note = (key: string, label: string, line: number, kind: AssetUseKind): void => {
    if (key === '') return;
    const hit = byKey.get(key);
    if (hit) {
      hit.count += 1;
      return;
    }
    byKey.set(key, { label, line, kind, count: 1 });
    order.push(key);
  };
  for (const token of parseMarkdownTokens(body)) {
    const line = (token.map?.[0] ?? 0) + 1;
    if (token.type === 'fence') {
      const { parse } = fenceAssetOfInfo((token.info ?? '').trim());
      if (parse.kind === 'one') note(parse.key, parse.rest, line, 'fence');
      continue;
    }
    if (token.type !== 'inline' || token.children === null) continue;
    const kids = token.children;
    for (let i = 0; i < kids.length; i++) {
      const t = kids[i]!;
      if (t.type === 'image') {
        const src = String(t.attrGet('src') ?? '');
        if (src.startsWith(FENCE_ASSET_PREFIX)) {
          note(src.slice(FENCE_ASSET_PREFIX.length), t.content ?? '', line, 'image');
        }
      } else if (t.type === 'link_open') {
        const href = String(t.attrGet('href') ?? '');
        if (!href.startsWith(FENCE_ASSET_PREFIX)) continue;
        // ⚠ ラベルの拾い方は描く側(`link_open` rule)と同じ ── text / code_inline だけ連ねる
        let label = '';
        for (let j = i + 1; j < kids.length; j++) {
          const u = kids[j]!;
          if (u.type === 'link_close') break;
          if (u.type === 'text' || u.type === 'code_inline') label += u.content;
        }
        note(href.slice(FENCE_ASSET_PREFIX.length), label, line, 'link');
      }
    }
  }
  return order.map((key) => {
    const v = byKey.get(key)!;
    return { key, label: v.label, line: v.line, kind: v.kind, count: v.count };
  });
}
