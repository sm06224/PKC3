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

import { frontmatterLineCount } from '../markdown/frontmatter';
import { MAX_TAG_CHARS } from './tags';

/** fence の開き閉じ。⚠ `task-count.ts` と同じ形にする(判定を散らさない)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** ATX 見出し。⚠ **井桁のあとに空白が要る** ── ここがタグ行との分かれ目である。 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;

/**
 * 🔴 **画面に出ない囲み**(2026-08-29 の着地後レビュー。**実物で再現した**)。
 *
 * ⚠ `%%%` のコメントと `:::comment` は**描かれない** ── なのに走査だけが拾うと、
 *   「**隠したはずのタグでフォルダに集まる**」という食い違いになる。
 * ⚠ `:::if{format=…}` は**画面(html)以外**の指定なら描かれない。走査は画面と
 *   同じ側に立つので、`html` 以外は飛ばす。
 * 🔑 判定の向きは 1 つ:**画面に札として出るものだけを索引に入れる**
 *   ── user が**見て消せるもの**だけを集める。
 */
const COMMENT_FENCE = /^ {0,3}%%%\s*$/;
const CONTAINER_OPEN = /^ {0,3}:::+\s*([A-Za-z][\w-]*)?(\{[^}]*\})?\s*$/;
const CONTAINER_CLOSE = /^ {0,3}:::+\s*$/;
/** `:::if{format=html}` の中身だけが画面に出る(それ以外は飛ばす)。 */
const IF_FORMAT = /format\s*=\s*([A-Za-z0-9_-]+)/;

/**
 * 🔴 **箇条書きの印**(2026-08-29)。⚠ 中身は**項目の中**なので、画面は札にしない。
 *
 * ⚠ `- #買い物` は行頭が `#` ではないので元から当たらないが、
 *   **項目の 2 行目**(`1. 本文` の次の `   #買い物`)は下げを外すと当たってしまう ──
 *   画面は項目の中なので札にせず、**索引にだけ入る**食い違いになる(実測)。
 */
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

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
 * 🔴 **索引の区切りに使う字は、名前に入れられない**(2026-08-29 に実測)。
 *
 * ⚠ 索引の列は `|` で連結する(`tags.ts` の `encodeTags`)ので、名前に `|` が
 *   入っていると**往復で別の名前に化ける** ── 実測: `#設計|検討` は
 *   画面の札が `設計|検討`、索引の往復が `設計 検討`。
 *   帰結は「**保存した直後だけ**スマートフォルダに並び、次の起動で黙って消える」。
 * 🔑 だから `#117` と同じ扱いにする ── **その語をタグにしない**(本文の字は
 *   1 バイトも変えない)。⚠ 直すのは「片方を合わせる」ではなく
 *   **食い違いが起きない形にする**(CLAUDE.md §7「起こらなくするほうが強い」)。
 */
const TAG_SEP_IN_NAME = /\|/;

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
    // ⚠ 索引の区切りを名前に含むものは**タグにしない**(往復で化けるため。上の注記)
    if (TAG_SEP_IN_NAME.test(name)) continue;
    /**
     * 🔴 **長すぎる名前はタグにしない**(2026-08-29 の着地後レビュー。実測で確認)。
     *
     * ⚠ 索引は `MAX_TAG_CHARS`(40 字)で落とすのに、**画面はそのまま札にしていた** ──
     *   41 字のタグは「札は押せる形で出るのに、スマートフォルダにも集計にも
     *   1 件も入らない」という**黙った取りこぼし**になっていた。
     * 🔑 判定はここ 1 か所なので、**落とすなら札にもしない**(見れば効いていないと分かる)。
     */
    if ([...name].length > MAX_TAG_CHARS) continue;
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
  /**
   * 🔴 **画面に出ない囲みの深さ**(2026-08-29)。0 より大きい間は 1 つも拾わない。
   * ⚠ 数える対象は `%%%` と、描かれない `:::` の囲み(`comment` /
   *   `if{format≠html}`)だけ ── 描かれる囲み(`note` など)の中身は画面に出るので数えない。
   */
  let hidden = 0;
  /** いま開いている `:::` の入れ子。⚠ 閉じで hidden を戻すために、隠したかを覚える。 */
  const containers: boolean[] = [];
  /**
   * 🔴 **frontmatter の中は見ない**(2026-08-29 の着地後レビュー。**実物で再現した**)。
   *
   * ⚠ `---` の中に `#下書き` と書くのは YAML のコメントとして**正しい書き方**だが、
   *   走査だけが拾うと **user に消せない幽霊タグ**になる ── 画面(本文の面は
   *   `bodyBelowFrontmatter` を描く)にも情報ペインにも出ないので、
   *   **どこを直せば消えるのか分からない**。
   * 🔑 行数は `frontmatterLineCount` から引く(切り方を 2 か所に書かない ── §7)。
   */
  const skipTop = frontmatterLineCount(body);
  /**
   * 🔴 **段落の続きかどうか**(2026-08-29)。markdown は
   *   **空行の直後**の半角 4 つ下げだけをコードにする ── 段落の 2 行目を下げても
   *   それは同じ段落の続きで、画面には**札が出る**。
   * ⚠ ここを見ないと「画面に札、索引に無し」になる(実測済み)。
   */
  let prevBlank = true;
  /** いま箇条書きの中か。⚠ 項目の続きの行は、画面では項目の中身になる。 */
  let inList = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (i < skipTop) {
      prevBlank = true;
      continue;
    }
    const f = FENCE.exec(raw);
    if (f !== null) {
      const mark = f[1]!;
      if (fence === null) fence = { ch: mark[0]!, len: mark.length };
      // ⚠ 閉じは**同じ文字で同じ数以上**(短い ``` では ```` は閉じない)
      else if (mark[0] === fence.ch && mark.length >= fence.len) fence = null;
      prevBlank = false;
      continue;
    }
    if (fence !== null) {
      prevBlank = false;
      continue;
    }
    if (COMMENT_FENCE.test(raw)) {
      // ⚠ `%%%` は開きと閉じが同じ字 ── 入っていれば出る、出ていれば入る
      hidden = hidden > 0 ? hidden - 1 : hidden + 1;
      prevBlank = false;
      continue;
    }
    const co = CONTAINER_OPEN.exec(raw);
    if (co !== null && co[1] !== undefined) {
      const name = co[1];
      const attrs = co[2] ?? '';
      const fmt = IF_FORMAT.exec(attrs)?.[1];
      // ⚠ 隠すのは 2 つだけ ── コメントと、画面(html)以外を指した `if`
      const hide = name === 'comment' || (name === 'if' && fmt !== undefined && fmt !== 'html');
      containers.push(hide);
      if (hide) hidden += 1;
      prevBlank = false;
      continue;
    }
    if (CONTAINER_CLOSE.test(raw)) {
      const wasHidden = containers.pop();
      if (wasHidden === true) hidden -= 1;
      prevBlank = false;
      continue;
    }
    if (raw.trim() === '') {
      prevBlank = true;
      continue;
    }
    if (LIST_MARKER.test(raw)) {
      inList = true;
      prevBlank = false;
      continue;
    }
    if (inList) {
      // ⚠ 下げてある行は**項目の中身**。下げていない行は、空行の後なら箇条書きの外
      if (/^[ \t]/.test(raw) || !prevBlank) {
        prevBlank = false;
        continue;
      }
      inList = false;
    }
    const h = HEADING.exec(raw);
    if (h !== null) {
      const level = h[1]!.length;
      // ⚠ 深い側を捨ててから積む(見出しが浅くなったら、その下は道筋から外れる)
      path.length = level - 1;
      path[level - 1] = h[2]!.trim();
      prevBlank = false;
      continue;
    }
    // ⚠ 段落の**続き**なら、markdown は下げをコードにしない ── 下げを外して当てる
    const target = prevBlank ? raw : raw.replace(/^[ \t]+/, '');
    prevBlank = false;
    if (hidden > 0) continue;
    const names = parseTagLine(target);
    if (names === null) continue;
    const heading = path.filter((x) => x !== undefined && x !== '');
    for (const name of names) out.push({ name, line: i, heading });
  }
  return out;
}
