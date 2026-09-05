/**
 * 最小の XML パーサ(#199 / #238 ── SVG を EMF に起こすため)。
 *
 * 🔴 **なぜ自前で書くのか。** 変換は **worker の中**で走る(重い処理はワーカーへ ──
 * 不可侵指示 2026-08-03)。⚠ worker には `DOMParser` が**無い**ので、ブラウザの
 * XML パーサは使えない。ここは `features/` 層 = **純粋な TS**(browser API 無し)で、
 * node の unit からもそのまま回せる。
 *
 * ⚠ **汎用の XML パーサを名乗らない。** 受けるのは **mermaid が吐く SVG** の範囲:
 * 要素・属性・テキスト・コメント・CDATA・自己閉じタグ・実体参照(5 つ + 数値)。
 * DTD / 名前空間の解決 / 属性の既定値は**扱わない**(mermaid の出力に出ない)。
 */

/** 要素 1 つ。⚠ テキストは `tag === '#text'` の子として持つ(混在内容を保つため)。 */
export interface XmlNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  /** `#text` のときだけ入る。 */
  readonly text?: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // ⚠ **escape で書く**(2026-09-05)── 生で置くと普通の空白と見分けが付かない
  nbsp: '\u00a0',
};

/**
 * 実体参照を戻す。
 * ⚠ **知らない実体はそのまま残す** ── 落とすと本文が静かに欠ける。
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const n = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (body.startsWith('#')) {
      const n = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

interface Cursor {
  readonly src: string;
  i: number;
}

function skipWs(c: Cursor): void {
  while (c.i < c.src.length && /\s/.test(c.src[c.i]!)) c.i += 1;
}

/** 属性を読む。⚠ 値の引用符は `"` と `'` の両方が来る(mermaid は両方使う)。 */
function readAttrs(c: Cursor): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (;;) {
    skipWs(c);
    const ch = c.src[c.i];
    if (ch === undefined || ch === '>' || ch === '/') return attrs;
    const start = c.i;
    while (c.i < c.src.length && !/[\s=/>]/.test(c.src[c.i]!)) c.i += 1;
    const name = c.src.slice(start, c.i);
    if (name === '') {
      // 想定外の字 ── 進めないと無限ループになる
      c.i += 1;
      continue;
    }
    skipWs(c);
    if (c.src[c.i] !== '=') {
      attrs[name] = '';
      continue;
    }
    c.i += 1;
    skipWs(c);
    const quote = c.src[c.i];
    if (quote === '"' || quote === "'") {
      c.i += 1;
      const vs = c.i;
      while (c.i < c.src.length && c.src[c.i] !== quote) c.i += 1;
      attrs[name] = decodeEntities(c.src.slice(vs, c.i));
      c.i += 1;
    } else {
      const vs = c.i;
      while (c.i < c.src.length && !/[\s>]/.test(c.src[c.i]!)) c.i += 1;
      attrs[name] = decodeEntities(c.src.slice(vs, c.i));
    }
  }
}

/** 生のテキストとして中身を読む要素(中の `<` を印として扱わない)。 */
const RAW_TEXT = new Set(['style', 'script']);

function parseNode(c: Cursor): XmlNode | null {
  if (c.src[c.i] !== '<') return null;
  // コメント / CDATA / 宣言は読み飛ばす(CDATA だけは中身をテキストとして拾う)
  if (c.src.startsWith('<!--', c.i)) {
    const end = c.src.indexOf('-->', c.i);
    c.i = end < 0 ? c.src.length : end + 3;
    return null;
  }
  if (c.src.startsWith('<![CDATA[', c.i)) {
    const end = c.src.indexOf(']]>', c.i);
    const text = c.src.slice(c.i + 9, end < 0 ? c.src.length : end);
    c.i = end < 0 ? c.src.length : end + 3;
    return { tag: '#text', attrs: {}, children: [], text };
  }
  if (c.src.startsWith('<?', c.i) || c.src.startsWith('<!', c.i)) {
    const end = c.src.indexOf('>', c.i);
    c.i = end < 0 ? c.src.length : end + 1;
    return null;
  }
  c.i += 1; // '<'
  const ns = c.i;
  while (c.i < c.src.length && !/[\s/>]/.test(c.src[c.i]!)) c.i += 1;
  const tag = c.src.slice(ns, c.i);
  const attrs = readAttrs(c);
  skipWs(c);
  if (c.src.startsWith('/>', c.i)) {
    c.i += 2;
    return { tag, attrs, children: [] };
  }
  c.i += 1; // '>'
  const children: XmlNode[] = [];
  if (RAW_TEXT.has(tag)) {
    const close = c.src.indexOf(`</${tag}`, c.i);
    const end = close < 0 ? c.src.length : close;
    children.push({ tag: '#text', attrs: {}, children: [], text: c.src.slice(c.i, end) });
    c.i = end;
  } else {
    for (;;) {
      if (c.i >= c.src.length) break;
      if (c.src.startsWith('</', c.i)) break;
      if (c.src[c.i] === '<') {
        const child = parseNode(c);
        if (child) children.push(child);
        continue;
      }
      const ts = c.i;
      while (c.i < c.src.length && c.src[c.i] !== '<') c.i += 1;
      const text = c.src.slice(ts, c.i);
      // ⚠ **空白だけの節点も落とさない**(`<tspan> </tspan>` が字下げに使われる)
      if (text !== '') children.push({ tag: '#text', attrs: {}, children: [], text: decodeEntities(text) });
    }
  }
  // 閉じタグを飛ばす
  if (c.src.startsWith('</', c.i)) {
    const end = c.src.indexOf('>', c.i);
    c.i = end < 0 ? c.src.length : end + 1;
  }
  return { tag, attrs, children };
}

/**
 * 根の要素を返す。⚠ 根が見つからないときは**投げる**(黙って空を返さない ──
 * 空の図を書き出して「描けた」と言うのが一番悪い)。
 */
export function parseXml(src: string): XmlNode {
  const c: Cursor = { src, i: 0 };
  while (c.i < src.length) {
    skipWs(c);
    if (c.src[c.i] !== '<') {
      c.i += 1;
      continue;
    }
    const node = parseNode(c);
    if (node && node.tag !== '#text') return node;
  }
  throw new Error('XML の根が見つかりません');
}

/** 子孫を先行順で辿る(テキスト節点を含む)。 */
export function* walk(node: XmlNode, chain: XmlNode[] = []): Generator<{ node: XmlNode; chain: XmlNode[] }> {
  const here = [...chain, node];
  yield { node, chain: here };
  for (const child of node.children) yield* walk(child, here);
}

/** 要素の中の文字を連結する(タグは無視)。 */
export function textOf(node: XmlNode): string {
  if (node.tag === '#text') return node.text ?? '';
  return node.children.map(textOf).join('');
}
