/**
 * タグ(#182 / 台帳 #180 の A-2)。
 *
 * 🔴 **新しい概念を足さない。** PKC3 は frontmatter が本文の中にあるので、
 * タグは `tags: [買い物, 家事]` と**書けば済む** ── PKC2 のように record へ
 * `tags?: string[]` という別の場所を作らない(founding「JSON 文字列 body を作らない」
 * と同じ向き)。
 *
 * ⚠ **フレーバー固有ではない。** todo にも text にも添付にも付けられる ──
 * だから `FlavorSpec.extract`(フレーバーごと)ではなく、**保存経路で 1 回**
 * 呼ぶ独立の関数にする。フレーバーごとに書くと、書き忘れたフレーバーだけ
 * タグが効かない(§7 の型)。
 */
import { parseFrontmatter } from '@features/markdown/frontmatter';
import { hashRunWords, strandedHashWords } from './tag-words';

/** 1 ノートのタグ数の上限。⚠ 上限が無いと、事故った本文が一覧を埋め尽くす。 */
export const MAX_TAGS = 32;
/** 1 タグの長さの上限(文字)。 */
export const MAX_TAG_CHARS = 40;

/**
 * タグを正規化する。⚠ **前後の空白を落とし、小文字化しない** ──
 * 日本語に大小は無く、英語のタグは user が書いたとおりに見せたい。
 * 突き合わせだけ `toLowerCase()` する(`sameTag`)。
 */
function normalize(raw: string): string {
  /**
   * 🔴 **先頭の井桁は落とす**(2026-08-29 の動線レビュー。実測で確認)。
   *
   * ⚠ 本文では **`#買い物`** という札で見えるのに、情報ペインやスマートフォルダの
   *   条件では **`買い物`**(井桁なし)で出る ── **見えている字をそのまま打つと
   *   `#買い物` という別のタグが作られて**いた(集計では別の組、条件には入らない)。
   *   書けてしまうので、どこにも理由が出ない。
   * 🔑 だから**打つ側で受け止める** ── 井桁は付けても付けなくても同じタグにする。
   * ⚠ 本文のタグ行から来る名前は `parseTagLine` が既に井桁を外しているので、
   *   ここは**打った字**にだけ効く(綴りの正本は 1 つのまま)。
   */
  // ⚠ 井桁が空白を挟んで続く形(`# #買い物`)も落とす ── `/^#+/` だけだと
  //    **`#買い物` という井桁つきの名前**が残る(2026-08-29 に直したはずの形が戻る)
  return raw.trim().replace(/^[#\s]+/u, '').trim().replace(/\s+/g, ' ');
}

/**
 * 🔴 **1 本の字を、いくつのタグとして読むか**(#637。user 裁定 2026-08-31)。
 *
 * > 「**#tag1 #tag2 ってすればいいやん**」
 *
 * ⚠ この 1 行で、それまでの案(カンマ・読点・セミコロンを足す)は**取り下げた** ──
 * 区切りを 3 つ足すより、**user が実際に書く形を 1 つ通す**ほうが強い。
 *
 * ## 規則は 1 つ:**井桁が付いていれば、空白で区切る**
 *
 * | 打った字 | 何個 | なぜ |
 * |---|---|---|
 * | `#買い物 #家事` | **2** | 全部の語が `#` で始まる = 並べて書いている |
 * | `買い物 家事` | **1**「買い物 家事」 | 🔴 **空白入りのタグは意図である**(下記) |
 * | `買い物, 家事` | **2** | frontmatter が元から受けていた形(落とさない) |
 * | `#買い物` | **1** | 語が 1 つなら井桁を外すだけ |
 *
 * 🔴 **空白だけでは割らない。** 空白入りのタグ名は事故ではなく意図で、
 * `tests/features/tags.test.ts` と `bulk-tag.test.ts` が pin している。
 * ⚠ しかも `encodeTags`(下)は索引の `|` を**空白へ変換する**ので、
 *   こちら自身が空白入りの名前を**作る側**に居る ── 空白で割ると自分の索引を割る。
 * 🔑 井桁が**全部の語に付いている**ときだけ割れば、その心配が消える。
 *
 * ⚠ **判定はここ 1 か所**(§7)── 打つ欄も frontmatter もここを通す。
 *   欄だけに split を書くと、同じ字が場所によって 1 個にも 2 個にもなる。
 */
export function splitTags(raw: string): string[] {
  const s = raw.trim();
  if (s === '') return [];
  // 🔑 **井桁の並びかどうかは `hashRunWords` 1 か所**(#637 の着地前レビュー B)──
  //    ここに 2 本目の判定を書くと、同じ字が欄と `tags:` で別の個数になる
  const words = hashRunWords(s) ?? strandedHashWords(s);
  /**
   * ⚠ 井桁の並びでないときは、これまでどおり**カンマだけ**で割る(空白は割らない)。
   * 🔑 **角括弧は落とす**(着地前の動線レビュー F)── マニュアルは `tags:` の行に
   *   `[#買い物, #家事]` と書く形を薦めているので、それを**欄へ貼る人が居る**。
   *   落とさないと「[買い物」「家事]」という 2 つの名前ができる(実測)。
   */
  const bare = /^\[.*\]$/u.test(s) ? s.slice(1, -1) : s;
  /**
   * ⚠ **カンマは井桁の並びの中でも区切りである**(2 稿目で `#買い物,#家事` を落として判明)。
   *   空白が 1 つも無いので語は 1 つになり、井桁の並びとしては割れない ── ここで
   *   もう一度カンマで割らないと「買い物,#家事」という 1 つの名前になる。
   */
  const parts = (words ?? [bare]).flatMap((w) => w.split(','));
  const out: string[] = [];
  for (const part of parts) {
    // ⚠ `#買い物, #家事` のように区切りを重ねて書かれることがある ── 末尾の
    //    区切りらしき字は落とす(落とさないと「買い物,」という別のタグになる)
    const t = normalize(part.replace(/[,、;；]+$/u, ''));
    if (t === '' || [...t].length > MAX_TAG_CHARS) continue;
    if (out.some((x) => sameTag(x, t))) continue;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 🔴 **正規化した形を外にも出す**(#402 ①)。
 * ⚠ 一括の入力欄から来る字は `  請求済  ` のような形をしている ── 呼び側が
 *   自前で `trim` すると、**読む側(`readTags`)と規則が 2 つ**になる(§7)。
 */
export function normalizeTag(raw: string): string {
  return normalize(raw);
}

/**
 * 🔴 **タグを 1 つ足した / 外した形を返す**(#402 ①)。
 *
 * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
 * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
 *
 * ⚠ **突き合わせは大小無視**(`sameTag`)── `#請求済` と `#請求済` が
 *   2 つ並ぶのを防ぐ。⚠ **並べ替えない**(`readTags` と同じ ── 書いた順は user の物)。
 * ⚠ 上限(`MAX_TAGS` / `MAX_TAG_CHARS`)を**ここでも守る** ── 一括は
 *   1 度に 12 件書くので、破る形を作ると 12 件まとめて壊れる。
 *
 * @returns 変わらないときは `null`(呼び側が「書かない」を選べる)
 */
export function withTag(
  tags: readonly string[],
  tag: string,
  mode: 'add' | 'remove',
): string[] | null {
  const t = normalize(tag);
  if (t === '' || [...t].length > MAX_TAG_CHARS) return null;
  const has = tags.some((x) => sameTag(x, t));
  if (mode === 'add') {
    if (has) return null;
    // ⚠ 上限に当たったら**足さない**(黙って古い方を落とさない)
    if (tags.length >= MAX_TAGS) return null;
    return [...tags, t];
  }
  if (!has) return null;
  return tags.filter((x) => !sameTag(x, t));
}

/** 同じタグか(表示は原文、突き合わせは大小無視)。 */
export function sameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * body の frontmatter からタグを読む。
 *
 * 受ける形は 2 つ ── **user がどちらで書いても通す**(記法を減らさない):
 * - 配列: `tags: [買い物, 家事]`
 * - 文字列: `tags: 買い物, 家事`(カンマ区切り)
 *
 * ⚠ 空・重複・長すぎるものは落とす。⚠ 順序は**書いた順**を保つ(並べ替えない ──
 * user が意味のある順に書いていることがある)。
 */
export function readTags(body: string): string[] {
  const { meta } = parseFrontmatter(body);
  const raw = meta.tags;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    // ⚠ 文字列の形は **`splitTags` 1 か所**で読む(§7)── 打つ欄と規則を分けない。
    //    これで `tags: #買い物 #家事` も打った欄と同じに 2 個として読める。
    return splitTags(String(raw));
  }
  /**
   * 🔴 **配列の中身も割る**(#637 の着地前レビュー A。**これが元の不具合の本体**)。
   *
   * ⚠ 1 稿目は文字列の枝しか割っておらず、**user が既に持っているノートが直らなかった** ──
   *   直す前の打つ欄は `normalizeTag('#買い物 #家事')` = **`買い物 #家事`** という
   *   1 つの名前を作り、`,` を含まないので quote すらされずに
   *   **`tags: ["買い物 #家事"]`** として保存されていた(実測)。
   *   つまり「一つになってしまう」と報告された当のノートが、1 稿目では 1 個のままだった。
   * ⚠ **カンマでは割らない** ── `["買い物, 家事"]` は `,` を含むので writer が
   *   **わざと quote した 1 つの名前**である(`scalarNeedsQuote`)。割ると別のデータを壊す。
   */
  const parts: string[] = raw
    .filter((v) => v !== null && v !== undefined)
    .flatMap((v) => {
      const s = String(v);
      return ((hashRunWords(s) ?? strandedHashWords(s) ?? [s]) as string[]);
    });
  const out: string[] = [];
  for (const part of parts) {
    const t = normalize(part);
    if (t === '' || [...t].length > MAX_TAG_CHARS) continue;
    if (out.some((x) => sameTag(x, t))) continue;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 抽出列へ入れる形。⚠ **区切りは空白ではなく制御文字を避けた私用文字**にしない
 * ── SQL の LIKE で「タグの丸ごと一致」を引くために、**前後に区切りを付けた形**
 * (`|買い物|家事|`)にする。こうすると `%|買い物|%` が部分一致を誤爆しない
 * (`買い物リスト` というタグに `買い物` が当たらない)。
 * ⚠ タグ自体に `|` が含まれうるので、正規化で落とす。
 */
export const TAG_SEP = '|';

export function encodeTags(tags: readonly string[]): string {
  const safe = tags.map((t) => t.split(TAG_SEP).join(' ')).filter((t) => t !== '');
  return safe.length === 0 ? '' : TAG_SEP + safe.join(TAG_SEP) + TAG_SEP;
}

export function decodeTags(encoded: string | null): string[] {
  if (!encoded) return [];
  return encoded.split(TAG_SEP).filter((t) => t !== '');
}
