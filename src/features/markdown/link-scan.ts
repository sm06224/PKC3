/**
 * markdown のリンク宛先を **1 つの規則で**拾う(P7 段② のレビュー M-1 / M-3)。
 *
 * 🔴 **同じ判定が 2 か所に生えたので、規則を 1 つに寄せた**(CLAUDE.md)。
 * 書出し側(`export/pkc3-markdown-zip.ts`)は `](asset:key)` を相対パスへ書き換えるため、
 * 取込側(`import/plain-markdown.ts`)は「解決しない参照」を数えるため、それぞれ
 * 別々に走査を書いていた。結果、取込側は
 * - **参照形式リンク**(`[a]: images/x.png`)と **HTML の `src` / `href`** を取りこぼし
 *   ── いちばん数えたいもの(黙って画像が壊れる形)を落としていた
 * - fence / 行内コード / エスケープの中まで数え、**嘘の警告**を出していた
 * という、誤差が**両方向**に出る形になっていた。
 *
 * ## 役割分担
 * ここは **どこがリンクの宛先か** だけを返す(広く・忠実に)。
 * 「その宛先をどう扱うか」は consumer が決める ── 書出しは `asset:` だけを狭く
 * 書き換え、取込は相対パスだけを数える。⚠ **誤差の向きは consumer 側で決める**。
 *
 * ## CommonMark のうち見るもの
 * - コードフェンス(``` / ~~~。**閉じは開き以上の長さ**、3 スペースまで字下げ可)
 * - 行内コード(バッククォート連。⚠ **空行を越えない**)
 * - `\]` エスケープ
 * - `](dest)` / `](<dest>)` / `](dest "title")`、宛先の括弧は 1 段まで対応
 * - 参照形式の定義行 `[label]: dest "title"`
 * - HTML の `src=` / `href=`
 */

export type LinkKind = 'inline' | 'reference' | 'html';

export interface LinkSite {
  kind: LinkKind;
  /**
   * 🔴 **画像として書かれているか**(#264 段⓪)。
   *
   * ⚠ **これを持たないと、「取り込む」がリンクまで取りに行く** ── user が単に
   *   貼っただけの web ページの URL まで**第三者へ通信する**ことになる
   *   (#264 が「自動で取り込む」を棄却した理由②を、押した瞬間にリンクの数だけやる)。
   * ⚠ 「fetch して MIME で捨てる」は解にならない ── **通信そのもの**が問題なので、
   *   **行く前に**絞る必要がある。
   *
   * 決まり方は形ごとに違う:
   * - `![x](y)` … 対応する `[` の 1 つ前が(エスケープされていない)`!`
   * - `<img src="…">` … **タグ名**で決まる(`src` を持つのは `img` / `video` など)
   * - 🔴 `[label]: dest` … **定義行では決まらない。常に `false`** ──
   *   `!` が付くのは**使う側**である。⚠ 定義だけを見て「画像だ」と決めると、
   *   **同じ定義をリンクとしても使っているノート**で取りに行ってしまう。
   */
  image: boolean;
  /** 置換対象の開始 index(text 内)。 */
  start: number;
  /** 置換対象の終端 index(排他)。 */
  end: number;
  /** 宛先(`<>` は外す。`title` は含まない)。 */
  dest: string;
  /** `[start, end)` のうち宛先そのものの範囲。書換はここだけ差し替えれば足りる。 */
  destStart: number;
  destEnd: number;
}

export interface LinkScan {
  sites: LinkSite[];
  /** 閉じていないコードフェンス(あれば開き記号)。書出し側が警告に使う。 */
  openFence: string | null;
}

/**
 * ⚠ 位置合わせは **sticky(`y`)**で行う。`text.slice(i)` を作って `^` で当てると
 * 位置ごとに**残り全体をコピー**することになり、走査が O(n²) になる ──
 * 実測で行内コードの多い 3MB の md が **74.8 秒**かかっていた。
 */
/** `](dest)` / `](<dest>)` / `](dest "title")`。宛先の括弧は 1 段まで。 */
const INLINE_LINK =
  /\]\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))*))(\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/y;
/** 参照形式の定義行 `[label]: dest "title"`。 */
const REF_DEF = / {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^<>\n]*)>|(\S+))/y;
/** コードフェンスの開き。 */
const FENCE_OPEN = /(`{3,}|~{3,})/y;
/** バッククォート連(行内コードの開き)。 */
const TICK_RUN = /`+/y;
/** 段落の切れ目(空行)。⚠ CR / CRLF / LF のどれでも切れる。 */
const BLANK_LINE = /(?:\r\n|[\r\n])[ \t]*(?:\r\n|[\r\n])/g;
/** HTML 属性 `src="..."` / `href='...'`。 */
const HTML_ATTR = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
/** HTML タグとして読む窓。⚠ 迷子の `<` で遠くまで slice しない。 */
const TAG_WINDOW = 4096;
/**
 * 🔴 **画像として読むタグ**(#264 段⓪)。⚠ `<a href>` は入れない。
 * ⚠ 足すときは「**その `src` は絵か**」を問う ── `<script src>` や `<iframe src>` は
 *   絵ではないので入れない(取り込んでも意味が無く、通信だけ増える)。
 */
const IMAGE_TAG = /^<\s*(?:img|image|picture|source|video|audio)\b/i;

/**
 * 対応する `[` の 1 つ前が `!` か(#264 段⓪)。
 * ⚠ **`!` 自身のエスケープを見る** ── `\![x](y)` は**リンク**である。
 */
function isImageOpen(text: string, open: number): boolean {
  if (open <= 0 || text[open - 1] !== '!') return false;
  let k = open - 2;
  let c = 0;
  while (k >= 0 && text[k] === '\\') {
    c++;
    k--;
  }
  return c % 2 === 0;
}

/** 閉じ fence の正規表現(形ごとにコンパイルを使い回す)。 */
const closeCache = new Map<string, RegExp>();

/** sticky 正規表現を位置 `i` に当てる。 */
function at(re: RegExp, text: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(text);
}

/**
 * リンク宛先を走査する。**コードの中は見ない**。
 *
 * ⚠ 走査対象は**原文**を渡すこと。`parseFrontmatter` の戻り body を渡すと
 * CRLF が正規化され、index が原文とずれる(= 書換に使えない)。
 */
export function scanLinks(text: string): LinkScan {
  const sites: LinkSite[] = [];
  let openFence: string | null = null;
  let i = 0;
  const n = text.length;
  // ⚠ **行末は `\n` だけではない**。CommonMark の line ending は `\n` / `\r` /
  // `\r\n` の 3 つで、markdown-it も `\r\n?` を `\n` に正規化してから parse する
  // ── ここで `\n` だけを見ると、**描画は正しいのに走査だけがずれる**
  const atLineStart = (): boolean =>
    i === 0 || text[i - 1] === '\n' || text[i - 1] === '\r';
  // 🔴 **単調前進をキャッシュする**。`i` は決して戻らないので、「i 以降で最初の
  // 空行」も単調に進む ── 毎回 `i` から探し直すと、空行の無い本文では
  // バッククォート 1 個ごとに残り全体を舐めて **O(n²)** になる。
  // 実測: 行内コードの多い 3MB の md が **103.7 秒**(このキャッシュで 40ms 台)。
  // ⚠ ここは元の書出し側にも同型で在った(`text.indexOf('\n\n', i)`)── 走査を
  // 1 本に寄せたことで、両方まとめて直っている
  let blankFrom = -1; // このキャッシュが有効な下限
  let blankAt = -1; // その位置(-1 = 以降に空行なし)
  const nextBlankLine = (from: number): number => {
    if (blankFrom >= 0 && (blankAt === -1 || blankAt >= from) && from >= blankFrom) return blankAt;
    BLANK_LINE.lastIndex = from;
    const m = BLANK_LINE.exec(text);
    blankFrom = from;
    blankAt = m ? m.index : -1;
    return blankAt;
  };
  /** 直前の連続バックスラッシュが奇数個 = この文字はエスケープされている。 */
  const escaped = (): boolean => {
    let k = i - 1;
    let c = 0;
    while (k >= 0 && text[k] === '\\') {
      c++;
      k--;
    }
    return c % 2 === 1;
  };

  /**
   * 🔴 **開いている `[` の位置**(いちばん内側が末尾。#264 段⓪)。
   *
   * ⚠ **`]` から後ろ向きに対応する `[` を探さない** ── ラベルの中の `[]` を
   *   釣り合わせる必要があり、リンク 1 本ごとに O(n) = 走査全体が **O(n²)** になる。
   * 🔑 この file は**まさにその理由で書き直された**(冒頭の実測: 3MB の md が 74.8 秒)。
   *   前へ進みながら積めば、**1 パスのまま**で対応が取れる。
   */
  const opens: number[] = [];

  while (i < n) {
    const ch = text[i]!;

    // ── コードフェンス。⚠ **閉じは開き以上の長さ**(CommonMark)── 長さを見ないと
    // 「4 個で開いて 3 個で閉じる」= markdown を説明する文書が壊れる(review M-1)。
    // ⚠ 閉じ fence は 3 スペースまで字下げできる ── 桁 0 固定で探すと
    // 「閉じない fence」と誤判定して以降を全部飲む
    if ((ch === '`' || ch === '~') && atLineStart()) {
      const m = at(FENCE_OPEN, text, i);
      if (m) {
        const fence = m[1]!;
        // ⚠ 同じ形の fence が何万個も出るので**コンパイルを使い回す**
        let closeRe = closeCache.get(fence);
        if (!closeRe) {
          closeRe = new RegExp(
            `(?:\\r\\n|[\\r\\n]) {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \t]*(?:\\r\\n|[\\r\\n]|$)`,
            'g',
          );
          closeCache.set(fence, closeRe);
        }
        closeRe.lastIndex = i + fence.length;
        const cm = closeRe.exec(text);
        if (cm) {
          i = cm.index + cm[0].length;
        } else {
          i = n; // 閉じない fence = ここから末尾まで全部コード
          openFence = fence;
        }
        continue;
      }
    }

    // ── 行内コード。⚠ markdown-it は**ブロックを越えて**コードスパンを作らない ──
    // 空行を跨いで対応付けると、野良バッククォート 2 個の間が丸ごと飛ぶ
    if (ch === '`') {
      const run = at(TICK_RUN, text, i)![0];
      const limit = nextBlankLine(i);
      const close = text.indexOf(run, i + run.length);
      if (close !== -1 && (limit === -1 || close < limit)) {
        i = close + run.length;
        continue;
      }
    }

    // ── 参照形式の定義行(行頭のみ)
    if (ch === '[' && atLineStart() && !escaped()) {
      const m = at(REF_DEF, text, i);
      if (m) {
        const dest = m[1] ?? m[2] ?? '';
        const destStart = i + m[0].length - dest.length - (m[1] !== undefined ? 1 : 0);
        sites.push({
          kind: 'reference',
          /**
           * 🔴 **定義行では画像かどうか決まらない**(#264 段⓪)── `!` が付くのは
           *   **使う側**(`![x][label]`)である。⚠ ここで `true` にすると、
           *   **同じ定義をリンクとしても使っているノート**で取りに行ってしまう。
           */
          image: false,
          start: i,
          end: i + m[0].length,
          dest,
          destStart,
          destEnd: destStart + dest.length,
        });
        i += m[0].length;
        continue;
      }
    }

    /**
     * ── 開き `[` を積む(#264 段⓪)。⚠ **`continue` しない** ── 下の判定は
     *   `[` に当たらないので、末尾の `i++` に任せて構造を変えない。
     * ⚠ 参照形式の定義行は上で丸ごと食べているので、ここへは来ない。
     */
    if (ch === '[' && !escaped()) opens.push(i);

    // ── インラインリンク / 画像
    if (ch === ']' && !escaped()) {
      /**
       * **リンクにならない `]` でも降ろす**(#264 段⓪)。
       *
       * ⚠ **1 稿目のここには「降ろさないと後ろのリンクが別の `[` と対応する」と
       *   書いていたが、誤りだった**(変異試験 L1 が SURVIVED で教えた)──
       *   積みは **LIFO** で、リンクの `[` は**必ず最後に積まれる**ので、
       *   置き去りの `[` は下に沈んだまま**誰にも降ろされない**。
       *   🔑 つまり**答えは 1 ビットも変わらない**。
       * 🔑 それでも降ろすのは**積みを伸ばさない**ためである ── 降ろさないと
       *   `]` の数だけ配列が伸びる(角括弧を多用する文書で無駄に太る)。
       *   ⚠ 守っている test は無い(CLAUDE.md「これが無いと壊れる、と書く前に
       *   外して壊れるのを見る」── 外しても壊れなかったので、そう書いてある)。
       */
      const open = opens.pop() ?? -1;
      if (text[i + 1] === '(') {
        const m = at(INLINE_LINK, text, i);
        if (m) {
          const dest = m[1] ?? m[2] ?? '';
          // 宛先の位置: `](` + 空白 + (`<`)
          const lead = /^\]\(\s*<?/.exec(m[0])![0].length;
          sites.push({
            kind: 'inline',
            image: isImageOpen(text, open),
            start: i,
            end: i + m[0].length,
            dest,
            destStart: i + lead,
            destEnd: i + lead + dest.length,
          });
          i += m[0].length;
          continue;
        }
      }
    }

    // ── HTML の src / href(`<img src="…">` など)。閉じ `>` までを窓にする
    if (ch === '<' && !escaped() && /[a-zA-Z]/.test(text[i + 1] ?? '')) {
      const close = text.indexOf('>', i);
      // ⚠ 迷子の `<` で遠くまで slice しない
      if (close !== -1 && close - i <= TAG_WINDOW) {
        const tag = text.slice(i, close + 1);
        // 🔴 HTML は**タグ名**で決まる(#264 段⓪)── `src` を持つのは `img` / `video` など
        const isImageTag = IMAGE_TAG.test(tag);
        HTML_ATTR.lastIndex = 0;
        for (let am = HTML_ATTR.exec(tag); am; am = HTML_ATTR.exec(tag)) {
          const dest = am[1] ?? am[2] ?? am[3] ?? '';
          if (dest === '') continue;
          const destStart = i + am.index + am[0].length - dest.length - (am[3] ? 0 : 1);
          sites.push({
            kind: 'html',
            /**
             * ⚠ **属性ではなくタグで見る** ── `<a href>` と `<img src>` は
             *   同じ `HTML_ATTR` に当たるので、属性名で分けると
             *   `<video src>` / `<source src>` を取りこぼす。
             */
            image: isImageTag,
            start: i + am.index,
            end: i + am.index + am[0].length,
            dest,
            destStart,
            destEnd: destStart + dest.length,
          });
        }
        i = close + 1;
        continue;
      }
    }

    i++;
  }
  return { sites, openFence };
}

/**
 * 宛先だけを差し替えた text を作る(範囲は `scanLinks` が返したものを使う)。
 * `replace` が `undefined` を返した site はそのまま残す。
 */
export function rewriteLinkDests(
  text: string,
  sites: readonly LinkSite[],
  replace: (site: LinkSite) => string | undefined,
): string {
  let out = '';
  let cursor = 0;
  for (const site of sites) {
    const next = replace(site);
    if (next === undefined) continue;
    out += text.slice(cursor, site.destStart) + next;
    cursor = site.destEnd;
  }
  return out + text.slice(cursor);
}
