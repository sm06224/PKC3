/**
 * 🔴 **囲み(フェンス)の中身を添付から取る**(#444 段①。user 裁定 2026-08-26)。
 *
 * > 「**PKC 内にすでに存在する HTML なら問題ないのでは?**」
 * > 「**HTML に限らずにフェンス内にアセットを呼び込むようにすればいいのでは?**」
 *
 * ```` ```csv asset:ast-xxxx ```` と書くと、囲みの中身を**その添付から**取る。
 *
 * ## なぜ HTML 専用にしないか
 *
 * ⚠ 起票時は「添付の HTML は script を走らせてよいか裁定が要る」と書いたが、
 *   **読まずに書いた**もので誤りだった ── ` ```html ` の箱は
 *   `sandbox="allow-scripts"`(`allow-same-origin` は付けない)/ `connect-src 'none'`
 *   の**1 つだけ**在る箱で、**字がどこから来たかを知らない**。本文に書いた HTML も
 *   添付の HTML も同じ箱に入るので、**新しい危険を 1 つも足さない**。
 * 🔑 だから html 専用の口を作らず、**囲み全部**に効く 1 つの規則にする
 *   (CLAUDE.md §7「判定を増やさない」)── csv でも同じ要望が出たときに
 *   2 本目が生えるのを止める。
 *
 * ## ここが持つのは**見出しの読み方だけ**
 *
 * 中身を読むのは adapter(IDB を持つ側)である ── ここは純関数のまま保つ。
 *
 * ## ⚠ 未参照の掃除は**心配しなくてよい**
 *
 * `features/asset/asset-ref-scan.ts` は「**本文のどこかに key が substring として
 * 現れるか**」で数えるので、見出しに書いた `asset:<key>` も**そのまま参照として
 * 数えられる**。規則を足す必要は無い(足すと §7 違反になる)。
 */

/** 見出しの `asset:` の読み方。⚠ 3 値 ── 「無い」と「書いてあるが読めない」を分ける。 */
export type FenceAssetParse =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly key: string; readonly rest: string }
  /** 書いてあるが使えない。⚠ **黙って素通りさせない** ── 理由を画面に出す。 */
  | { readonly kind: 'invalid'; readonly why: string };

/** 見出しに書く印。⚠ 本文の `![](asset:…)` と**同じ綴り**(2 つ目の書き方を作らない)。 */
export const FENCE_ASSET_PREFIX = 'asset:';

/**
 * 囲みの見出しの**言語より後ろ**(`rest`)から `asset:<key>` を 1 つ取り出す。
 *
 * ⚠ **大文字小文字は区別する** ── `markdown-render.ts` の
 *   `href.startsWith('asset:')` と同じ規則に揃える(2 つ目の規則を作らない)。
 * ⚠ **残りの語は残す** ── `csv noheader asset:k` も `csv asset:k noheader` も
 *   同じに読める(user に語順を覚えさせない)。
 */
export function takeFenceAsset(rest: string): FenceAssetParse {
  const words = rest.split(/\s+/).filter((w) => w !== '');
  const hits = words.filter((w) => w.startsWith(FENCE_ASSET_PREFIX));
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1)
    // ⚠ どちらを使うか決められない ── 勝手に片方を選ぶと、user は
    //   「書いたのに出ない」を追うことになる
    return { kind: 'invalid', why: `添付を ${hits.length} つ書いています(1 つにしてください)` };
  const key = hits[0]!.slice(FENCE_ASSET_PREFIX.length);
  if (key === '') return { kind: 'invalid', why: '添付の鍵が空です' };
  return {
    kind: 'one',
    key,
    rest: words.filter((w) => !w.startsWith(FENCE_ASSET_PREFIX)).join(' '),
  };
}

/**
 * 🔴 **中身を読み込む上限**(#444 段①)。
 *
 * ⚠ 配る量の話ではない(不可侵指示 2026-08-03「配る量は気にしない」)── これは
 *   **定常**の話である。50MB の字を `srcdoc` や表へ流し込むと、開くたびに
 *   その分を運ぶことになる。
 * ⚠ 超えたら**黙って切らない**。読み込まずに理由を出す(件数ではなく大きさで言う)。
 */
export const MAX_FENCE_ASSET_BYTES = 2 * 1024 * 1024;

/**
 * 画面に出す大きさ(「2.0MB」)。
 * 🔑 **実体は `features/asset/human-bytes.ts` の 1 本**(#454。2026-08-27 に寄せた)。
 * ⚠ ここに在った `formatBytes` は**同じ実装の 2 本目**だった ── 名前も 1 つにする
 *   (2 つ名前が在ると、片方だけ直しても誰も気づかない)。
 */
export { humanBytes } from '../asset/human-bytes';

/**
 * 🔴 **添付の字を「本文に書いてあったのと同じ形」に揃える**(#444 段②)。
 *
 * ⚠ markdown-it の囲みの中身は**必ず改行で終わる**(空の囲みだけが例外)。
 * 揃えないと、同じ添付でも**画面と書き出しで最後の 1 バイトがずれる** ──
 * 素のコード囲みは中身をそのまま `<code>` に流すので、実際に見た目に出る。
 * 🔑 揃える場所は**ここ 1 つ**にする ── 画面(`renderFenceFromAsset`)と
 *   書き出し(`fenceAssets`)の両方がこれを通る(CLAUDE.md §7)。
 */
export function asFenceContent(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}
