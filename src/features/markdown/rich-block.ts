/**
 * 🔴 **ブロック単位のリッチ編集 ── 純関数のコア**(v4.0 Phase 1 / PR-05。ビジョン 4-A)。
 *
 * > 「実態としての Markdown」×「ブロック単位ハイブリッド WYSIWYG」。
 * > 保存の正本は**常にプレーンな PKC-Markdown のまま**。クリックした**安全なブロックだけ**を、
 * > 記号を隠した `contenteditable` で直接編集させる。
 *
 * ## このファイルが持つ 3 つの判断(どれも 1 か所。CLAUDE.md §6-7)
 *
 * 1. **安全なブロックか**(`classifyRichBlock` / `parseRichBlock`)── 段落・見出し・単純な引用・
 *    子を持たない 1 つのリスト項目だけ。コード・数式・`:::`・表・区切り・脚注・frontmatter・HTML、
 *    行内のルビ・圏点・ロール・数式・画像・脚注参照などは **`null`**(呼び側は原文の `<textarea>` で開く)。
 * 2. **DOM → PKC-Markdown**(`serializeRichBlock`)── `contenteditable` の木を、決まった 1 通りの綴りへ戻す。
 *    ブラウザが勝手に入れる `<div>` / `<p>` / 末尾の `<br>` / 空の `<span>` / `style` のクズ / NBSP を均す。
 * 3. **往復しても 1 バイトも変わらないか**(`canRichEditSafely` / `prepareRichBlock`)──
 *    **本物の描き手**(`renderHtml` に渡される `renderMarkdown`)で描いた結果を整えて綴り直し、
 *    **原文と完全に一致したときだけ**リッチ編集を許す。⚠ 一致しなければ開かない(= 原文の編集)。
 *    「描き手と別の自前の構文解析」を持たないので、描き手の読み方と食い違う余地が無い。
 *
 * ## 原本不変の 3 段構え(呼び側 `row-swap.ts` と組で守る)
 *
 * - 開くときの往復の検算(ここ)── 表せないブロックはそもそもリッチで開かない。
 * - 何も変えずに閉じたら書かない(`dirty === false` → 原文をそのまま返す。呼び側)。
 * - 書き戻すのは開いたブロックの行の範囲だけ(`spliceLines`。呼び側)。
 *
 * ## 下線・文字色(`:字:属性:`)は「字の並びに付く属性」として扱う
 *
 * ⚠ 描き手は `:…:属性:` の中身を**一切解釈しない**(太字も `\` の逃がしも効かない生の字。実測)。
 *   だから綴るときは**いちばん内側**(字の並びの直前直後)に置く ── `**:字:red:**` は効くが、
 *   `:**字**:red:` は `**` がそのまま赤く出る。
 *
 * ⚠ **pure module**。DOM は呼び手から**渡された**ノードだけを読む(グローバルの `document` /
 *   `window` / `Node` を使わない ── 層の規約。happy-dom でもブラウザでも同じに動く)。
 */
import { inlineMarksIn } from './word-format';

/** リッチ編集へ昇格させるブロックの種類。 */
export type RichBlockKind = 'paragraph' | 'heading' | 'quote' | 'list-item';

/**
 * ブロックの行頭の記号を復元するためのメタ情報(本文には現れない「枠」の側)。
 * ⚠ **元の綴りを保つ**ために持つ ── `*` で書いた箇条書きを `-` に変えない、字下げ幅を変えない。
 */
export interface RichBlockMeta {
  readonly kind: RichBlockKind;
  /** 見出しのレベル(1〜6)。見出し以外は 0。 */
  readonly level: number;
  /** リスト項目の行頭の字下げ(空白)。リスト以外は `''`。 */
  readonly indent: string;
  /** リスト項目の記号(`-` / `*` / `+` / `1.` / `3)` …)。リスト以外は `''`。 */
  readonly marker: string;
  /** チェックリストの印の中身(`' '` / `'x'` / `'X'`)。チェックでなければ `null`。 */
  readonly checked: string | null;
}

/** 解いたブロック = 枠(メタ)+ 中身(行内の Markdown。行の区切りは `\n`)。 */
export interface ParsedRichBlock {
  readonly meta: RichBlockMeta;
  readonly content: string;
}

/** 段落のメタ(新しい空のブロック・リスト解除の行き先)。 */
export const PARAGRAPH_META: RichBlockMeta = { kind: 'paragraph', level: 0, indent: '', marker: '', checked: null };

// ── 1. 安全なブロックか ─────────────────────────────────────────

/** リスト項目の 1 行目(記号の後ろの空白は 1 つだけ受ける ── 幅が変わると続きの行の字下げが変わる)。 */
const LIST_FIRST = /^( *)([-*+]|\d{1,9}[.)]) (.*)$/;
/** チェックの印(`[ ]` / `[x]` / `[X]` + 空白)。 */
const TASK_HEAD = /^\[([ xX])\] (.*)$/;
const HEADING = /^(#{1,6}) (.*)$/;

/**
 * 🔴 **行頭が別のブロックを始める字か**(段落・引用・リストの中身の行に現れたら原文の編集へ回す)。
 * ⚠ 保守的に広く取る ── 迷ったら「リッチで開かない」(原文の編集で困ることは無い)。
 */
function startsOtherBlock(line: string): boolean {
  return (
    /^\s/.test(line) ||
    /^#{1,6}(\s|$)/.test(line) ||
    /^>/.test(line) ||
    /^[-*+](\s|$)/.test(line) ||
    /^\d{1,9}[.)](\s|$)/.test(line) ||
    /^(```|~~~|\$\$|:::|\+\+\+|\|)/.test(line) ||
    /^(=+|-+)\s*$/.test(line) ||
    /^([*_-])(\s*\1){2,}\s*$/.test(line) ||
    /^\[\^[^\]]*\]:/.test(line) ||
    /^\[[^\]]*\]:/.test(line) ||
    /^</.test(line) ||
    // 表の区切りの行(`--- | ---` / `:-:|--`)── 前の行と組んで表になる
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
  );
}

/** `\` + 逃がしてよい記号(PKC3 の綴りが出す物と、CommonMark が受ける ASCII 記号)。 */
const ESCAPE_PAIR = /\\[\\`*_{}[\]()#+\-.!~=^$:|<>&]/g;

/**
 * 🔴 **行内に、リッチ編集が表せない記法が在るか**(在れば原文の編集へ)。
 * 数式(`$`)/ ルビ・強調ルビ(`[[`)/ 圏点(`^^`)/ ロール(`:名前:[…]`)/ HTML のタグ・コメント(`<…`)/
 * 脚注参照(`[^…]`)/ 画像(`![`)/ カード(`@[`)/ 差し込み(`{{`)/ 上の表に無い `\` の逃がし。
 * ⚠ 逃がした字(`\$` など)は字なので数えない ── 先に潰してから見る。
 */
function hasUnsupportedInline(text: string): boolean {
  const s = text.replace(ESCAPE_PAIR, 'xx');
  return (
    s.includes('\\') ||
    s.includes('$') ||
    s.includes('[[') ||
    s.includes('^^') ||
    /:[A-Za-z][\w-]*:\[/.test(s) ||
    /<[A-Za-z/!?]/.test(s) ||
    s.includes('[^') ||
    s.includes('![') ||
    s.includes('@[') ||
    s.includes('{{')
  );
}

/** 中身の行として受けられるか(空でない・行頭が別のブロックでない)。 */
function plainContentLine(line: string): boolean {
  return line !== '' && !startsOtherBlock(line);
}

/**
 * 🔴 **ブロックの原文を、枠(メタ)と中身に分ける**。リッチで扱えなければ `null`。
 * ⚠ ここは**形の判定だけ**。描き手が同じに読むか(往復の一致)は {@link prepareRichBlock} が見る。
 * ⚠ 改行は LF にそろえた原文を渡す(呼び側は `normalizeEol` 済み)。
 */
export function parseRichBlock(source: string): ParsedRichBlock | null {
  if (source.includes('\r')) return null;
  // 空 = 新しい空の段落(書き足す行・Enter で作った行)
  if (source === '') return { meta: PARAGRAPH_META, content: '' };
  const lines = source.split('\n');
  const first = lines[0]!;
  let parsed: ParsedRichBlock;

  const h = HEADING.exec(first);
  if (/^#/.test(first)) {
    if (h === null || lines.length !== 1) return null;
    parsed = { meta: { ...PARAGRAPH_META, kind: 'heading', level: h[1]!.length }, content: h[2]! };
  } else if (/^>/.test(first)) {
    const body: string[] = [];
    for (const l of lines) {
      if (!l.startsWith('> ')) return null;
      const c = l.slice(2);
      if (!plainContentLine(c)) return null;
      body.push(c);
    }
    parsed = { meta: { ...PARAGRAPH_META, kind: 'quote' }, content: body.join('\n') };
  } else if (LIST_FIRST.test(first)) {
    const m = LIST_FIRST.exec(first)!;
    const indent = m[1]!;
    const marker = m[2]!;
    let head = m[3]!;
    let checked: string | null = null;
    const t = TASK_HEAD.exec(head);
    if (t !== null) {
      checked = t[1]!;
      head = t[2]!;
    } else if (/^\[[ xX]\]$/.test(head)) {
      // `- [ ]` だけ(後ろの空白が無い)── 描き手の読み方が揺れるので開かない
      return null;
    }
    if (head !== '' && startsOtherBlock(head)) return null;
    const cont = indent + ' '.repeat(marker.length + 1);
    const body = [head];
    for (const l of lines.slice(1)) {
      if (!l.startsWith(cont)) return null;
      const c = l.slice(cont.length);
      if (!plainContentLine(c)) return null;
      body.push(c);
    }
    // 空の項目に続きの行は無い(`- ` の次の行は別物)
    if (head === '' && body.length > 1) return null;
    parsed = { meta: { kind: 'list-item', level: 0, indent, marker, checked }, content: body.join('\n') };
  } else {
    for (const l of lines) if (!plainContentLine(l)) return null;
    parsed = { meta: PARAGRAPH_META, content: source };
  }
  if (hasUnsupportedInline(parsed.content)) return null;
  return parsed;
}

/**
 * 🔴 **リッチ編集へ昇格させてよい形か**(種類を返す。だめなら `null` = 原文の `<textarea>` へ)。
 * ⚠ 形の判定だけ ── 実際に開く前に {@link canRichEditSafely} で往復の一致も確かめる。
 */
export function classifyRichBlock(sourceLines: string): RichBlockKind | null {
  return parseRichBlock(sourceLines)?.meta.kind ?? null;
}

/**
 * 枠(メタ)+ 中身 → ブロックの原文(`parseRichBlock` の逆)。
 * ⚠ 見出しは 1 行しか持てないので、中身の改行は空白にする。
 */
export function composeRichBlock(meta: RichBlockMeta, content: string): string {
  return composeWithMap(meta, content).text;
}

/** 中身の字の位置 → ブロックの原文の位置(caret を写すため)。 */
function composeWithMap(meta: RichBlockMeta, content: string): { text: string; map: (at: number) => number } {
  const lines = content.split('\n');
  const prefixes: string[] = [];
  if (meta.kind === 'heading') {
    const p = `${'#'.repeat(meta.level)} `;
    return { text: p + content.replace(/\n/g, ' '), map: (at) => p.length + at };
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (meta.kind === 'quote') prefixes.push('> ');
    else if (meta.kind === 'list-item') {
      prefixes.push(
        i === 0
          ? `${meta.indent}${meta.marker} ${meta.checked !== null ? `[${meta.checked}] ` : ''}`
          : meta.indent + ' '.repeat(meta.marker.length + 1),
      );
    } else prefixes.push('');
  }
  const text = lines.map((l, i) => prefixes[i]! + l).join('\n');
  const map = (at: number): number => {
    let line = 0;
    let rest = at;
    while (line < lines.length - 1 && rest > lines[line]!.length) {
      rest -= lines[line]!.length + 1;
      line += 1;
    }
    let out = 0;
    for (let i = 0; i < line; i += 1) out += prefixes[i]!.length + lines[i]!.length + 1;
    return out + prefixes[line]!.length + rest;
  };
  return { text, map };
}

/** 中身の行頭(リッチで表す字の始まり)が、ブロックの原文で何文字目か(0 行目)。 */
export function richContentStart(meta: RichBlockMeta): number {
  return composeWithMap(meta, '').map(0);
}

// ── 2. DOM → PKC-Markdown ─────────────────────────────────────

/** 最小限の DOM のかたち(happy-dom / ブラウザのどちらでも満たす)。 */
type AnyNode = Node;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 書式の 1 つ(行内)。 */
type Fmt =
  | { readonly k: 'b' }
  | { readonly k: 'i' }
  | { readonly k: 's' }
  | { readonly k: 'm' }
  | { readonly k: 'c' }
  | { readonly k: 'a'; readonly href: string };

/** 下線・文字色(字の並びの属性)。 */
interface Deco {
  readonly underline: boolean;
  readonly color: string | null;
}

const NO_DECO: Deco = { underline: false, color: null };

type Tok =
  | { readonly t: 'open'; readonly f: Fmt; id: number }
  | { readonly t: 'close'; readonly f: Fmt; id: number }
  | { readonly t: 'text'; s: string; readonly deco: Deco }
  | { readonly t: 'br' }
  | { readonly t: 'pt'; readonly id: number };

/** caret / 選択の端(DOM 上の点)。 */
export interface RichPoint {
  readonly node: AnyNode;
  readonly offset: number;
}

function fmtSig(f: Fmt): string {
  return f.k === 'a' ? `a:${f.href}` : f.k;
}

function decoSig(d: Deco): string {
  return `${d.underline ? 'u' : ''}|${d.color ?? ''}`;
}

/** `#rrggbb` / 色の名前 / `rgb(…)` を、style 属性の字から取り出す(⚠ 計算後の値ではなく書いた字)。 */
function styleColor(style: string): string | null {
  const m = /(?:^|;)\s*color\s*:\s*([^;]+?)\s*(?:;|$)/i.exec(style);
  return m === null ? null : m[1]!;
}

function styleUnderline(style: string): boolean {
  return /(?:^|;)\s*text-decoration(?:-line)?\s*:\s*[^;]*underline/i.test(style);
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/** その要素が付ける行内の書式(無ければ `null`)。⚠ 自前の印(`data-pkc-rich-*`)と、ブラウザが作る素の要素を読む。 */
function fmtOfElement(el: Element): Fmt | null {
  switch (tagOf(el)) {
    case 'strong':
    case 'b':
      return { k: 'b' };
    case 'em':
    case 'i':
      return { k: 'i' };
    case 's':
    case 'del':
    case 'strike':
      return { k: 's' };
    case 'mark':
      return { k: 'm' };
    case 'code':
      return { k: 'c' };
    case 'a': {
      const href = el.getAttribute('href');
      return href === null || href === '' ? null : { k: 'a', href };
    }
    default:
      return null;
  }
}

/** その要素が付ける下線・文字色(無ければ `null`)。 */
function decoOfElement(el: Element): Deco | null {
  const tag = tagOf(el);
  if (tag === 'u') return { underline: true, color: null };
  if (tag === 'font') {
    const c = el.getAttribute('color');
    return c === null || c === '' ? null : { underline: false, color: c };
  }
  if (tag !== 'span') return null;
  const color = el.getAttribute('data-pkc-rich-color');
  const underline = el.getAttribute('data-pkc-rich-underline') === '1';
  if (color === null && !underline) return null;
  return { underline, color: color === '' ? null : color };
}

const BLOCKISH = new Set(['div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre']);
const SKIP = new Set(['input', 'script', 'style', 'img', 'button', 'template', 'svg', 'video', 'audio', 'iframe', 'object']);

/** DOM → 字句の列(書式の開閉 / 字 / 改行 / 点)。 */
function tokenize(root: AnyNode, points: readonly RichPoint[]): Tok[] {
  const out: Tok[] = [];
  let nextId = 1;
  const ptAt = (node: AnyNode, offset: number): void => {
    points.forEach((p, i) => {
      if (p.node === node && p.offset === offset) out.push({ t: 'pt', id: i });
    });
  };
  const pushText = (s: string, deco: Deco, inCode: boolean): void => {
    // ⚠ NBSP は空白、幅の無い字は捨てる、CR は捨てる。字の中の改行は行の区切り(pre-wrap で打った改行)
    const clean = s.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff\r]/g, '');
    const parts = clean.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) out.push(inCode ? { t: 'text', s: ' ', deco } : { t: 'br' });
      if (part !== '') out.push({ t: 'text', s: part, deco });
    });
  };
  const lastIsBreakOrEmpty = (): boolean => {
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const t = out[i]!;
      if (t.t === 'pt' || t.t === 'open' || t.t === 'close') continue;
      return t.t === 'br';
    }
    return true;
  };
  const visit = (node: AnyNode, deco: Deco, inCode: boolean, inLink: boolean): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = node.nodeValue ?? '';
      const offs = points
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.node === node)
        .sort((a, b) => a.p.offset - b.p.offset);
      let at = 0;
      for (const { p, i } of offs) {
        const o = Math.max(0, Math.min(text.length, p.offset));
        pushText(text.slice(at, o), deco, inCode);
        out.push({ t: 'pt', id: i });
        at = o;
      }
      pushText(text.slice(at), deco, inCode);
      return;
    }
    const isEl = node.nodeType === ELEMENT_NODE;
    const el = isEl ? (node as Element) : null;
    if (el !== null) {
      const tag = tagOf(el);
      if (SKIP.has(tag)) return;
      if (tag === 'br') {
        out.push(inCode ? { t: 'text', s: ' ', deco } : { t: 'br' });
        return;
      }
      // 区切りの要素(ブラウザが Enter で作る `<div>` など)は、前に字が在れば改行を 1 つ入れる
      if (BLOCKISH.has(tag) && node !== root && !lastIsBreakOrEmpty()) out.push({ t: 'br' });
    }
    const fmtRaw = el === null || node === root ? null : fmtOfElement(el);
    // ⚠ コードの中の書式・リンクの中のリンクは平らにする(綴れない入れ子を作らない)
    const fmt = fmtRaw === null || inCode || (fmtRaw.k === 'a' && inLink) ? null : fmtRaw;
    const d = el === null || node === root ? null : decoOfElement(el);
    const nextDeco: Deco = d === null ? deco : { underline: deco.underline || d.underline, color: d.color ?? deco.color };
    let id = 0;
    if (fmt !== null) {
      id = nextId;
      nextId += 1;
      out.push({ t: 'open', f: fmt, id });
    }
    const kids = node.childNodes;
    for (let k = 0; k < kids.length; k += 1) {
      ptAt(node, k);
      visit(kids[k]!, nextDeco, inCode || fmt?.k === 'c', inLink || fmt?.k === 'a');
    }
    ptAt(node, kids.length);
    if (fmt !== null) out.push({ t: 'close', f: fmt, id });
  };
  visit(root, NO_DECO, false, false);
  return out;
}

/** 点(`pt`)を飛ばして、`i` の次の字句の添字。 */
function nextReal(toks: readonly Tok[], i: number): number {
  let j = i + 1;
  while (j < toks.length && toks[j]!.t === 'pt') j += 1;
  return j;
}

/**
 * 🔴 **ブラウザのクズを均す**(字句の列の上で。決まった 1 通りの綴りにする)。
 * ① 空の書式(`<b></b>`)を消す ② 隣り合う同じ書式(`<b>a</b><b>b</b>`)を 1 つにつなぐ
 * ③ 書式の内側の端の空白を外へ出す(`** a**` は太字にならない)④ 行頭・行末の空白を落とす
 * ⑤ 先頭・末尾・連続の改行を 1 つにする(末尾の `<br>` はブラウザの番兵)。
 */
function normalize(toks: Tok[]): Tok[] {
  let changed = true;
  let guard = 0;
  while (changed && guard < 10_000) {
    changed = false;
    guard += 1;
    for (let i = 0; i < toks.length; i += 1) {
      const a = toks[i]!;
      const j = nextReal(toks, i);
      const b = toks[j];
      if (b === undefined) break;
      // ① 空の書式
      if (a.t === 'open' && b.t === 'close' && a.id === b.id) {
        toks.splice(j, 1);
        toks.splice(i, 1);
        changed = true;
        break;
      }
      // ② 同じ書式の閉じ → 開きをつなぐ(後ろの閉じの id を前のものへ付け替える)
      if (a.t === 'close' && b.t === 'open' && fmtSig(a.f) === fmtSig(b.f)) {
        const oldId = b.id;
        for (let k = j + 1; k < toks.length; k += 1) {
          const t = toks[k]!;
          if (t.t === 'close' && t.id === oldId) {
            t.id = a.id;
            break;
          }
        }
        toks.splice(j, 1);
        toks.splice(i, 1);
        changed = true;
        break;
      }
      // ③ 書式の内側の端の空白
      if (a.t === 'open' && b.t === 'text' && j === i + 1 && /^\s/.test(b.s)) {
        const lead = /^\s+/.exec(b.s)![0];
        b.s = b.s.slice(lead.length);
        toks.splice(i, 0, { t: 'text', s: lead, deco: b.deco });
        if (b.s === '') toks.splice(j + 1, 1);
        changed = true;
        break;
      }
      if (a.t === 'text' && b.t === 'close' && j === i + 1 && /\s$/.test(a.s)) {
        const trail = /\s+$/.exec(a.s)![0];
        a.s = a.s.slice(0, a.s.length - trail.length);
        toks.splice(j + 1, 0, { t: 'text', s: trail, deco: a.deco });
        if (a.s === '') toks.splice(i, 1);
        changed = true;
        break;
      }
      // 同じ属性の字は 1 つへ(下線・文字色の囲みを細切れにしない)
      if (a.t === 'text' && b.t === 'text' && j === i + 1 && decoSig(a.deco) === decoSig(b.deco)) {
        a.s += b.s;
        toks.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  // ④ 行頭・行末の空白 / ⑤ 改行
  const lines: Tok[][] = [[]];
  for (const t of toks) {
    if (t.t === 'br') lines.push([]);
    else lines[lines.length - 1]!.push(t);
  }
  const trimEdge = (line: Tok[], fromStart: boolean): void => {
    const idx = fromStart ? [...line.keys()] : [...line.keys()].reverse();
    for (const i of idx) {
      const t = line[i]!;
      if (t.t !== 'text') continue;
      const s = fromStart ? t.s.replace(/^[ \t]+/, '') : t.s.replace(/[ \t]+$/, '');
      t.s = s;
      if (s !== '') return;
    }
  };
  const hasText = (line: Tok[]): boolean => line.some((t) => t.t === 'text' && t.s !== '');
  for (const line of lines) {
    trimEdge(line, true);
    trimEdge(line, false);
  }
  const out: Tok[] = [];
  let pendingBreak = false;
  let started = false;
  for (const line of lines) {
    const filled = hasText(line);
    if (filled && started && pendingBreak) out.push({ t: 'br' });
    if (filled) started = true;
    // 字の無い行の書式の開閉・点は残す(行をまたぐ太字の端と caret を落とさない)
    for (const t of line) if (!(t.t === 'text' && t.s === '')) out.push(t);
    pendingBreak = true;
  }
  // 改行をまたいで空になった書式を、もう一度均す
  return normalizeEmptyPairs(out);
}

function normalizeEmptyPairs(toks: Tok[]): Tok[] {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < toks.length; i += 1) {
      const a = toks[i]!;
      const j = nextReal(toks, i);
      const b = toks[j];
      if (b === undefined) break;
      if (a.t === 'open' && b.t === 'close' && a.id === b.id) {
        toks.splice(j, 1);
        toks.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return toks;
}

/** 組み立て中の 1 文字(どこから来たか ── 字だけを逃がしの対象にする)。 */
interface Cell {
  ch: string;
  /** user の字(逃がしの対象)か、記法の記号・生の字か。 */
  readonly text: boolean;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/** 字句の列 → 字の列(記法の記号つき)。点の位置も返す。 */
function assemble(toks: readonly Tok[]): { cells: Cell[]; pts: Map<number, number>; decos: { start: number; end: number }[] } {
  const cells: Cell[] = [];
  const pts = new Map<number, number>();
  const decos: { start: number; end: number }[] = [];
  const raw = (s: string): void => {
    for (const ch of s) cells.push({ ch, text: false });
  };
  const txt = (s: string): void => {
    for (const ch of s) cells.push({ ch, text: true });
  };
  // コード・自動リンク(URL がそのまま字)の中身を先に引く
  const innerText = (from: number, id: number): { text: string; end: number; plain: boolean } => {
    let s = '';
    let plain = true;
    let k = from + 1;
    for (; k < toks.length; k += 1) {
      const t = toks[k]!;
      if (t.t === 'close' && t.id === id) break;
      if (t.t === 'text') {
        s += t.s;
        if (t.deco.underline || t.deco.color !== null) plain = false;
      } else if (t.t === 'br') s += ' ';
      else if (t.t !== 'pt') plain = false;
    }
    return { text: s, end: k, plain };
  };
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.t === 'pt') {
      pts.set(t.id, cells.length);
      continue;
    }
    if (t.t === 'br') {
      raw('\n');
      continue;
    }
    if (t.t === 'text') {
      const d = t.deco;
      if (!d.underline && d.color === null) {
        txt(t.s);
        continue;
      }
      /**
       * 🔴 下線・文字色は**字の並びのすぐ外**に置く(中身は描き手が解釈しない生の字)。
       * ⚠ 同じ属性の字が caret の点を挟んで続いても**1 つの囲み**にする ── 点で割ると
       *   綴りが変わり、何もしていないのに「変わった」になる。
       */
      const attrs = [d.underline ? 'underline' : null, d.color].filter((x): x is string => x !== null).join(', ');
      const start = cells.length;
      raw(':');
      raw(t.s);
      let k = i + 1;
      for (; k < toks.length; k += 1) {
        const u = toks[k]!;
        if (u.t === 'pt') pts.set(u.id, cells.length);
        else if (u.t === 'text' && decoSig(u.deco) === decoSig(d)) raw(u.s);
        else break;
      }
      i = k - 1;
      raw(`:${attrs}:`);
      decos.push({ start, end: cells.length });
      continue;
    }
    const f = t.f;
    if (t.t === 'open') {
      if (f.k === 'c') {
        // コードの中身は生の字(逃がさない)。`` ` `` を含むなら囲みを伸ばす
        const inner = innerText(i, t.id);
        const runs = inner.text.match(/`+/g) ?? [];
        const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
        const pad = inner.text.startsWith('`') || inner.text.endsWith('`') ? ' ' : '';
        raw(fence + pad);
        for (let k = i + 1; k < inner.end; k += 1) {
          const u = toks[k]!;
          if (u.t === 'pt') pts.set(u.id, cells.length);
          else if (u.t === 'text') raw(u.s);
          else if (u.t === 'br') raw(' ');
        }
        raw(pad + fence);
        i = inner.end;
        continue;
      }
      if (f.k === 'a') {
        // 自動リンク(字がそのまま URL)は字のまま書く ── `[url](url)` にしない
        const inner = innerText(i, t.id);
        if (inner.plain && inner.text === f.href && /^https?:\/\/\S+$/.test(f.href)) {
          for (let k = i + 1; k < inner.end; k += 1) {
            const u = toks[k]!;
            if (u.t === 'pt') pts.set(u.id, cells.length);
            else if (u.t === 'text') raw(u.s);
          }
          i = inner.end;
          continue;
        }
        raw('[');
        continue;
      }
      raw(f.k === 'b' ? '**' : f.k === 'i' ? '*' : f.k === 's' ? '~~' : '==');
      continue;
    }
    // close
    if (f.k === 'a') raw(`](${f.href})`);
    else raw(f.k === 'b' ? '**' : f.k === 'i' ? '*' : f.k === 's' ? '~~' : f.k === 'm' ? '==' : '');
  }
  return { cells, pts, decos };
}

/** 字の列を逃がしの判断つきで綴る。 */
function escapeCells(cells: readonly Cell[], listContent: boolean, heading: boolean): { out: string; map: number[] } {
  const s = cells.map((c) => c.ch).join('');
  const lineStarts = new Set<number>([0]);
  for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') lineStarts.add(i + 1);
  const esc = new Array<boolean>(cells.length).fill(false);
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i]!;
    if (!c.text) continue;
    const ch = c.ch;
    const prev = s[i - 1];
    const next = s[i + 1];
    if (ch === '\\' || ch === '*' || ch === '`' || ch === '$') esc[i] = true;
    else if (ch === '_') esc[i] = !isWordChar(prev) || !isWordChar(next);
    else if (ch === '~' || ch === '=' || ch === '^') esc[i] = prev === ch || next === ch;
    else if (ch === '[') esc[i] = next === '[' || next === '^';
    else if (ch === ']') esc[i] = next === '(' || next === '[';
    else if (ch === '{') esc[i] = next === '{';
    else if (ch === '<') esc[i] = next !== undefined && /[A-Za-z]/.test(next);
    else if (ch === '&') esc[i] = /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(s.slice(i));
    else if (ch === ':') esc[i] = /^:[A-Za-z][\w-]*:\[/.test(s.slice(i));
  }
  /**
   * 見出しの行末の ` #` は描き手が閉じの記号として捨てる ── 字なら逃がす。
   * ⚠ 見出しは 1 行で、行頭が別のブロックに化けることは無い(`# 1. はじめに` の `.` を逃がさない)。
   */
  if (heading) {
    const m = /\s(#+)\s*$/.exec(s);
    if (m !== null) {
      const at = s.length - m[0].length + 1;
      if (cells[at]?.text === true) esc[at] = true;
    }
  }
  // 行頭の字(別のブロックに化けるもの)
  for (const ls of heading ? [] : lineStarts) {
    const c = cells[ls];
    if (c === undefined || !c.text) continue;
    const rest = s.slice(ls, s.indexOf('\n', ls) === -1 ? s.length : s.indexOf('\n', ls));
    const m = /^\d{1,9}([.)])(\s|$)/.exec(rest);
    if (m !== null) {
      const at = ls + rest.indexOf(m[1]!);
      if (cells[at]?.text === true) esc[at] = true;
      continue;
    }
    if (
      /^#{1,6}(\s|$)/.test(rest) ||
      /^[>|]/.test(rest) ||
      /^[-+*](\s|$)/.test(rest) ||
      /^:::/.test(rest) ||
      /^(=+|-+)\s*$/.test(rest) ||
      /^\+{3,}\s*$/.test(rest) ||
      /^\[\^|^\[[^\]]*\]:/.test(rest) ||
      /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(rest) ||
      (listContent && ls === 0 && /^\[[ xX]\](\s|$)/.test(rest))
    ) {
      esc[ls] = true;
    }
  }
  const build = (): { out: string; map: number[] } => {
    let out = '';
    const map: number[] = [];
    for (let i = 0; i < cells.length; i += 1) {
      map.push(out.length);
      if (esc[i]) out += '\\';
      out += cells[i]!.ch;
    }
    map.push(out.length);
    return { out, map };
  };
  // 🔴 字の中の `:` が下線・文字色の囲みに化けるなら逃がす(描き手と同じ読み方 `inlineMarksIn` で見る)
  for (let guard = 0; guard < 64; guard += 1) {
    const { out, map } = build();
    // 逃がした字は読み手から見えない ── 同じ長さの別の字で潰してから探す
    const masked = out.replace(/\\[\s\S]/g, '\u{E000}\u{E000}');
    let fixed = false;
    for (const mk of inlineMarksIn(masked, 0, masked.length)) {
      // 囲みの開きの `:` がどの字か(逃がした字は `\` の 1 つ後ろ)
      const k = map.findIndex((p, j) => j < cells.length && p + (esc[j] ? 1 : 0) === mk.start);
      if (k >= 0 && cells[k]!.text && cells[k]!.ch === ':' && !esc[k]) {
        esc[k] = true;
        fixed = true;
        break;
      }
    }
    if (!fixed) return { out, map };
  }
  return build();
}

/**
 * 🔴 **行内の DOM → 行内の PKC-Markdown**(点の位置つき)。
 * @param points 写したい DOM 上の点(caret・選択の端)。返りの `offsets` は同じ順で、中身の字の位置。
 *   木の中に見つからない点は末尾にする。
 */
export function serializeRichInline(
  root: AnyNode,
  points: readonly RichPoint[] = [],
  opts: { readonly listContent?: boolean; readonly heading?: boolean } = {},
): { text: string; offsets: number[] } {
  const toks = normalize(tokenize(root, points));
  const { cells, pts } = assemble(toks);
  const { out, map } = escapeCells(cells, opts.listContent === true, opts.heading === true);
  const offsets = points.map((_, i) => {
    const at = pts.get(i);
    return at === undefined ? out.length : (map[at] ?? out.length);
  });
  return { text: out, offsets };
}

function inlineOpts(meta: RichBlockMeta): { listContent: boolean; heading: boolean } {
  return { listContent: meta.kind === 'list-item', heading: meta.kind === 'heading' };
}

/**
 * 🔴 **`contenteditable` の木 → ブロックの PKC-Markdown**(決まった 1 通りの綴り)。
 * `meta` で行頭の記号(見出しのレベル・リストの字下げと記号・チェック・引用)を復元する。
 */
export function serializeRichBlock(meta: RichBlockMeta, root: AnyNode): string {
  return composeRichBlock(meta, serializeRichInline(root, [], inlineOpts(meta)).text);
}

/** {@link serializeRichBlock} + DOM の点 → ブロックの原文の位置。 */
export function serializeRichBlockWithPoints(
  meta: RichBlockMeta,
  root: AnyNode,
  points: readonly RichPoint[],
): { text: string; offsets: number[] } {
  const inline = serializeRichInline(root, points, inlineOpts(meta));
  const { text, map } = composeWithMap(meta, inline.text);
  return { text, offsets: inline.offsets.map(map) };
}

// ── 3. 往復しても変わらないか ─────────────────────────────────

/** 描き手に渡す形(リスト項目は字下げを外す ── 4 つ以上の字下げは描き手がコードと読む)。 */
function renderableSource(p: ParsedRichBlock): string {
  return p.meta.kind === 'list-item' ? composeRichBlock({ ...p.meta, indent: '' }, p.content) : composeRichBlock(p.meta, p.content);
}

function elementChildren(el: AnyNode): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === ELEMENT_NODE) out.push(n as Element);
    else if (n.nodeType === TEXT_NODE && (n.nodeValue ?? '').trim() !== '') return [];
  }
  return out;
}

/** 描いた結果から、中身を持つ要素を 1 つ取り出す(形が違えば `null`)。 */
function contentElementOf(meta: RichBlockMeta, root: Element, emptyOk: boolean): Element | null {
  const els = elementChildren(root);
  if (meta.kind === 'paragraph') {
    if (els.length === 0 && emptyOk && (root.textContent ?? '').trim() === '') return root;
    return els.length === 1 && tagOf(els[0]!) === 'p' ? els[0]! : null;
  }
  if (meta.kind === 'heading') return els.length === 1 && tagOf(els[0]!) === `h${meta.level}` ? els[0]! : null;
  if (meta.kind === 'quote') {
    if (els.length !== 1 || tagOf(els[0]!) !== 'blockquote') return null;
    const inner = elementChildren(els[0]!);
    return inner.length === 1 && tagOf(inner[0]!) === 'p' ? inner[0]! : null;
  }
  if (els.length !== 1) return null;
  const list = els[0]!;
  const ordered = /^\d/.test(meta.marker);
  if (tagOf(list) !== (ordered ? 'ol' : 'ul')) return null;
  const items = elementChildren(list);
  return items.length === 1 && tagOf(items[0]!) === 'li' ? items[0]! : null;
}

/**
 * 描き手の出した行内の要素を、リッチ編集の木へ**厳格に**写す(知らない要素が 1 つでも在れば `null`)。
 * ⚠ 描き手の飾り(`target` / `data-pkc-action` / class)は捨て、書式を表す最小の形にする ──
 *   セルの中のリンクを押してもノートへ飛ばない・余計な属性が戻り道に混ざらない。
 */
function cleanInline(src: Element, doc: Document, task: boolean): DocumentFragment | null {
  const frag = doc.createDocumentFragment();
  let skippedBox = !task;
  let afterBox = false;
  let afterBr = false;
  const copyInto = (from: AnyNode, into: Node): boolean => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === TEXT_NODE) {
        let v = n.nodeValue ?? '';
        // 描き手の `<br>\n` の改行は飾り(行の区切りは `<br>` が持つ)
        if (afterBr) v = v.replace(/^\n/, '');
        // チェックの印の後ろの空白 1 つは記号の一部
        if (afterBox) v = v.replace(/^ /, '');
        afterBr = false;
        afterBox = false;
        if (v.includes('\n')) return false;
        if (v !== '') into.appendChild(doc.createTextNode(v));
        continue;
      }
      if (n.nodeType !== ELEMENT_NODE) continue;
      const el = n as Element;
      const tag = tagOf(el);
      if (!skippedBox && tag === 'input' && el.getAttribute('type') === 'checkbox' && from === src) {
        skippedBox = true;
        afterBox = true;
        continue;
      }
      afterBox = false;
      if (tag === 'br') {
        into.appendChild(doc.createElement('br'));
        afterBr = true;
        continue;
      }
      afterBr = false;
      let made: Element;
      if (tag === 'strong' || tag === 'mark' || tag === 's' || tag === 'code') {
        if (el.attributes.length > 0) return false;
        made = doc.createElement(tag);
      } else if (tag === 'em') {
        if (el.attributes.length > 0) return false; // 圏点(`em.pkc-em-dot`)などは開かない
        made = doc.createElement('em');
      } else if (tag === 'a') {
        const href = el.getAttribute('href');
        if (href === null || href === '') return false;
        made = doc.createElement('a');
        made.setAttribute('href', href);
      } else if (tag === 'span' && el.getAttribute('class') === 'pkc-inline-mark') {
        const style = el.getAttribute('style') ?? '';
        const color = styleColor(style);
        const underline = styleUnderline(style);
        // 下線・文字色のほか(太さ・背景・大きさ …)を持つなら開かない
        const rest = style
          .split(';')
          .map((x) => x.trim())
          .filter((x) => x !== '' && !/^color\s*:/i.test(x) && !/^text-decoration(-line)?\s*:\s*underline$/i.test(x));
        if (rest.length > 0 || (color === null && !underline)) return false;
        made = richDecoSpan(doc, underline, color);
      } else {
        return false;
      }
      if (!copyInto(el, made)) return false;
      into.appendChild(made);
    }
    return true;
  };
  return copyInto(src, frag) ? frag : null;
}

/** 下線・文字色の `<span>`(セルの中で使う形。`serializeRichInline` が読む印つき)。 */
export function richDecoSpan(doc: Document, underline: boolean, color: string | null): HTMLElement {
  const span = doc.createElement('span');
  const style: string[] = [];
  if (color !== null) {
    span.setAttribute('data-pkc-rich-color', color);
    style.push(`color: ${color}`);
  }
  if (underline) {
    span.setAttribute('data-pkc-rich-underline', '1');
    style.push('text-decoration: underline');
  }
  span.setAttribute('style', style.join('; '));
  return span;
}

/** 開いてよいと分かったブロック(枠 + セルに入れる木)。 */
export interface PreparedRichBlock extends ParsedRichBlock {
  /** セルに入れる行内の木(`parseDom` の文書のノード)。 */
  readonly nodes: DocumentFragment;
}

/**
 * 🔴 **開けるか確かめて、セルに入れる木を作る**(開けなければ `null`)。
 *
 * 1. 形の判定(`parseRichBlock`)
 * 2. **本物の描き手**で描く(`renderHtml`)→ `parseDom` で木にする
 * 3. 中身の要素を厳格に写す(知らない要素が在れば開かない)
 * 4. 🔴 写した木を綴り直して**原文と 1 バイトも違わない**ことを確かめる
 */
export function prepareRichBlock(
  sourceLines: string,
  renderHtml: (md: string) => string,
  parseDom: (html: string) => Element,
): PreparedRichBlock | null {
  const p = parseRichBlock(sourceLines);
  if (p === null) return null;
  let root: Element;
  try {
    root = parseDom(sourceLines === '' ? '' : renderHtml(renderableSource(p)));
  } catch {
    return null;
  }
  const content = contentElementOf(p.meta, root, p.content === '');
  if (content === null) return null;
  const doc = root.ownerDocument;
  const nodes = cleanInline(content, doc, p.meta.kind === 'list-item' && p.meta.checked !== null);
  if (nodes === null) return null;
  if (serializeRichBlock(p.meta, nodes) !== sourceLines) return null;
  return { ...p, nodes };
}

/**
 * 🔴 **このブロックを、意味・構造を失わずにリッチ編集できるか**(検算できる形で外へ出す)。
 * 「HTML にする → `serializeRichBlock` で戻す」で原文と一致するときだけ `true`。
 */
export function canRichEditSafely(
  sourceLines: string,
  renderHtml: (md: string) => string,
  parseDom: (html: string) => Element,
): boolean {
  return prepareRichBlock(sourceLines, renderHtml, parseDom) !== null;
}

/**
 * 🔴 **Enter で作る次のブロックの枠**。リスト項目なら同じ種類の次の項目(番号は 1 つ進め、チェックは外す)、
 * それ以外(段落・見出し・引用)は段落。
 */
export function nextRichMeta(meta: RichBlockMeta): RichBlockMeta {
  if (meta.kind !== 'list-item') return PARAGRAPH_META;
  const num = /^(\d+)([.)])$/.exec(meta.marker);
  const marker = num === null ? meta.marker : `${Number(num[1]) + 1}${num[2]}`;
  return { ...meta, marker, checked: meta.checked === null ? null : ' ' };
}
