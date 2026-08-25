/**
 * 🔴 **雛形の表**(#196 / B-2)── 「どのノートが雛形で、短縮語は何か」を 1 か所で決める。
 *
 * ## 置き場所は **`snippet` アーキタイプ**(設計 §4.3 の裁定点 A)
 *
 * ```markdown
 * ---
 * abbr: addr
 * ---
 * 〒100-0000 東京都千代田区…
 * ```
 *
 * 🔑 これを選んだ理由は 3 つ:
 * - **JSON 文字列 body を作らない**(不可侵指示 2026-07-27)
 * - バックアップ・書き出し・取り込み・履歴・検索が**何も足さずに**通る
 *   (どれも archetype で絞っていない)
 * - 「どの entry が雛形か」を**本文を読まずに**知れる(archetype は常駐の集約に在る)
 *
 * ⚠ **flag に詰めるのは論外**である ── PKC2 は 14 種の雛形本文を**文字列フラグ 1 本に
 * JSON で**詰めて Flags インスペクタで手編集させていた。PKC3 の「flags は最大 15 個、
 * 正規設定と分離」と正面から衝突する。
 *
 * 🔑 **pure module**。DB も DOM も知らない ── 「読んだ本文の一覧」を貰って表にするだけ。
 */
import { parseFrontmatter } from '@features/markdown/frontmatter';

/** 雛形ノートの archetype。⚠ **綴りはここ 1 か所**(registry も面もここを引く)。 */
export const SNIPPET_ARCHETYPE = 'snippet';

/** frontmatter の鍵。⚠ 同上。 */
export const SNIPPET_ABBR_KEY = 'abbr';

/**
 * 上限。⚠ どれも「画面に出して意味がある量」で決めてある。
 * 🔑 **数で持つ** ── 「多すぎたら間引く」を散文の規律にしない。
 */
export const SNIPPET_LIMITS = {
  /**
   * 表に載せる雛形の数。⚠ **本文ごと主スレッドへ運ぶ**ので、いちばん重い次元である。
   * 🔑 それでも運ぶのは、**挿す瞬間に往復を挟まない**ため ── 挟むと、押してから
   *   字が出るまでに間が空き、その間に打った字と競合する。
   * ⚠ 「全件の本文を運ばない」の不可侵指示(2026-07-27)とは別物である:
   *   運ぶのは **user が雛形として作ったものだけ**で、上限つきである。
   */
  notes: 200,
  /** 1 つの雛形の字数。⚠ 超えた分は**載せない**(切って挿すと本文が壊れる)。 */
  bodyChars: 4000,
  /** 短縮語の字数。⚠ 長すぎる語は打つより探すほうが速い。 */
  abbrChars: 32,
} as const;

/** 表の 1 行。 */
export interface SnippetItem {
  readonly lid: string;
  /** 題名(`/` の一覧に出る字)。 */
  readonly title: string;
  /** 短縮語。書いていなければ `''`(`/` からは呼べるが `Tab` では出ない)。 */
  readonly abbr: string;
  /** 挿す本文(**frontmatter を除いた残り**)。 */
  readonly body: string;
}

/** 走査の結果。⚠ **切ったかどうかを一緒に運ぶ**(黙って切らない)。 */
export interface SnippetScan {
  readonly items: readonly SnippetItem[];
  /** 候補になった雛形の総数(切る前)。 */
  readonly total: number;
  /** 🔴 上限で切ったか。⚠ 切ったなら**画面にそう出す**(「無い」と読ませない)。 */
  readonly truncated: boolean;
}

/**
 * 本文 1 本を表の 1 行にする。⚠ **口はここ 1 つ**(CLAUDE.md §7)──
 * 走査する側と、押した 1 件を組み直す側で別々に組むと、片方だけ規則が変わる。
 *
 * @returns 載せられないものは `null`(長すぎる / 本文が空)
 */
export function snippetItemOf(lid: string, title: string, body: string): SnippetItem | null {
  const parsed = parseFrontmatter(body);
  const raw = parsed.meta[SNIPPET_ABBR_KEY];
  const abbr = typeof raw === 'string' ? raw.trim() : '';
  // 🔑 挿すのは**frontmatter を除いた残り** ── `abbr:` まで本文へ挿さない
  const text = parsed.body.replace(/^\n+/, '');
  if (text === '') return null;
  if (text.length > SNIPPET_LIMITS.bodyChars) return null;
  return {
    lid,
    title,
    abbr: abbr.length > SNIPPET_LIMITS.abbrChars ? '' : abbr,
    body: text,
  };
}

/**
 * 🔴 **カーソルの手前に在る短縮語**を探す(`Tab` が呼ぶ)。
 *
 * ⚠ **長いほうを採る** ── `ad` と `addr` の両方が在るとき、`addr` と打った人に
 *   `ad` を出さない。
 * ⚠ **語の途中では出さない** ── 直前が英数字なら、`myaddr` の尻に当たっているので
 *   出さない(誤爆の唯一の現実的な形)。⚠ 日本語の短縮語には効かない判定だが、
 *   それでよい:`Tab` は**明示の操作**なので、勝手に展開されることが無い
 *   (Text Blaze の自動展開を採らない理由 ── 設計 §4.4)。
 *
 * @returns 当たった行と、本文の中での始まり。当たらなければ `null`
 */
export function abbrBeforeCaret(
  text: string,
  caret: number,
  items: readonly SnippetItem[],
): { item: SnippetItem; start: number } | null {
  let best: { item: SnippetItem; start: number } | null = null;
  for (const item of items) {
    if (item.abbr === '') continue;
    const start = caret - item.abbr.length;
    if (start < 0) continue;
    if (text.slice(start, caret) !== item.abbr) continue;
    // ⚠ 直前が英数字なら語の途中(`myaddr` の尻)── 出さない
    if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1]!)) continue;
    if (best === null || item.abbr.length > best.item.abbr.length) best = { item, start };
  }
  return best;
}

/**
 * `/` の一覧を絞る。⚠ **題名と短縮語の両方**で当てる ── 覚えているほうで探せる。
 * ⚠ 大文字小文字を無視する(短縮語は打ちやすさが命なので、`Addr` でも当てる)。
 */
export function filterSnippets(
  items: readonly SnippetItem[],
  query: string,
): readonly SnippetItem[] {
  const q = query.trim().toLowerCase();
  /**
   * ⚠ **空のときの早期 return は書かない**(2026-08-25、変異試験 T8 が SURVIVED で教えた)。
   * `''.includes('')` は常に真なので、外しても結果は 1 件も変わらない = **no-op** だった。
   * 🔑 CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」。
   */
  return items.filter(
    (s) => s.title.toLowerCase().includes(q) || s.abbr.toLowerCase().includes(q),
  );
}
