/**
 * 🔴 **本文の中に書いたタグを拾う**(#550 段①。user 要望 2026-08-29)。
 *
 * > 「**PKC-Markdown の仕様をふやす「#tag-name #tag-name2」 のように、
 * >  見出しにならない＝井桁と名前を半角空白で区切らない、タグ同士は半角空白または
 * >  全角空白で区切る単独行は空白文字種でパースしてその行が存在する見出しレベルの
 * >  タグとして機能すること**」
 *
 * ## ここは純粋層である
 *
 * ⚠ **画面にも保存にも繋がっていない。** 本文 → `(タグ, 見出しの位置)` を返すだけ。
 * 🔑 分けた理由は、この層だけなら**見え方が 1 バイトも変わらない**からである
 *   ── 記法の判定を先に全数で固めてから、上へ繋ぐ。
 *
 * ## 規則(設計 doc `tag-system-design-2026-08.md` §3.1)
 *
 * 1. 行(前後の空白を除く)が **1 個以上のトークンだけ**からなる
 * 2. トークン = `#` + 名前。⚠ **`#` の直後に空白を置かない**(置けば見出し)
 * 3. 区切りは **半角空白 / 全角空白 / タブ**
 * 4. そのタグは **その行が属する見出し**に付く
 *
 * ⚠ **fence の中は見ない**(`task-count.ts` と同じ作法)。
 *
 * ## 🔴 数字だけのタグは作らない(設計 doc §3.3 の推薦)
 *
 * ⚠ `#117 #121` のような**番号を並べた行**は、この repo の doc に **12 回**出てくる。
 *   これをタグにすると、issue 番号を並べただけの行が突然タグ行になる。
 * 🔑 だから **名前に「数字以外」を 1 文字以上求める**。失うのは「数字だけのタグ」
 *   だけで(必要なら `#no117` と書ける)、得るのは**既存の本文を 1 行も壊さない**こと。
 */

/** fence の開き閉じ。⚠ `task-count.ts` と同じ形にする(判定を散らさない)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** ATX 見出し。⚠ **井桁のあとに空白が要る** ── ここがタグ行との分かれ目である。 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/**
 * タグ行の候補。⚠ **区切りは「空白文字種」** ── 半角 / 全角 / タブ。
 * ⚠ 全角空白は `\u3000` と**escape で**書く(生バイトを埋めない ── repo-hygiene が止める)(`\s` は環境で揺れるので使わない)。
 *
 * 🔴 **markdown が「コード」にする下げ方だけを外す**(2026-08-29、描画との
 *   parity test が教えた)。
 * ⚠ 1 稿目は `^[ \t\u3000]*` = **いくつでも**だったので、**半角 4 つ下げた行**
 *   (markdown では**コードブロック**)まで拾っていた ── 画面にはコードとして
 *   出るのに**索引にはタグとして入る**、という食い違いになる。
 * ⚠ ただし `{0,3}` に縮めるのは**やりすぎだった** ── 全角空白で書き始めた行
 *   (日本語では普通に打つ)まで落ちた。**全角空白は markdown の字下げではない**
 *   ので、そのまま本文の段落になる ── 落とすと**書き方を 1 つ奪う**
 *   (CLAUDE.md「記法を減らすことは、user の動線を減らすこと」)。
 * 🔑 だから**外すのは 2 つだけ**:行頭の**半角 4 つ**と**タブ**
 *   (どちらも markdown がコードにする形)。
 */
const TAG_LINE =
  /^(?! {4})(?!\t)[ \u3000]*(#[^\s\u3000]+(?:[ \t\u3000]+#[^\s\u3000]+)*)[ \t\u3000]*$/;

/** 名前に数字以外が 1 文字でもあるか。⚠ 無いものはタグにしない(上の注記)。 */
const HAS_NON_DIGIT = /[^0-9]/;

/**
 * 🔴 **1 行がタグ行か**(#550 段③)。タグ行なら**名前の並び**、違うなら `null`。
 *
 * 🔑 **判定はここ 1 か所**である ── 走査(`scanBodyTags`)と描画(markdown の
 *   ブロック規則)が**別々に書くと、集まるタグと画面のバッジが静かに食い違う**
 *   (CLAUDE.md §7「同じ問いに答える口が 2 つ」)。
 * ⚠ **fence の中かどうかは見ない** ── それは行 1 本では決まらないので、
 *   呼び側(走査 / markdown-it)がそれぞれの文脈で判断する。
 */
export function parseTagLine(line: string): string[] | null {
  const t = TAG_LINE.exec(line);
  if (t === null) return null;
  const names: string[] = [];
  for (const tok of t[1]!.split(/[ \t\u3000]+/)) {
    const name = tok.slice(1);
    // ⚠ 数字だけの名前は**タグにしない**(`#117 #121` のような番号の行を守る)
    if (name === '' || !HAS_NON_DIGIT.test(name)) continue;
    names.push(name);
  }
  // ⚠ **1 つも残らなければタグ行ではない**(`#117 #121` だけの行は本文のまま)
  return names.length === 0 ? null : names;
}

/** 本文の中で見つけたタグ 1 個。 */
export interface BodyTag {
  /** タグ名(`#` を除く)。⚠ 正規化は**していない** ── 呼び側が `normalizeTag` に通す。 */
  readonly name: string;
  /** そのタグが書かれた行(0 始まり)。 */
  readonly line: number;
  /**
   * その行が属する見出しの道筋(浅い順)。見出しの外なら空。
   * 🔑 user の要件「**どの見出しや記事でタグがついたのかわかりやすく**」の材料である。
   */
  readonly heading: readonly string[];
}

/**
 * 本文から**本文中のタグ**を拾う。
 *
 * ⚠ 重複は**除かない** ── 「どの見出しで付いたか」を捨てないため
 *   (集約する側が `sameTag` で畳む)。
 */
export function scanBodyTags(body: string): BodyTag[] {
  const out: BodyTag[] = [];
  const lines = body.split(/\r\n|[\r\n]/);
  let fence: { ch: string; len: number } | null = null;
  /** 見出しの道筋。添字 = レベル-1。 */
  const path: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const f = FENCE.exec(raw);
    if (f !== null) {
      const mark = f[1]!;
      if (fence === null) fence = { ch: mark[0]!, len: mark.length };
      // ⚠ 閉じは**同じ文字で同じ数以上**(短い ``` では ```` は閉じない)
      else if (mark[0] === fence.ch && mark.length >= fence.len) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = HEADING.exec(raw);
    if (h !== null) {
      const level = h[1]!.length;
      // ⚠ 深い側を捨ててから積む(見出しが浅くなったら、その下は道筋から外れる)
      path.length = level - 1;
      path[level - 1] = h[2]!.trim();
      continue;
    }
    const names = parseTagLine(raw);
    if (names === null) continue;
    const heading = path.filter((x) => x !== undefined && x !== '');
    for (const name of names) out.push({ name, line: i, heading });
  }
  return out;
}
