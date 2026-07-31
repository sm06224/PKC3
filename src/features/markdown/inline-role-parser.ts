/**
 * Inline role parser(reform-2026-05、Phase 1 PR-E)。
 *
 * formal inline 記法 `:role:[content]{attrs}` の parser。AI / 機械が emit する
 * 厳密形 inline markup を 1 unit として認識し、role / content / attrs に分解する。
 *
 * 受理する形:
 *
 *   :role:[content]              ── content あり、attrs なし
 *   :role:[content]{attrs}       ── content + attrs
 *   :role:{attrs}                ── self-closing(autoref / image など)
 *
 * `:role:` だけ(後続 `[` も `{` も無し)は L-6 simple-inline `:text:attrs:` 等
 * との曖昧化を避けるため拒否(null 返却)、caller 側で fall-through する。
 *
 * 設計詳細は `docs/development/notation-redesign-2026-05/01-notation-catalog.md`
 * §1.3 inline 修飾 を参照。
 */

import { parseBlockDirectiveAttrs, type BlockDirectiveAttrs } from './block-directive-attrs';

export interface InlineRoleMatch {
  /** role 名(`sup` / `sub` / `span` / `ruby` / `mark` / `code` 等) */
  role: string;
  /** `[content]` 部分。self-closing(`{attrs}` のみ)時は null */
  content: string | null;
  /** `{attrs}` 部分。指定無しは empty attrs */
  attrs: BlockDirectiveAttrs;
  /** 消費 char 数(start から `:role:[…]{…}` 末尾まで) */
  length: number;
}

const ROLE_NAME_RE = /^([A-Za-z_][\w-]*):/;

/**
 * `src[start..]` の先頭から inline role を試行 parse。
 *
 *   parseInlineRoleAt(':sup:[2]', 0)
 *     → { role: 'sup', content: '2', attrs: {…empty}, length: 8 }
 *
 *   parseInlineRoleAt(':span:[hi]{class=warn}', 0)
 *     → { role: 'span', content: 'hi', attrs: { id, classes:[], kvs:{class:'warn'} }, length: 21 }
 *
 *   parseInlineRoleAt(':autoref:{id="fig1"}', 0)
 *     → { role: 'autoref', content: null, attrs: {…id "fig1"}, length: 20 }
 *
 *   parseInlineRoleAt(':just:colons:', 0)
 *     → null(neither `[` nor `{` follows、L-6 fall-through)
 */
export function parseInlineRoleAt(src: string, start: number): InlineRoleMatch | null {
  if (src[start] !== ':') return null;

  const rest = src.slice(start + 1);
  const m = ROLE_NAME_RE.exec(rest);
  if (!m) return null;

  const role = m[1]!;
  let pos = start + 1 + m[0]!.length;

  let content: string | null = null;
  let hadContent = false;

  if (src[pos] === '[') {
    const endPos = scanBracketBalanced(src, pos, '[', ']');
    if (endPos < 0) return null;
    content = src.slice(pos + 1, endPos);
    pos = endPos + 1;
    hadContent = true;
  }

  let attrs: BlockDirectiveAttrs = { id: undefined, classes: [], kvs: {} };
  let hadAttrs = false;

  if (src[pos] === '{') {
    const endPos = scanBraceBalanced(src, pos);
    if (endPos < 0) return null;
    const inner = src.slice(pos + 1, endPos);
    attrs = parseBlockDirectiveAttrs(inner);
    pos = endPos + 1;
    hadAttrs = true;
  }

  if (!hadContent && !hadAttrs) return null;

  return { role, content, attrs, length: pos - start };
}

function scanBracketBalanced(src: string, start: number, open: string, close: string): number {
  // reform-2026-05 Phase 2 PR-2J(2026-05-10、user バグレポ反映):
  // ChatGPT 等 AI は `[content]` を複数行に渡って書く(:::section 内 :emphasis:[\n…\n])。
  // 旧実装は newline で reject していたが、blank line(連続 \n\n)以外は受理に変更。
  // blank line で reject(paragraph 境界、inline rule の責任範囲外)。
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      i++;
      continue;
    }
    // blank line(連続 \n\n)で reject(paragraph break)
    if (c === '\n' && src[i + 1] === '\n') return -1;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanBraceBalanced(src: string, start: number): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length) {
      i++;
      continue;
    }
    if (c === '\n') return -1;
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
