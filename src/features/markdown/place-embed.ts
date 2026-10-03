/**
 * 🔴 **板に置いたノートの中身を、読み取り専用で描く**(#529 W3-①)── 規則だけの pure な側。
 *
 * ## 何が起きるか(画面の言葉)
 *
 * `:::format{.pkc-place entry=ノートのID}` の塊は、これまで**題名のボタン 1 個**だった。
 * いまは**その下に、置いたノートの本文が(読むだけの形で)出る**。押せるのは題名の帯
 * (今の窓でそのノートを開く)だけで、チェックや表のセルは押せない。
 *
 * ## ⚠ 裁定(2026-08-19 Q1「展開はしない」)を覆している
 *
 * 設計 doc §6 / §8 の W3。覆す条件(PKC2 の transclusion が持っていた制約)を引き継ぐ:
 * **深さ ≤ 1**(置いたノートの中の板は展開せず題名だけの行へ降ろす)/ **id は枠ごとの接頭辞つきで残す**
 * (`place-<n>-`。素の id だと host の目次ジャンプと衝突する ── `adapter/ui/render/place-embed.ts` の
 * `sanitizeEmbedded`)/ チェック・表は**読み取り専用**(押せる旗を渡さない)/
 * **自分自身を置いた塊は展開しない**(循環は深さ ≤ 1 が既に止める)。
 *
 * ## 🔑 ここが持つのは「画面に出す量・大きさ」の定数と、型で決める関数だけ
 *
 * どれも描く側(`adapter/ui/render/place-embed.ts`)と状態(`app-state.ts`)が
 * **同じ値・同じ判定**を読む(§7 ── 2 か所に書かない)。数の根拠は
 * `docs/development/place-embed-measure-2026-10.md`(W3-③ の実測)。
 */
import { bodyBelowFrontmatter } from './frontmatter';
import { readAttachmentMeta } from '../flavor/attachment-flavor';
import { assetPreviewKind } from '../asset/asset-preview-kind';

/**
 * 🔴 **entry= の塊に w= / h= が無いときの大きさ**(px)。
 *
 * ⚠ 中身で板を伸ばさない ── 板は絶対配置で、線(`from=` / `to=`)は**塊の大きさ**から
 *   端点を決める。中身の長さで大きさが決まると、本文を直すたびに線が動く。
 *   🔑 だから**固定の既定**を持ち、収まらない分は塊の中で送る(`overflow: auto`)。
 * 理由の数字:320×240 は、付箋の既定(`w=240 h=120`、右クリックで置く形)より一回り大きく、
 *   見出し + 10 行ほどの本文 + 表 1 つが**送らずに**見える大きさ。⚠ 測って決めた値ではない。
 */
export const PLACE_ENTRY_DEFAULT_W = 320;
export const PLACE_ENTRY_DEFAULT_H = 240;

/**
 * 🔴 **板に出す本文の長さ**(字数)。
 *
 * 長い本文は先頭からこの量で切り、末尾に「続きは元のノートで」と出す(設問 1 = A)。
 * ⚠ 4,000 を動かさない理由は `docs/development/place-embed-measure-2026-10.md`(W3-③)。
 */
export const PLACE_BODY_CLIP = 4000;

/**
 * 🔴 **板のために持っておく本文の数**(上限)。
 *
 * ⚠ 状態に載せるのは**切った本文**(`PLACE_BODY_CLIP` 字まで)なので、全部埋まっても
 *   200 × 4,000 字 = 約 800K 字(UTF-16 で 1.6MB)で、**大きなノートを 1 件置いても常駐は増えない**
 *   (全文を持たない ── 2026-07-27「生成物のライフサイクル終端での即破棄」)。
 *   超えたら古い物から手放す(手放した物は、板が描き直されるときに読み直す)。
 * 🔴 **板 1 枚に置いて中身が出るのは、先頭から 200 枚まで**(それより後ろは題名の帯だけ)。
 *   40 だった頃は、板に 100 枚置くと**どの 40 枚に中身が出るかが開くたびに変わった**
 *   (頼む数だけ上限で切られ、手放した物を頼み直していた ── 実測は上の doc)。
 *   200 は**測った範囲**(N = 200 まで)で、それ以上は測っていない。
 */
export const PLACE_BODY_CAP = 200;

/**
 * 🔴 **画面からこの距離(px)までに近づいた枠から、中身を描く**(スクロールに追従する余白)。
 *
 * 板の中身(本文・図・画像)は**近づいた枠から**描く(図の「見えたとき」と同じ作法)。離れた枠は帯だけで、
 * **一度描いた枠は離れても捨てない**(捨てると、作り直すたびに画像を読み直してブラウザの控えが積もる ──
 * 実測は `docs/development/place-embed-measure-2026-10.md`)。
 * 800 は画面 1 つ分ほど先 ── 枠 320 × 240 で、スクロール 1 回ぶんが先に描かれている余白。
 */
export const PLACE_NEAR_MARGIN = 800;

/**
 * 🔴 **枠の中の SQL の囲み(` ```sql embed `)の答えの代わりに出す 1 行**(#529 Q2 = B。Gemini 裁定 2026-10-02)。
 * ⚠ 枠は読み取り専用の抜粋で、**答えを引かない**(保存と同じ worker を叩くので、200 枚の板が
 *   開くたびに 200 回走ると保存を待たせる)。理由を言わないと、**SQL の字だけが出て答えが無い**ので
 *   「壊れた」に見える ── だから黙って空にせず、開けば出ることを言う。
 */
export const PLACE_SQL_NOTE = 'ここでは答えを出しません(ノートを開くと出ます)';
/** 上の 1 行の器。⚠ 本文の `data-pkc-sql-embed` は**付けない**(付けると本文の描画が掴んで答えを引く)。 */
export const PLACE_SQL_FIELD = 'place-sql-note';

/**
 * 🔴 **置いた添付ノートのうち、板に絵を出せる物**(#529 W3-②。Gemini 裁定 2026-10-01 Q2 = A)。
 *
 * - `image` = 画像そのものを枠いっぱいに描く(`object-fit: contain`)
 * - `pdf` = **題名の帯 + 「PDF」の字**だけ。⚠ 1 ページ目は描かない ── PKC3 に PDF を絵にする描画器は無く
 *   (添付の面は**ブラウザ内蔵のビューア**を `<object>` で埋めるだけ)、板に N 枚置くたびに
 *   ビューアを N 個立てるのは、描画のたびに別プロセスを抱える作りになる(依存を足す話は別の裁定)。
 * ⚠ Office・zip・その他は**ここに入らない**(`att` が無い = 題名の帯だけ。W3-① のまま)。
 */
export interface PlaceAttachment {
  readonly key: string;
  readonly mime: string;
  readonly kind: 'image' | 'pdf';
}

/** 板に出す分 ── 切った本文と、切ったかどうか。 */
export interface PlaceExcerpt {
  readonly text: string;
  /** `true` = 続きがある(描く側が「続きは元のノートで」を足す)。 */
  readonly cut: boolean;
  /** 添付ノートで、絵(または PDF の字)を出せる物。⚠ 添付以外では**必ず無い**。 */
  readonly att?: PlaceAttachment;
}

/**
 * このノートの中身を**読んでよいか**(型で決める)。
 *
 * ⚠ **フォルダ**は本文を持たない(出すと永久に空)── **題名の行だけ**にする。
 * ⚠ **添付**は読む(本文は frontmatter だけで小さい)── 絵を出せるかは**読んだ後**に分かる
 *   (`excerptOf` が `att` を付ける)。出すかどうかは `placeFramed` / 描く側が決める。
 * 🔑 状態(読むかどうか)と描く側(出すかどうか)が**同じ 1 本**を通る ── 別々に書くと、
 *   読んだのに出さない / 出すのに読んでいない、が起きる(§7)。
 */
export function placeEmbeddable(archetype: string): boolean {
  return archetype !== 'folder';
}

/**
 * 🔴 **この塊に既定の大きさ(320×240)を当てるか**。
 *
 * - 本文を出す型 → 常に当てる(中身で板を伸ばさない)
 * - 添付 → **絵を出せる画像のときだけ**(読むまでは分からない = 読み終えた後に置き直す)。
 *   PDF・Office・その他は今までどおり中身の大きさ(題名の帯だけ)
 * - フォルダ → 当てない
 */
export function placeFramed(archetype: string, excerpt: PlaceExcerpt | undefined): boolean {
  if (archetype === 'folder') return false;
  if (archetype === 'attachment') return excerpt?.att?.kind === 'image';
  return true;
}

/** 2 つの切り出しが同じ内容か(状態の指紋を無駄に動かさない)。 */
export function sameExcerpt(a: PlaceExcerpt, b: PlaceExcerpt): boolean {
  return (
    a.cut === b.cut &&
    a.text === b.text &&
    a.att?.key === b.att?.key &&
    a.att?.mime === b.att?.mime &&
    a.att?.kind === b.att?.kind
  );
}

/**
 * ノートの本文から、板に出す分を切り出す。
 *
 * - frontmatter は**描かない**(`bodyBelowFrontmatter` ── 本文の面と同じ 1 本)
 * - `PLACE_BODY_CLIP` 字以内ならそのまま(`cut: false`)
 * - 超えたら、**その手前の最後の改行**で切る(表や箇条書きの行を途中で割らない)。
 *   改行が前半に無い(長い 1 行)ときだけ字数で切る。⚠ サロゲートペアは割らない。
 * - 🔴 **添付ノートは本文(説明文)を出さない**(`text` は空)── 出すのは絵だけ。
 *   `archetype` を渡さない呼び出し(= 添付ではない)は今までどおり。
 */
export function excerptOf(body: string, archetype?: string): PlaceExcerpt {
  if (archetype === 'attachment') {
    const meta = readAttachmentMeta(body);
    const kind = assetPreviewKind(meta.mime);
    if (meta.assetKey === null || (kind !== 'image' && kind !== 'pdf')) return { text: '', cut: false };
    return { text: '', cut: false, att: { key: meta.assetKey, mime: meta.mime, kind } };
  }
  const below = bodyBelowFrontmatter(body);
  if (below.length <= PLACE_BODY_CLIP) return { text: below, cut: false };
  const nl = below.lastIndexOf('\n', PLACE_BODY_CLIP);
  let end = nl > PLACE_BODY_CLIP / 2 ? nl : PLACE_BODY_CLIP;
  // 🔑 切り口が上位サロゲート(絵文字の前半分)で終わるなら、1 字戻す
  const last = below.charCodeAt(end - 1);
  if (end === PLACE_BODY_CLIP && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: below.slice(0, end), cut: true };
}
