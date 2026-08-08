/**
 * 🔴 **読む面のコピー**(2026-08-08。user 裁定「markdown のテキストとしての
 * コピーと HTML 書式ありのコピーの両方」)。
 *
 * - ノート全体: 原文(text/plain)/ 描画(text/plain + text/html)── binder が
 *   clipboard を呼び、ここは**選択範囲 → 原文**の解決と結果の可視化だけを持つ
 * - 選択範囲: 読む面は `sourceLineAnchors` で描かれている
 *   (`data-pkc-source-line` / `data-pkc-source-end`、どちらも**含む端**・0 始まり)
 *   ので、選択の両端から最寄りの刻印要素へ上がって原文の行へ逆引きし、
 *   `mapVisibleToSource`(誤差は**手前**に固定)で文字まで絞る。
 *
 * ⚠ **既定の copy イベントには介入しない**(Ctrl+C は「見えているテキストの
 * コピー」のまま)── 動くのは明示のボタンだけ。
 * ⚠ 読む面は frontmatter を**剥いだ**本文(`fm.body`)で描かれる ── 刻印の
 * 行番号も fm.body 基準なので、**逆引きも fm.body に対して行う**(全文 body の
 * 行番号と混ぜると、frontmatter の行数ぶんずれた別の行を返す)。
 * ⚠ 端の精密化の誤差は選択を**外へ**広げる向きに倒す: 始端は手前(広く拾う)、
 * 終端は正確に取れないときだけ**その刻印の行末**まで含める ── 手前へ縮めると
 * 選択した中身が欠ける。
 */
import { parseFrontmatter } from '@features/markdown/frontmatter';
import { mapVisibleToSource } from '@features/markdown/source-ranges';
import { flashCopied } from './copy-md-block';

/** 選択の端 1 つを、刻印要素 + その中の描画文字位置に解決したもの。 */
interface AnchorPoint {
  el: Element;
  /** 刻印の原文行(含む端・fm.body 基準)。 */
  lines: { start: number; end: number };
  /** 刻印要素の描画テキストの中で、端が何文字目か。 */
  visibleOffset: number;
}

/** 端 1 つ → 最寄りの刻印要素。刻印が引けなければ null(その選択は扱えない)。 */
function anchorAt(host: HTMLElement, container: Node, offset: number): AnchorPoint | null {
  const base = container instanceof Element ? container : container.parentElement;
  const el = base?.closest('[data-pkc-source-line]') ?? null;
  if (el === null || !host.contains(el)) return null;
  const start = Number(el.getAttribute('data-pkc-source-line'));
  const endRaw = el.getAttribute('data-pkc-source-end');
  const end = endRaw === null ? start : Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  // 刻印要素の先頭から端までの描画文字数。⚠ Range に数えさせる ── 端が
  // テキストの中でも要素の継ぎ目でも、同じ規則で数えられる
  const r = host.ownerDocument.createRange();
  r.selectNodeContents(el);
  let visibleOffset: number;
  try {
    r.setEnd(container, offset);
    visibleOffset = r.toString().length;
  } catch {
    visibleOffset = 0; // 数えられなければ行頭(誤差は広く拾う側)
  }
  return { el, lines: { start, end }, visibleOffset };
}

/** いまの選択の両端。使えない選択(潰れている / 刻印の外)は null。 */
function endpoints(host: HTMLElement): { start: AnchorPoint; end: AnchorPoint } | null {
  const sel = host.ownerDocument.getSelection();
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const start = anchorAt(host, r.startContainer, r.startOffset);
  const end = anchorAt(host, r.endContainer, r.endOffset);
  if (start === null || end === null) return null;
  return { start, end };
}

/**
 * いまの選択を「選択範囲をコピー」で扱えるか(ボタンの活性が読む)。
 * 🔑 **判定は `endpoints` の 1 本** ── `selectedMarkdown` と同じ規則を使う
 * (活性と実行で規則が割れると、押せるのにコピーできない、が生まれる)。
 */
export function hasSourceSelection(host: HTMLElement): boolean {
  return endpoints(host) !== null;
}

/** 行 index(0 始まり)→ その行の先頭の文字 index。行が無ければ末尾。 */
function lineStartIndex(text: string, line: number): number {
  let at = 0;
  for (let i = 0; i < line; i += 1) {
    const nl = text.indexOf('\n', at);
    if (nl === -1) return text.length;
    at = nl + 1;
  }
  return at;
}

/** 行 index → その行の末尾(改行の手前)の文字 index。 */
function lineEndIndex(text: string, line: number): number {
  const at = lineStartIndex(text, line);
  const nl = text.indexOf('\n', at);
  return nl === -1 ? text.length : nl;
}

/** 端 1 つ → fm.body の文字 index。誤差は選択を**外へ**広げる向き(冒頭の注記)。 */
function resolvePoint(body: string, p: AnchorPoint, side: 'start' | 'end'): number {
  const base = lineStartIndex(body, p.lines.start);
  const sliceEnd = lineEndIndex(body, p.lines.end);
  const m = mapVisibleToSource(
    body.slice(base, sliceEnd),
    p.el.textContent ?? '',
    p.visibleOffset,
  );
  if (side === 'start') return base + m.offset;
  return m.exact ? base + m.offset : sliceEnd;
}

/**
 * いまの選択を **Markdown の原文**として返す。扱えない選択は null
 * (呼び側が理由を出す ── 無言で終えない)。
 */
export function selectedMarkdown(host: HTMLElement, fullBody: string): string | null {
  const pts = endpoints(host);
  if (pts === null) return null;
  // 🔴 描画は frontmatter を剥いだ側 ── 行番号の基準を合わせる(冒頭の注記)
  const body = parseFrontmatter(fullBody).body;
  const s = resolvePoint(body, pts.start, 'start');
  const e = resolvePoint(body, pts.end, 'end');
  if (e <= s) return null;
  return body.slice(s, e);
}

/**
 * コピーの後始末(コピー系のボタン共通)。押しても画面が変わらない操作なので、
 * 渡ったらボタンを光らせ(`copy-md-block` と同じ合図)、渡らなければ理由を出す。
 */
export function finishCopy(
  dispatcher: { dispatch(action: { type: 'OP_FAILED'; error: string }): void },
  target: HTMLElement,
  done: Promise<boolean>,
): void {
  void done.then((ok) => {
    if (ok) flashCopied(target);
    else dispatcher.dispatch({ type: 'OP_FAILED', error: 'コピーできませんでした' });
  });
}
