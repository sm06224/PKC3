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
  /**
   * 🔴 **当たった所の前後 1 行**(依頼 67-2。Gemini 裁定 2026-10-13 = 推薦どおり)。
   * ⚠ 本文の行を優先する(題名はもう一覧の字に出ている)。当たりの前後を切り、切れた側は「…」。
   */
  readonly excerpt: string;
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
 * ⚠ **全角と半角、`+` の前後の空白は区別しない**(`foldForFind`)。マニュアルは
 *   「Ctrl+S」と「Ctrl + S」を両方書いているので、どちらを打っても同じ節が出る。
 *   ⚠ ひらがなとカタカナは畳まない(別の判断待ち)。
 * ⚠ **見出しの行も数える** ── 節の題名に当たったのに 0 件と出ると、user は
 *   「無い」と読む。
 * ⚠ **フェンスの中も数える** ── user はコードの例も探す。
 *   (見出しの割り出しだけがフェンスを避ける。)
 */
export function findInManual(text: string, query: string): readonly ManualHit[] {
  const q = foldForFind(query.trim()).text;
  if (q === '') return [];
  const hits: ManualHit[] = [];
  let cur: ManualSection = PREAMBLE;
  let count = 0;
  /** 本文の最初の当たり / 見出しの当たり(本文に無いときの代わり)。 */
  let bodyLine: string | null = null;
  let headLine: string | null = null;
  let fence: string | null = null;
  let seen = 0;
  const flush = (): void => {
    if (count > 0) {
      const line = bodyLine ?? headLine ?? '';
      hits.push({ section: cur, count, excerpt: excerptOf(line, q) });
    }
    count = 0;
    bodyLine = null;
    headLine = null;
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
    const n = occurrences(foldForFind(line).text, q);
    if (n > 0) {
      if (HEADING.test(line) && fence === null && f === null) headLine ??= line;
      else bodyLine ??= line;
    }
    count += n;
  }
  flush();
  return hits;
}

/** 抜き出しの片側の長さ(当たりの前後に残す字数)。 */
export const MANUAL_EXCERPT_SIDE = 14;

/**
 * 探すための正規化。⚠ 全角→半角など(NFKC)・大小・**`+` の前後の空白**を畳む。
 * 返す `start[i]` / `end[i]` は、畳んだ後の i 字目が**元の字列のどこ**に当たるか
 * (抜き出しが元の字の上で切れるように)。ひらがな・カタカナは畳まない。
 */
function foldForFind(src: string): { text: string; start: number[]; end: number[] } {
  let text = '';
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  for (const ch of src) {
    const folded = ch.normalize('NFKC').toLowerCase();
    for (const f of folded) {
      for (let k = 0; k < f.length; k++) {
        text += f[k];
        start.push(at);
        end.push(at + ch.length);
      }
    }
    at += ch.length;
  }
  // `+` に隣り合う空白を落とす(位置の対応も一緒に落とす)。
  let outText = '';
  const outStart: number[] = [];
  const outEnd: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/u.test(c)) {
      let j = i;
      while (j < text.length && /\s/u.test(text[j]!)) j++;
      const before = outText.endsWith('+');
      const after = text[j] === '+';
      if (before || after) {
        i = j - 1;
        continue;
      }
    }
    outText += c;
    outStart.push(start[i]!);
    outEnd.push(end[i]!);
  }
  return { text: outText, start: outStart, end: outEnd };
}

/**
 * 当たりを含む 1 行を、当たりの前後で切って返す(切れた側に「…」)。
 * ⚠ 記法の頭(見出しの `#` / 箇条書き / 引用)は落とす ── 星や記号が見えたまま出ない。
 * ⚠ 当たりの位置は畳んだ字列で探し、**元の字の位置へ戻して**切る(`Ctrl + S` の空白も含めて残る)。
 */
export function excerptOf(line: string, q: string): string {
  const text = line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/u, '')
    .replace(/[*`_]/gu, '')
    .trim();
  const needle = foldForFind(q.trim()).text;
  const folded = foldForFind(text);
  const idx = needle === '' ? -1 : folded.text.indexOf(needle);
  if (idx < 0) return text.length > MANUAL_EXCERPT_SIDE * 2 ? `${text.slice(0, MANUAL_EXCERPT_SIDE * 2)}…` : text;
  const hitFrom = folded.start[idx]!;
  const hitTo = folded.end[idx + needle.length - 1]!;
  const from = Math.max(0, hitFrom - MANUAL_EXCERPT_SIDE);
  const to = Math.min(text.length, hitTo + MANUAL_EXCERPT_SIDE);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
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
