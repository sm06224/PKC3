/**
 * Minimal regex-based syntax highlighter for Markdown fenced code
 * blocks.
 *
 * Features layer — pure function, no browser APIs.
 *
 * Design goals (see docs/development/markdown-code-block-highlighting.md):
 *   - Single-HTML product: no external CDN, no runtime loader.
 *   - Small bundle: ~8KB uncompressed for the 9 supported languages
 *     is cheaper than the ~100KB a subsetted highlight.js would cost.
 *   - Readable technical memo, not editor-grade. Token granularity
 *     covers comments / strings / keywords / numbers / builtins /
 *     variables plus a few language-specific extras (HTML tags,
 *     diff markers, YAML keys). That's enough to carry the structure.
 *   - Plain fallback for unknown languages keeps existing behaviour.
 *
 * Algorithm:
 *   Sticky-regex token walk. At each position we try every rule in
 *   order; the first match at that exact position (sticky / `y` flag)
 *   wins. Unmatched characters are emitted verbatim. Earlier rules
 *   get priority — ordered so that comments beat strings beat
 *   keywords etc.
 *
 * Output is safe HTML. Every emitted chunk — matched token or plain
 * gap — goes through `escapeHtml`, so source like `<div>` inside a
 * JS string never escapes the surrounding `<code>` element.
 */

/**
 * Token kinds → CSS class. Classes are scoped under
 * `.pkc-md-rendered pre code` in styles/base.css so they don't leak
 * elsewhere. Short kind names keep the markup compact; the CSS file
 * is the single source of truth for the mapping.
 */
const KIND_CLASS: Readonly<Record<string, string>> = {
  comment: 'pkc-tok-comment',
  string: 'pkc-tok-string',
  keyword: 'pkc-tok-keyword',
  number: 'pkc-tok-number',
  builtin: 'pkc-tok-builtin',
  variable: 'pkc-tok-variable',
  type: 'pkc-tok-type',
  attr: 'pkc-tok-attr',
  punct: 'pkc-tok-punct',
  regex: 'pkc-tok-regex',
  tag: 'pkc-tok-tag',
  meta: 'pkc-tok-meta',
  ins: 'pkc-tok-ins',
  del: 'pkc-tok-del',
  hunk: 'pkc-tok-hunk',
};

interface Rule {
  /** Sticky-flag regex (`y`). Use the `m` flag for line-anchored rules. */
  re: RegExp;
  kind: string;
}

/** Map language aliases to canonical language ids. */
const ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  ps1: 'powershell',
  pwsh: 'powershell',
  // CodeEditLite(code-edit-lite-design-2026-07):xml / svg は html rule で
  // 十分に読める(タグ / 属性 / 文字列 / コメント / entity が共通)。
  xml: 'html',
  svg: 'html',
};

/**
 * Normalize a fence language tag to a canonical id. Returns `null`
 * when no canonical form exists (language is unsupported / empty).
 */
function canonicalLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const lower = lang.toLowerCase().trim();
  if (!lower) return null;
  return ALIASES[lower] ?? lower;
}

// ── Shared fragments ─────────────────────────────────
//
// Reused across language rule tables so each language file stays
// small. Fragments are combined into final sticky regexes via
// `mkRule`, which always sets the `y` flag so the tokenizer can
// use `lastIndex` as the match anchor.

const F_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//;
const F_LINE_COMMENT_SLASH = /\/\/[^\n]*/;
const F_LINE_COMMENT_HASH = /#[^\n]*/;
const F_LINE_COMMENT_DASH = /--[^\n]*/;
const F_STRING_DQ = /"(?:[^"\\\n]|\\.)*"/;
const F_STRING_SQ = /'(?:[^'\\\n]|\\.)*'/;
const F_STRING_BT = /`(?:[^`\\]|\\.)*`/;
const F_NUMBER = /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;

function mkRule(src: RegExp, kind: string, extraFlags = ''): Rule {
  // Merge the source regex's own flags with any extra ones the caller
  // asked for, plus the mandatory sticky `y` anchor. `g` is dropped
  // because it conflicts with sticky-mode `lastIndex` semantics.
  const merged = new Set<string>();
  for (const f of src.flags) merged.add(f);
  for (const f of extraFlags) merged.add(f);
  merged.add('y');
  merged.delete('g');
  return { re: new RegExp(src.source, [...merged].join('')), kind };
}

// ── Language rule tables ─────────────────────────────

const JS_KEYWORDS =
  /\b(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|await|as|static|get|set)\b/;
const JS_LITERALS = /\b(?:null|undefined|true|false|NaN|Infinity)\b/;
const JS_BUILTINS =
  /\b(?:console|document|window|globalThis|Math|JSON|Array|Object|String|Number|Boolean|Date|Promise|Set|Map|WeakSet|WeakMap|Symbol|Error|RegExp|Reflect|Proxy)\b/;

const TS_KEYWORDS =
  /\b(?:interface|type|enum|implements|private|public|protected|readonly|abstract|declare|namespace|module|keyof|infer|satisfies|override)\b/;
const TS_TYPES =
  /\b(?:any|unknown|never|number|string|boolean|bigint|symbol|object|void)\b/;

const JS_BASE: Rule[] = [
  mkRule(F_LINE_COMMENT_SLASH, 'comment'),
  mkRule(F_BLOCK_COMMENT, 'comment'),
  mkRule(F_STRING_DQ, 'string'),
  mkRule(F_STRING_SQ, 'string'),
  mkRule(F_STRING_BT, 'string'),
  mkRule(F_NUMBER, 'number'),
];

const LANGS: Readonly<Record<string, Rule[]>> = {
  javascript: [
    ...JS_BASE,
    mkRule(JS_KEYWORDS, 'keyword'),
    mkRule(JS_LITERALS, 'keyword'),
    mkRule(JS_BUILTINS, 'builtin'),
  ],
  typescript: [
    ...JS_BASE,
    mkRule(TS_KEYWORDS, 'keyword'),
    mkRule(JS_KEYWORDS, 'keyword'),
    mkRule(JS_LITERALS, 'keyword'),
    mkRule(TS_TYPES, 'type'),
    mkRule(JS_BUILTINS, 'builtin'),
  ],
  json: [
    mkRule(F_STRING_DQ, 'string'),
    mkRule(/\b(?:true|false|null)\b/, 'keyword'),
    mkRule(F_NUMBER, 'number'),
  ],
  html: [
    mkRule(/<!--[\s\S]*?-->/, 'comment'),
    mkRule(/<!DOCTYPE[^>]*>/i, 'meta'),
    mkRule(F_STRING_DQ, 'string'),
    mkRule(F_STRING_SQ, 'string'),
    // Opening / closing tag brackets, including self-closing slashes.
    mkRule(/<\/?[a-zA-Z][\w:-]*/, 'tag'),
    mkRule(/\/?>/, 'tag'),
    // HTML entities.
    mkRule(/&[#\w]+;/, 'meta'),
    // Attribute names preceding `=`. Match before `=` via lookahead
    // so the equals sign itself stays plain.
    mkRule(/[\w-]+(?==)/, 'attr'),
  ],
  css: [
    mkRule(F_BLOCK_COMMENT, 'comment'),
    mkRule(F_STRING_DQ, 'string'),
    mkRule(F_STRING_SQ, 'string'),
    mkRule(/@[\w-]+/, 'meta'),
    // Property names — `foo-bar:` before the colon.
    mkRule(/[\w-]+(?=\s*:)/, 'attr'),
    // Hex colours.
    mkRule(/#[0-9a-fA-F]{3,8}\b/, 'number'),
    mkRule(/-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|deg|s|ms|pt|fr)?\b/, 'number'),
    mkRule(/!important\b/, 'keyword'),
  ],
  bash: [
    mkRule(F_LINE_COMMENT_HASH, 'comment'),
    mkRule(F_STRING_DQ, 'string'),
    mkRule(F_STRING_SQ, 'string'),
    mkRule(F_STRING_BT, 'string'),
    mkRule(/\$\{[^}]*\}|\$\w+|\$\$|\$\?|\$\*|\$@/, 'variable'),
    mkRule(
      /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|break|continue|export|local|readonly|declare|set|unset|source|trap|shift|eval|exec|test)\b/,
      'keyword',
    ),
    mkRule(
      /\b(?:echo|printf|cd|pwd|ls|cat|head|tail|grep|sed|awk|find|xargs|sort|uniq|wc|cut|tr|tee|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|touch|which|whoami|ps|kill|curl|wget|ssh|scp|rsync|git|npm|yarn|pnpm|node|deno|bun|python|python3|pip|make|docker|kubectl)\b/,
      'builtin',
    ),
    mkRule(F_NUMBER, 'number'),
  ],
  yaml: [
    mkRule(F_LINE_COMMENT_HASH, 'comment'),
    mkRule(F_STRING_DQ, 'string'),
    mkRule(F_STRING_SQ, 'string'),
    // YAML keys at line start: optional `- ` then `key:` (key itself
    // must stop before the colon). The leading `^` pairs with the
    // `m` flag so line-anchored matches work with sticky mode.
    mkRule(/^[ \t]*-?[ \t]*[\w.-]+(?=\s*:)/, 'attr', 'm'),
    mkRule(/&\w+|\*\w+/, 'meta'),
    mkRule(/\b(?:true|false|null|yes|no|on|off|~)\b/, 'keyword'),
    mkRule(F_NUMBER, 'number'),
  ],
  diff: [
    // Line-anchored. The order matters: hunk headers and file
    // headers win before the generic +/-/- lines.
    mkRule(/^@@[^@\n]*@@.*/, 'hunk', 'm'),
    mkRule(/^(?:diff|index|---|\+\+\+)[^\n]*/, 'meta', 'm'),
    mkRule(/^\+[^\n]*/, 'ins', 'm'),
    mkRule(/^-[^\n]*/, 'del', 'm'),
  ],
  sql: [
    mkRule(F_LINE_COMMENT_DASH, 'comment'),
    mkRule(F_BLOCK_COMMENT, 'comment'),
    mkRule(F_STRING_SQ, 'string'),
    mkRule(
      /\b(?:SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|USING|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|VIEW|INDEX|DROP|ALTER|TRUNCATE|AS|AND|OR|NOT|NULL|IS|IN|BETWEEN|LIKE|ILIKE|EXISTS|CASE|WHEN|THEN|ELSE|END|DISTINCT|UNION|ALL|INTERSECT|EXCEPT|PRIMARY|KEY|FOREIGN|REFERENCES|CHECK|DEFAULT|CONSTRAINT|UNIQUE|WITH|RECURSIVE|RETURNING|BEGIN|COMMIT|ROLLBACK)\b/i,
      'keyword',
    ),
    mkRule(/\b(?:true|false|null)\b/i, 'keyword'),
    mkRule(F_NUMBER, 'number'),
  ],
  powershell: [
    mkRule(F_LINE_COMMENT_HASH, 'comment'),
    mkRule(F_STRING_DQ, 'string'),
    mkRule(F_STRING_SQ, 'string'),
    mkRule(/\$[A-Za-z_]\w*/, 'variable'),
    mkRule(
      /\b(?:if|else|elseif|while|for|foreach|do|function|return|break|continue|switch|param|begin|process|end|try|catch|finally|throw|filter|in)\b/i,
      'keyword',
    ),
    mkRule(
      /\b(?:[A-Z][a-z]+-[A-Za-z]+)\b/,
      'builtin',
    ),
    mkRule(/\B-[A-Za-z][\w-]*/, 'attr'),
    mkRule(F_NUMBER, 'number'),
  ],
};

/**
 * HTML-escape a string for safe embedding inside element content.
 * Local copy instead of importing one from elsewhere — keeps this
 * module self-contained and avoids a circular dependency with the
 * markdown renderer that will call us.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Return the full canonical id list — used by tests to assert coverage. */
export function listSupportedLanguages(): readonly string[] {
  return Object.keys(LANGS);
}

/** True iff the language (or any of its aliases) is highlightable. */
export function isHighlightable(lang: string | null | undefined): boolean {
  const id = canonicalLang(lang);
  return id !== null && id in LANGS;
}

/**
 * Highlight `code` for `lang`. Returns safe HTML (all text is
 * escaped). When the language is unknown the entire body is
 * escaped and returned unwrapped — the caller can emit it inside
 * `<pre><code>` as plain text.
 *
 * The returned HTML never includes a wrapping `<pre>` / `<code>` —
 * the caller decides the wrapper. The markdown-it `highlight` hook
 * uses this directly; markdown-it adds the wrapping elements itself.
 */
export function highlightCode(code: string, lang: string | null | undefined): string {
  const id = canonicalLang(lang);
  const rules = id ? LANGS[id] : undefined;
  if (!rules) return escapeHtml(code);

  let out = '';
  let pos = 0;
  let plainStart = 0;
  const n = code.length;

  while (pos < n) {
    let matched: { end: number; kind: string; text: string } | null = null;
    for (const r of rules) {
      r.re.lastIndex = pos;
      const m = r.re.exec(code);
      if (m && m.index === pos && m[0].length > 0) {
        matched = { end: pos + m[0].length, kind: r.kind, text: m[0] };
        break;
      }
    }
    if (matched) {
      if (plainStart < pos) {
        out += escapeHtml(code.slice(plainStart, pos));
      }
      const cls = KIND_CLASS[matched.kind] ?? '';
      if (cls) {
        out += `<span class="${cls}">${escapeHtml(matched.text)}</span>`;
      } else {
        out += escapeHtml(matched.text);
      }
      pos = matched.end;
      plainStart = pos;
    } else {
      pos++;
    }
  }
  if (plainStart < n) {
    out += escapeHtml(code.slice(plainStart));
  }
  return out;
}
