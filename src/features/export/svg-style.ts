/**
 * SVG の見た目を決める(#199 / #238)── **小さな CSS カスケード**。
 *
 * 🔴 **これが無いと図が黒くなる。** mermaid は色を要素の属性ではなく
 * `<style>` の**子孫セレクタ**(`#id .node rect { fill: … }`)で与える。
 * ⚠ LibreOffice の SVG 取り込みはここを解決できず、実測で**箱が真っ黒・文字が消えた**
 * (2026-08-17)。だから変換は自前で持つ。
 *
 * ⚠ **CSS の全部は要らない。** mermaid の出力に出るものだけ:
 * 子孫 / 子(`>`)結合子・クラス・要素名・id・属性(`[a="b"]`)・`!important`・
 * 詳細度・**継承**(`fill` / `stroke` / `font-*` / `text-anchor` は継承する)。
 * `@keyframes` などの at 規則は**中身ごと読み飛ばす**(入れ子の括弧を数える)。
 */
import type { XmlNode } from './xml-lite';

/** 単純選択子 1 つ(`rect` / `.node` / `#id` / `[data-look="neo"]` の合成)。 */
interface Simple {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attrs: readonly (readonly [string, string | null])[];
  /** 直前の結合子。`'>'` なら親、`' '` なら祖先のどこか。 */
  readonly combinator: ' ' | '>';
}

export interface CssRule {
  readonly parts: readonly Simple[];
  readonly decls: Readonly<Record<string, string>>;
  readonly important: ReadonlySet<string>;
  /** 詳細度 (id, class/attr, tag) を 1 つの数へ畳んだもの。 */
  readonly spec: number;
  readonly order: number;
}

/** SVG で継承する性質(mermaid の出力に効くものだけ)。 */
const INHERITED = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'color',
  'visibility',
]);

/** 要素に直接書ける見た目の属性(= 表現属性。CSS 規則より**弱い**)。 */
const PRESENTATION = new Set([
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'color',
  'visibility',
  'display',
]);

function parseSimple(text: string, combinator: ' ' | '>'): Simple | null {
  let tag: string | undefined;
  let id: string | undefined;
  const classes: string[] = [];
  const attrs: [string, string | null][] = [];
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?\]|(\*)|(::?[\w-]+(?:\([^)]*\))?)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(text)) !== null) {
    any = true;
    if (m[1] !== undefined) {
      const t = m[1];
      if (t.startsWith('.')) classes.push(t.slice(1));
      else if (t.startsWith('#')) id = t.slice(1);
      else tag = t;
    } else if (m[2] !== undefined) {
      attrs.push([m[2], m[3] ?? m[4] ?? null]);
    }
    // `*` と 擬似クラスは「何も足さない」── 落としても mermaid では実害が無い
  }
  return any ? { tag, id, classes, attrs, combinator } : null;
}

/** 選択子 1 本を単純選択子の並びへ。⚠ 読めない形は `null`(捨てる)。 */
function parseSelector(sel: string): Simple[] | null {
  const tokens = sel.trim().split(/\s*(>)\s*|\s+/).filter((t) => t !== undefined && t !== '');
  const parts: Simple[] = [];
  let combinator: ' ' | '>' = ' ';
  for (const t of tokens) {
    if (t === '>') {
      combinator = '>';
      continue;
    }
    const s = parseSimple(t, combinator);
    if (!s) return null;
    parts.push(s);
    combinator = ' ';
  }
  return parts.length > 0 ? parts : null;
}

function specificityOf(parts: readonly Simple[]): number {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const p of parts) {
    if (p.id) a += 1;
    b += p.classes.length + p.attrs.length;
    if (p.tag) c += 1;
  }
  return a * 10000 + b * 100 + c;
}

/**
 * `<style>` の中身を規則の並びにする。
 * ⚠ **at 規則は中身ごと飛ばす** ── `@keyframes` の中の `from{…}` を規則と読むと、
 * 誰にも当たらないゴミが混ざる(そして詳細度の計算を狂わせる)。
 */
export function parseCss(text: string): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  let order = 0;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) break;
    const head = text.slice(i, brace).trim();
    if (head.startsWith('@')) {
      // 入れ子の括弧を数えて丸ごと飛ばす
      let depth = 0;
      let j = brace;
      for (; j < text.length; j += 1) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      i = j + 1;
      continue;
    }
    const close = text.indexOf('}', brace);
    const body = text.slice(brace + 1, close < 0 ? text.length : close);
    const decls: Record<string, string> = {};
    const important = new Set<string>();
    for (const decl of body.split(';')) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      let value = decl.slice(colon + 1).trim();
      if (/!important$/i.test(value)) {
        important.add(name);
        value = value.replace(/!important$/i, '').trim();
      }
      if (name !== '') decls[name] = value;
    }
    for (const sel of head.split(',')) {
      const parts = parseSelector(sel);
      if (!parts) continue;
      rules.push({ parts, decls, important, spec: specificityOf(parts), order: order += 1 });
    }
    i = close < 0 ? text.length : close + 1;
  }
  return rules;
}

function classesOf(node: XmlNode): string[] {
  const raw = node.attrs['class'];
  return raw === undefined ? [] : raw.split(/\s+/).filter((s) => s !== '');
}

function matchSimple(node: XmlNode, s: Simple): boolean {
  if (s.tag !== undefined && s.tag !== node.tag) return false;
  if (s.id !== undefined && node.attrs['id'] !== s.id) return false;
  if (s.classes.length > 0) {
    const have = classesOf(node);
    for (const c of s.classes) if (!have.includes(c)) return false;
  }
  for (const [name, want] of s.attrs) {
    const got = node.attrs[name];
    if (got === undefined) return false;
    if (want !== null && got !== want) return false;
  }
  return true;
}

/** 祖先の鎖(根 → 自分)に選択子が当たるか。 */
function matches(chain: readonly XmlNode[], parts: readonly Simple[]): boolean {
  let pi = parts.length - 1;
  let ci = chain.length - 1;
  if (!matchSimple(chain[ci]!, parts[pi]!)) return false;
  pi -= 1;
  ci -= 1;
  while (pi >= 0) {
    const part = parts[pi]!;
    // ⚠ 結合子は**自分の左側**に書かれたものを見る(`A > B` の `>` は B が持つ)
    const child = parts[pi + 1]!.combinator === '>';
    if (child) {
      if (ci < 0 || !matchSimple(chain[ci]!, part)) return false;
      ci -= 1;
      pi -= 1;
      continue;
    }
    let found = false;
    while (ci >= 0) {
      if (matchSimple(chain[ci]!, part)) {
        found = true;
        ci -= 1;
        break;
      }
      ci -= 1;
    }
    if (!found) return false;
    pi -= 1;
  }
  return true;
}

/** `style="a:b;c:d"` を分解する。 */
function parseInline(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const decl of text.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (name !== '') out[name] = value;
  }
  return out;
}

export type Style = Readonly<Record<string, string>>;

/**
 * 鎖(根 → 自分)から見た目を決める。
 *
 * 優先順(弱い → 強い): **継承** < 表現属性 < CSS 規則(詳細度順)< `style=` < `!important`。
 * ⚠ SVG では**表現属性は CSS 規則より弱い** ── ここを逆にすると mermaid の
 * `<rect style="">`(空の style)や既定塗りが CSS に勝ってしまい、色が化ける。
 */
export function computeStyle(chain: readonly XmlNode[], rules: readonly CssRule[]): Style {
  let inherited: Record<string, string> = {};
  let out: Record<string, string> = {};
  for (let depth = 0; depth < chain.length; depth += 1) {
    const node = chain[depth]!;
    const here: Record<string, string> = { ...inherited };
    for (const [name, value] of Object.entries(node.attrs)) {
      if (PRESENTATION.has(name)) here[name] = value;
    }
    const hits = rules
      .filter((r) => matches(chain.slice(0, depth + 1), r.parts))
      .sort((x, y) => x.spec - y.spec || x.order - y.order);
    for (const r of hits) for (const [name, value] of Object.entries(r.decls)) here[name] = value;
    for (const [name, value] of Object.entries(parseInline(node.attrs['style']))) here[name] = value;
    for (const r of hits) for (const name of r.important) here[name] = r.decls[name]!;
    out = here;
    inherited = {};
    for (const [name, value] of Object.entries(here)) if (INHERITED.has(name)) inherited[name] = value;
  }
  return out;
}

/**
 * 色を `#rrggbb` に正規化する。⚠ **読めない色は `null`** ──
 * `url(#gradient)` / `currentColor` / `revert` は「指定なし」として扱う
 * (mermaid の neo テーマが `stroke:url(#…)` を使う。ここで潰さないと**黒く塗る**)。
 */
export function parseColor(value: string | undefined): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'none' || v === 'transparent' || v.startsWith('url(') || v === 'currentcolor' || v === 'revert' || v === 'inherit') {
    return null;
  }
  const named: Record<string, number> = {
    black: 0x000000,
    white: 0xffffff,
    red: 0xff0000,
    green: 0x008000,
    blue: 0x0000ff,
    gray: 0x808080,
    grey: 0x808080,
  };
  if (named[v] !== undefined) return named[v]!;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = [...m[1]!].map((c) => Number.parseInt(c + c, 16));
    return ((r! << 16) | (g! << 8) | b!) >>> 0;
  }
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return Number.parseInt(m[1]!, 16);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (m) {
    const r = Math.round(Number(m[1]));
    const g = Math.round(Number(m[2]));
    const b = Math.round(Number(m[3]));
    return ((r << 16) | (g << 8) | b) >>> 0;
  }
  return null;
}

/** `12px` / `1.1em` などを px にする。`em` は与えられた font-size 基準。 */
export function parseLength(value: string | undefined, em: number, fallback = 0): number {
  if (value === undefined) return fallback;
  const m = /^\s*(-?[\d.]+)\s*(px|em|rem|pt|%)?\s*$/.exec(value);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  switch (m[2]) {
    case 'em':
    case 'rem':
      return n * em;
    case 'pt':
      return (n * 96) / 72;
    case '%':
      return (n / 100) * em;
    default:
      return n;
  }
}
