/**
 * 🔴 **スマートフォルダの条件**(#421 段①。user 要望 2026-08-26)。
 *
 * > 1件、追加したい機能として、iPhoneとかのメモアプリにあるスマートメモのような
 * > 整理機能が欲しいです
 *
 * ## 何のために在るか
 *
 * 「請求」タグのノートがあちこちのフォルダに散っている ── いまは絞り込み欄に
 * 毎回打つしかなく、**「請求のノート」という場所がどこにも無い**。
 * 🔑 条件を**保存して、名前を付けて、場所として置く**のがこれである。
 *
 * ## 🔴 正本は本文の frontmatter(新しい入れ物を作らない)
 *
 * タグが `tags:` で済んでいるのと**同じ理由**(`flavor/tags.ts` 冒頭
 * 「新しい概念を足さない」)。⚠ 端末の保存(localStorage)に置くと
 * **書き出しにも別の端末にも乗らない**。
 *
 * ```markdown
 * ---
 * smart-tags: [請求]
 * ---
 * 月末にまとめて処理するぶん。
 * ```
 *
 * ⚠ **入れ子は使えない** ── PKC3 の frontmatter は**平らな key しか読まない**
 * (`frontmatter.ts` が「Nested mappings」を非対応と宣言している)。だから
 * 条件は `smart-〇〇` の**平らな key を並べる**形にする(段②で増える key も同じ形)。
 *
 * ## ⚠ 条件が 1 つも無いときは「何も集めない」
 *
 * 🔑 **「全部集める」にしない。** 作った直後は条件が空なので、そこで全件が
 * 並ぶと「壊れている / 作り間違えた」と読まれる ── **空は空**として出し、
 * 画面には「条件を選んでください」と書く(呼び側の仕事)。
 *
 * ⚠ **pure module**。browser API も DB も知らない。
 */
import { parseFrontmatter, spliceFrontmatterKeys } from '../markdown/frontmatter';
import { MAX_TAG_CHARS, normalizeTag, readTags, sameTag } from '../flavor/tags';

/**
 * 🔴 **この入れ物の archetype**。⚠ 綴りはここ 1 か所 ── 直書きすると、
 * 足した面だけスマートフォルダが「ふつうのノート」に見える(§7)。
 */
export const SMART_ARCHETYPE = 'smart';

/** 条件を書く frontmatter の key。⚠ 段②で増えるものも `smart-` で始める。 */
export const SMART_TAGS_KEY = 'smart-tags';

/**
 * 1 つのスマートフォルダが持てる条件タグの数。
 * ⚠ 上限は**手違いの検出**である ── AND なので数が増えるほど当たりは減るが、
 * 帯に 50 個並ぶと条件そのものが読めなくなる。
 */
export const MAX_SMART_TAGS = 8;

/**
 * 集める上限。⚠ 超えたぶんは **lid を持たないが数は数え続ける**
 * (「N 件中 M 件を出しています」と言えるように ── `QUERY_LIMITS` と同じ規律)。
 */
export const SMART_LIMIT = 500;

/** 条件。⚠ 段①は**タグだけ**(段②で種類・日付・語が増える)。 */
export interface SmartSpec {
  /** 🔑 **AND** ── 全部付いているノートだけ当たる。 */
  readonly tags: readonly string[];
}

export const EMPTY_SMART: SmartSpec = { tags: [] };

/** 条件が 1 つも無いか。⚠ **空は「全部」ではなく「何も」**である(上の注記)。 */
export const isSmartEmpty = (spec: SmartSpec): boolean => spec.tags.length === 0;

/**
 * 本文から条件を読む。
 *
 * 受ける形は 2 つ ── **user がどちらで書いても通す**(記法を減らさない。
 * `readTags` と**同じ規則**である):
 * - 配列: `smart-tags: [請求, 未処理]`
 * - 文字列: `smart-tags: 請求, 未処理`(カンマ区切り)
 *
 * ⚠ 空・重複・長すぎるものは落とす。⚠ 並べ替えない(書いた順は user の物)。
 */
export function readSmartSpec(body: string): SmartSpec {
  const { meta } = parseFrontmatter(body);
  const raw = meta[SMART_TAGS_KEY];
  if (raw === undefined || raw === null) return EMPTY_SMART;
  /**
   * ⚠ **空の要素は `null` で来る**(frontmatter の parser がそう返す)── そのまま
   *   `String()` すると **`"null"` という名前のタグ**が条件になる(`readTags` が
   *   同じ罠を踏んで直してある)。
   */
  const parts: string[] = Array.isArray(raw)
    ? raw.filter((v) => v !== null && v !== undefined).map((v) => String(v))
    : String(raw).split(',');
  const out: string[] = [];
  for (const part of parts) {
    const t = normalizeTag(part);
    if (t === '' || [...t].length > MAX_TAG_CHARS) continue;
    if (out.some((x) => sameTag(x, t))) continue;
    out.push(t);
    if (out.length >= MAX_SMART_TAGS) break;
  }
  return { tags: out };
}

/**
 * 条件を書き換えた結果。
 *
 * 🔴 **「変わらなかった」を 1 つに畳まない**(#421 着地前の変異試験)。
 * ⚠ 畳むと呼び側は**黙って捨てるしかなくなる** ── user は 9 個目の条件を
 *   足したつもりで、**何も起きない画面**を見る(理由がどこにも出ない)。
 * 🔑 だから「押しても同じ」(`unchanged`)と「**受けられなかった**」
 *   (`limit` / `invalid`)を分ける ── 前者は黙ってよいが、後者は画面に出す。
 */
export type SmartCondResult =
  | { readonly ok: true; readonly spec: SmartSpec }
  | { readonly ok: false; readonly reason: 'unchanged' | 'limit' | 'invalid' };

/** 条件のタグを 1 つ足す / 外す。⚠ 判定はここ 1 か所(§7)。 */
export function withSmartTag(
  spec: SmartSpec,
  tag: string,
  mode: 'add' | 'remove',
): SmartCondResult {
  const t = normalizeTag(tag);
  if (t === '' || [...t].length > MAX_TAG_CHARS) return { ok: false, reason: 'invalid' };
  const has = spec.tags.some((x) => sameTag(x, t));
  if (mode === 'add') {
    if (has) return { ok: false, reason: 'unchanged' };
    // ⚠ 上限に当たったら**足さない**(黙って古い方を落とさない ── `withTag` と同じ)
    if (spec.tags.length >= MAX_SMART_TAGS) return { ok: false, reason: 'limit' };
    return { ok: true, spec: { tags: [...spec.tags, t] } };
  }
  if (!has) return { ok: false, reason: 'unchanged' };
  return { ok: true, spec: { tags: spec.tags.filter((x) => !sameTag(x, t)) } };
}

/**
 * 断り文。⚠ **押した場所の言葉で書く**(「条件」「タグ」)── 内部の語を出さない。
 * @returns 黙ってよいとき(`unchanged`)は `null`
 */
export function smartCondError(reason: 'unchanged' | 'limit' | 'invalid'): string | null {
  if (reason === 'unchanged') return null;
  if (reason === 'limit') return `条件は ${MAX_SMART_TAGS} つまでです(1 つ外してから足してください)`;
  return `そのタグは条件にできません(空か、${MAX_TAG_CHARS} 文字を超えています)`;
}

/**
 * 条件を本文へ書き戻す(**原文 splice** ── 説明文も他の key も無傷)。
 * ⚠ 空になったら **key ごと消す**(`smart-tags: []` を残すと、次に読んだとき
 *   「条件が在るのに当たらない」に見える)。
 */
export function writeSmartSpec(body: string, spec: SmartSpec): string {
  return spliceFrontmatterKeys(body, {
    [SMART_TAGS_KEY]: spec.tags.length === 0 ? undefined : [...spec.tags],
  });
}

/**
 * そのノートが条件に当たるか。
 * 🔑 **AND**(条件のタグを全部持っている)。⚠ 突き合わせは大小無視(`sameTag`)。
 */
export function matchesSmart(spec: SmartSpec, tags: readonly string[]): boolean {
  if (isSmartEmpty(spec)) return false; // ⚠ 空は「何も集めない」
  return spec.tags.every((want) => tags.some((have) => sameTag(have, want)));
}

/** 走査の結果。⚠ `total` は**上限で切る前**の数。 */
export interface SmartHit {
  readonly lids: readonly string[];
  readonly total: number;
}

export interface SmartScan {
  /** 本文の**先頭だけ**の列を食わせる(呼ぶのは storage worker)。 */
  feed(rows: readonly { lid: string; head: string }[]): void;
  finish(): SmartHit;
}

/**
 * 🔴 **当てるのはここ 1 か所**(#421)。worker も test も同じ関数を通る。
 *
 * ⚠ **走査は集計と同じ型**(`createQueryScan`)── 本文の先頭だけを 500 件ずつ
 *   舐め、主スレッドへ返すのは **lid だけ**である(不可侵指示「ゼロコピー」)。
 * ⚠ **自分自身は当てない** ── スマートフォルダに条件タグを書いた本文が
 *   自分の中に並ぶと、開くたびに入れ子が 1 段深く見える。
 *
 * @param selfLid そのスマートフォルダ自身の lid(除くため)
 */
export function createSmartScan(spec: SmartSpec, selfLid: string): SmartScan {
  const lids: string[] = [];
  let total = 0;
  return {
    feed(rows) {
      /**
       * ⚠ **空のときの早期 return をここに置かない**(§7)。
       *   「条件が空 → 何も集めない」は `matchesSmart` が答えているので、
       *   ここに書いても**出る答えは 1 バイトも変わらない**
       *   (変異試験 S5 が SURVIVED で教えた ── 消しても誰も困らない行だった)。
       * 🔑 **走査そのものを止めるのは、ここではなく呼び側である** ──
       *   `REQUEST_SMART_SCAN` が条件 0 件のとき worker を呼ばない
       *   (作った直後のスマートフォルダを開くだけで全件走査が走るのを止める)。
       *   ⚠ その門は `tests/adapter/smart-folder.test.ts` が
       *   「**頼まなかったこと**」で見ている ── ここに書き戻すと、
       *   同じ判定が 2 か所になり、片方を壊しても鳴らなくなる。
       */
      for (const row of rows) {
        if (row.lid === selfLid) continue;
        /**
         * ⚠ **タグの読み方は `readTags` 1 本**(§7)── ここに独自の読み方を
         *   書くと、一覧に出る札と「当たるかどうか」が静かに食い違う。
         */
        if (!matchesSmart(spec, readTags(row.head))) continue;
        total += 1;
        // ⚠ 上限を超えたぶんは lid を持たないが、**数は数え続ける**
        if (lids.length < SMART_LIMIT) lids.push(row.lid);
      }
    },
    finish() {
      return { lids, total };
    },
  };
}
