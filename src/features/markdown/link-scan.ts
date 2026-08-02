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

    // ── インラインリンク / 画像
    if (ch === ']' && text[i + 1] === '(' && !escaped()) {
      const m = at(INLINE_LINK, text, i);
      if (m) {
        const dest = m[1] ?? m[2] ?? '';
        // 宛先の位置: `](` + 空白 + (`<`)
        const lead = /^\]\(\s*<?/.exec(m[0])![0].length;
        sites.push({
          kind: 'inline',
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

    // ── HTML の src / href(`<img src="…">` など)。閉じ `>` までを窓にする
    if (ch === '<' && !escaped() && /[a-zA-Z]/.test(text[i + 1] ?? '')) {
      const close = text.indexOf('>', i);
      // ⚠ 迷子の `<` で遠くまで slice しない
      if (close !== -1 && close - i <= TAG_WINDOW) {
        const tag = text.slice(i, close + 1);
        HTML_ATTR.lastIndex = 0;
        for (let am = HTML_ATTR.exec(tag); am; am = HTML_ATTR.exec(tag)) {
          const dest = am[1] ?? am[2] ?? am[3] ?? '';
          if (dest === '') continue;
          const destStart = i + am.index + am[0].length - dest.length - (am[3] ? 0 : 1);
          sites.push({
            kind: 'html',
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
