/**
 * 貼り付けた **リッチテキスト(RTF)を PKC-Markdown へ戻す**
 * (user 指示 2026-08-25「**HTML貼付のほか、最近はリッチタイプテキストも増えてる /
 * 対応して欲しい**」)。
 *
 * ## 🔑 HTML の**代わり**ではなく、HTML が無いときの道である
 *
 * Word / Excel / Google ドキュメント / LibreOffice は、コピーすると
 * **`text/html` と `text/rtf` の両方**をクリップボードに載せる ── そこは
 * `html-to-markdown.ts` のほうが**必ず忠実**である(見出しもコードもそのまま
 * 在るので)。だから RTF は **HTML が無い / 使えないときだけ**通す
 * (配線は `binder.ts` の `pasteText` 1 か所)。
 *
 * 🔴 **RTF しか載らない出し手が実在する**のがこの module の理由である ──
 * Windows の WordPad、macOS の TextEdit(リッチテキスト書類)、一部の
 * ネイティブ製アプリは `text/html` を書かない。いままではそこから貼ると
 * **平文に潰れていた**(書式が丸ごと落ちる)。
 *
 * ⚠ **実測できたのはここまで**(2026-08-25、同梱 Chromium):
 * 貼付イベントの `clipboardData.types` に `text/rtf` が載り、`getData` で読める。
 * ⚠ **実機の Word / TextEdit から貼ったところは測っていない**(この箱に
 * ネイティブのアプリが無い)── そこは cowork へ回す。
 *
 * ## 介入しない条件(`convertPastedRtf` が `null` を返す = 既定の貼付に委ねる)
 *
 * - `text/rtf` が空 / 上限超過 / `{\rtf` で始まらない
 * - **`text/plain` が既に markdown 原文らしい**(判定は `html-to-markdown.ts` の 1 本)
 * - 変換して**得るものが無い**(見出し・リスト・表・リンク・画像・装飾が 1 つも無い)
 * - 変換結果が空 / 平文と同じ
 *
 * ## 出す形は PKC3 の描画に合わせる
 *
 * - 太字 `**` / 斜体 `*` / 取り消し `~~`
 * - **下線は `:文字:underline:`**(PKC3 の簡易 inline 記法)── ⚠ 中身に `:` が
 *   在るときは記法が閉じられないので**下線だけ落とす**(文字は残す)
 * - 見出しは**スタイルシートを読んで**決める ── RTF に見出しという概念は無く、
 *   Word は `{\stylesheet{\s1 heading 1;}…}` と `\s1` の対で表す
 * - 表は GFM(`gfmTable` を共有 ── 見出しが無い表に空の見出しを足す規則ごと)
 * - 画像(`\pngblip` / `\jpegblip`)は `data:` URL にして出す ── 資産へ逃がすのは
 *   呼び側(`inline-url-adopt.ts`)の仕事で、ここは純関数のまま保つ
 *
 * ## ⚠ 出せないもの(黙って化けさせないために書く)
 *
 * - **コード** ── RTF に「コード」は無い。等幅フォントで推測すると、ふつうの
 *   文まで backtick で包んでしまうので**やらない**
 * - **`\wmetafile`(WMF / EMF)の画像** ── ブラウザで描けないので落とす
 * - **`\'hh` の非 ASCII** ── cp1252 として読む。⚠ 近年の出し手は非 ASCII を
 *   `\uN` で書く(`\'hh` は取りこぼし用の `?` として付く)ので実害は無いが、
 *   古い出し手が cp932 などで書いた場合はここで化ける
 */
import { escapeInline, gfmTable, isSafeHref, plainLooksLikeMarkdown } from './html-to-markdown';

/** これより大きい `text/rtf` は**解析しない**(貼付でメインスレッドを止めない)。 */
export const PASTE_RTF_MAX = 4 * 1024 * 1024;

/** クリップボードの 2 面。**両方**を見て介入するかを決める。 */
export interface PastedRtf {
  readonly rtf: string;
  readonly plain: string;
}

/**
 * 🔴 **画像を預かる印**(私用領域)。
 *
 * ⚠ `data:` URL を段落の文字に混ぜると `escapeInline` が中の記号まで escape する
 * ── だから印で預かり、**最後に**開く。⚠ 生バイトで書かない(CLAUDE.md の
 * 「制御文字をソースに生バイトで埋めない」と同じ理由で、私用領域も escape で書く)。
 */
const IMG_MARK = '\uE010';

/** 1 続きの文字と、その飾り。 */
interface Run {
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  /** リンクの宛先(`\field` の中だけ)。 */
  href: string | null;
}

/** 文字の飾りの状態(group ごとに引き継ぐ)。 */
interface Fmt {
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  hidden: boolean;
}

/** いま何を読んでいるか。`skip` の中身は 1 文字も出さない。 */
type Dest = 'body' | 'skip' | 'stylesheet' | 'listtext' | 'fldinst' | 'pict';

interface Frame {
  fmt: Fmt;
  dest: Dest;
  /** `\uN` の後に読み飛ばす文字数(`\ucN`)。 */
  uc: number;
}

/** 中身を 1 文字も出さない destination(見出しの素になる `stylesheet` は別扱い)。 */
const SKIP_DEST = new Set([
  'fonttbl', 'colortbl', 'info', 'header', 'footer', 'headerl', 'headerr',
  'footerl', 'footerr', 'footnote', 'endnote', 'annotation', 'xe', 'tc', 'tcn',
  'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'rsidtbl',
  'generator', 'listtable', 'listoverridetable', 'pntxta', 'pntxtb', 'objdata',
  'nonshppict', 'shpinst', 'do', 'bkmkstart', 'bkmkend', 'atrfstart', 'atrfend',
  'mmathPr', 'wgrffmtfilter', 'operator', 'company', 'category',
]);

/** `\*` 付きでも中身を使う destination(これ以外の `{\*\…}` は捨てる)。 */
const KEEP_STARRED = new Set(['fldinst', 'pict']);

/** cp1252 のうち 0x80–0x9F(それ以外は latin-1 と同じ)。 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];

/** 記号を出す制御語(`\bullet` など)。 */
const SYMBOLS: Record<string, string> = {
  bullet: '•',
  endash: '–',
  emdash: '—',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  emspace: ' ',
  enspace: ' ',
  tab: '\t',
};

const freshFmt = (): Fmt => ({ b: false, i: false, u: false, strike: false, hidden: false });

/**
 * 飾りを markdown にする。
 *
 * ⚠ **空白は包みの外へ出す** ── `** 太字 **` は強調にならない(`**` の内側が
 * 空白で始まると markdown が受け付けない)。⚠ ここを落とすと、**Word から貼ると
 * 強調が生の `**` として出る**という、いちばん目に付く壊れ方になる。
 */
function renderRun(r: Run): string {
  if (r.text === '') return '';
  const lead = /^\s*/.exec(r.text)![0];
  const tail = /\s*$/.exec(r.text)![0];
  const core = r.text.slice(lead.length, r.text.length - tail.length);
  if (core === '') return r.text;
  let out = escapeInline(core);
  /**
   * ⚠ **下線は `:` を含む文字には掛けられない**(記法が閉じられない)。
   * 🔑 そのときは**飾りだけ落とす** ── 文字を落とすほうがずっと悪い。
   */
  if (r.u && !core.includes(':')) out = ':' + out + ':underline:';
  if (r.strike) out = '~~' + out + '~~';
  if (r.b) out = '**' + out + '**';
  if (r.i) out = '*' + out + '*';
  if (r.href !== null && isSafeHref(r.href)) {
    const target = r.href.trim().replace(/[()\s]/g, (ch) => encodeURIComponent(ch));
    out = '[' + out + '](' + target + ')';
  }
  return lead + out + tail;
}

const sameFmt = (a: Run, b: Run): boolean =>
  a.b === b.b && a.i === b.i && a.u === b.u && a.strike === b.strike && a.href === b.href;

function renderRuns(runs: Run[]): string {
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && sameFmt(last, r)) last.text += r.text;
    else merged.push({ ...r });
  }
  return merged.map(renderRun).join('');
}

/** 組み立て中の段落。 */
interface Para {
  runs: Run[];
  /** 箇条書きの深さ(`\ilvlN`)。`null` = リストではない。 */
  listLevel: number | null;
  /** 番号付きか。 */
  ordered: boolean;
  /** 見出しの段(1–6)。0 = 見出しではない。 */
  heading: number;
  /** 表の中か。 */
  inTable: boolean;
}

const freshPara = (): Para => ({
  runs: [],
  listLevel: null,
  ordered: false,
  heading: 0,
  inTable: false,
});

/**
 * 🔴 **RTF を PKC-Markdown にする唯一の判定**。`null` = 介入しない(既定の貼付)。
 * ⚠ 判定をここ 1 か所に閉じる ── 呼び側で条件を足すと、
 * 「経路ごとに挙動が違う」形になる(`convertPastedHtml` と同じ作法)。
 */
export function convertPastedRtf(clip: PastedRtf): string | null {
  const { rtf, plain } = clip;
  if (rtf === '' || rtf.length > PASTE_RTF_MAX) return null;
  if (!/^\s*\{\s*\\rtf\d/.test(rtf)) return null;
  if (plainLooksLikeMarkdown(plain)) return null;

  const md = parseRtf(rtf);
  if (md === null) return null;
  // ⚠ 平文と同じものを作っただけなら介入しない(undo の段数だけ増える)
  return md === plain.trim() ? null : md;
}

/** @returns 得るものが無ければ `null`。 */
export function parseRtf(rtf: string): string | null {
  const stack: Frame[] = [{ fmt: freshFmt(), dest: 'body', uc: 1 }];
  const top = (): Frame => stack[stack.length - 1]!;

  const blocks: string[] = [];
  let para = freshPara();
  /** 表の行を溜める(`\row` ごとに 1 行)。 */
  let tableRows: { cells: string[]; head: boolean }[] = [];
  let tableCells: string[] = [];
  let rowIsHeader = false;
  /** スタイル番号 → 見出しの段。 */
  const headingStyles = new Map<number, number>();
  /** `\field` の宛先(`\fldinst` が拾って、続く `\fldrslt` の文字に付く)。 */
  let pendingHref: string | null = null;
  let linkHref: string | null = null;
  /** リンクが効いている group の深さ(閉じたら宛先を返す)。 */
  let linkDepth = 0;
  /** stylesheet / listtext / fldinst / pict の中で溜める素の文字。 */
  let buf = '';
  /**
   * 画像の形式。
   *
   * ⚠ **溜めた文字から探してはいけない**(1 稿目で踏んだ)── `\pngblip` は
   * **制御語なのでトークナイザが食べる**ので、`buf` には 16 進しか残らない。
   * 「`buf` に `\pngblip` が在るか」で見ていたら**常に偽**で、画像が 1 枚も
   * 出なかった。🔑 制御語を見た**その場**で控える。
   */
  let pictKind: 'png' | 'jpeg' | null = null;
  let bufStyle = 0;
  /** `\uN` の取りこぼし用に読み飛ばす残り文字数。 */
  let skipChars = 0;
  /** 変換して得るものが在ったか(1 つでも在れば介入する)。 */
  let worth = false;

  const flushTable = (): void => {
    if (tableCells.length > 0) {
      tableRows.push({ cells: tableCells, head: rowIsHeader });
      tableCells = [];
    }
    const t = gfmTable(tableRows);
    if (t !== null) {
      blocks.push(t);
      worth = true;
    }
    tableRows = [];
    rowIsHeader = false;
  };

  const paraText = (): string => renderRuns(para.runs).replace(/\s+$/, '');

  const endPara = (): void => {
    if (para.inTable) {
      // 表の中の段落を閉じるのは `\cell` ── ここでは何もしない
      para = { ...freshPara(), inTable: true };
      return;
    }
    if (tableRows.length > 0 || tableCells.length > 0) flushTable();
    const text = paraText();
    if (text !== '') {
      if (para.heading > 0) {
        blocks.push('#'.repeat(para.heading) + ' ' + text);
        worth = true;
      } else if (para.listLevel !== null) {
        const indent = '  '.repeat(Math.min(para.listLevel, 6));
        blocks.push(indent + (para.ordered ? '1.' : '-') + ' ' + text);
        worth = true;
      } else {
        blocks.push(text);
      }
    }
    para = freshPara();
  };

  const push = (text: string): void => {
    if (text === '') return;
    const f = top();
    if (f.dest === 'skip' || f.fmt.hidden) return;
    if (f.dest !== 'body') {
      buf += text;
      return;
    }
    if ((f.fmt.b || f.fmt.i || f.fmt.u || f.fmt.strike) && text.trim() !== '') worth = true;
    if (linkHref !== null) worth = true;
    para.runs.push({
      text,
      b: f.fmt.b,
      i: f.fmt.i,
      u: f.fmt.u,
      strike: f.fmt.strike,
      href: linkHref,
    });
  };

  function applyWord(word: string, arg: number | null): void {
    const f = top();
    switch (word) {
      case 'pard':
        para.listLevel = null;
        para.heading = 0;
        return;
      case 'plain':
        f.fmt.b = false;
        f.fmt.i = false;
        f.fmt.u = false;
        f.fmt.strike = false;
        return;
      case 'b':
        f.fmt.b = arg !== 0;
        return;
      case 'i':
        f.fmt.i = arg !== 0;
        return;
      case 'strike':
        f.fmt.strike = arg !== 0;
        return;
      case 'ul':
        f.fmt.u = arg !== 0;
        return;
      case 'ulnone':
        f.fmt.u = false;
        return;
      case 'v':
        f.fmt.hidden = arg !== 0;
        return;
      case 'uc':
        f.uc = arg ?? 1;
        return;
      case 'u': {
        if (arg === null) return;
        push(String.fromCodePoint(arg < 0 ? arg + 0x10000 : arg));
        skipChars = f.uc;
        return;
      }
      case 'par':
        endPara();
        return;
      case 'line':
        push('\n');
        return;
      case 's':
        if (arg === null) return;
        if (f.dest === 'stylesheet') bufStyle = arg;
        else {
          const h = headingStyles.get(arg);
          if (h !== undefined) para.heading = h;
        }
        return;
      case 'ilvl':
        para.listLevel = arg ?? 0;
        return;
      case 'ls':
        if (para.listLevel === null) para.listLevel = 0;
        return;
      case 'intbl':
        para.inTable = true;
        return;
      case 'trhdr':
        rowIsHeader = true;
        return;
      case 'cell':
        tableCells.push(paraText());
        para = { ...freshPara(), inTable: true };
        return;
      case 'row':
        tableRows.push({ cells: tableCells, head: rowIsHeader });
        tableCells = [];
        rowIsHeader = false;
        para = freshPara();
        return;
      case 'stylesheet':
        f.dest = 'stylesheet';
        return;
      case 'listtext':
      case 'pntext':
        f.dest = 'listtext';
        return;
      case 'fldinst':
        f.dest = 'fldinst';
        return;
      case 'fldrslt':
        linkHref = pendingHref;
        linkDepth = stack.length;
        pendingHref = null;
        return;
      case 'pict':
        f.dest = 'pict';
        pictKind = null;
        return;
      case 'pngblip':
        pictKind = 'png';
        return;
      case 'jpegblip':
        pictKind = 'jpeg';
        return;
      default:
        if (SKIP_DEST.has(word)) f.dest = 'skip';
        else if (SYMBOLS[word] !== undefined) push(SYMBOLS[word]!);
        return;
    }
  }

  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const c = rtf[i]!;

    if (c === '{') {
      const f = top();
      stack.push({ fmt: { ...f.fmt }, dest: f.dest, uc: f.uc });
      i++;
      continue;
    }

    if (c === '}') {
      const closing = top();
      if (closing.dest === 'stylesheet') {
        /**
         * ⚠ **`bufStyle` が 0 でも溜めを捨てる**(1 稿目で踏んだ)。
         * `{\stylesheet{\s0 Normal;}{\s1 heading 1;}}` の 1 つ目は
         * `\s0` なので見出しにならないが、そこで捨てないと**次の名前の前に
         * `Normal;` がくっつき**、`heading 1` が読めなくなる ── 実際
         * 「`\s1` だけ見出しにならない」という形で落ちた。
         */
        if (bufStyle > 0) {
          const name = buf.replace(/;[\s\S]*$/, '').trim();
          const m = /^(?:heading|見出し)\s*([1-9])/i.exec(name);
          if (m) headingStyles.set(bufStyle, Math.min(6, Number(m[1])));
        }
        buf = '';
        bufStyle = 0;
      } else if (closing.dest === 'listtext') {
        // 🔑 リストの印は**中身**で決まる(`1.` なら番号付き)
        para.ordered = /\d[.)]/.test(buf);
        if (para.listLevel === null) para.listLevel = 0;
        buf = '';
      } else if (closing.dest === 'fldinst') {
        /**
         * ⚠ **当たったときだけ入れる**(1 稿目で踏んだ)。宛先は
         * `{\*\fldinst{HYPERLINK "…"}}` と**2 重の group**に入っているので、
         * 内側で拾った後に外側がもう一度ここへ来る ── `m` が無い回に
         * `null` を代入すると、**拾った宛先をその場で捨てる**。
         * 実際「リンクが 1 つも出ない」という形で落ちた。
         */
        const m = /HYPERLINK\s+"([^"]+)"/i.exec(buf);
        if (m) pendingHref = m[1]!;
        buf = '';
      } else if (closing.dest === 'pict') {
        const img = pictToDataUrl(buf, pictKind);
        buf = '';
        pictKind = null;
        if (img !== null) {
          para.runs.push({
            text: ' ' + IMG_MARK + img + IMG_MARK + ' ',
            b: false,
            i: false,
            u: false,
            strike: false,
            href: null,
          });
          worth = true;
        }
      }
      if (stack.length > 1) stack.pop();
      /**
       * ⚠ `\field` の結果が閉じたら宛先を返す ── 返さないと、**後続の文まで
       *   リンクの中に入る**(貼った先で全部が 1 本のリンクになる)。
       */
      if (linkHref !== null && stack.length < linkDepth) linkHref = null;
      i++;
      continue;
    }

    if (c === '\\') {
      const next = rtf[i + 1];
      if (next === undefined) break;
      // `\\` `\{` `\}` は文字そのもの
      if (next === '\\' || next === '{' || next === '}') {
        push(next);
        i += 2;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        i += 4;
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (skipChars > 0) skipChars--;
          else {
            const b = parseInt(hex, 16);
            push(String.fromCodePoint(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b));
          }
        }
        continue;
      }
      if (next === '~') {
        push(' ');
        i += 2;
        continue;
      }
      if (next === '-') {
        i += 2; // 任意ハイフン ── 出さない
        continue;
      }
      if (next === '_') {
        push('-');
        i += 2;
        continue;
      }
      if (next === '*') {
        // `{\*\word …}` ── 知らない destination は中身ごと捨てる
        const m = /^\\\*\\([a-zA-Z]+)/.exec(rtf.slice(i));
        if (!m || !KEEP_STARRED.has(m[1]!)) top().dest = 'skip';
        i += 2;
        continue;
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(rtf.slice(i));
      if (!m) {
        i += 2; // 知らない制御記号
        continue;
      }
      i += m[0].length;
      applyWord(m[1]!, m[2] === undefined ? null : Number(m[2]));
      continue;
    }

    if (c === '\r' || c === '\n') {
      i++; // RTF の生の改行は意味を持たない
      continue;
    }

    if (skipChars > 0) {
      skipChars--;
      i++;
      continue;
    }
    push(c);
    i++;
  }

  endPara();
  if (tableRows.length > 0 || tableCells.length > 0) flushTable();

  const text = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text === '' || !worth) return null;
  return restoreImages(text);
}

/**
 * `\pict` の 16 進を `data:` URL にする。
 * @param kind 制御語で分かった形式。⚠ **`null` は描けない形式**
 *   (`\wmetafile` の WMF / EMF)── ブラウザで描けないので出さない。
 */
function pictToDataUrl(raw: string, kind: 'png' | 'jpeg' | null): string | null {
  if (kind === null) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 32 || hex.length % 2 !== 0) return null;
  let bin = '';
  for (let k = 0; k < hex.length; k += 2) bin += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  return 'data:image/' + kind + ';base64,' + btoa(bin);
}

/**
 * 預かった画像を markdown の画像に戻す。
 * ⚠ **最後にやる** ── `escapeInline` を通すと `data:` URL の中の記号まで
 *   escape されるので、印で預かって最後に開く。
 */
function restoreImages(text: string): string {
  const re = new RegExp(IMG_MARK + '([^' + IMG_MARK + ']*)' + IMG_MARK, 'g');
  return text.replace(re, (_m, url: string) => '![](' + url + ')');
}
