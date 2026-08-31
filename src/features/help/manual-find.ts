/**
 * 🔴 **マニュアルの中を探す**(#636。user 指示 2026-08-31
 * 「**ヘルプにマニュアルの中を探すを置いて**」)。
 *
 * ## なぜ源文を走るのか(DOM ではなく)
 *
 * 🔴 **DOM は嘘をつく。** `HelpRenderer.drawManual` は `await` の**前**に
 *   「描いた」の印を立てるので、面を初めて開いた直後(または手放しからの
 *   開き直し直後)の**約 0.25 秒**、器の中に本文は 1 文字も無い ──
 *   ⚠ user は**開いてすぐ打つ**。
 * 🔑 源文(`MANUAL_TEXT`)は entry chunk に焼かれて **boot 時点から常駐**しており、
 *   #531 のアイドル手放しが捨てるのは **DOM だけ**である。だから走っても
 *   **常駐が 1 バイトも増えない**。
 * 🔑 走査は安い ── 237 KB / 3600 行の全走査で 1 ms 前後(実測)。
 *   **ワーカーは要らない。**
 *
 * ## 🔴 本文は 1 バイトも隠さない
 *
 * ⚠ 非該当を `hidden` で畳むと、その字が**ブラウザの Ctrl+F から見えなくなる**
 *   ── user 指示②(「ヘルプ閲覧中は ctrl+f をブラウザに返してください」)と
 *   正面衝突する。出すのは「**該当する節の一覧**」だけである。
 *
 * ## 飛び先は「何番目の見出しか」
 *
 * ⚠ **`id` は使えない** ── `id` が焼かれるのは h1〜h3 だけで、しかも面は `hidden` で
 *   同一 document に常駐するので **`#slug` は本文の面の見出しに当たる**
 *   (`help.ts` 冒頭がその実測つきの警告を持つ)。
 * 🔑 だから**源文の見出しの通し番号**を持ち、描かれた `h1〜h6` の同じ番号を掴む。
 *   ⚠ この対応は **160 = 160** で実測済みで、`manual-find.test.ts` が pin する。
 */

/** 源文の 1 節(見出し 1 本ぶん)。 */
export interface ManualSection {
  /** 見出しの字(記法はそのまま)。 */
  readonly title: string;
  /** `#` の数。 */
  readonly level: number;
  /** 🔑 **源文の見出しの通し番号**(0 始まり)。描かれた見出しの n 番目と対応する。 */
  readonly index: number;
  /**
   * 見出しが源文の何行目か(0 始まり)。
   * ⚠ **描けなかったときの逃げ道**である ── ワーカーが無い / 失敗したときは
   *   マニュアルが**素の原文**で出るので見出しが 1 本も無く、番号では飛べない。
   *   そのとき行の比で送る(#636 の着地前に、素の原文の経路が
   *   **全行 dead click** になっていたので足した)。
   */
  readonly line: number;
}

/** 探した結果の 1 節。 */
export interface ManualHit {
  readonly section: ManualSection;
  /** その節に何か所あったか。 */
  readonly count: number;
}

/** 一覧に出す節の上限。⚠ 超えた分は**数えたうえで**「あと N 節」と言う。 */
export const MANUAL_FIND_MAX_SECTIONS = 60;

/** 見出しの前に書かれた字を入れる、番号を持たない節。 */
const PREAMBLE: ManualSection = { title: '(先頭)', level: 0, index: -1, line: 0 };

const FENCE = /^\s*(`{3,}|~{3,})/u;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/u;

/**
 * 源文を節へ割る。⚠ **コードフェンスの中の `#` は見出しにしない** ──
 * マニュアル自身がフェンスの中で `# 見出し` を例示している。
 */
export function manualSections(text: string): readonly ManualSection[] {
  const out: ManualSection[] = [];
  let fence: string | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (f) {
      const mark = f[1]![0]!;
      if (fence === null) fence = mark;
      else if (mark === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = HEADING.exec(line);
    if (h) out.push({ title: h[2]!, level: h[1]!.length, index: out.length, line: i });
  }
  return out;
}

/**
 * 打った字が何節に何か所あるかを返す(源文の並び順)。
 *
 * ⚠ **大小は無視する**(英語の語を打つ人が居る)。日本語に大小は無いので副作用は無い。
 * ⚠ **見出しの行も数える** ── 節の題名に当たったのに 0 件と出ると、user は
 *   「無い」と読む。
 * ⚠ **フェンスの中も数える** ── user はコードの例も探す。
 *   (見出しの割り出しだけがフェンスを避ける。)
 */
export function findInManual(text: string, query: string): readonly ManualHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const hits: ManualHit[] = [];
  let cur: ManualSection = PREAMBLE;
  let count = 0;
  let fence: string | null = null;
  let seen = 0;
  const flush = (): void => {
    if (count > 0) hits.push({ section: cur, count });
    count = 0;
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (f === null && fence === null) {
      const h = HEADING.exec(line);
      if (h) {
        flush();
        cur = { title: h[2]!, level: h[1]!.length, index: seen, line: i };
        seen += 1;
      }
    } else if (f) {
      const mark = f[1]![0]!;
      if (fence === null) fence = mark;
      else if (mark === fence) fence = null;
    }
    count += occurrences(line.toLowerCase(), q);
  }
  flush();
  return hits;
}

/** 源文の行数(素の原文で出したときの、送る比を出すのに使う)。 */
export function manualLineCount(text: string): number {
  return text.split('\n').length;
}

/** 重ならない出現回数。⚠ `indexOf` の輪で数える(`split` は空文字で無限になる)。 */
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}
