/**
 * Block directive attribute parser(reform-2026-05、Phase 1 PR-D)。
 *
 * Pandoc-style `{key=value key2="quoted" #id .class flag}` attribute syntax を
 * 1 つの文字列から parse する pure helper。
 *
 * `:::name{attrs}` block / `:role:[content]{attrs}` inline 双方で使う共通基盤。
 *
 * 受理する記法:
 *
 *   - `key=value`          ── unquoted、value は 1 word(空白 / `}` 不可)
 *   - `key="value with sp"` ── double-quoted、空白許容
 *   - `key='value'`        ── single-quoted
 *   - `flag`               ── 単独 word は boolean true 扱い
 *   - `#id`                ── id 指定(slug-safe な英字 / 数字 / `-` / `_`)
 *   - `.class`             ── class 指定(同上)
 *
 * 設計詳細は `docs/development/notation-redesign-2026-05/01-notation-catalog.md`
 * §1.2.4 / §1.2.5 + §1.3.2 を参照。
 */

export interface BlockDirectiveAttrs {
  /** `#id` 指定。指定なし時 undefined。 */
  id?: string;
  /** `.class` 指定の集合。指定なし時 空配列。 */
  classes: string[];
  /** `key=value` / `flag` 指定の集合。flag は boolean true で stored。 */
  kvs: Record<string, string | boolean>;
}

/**
 * `{key=value ...}` の中身(`{` `}` は除いた本体)を parse。
 *
 *   parseBlockDirectiveAttrs('quote author="Smith" year=2020')
 *     → { id: undefined, classes: [], kvs: { quote: true, author: "Smith", year: "2020" } }
 *
 *   parseBlockDirectiveAttrs('#fig-1 .important caption="Diagram"')
 *     → { id: 'fig-1', classes: ['important'], kvs: { caption: 'Diagram' } }
 *
 * malformed token は silent skip(silent fail を避けたい場合は caller で
 * 「parse 後の空 attrs vs 入力非空」を検証して warning 表示)。
 */
export function parseBlockDirectiveAttrs(inner: string): BlockDirectiveAttrs {
  const out: BlockDirectiveAttrs = { id: undefined, classes: [], kvs: {} };
  if (!inner) return out;

  // Tokenize:
  //   - quoted tokens(`"..."`、`'...'`)を 1 token に保持
  //   - 残りは whitespace 区切り
  const tokens: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++;
      continue;
    }
    // `key="..."` or `key='...'` を 1 token として保持
    // word(non-quote / non-space)を読む。
    // reform-2026-05 hotfix(2026-05-10):smart quote(U+201C/D 双 + U+2018/9 単)
    // も ASCII quote と同等に受理(textarea autocorrect / typographer 経由で
    // smart quote 化された source も parse できるように)。
    let buf = '';
    while (i < inner.length) {
      const c = inner[i]!;
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (isQuoteOpen(c) && buf.length > 0 && buf[buf.length - 1] === '=') {
        // start quoted value
        const closeQuote = matchingClose(c);
        buf += c;
        i++;
        while (i < inner.length) {
          const cc = inner[i]!;
          buf += cc;
          i++;
          if (cc === '\\' && i < inner.length) {
            // escape next char
            buf += inner[i]!;
            i++;
            continue;
          }
          if (cc === closeQuote) break;
        }
        continue;
      }
      buf += c;
      i++;
    }
    if (buf.length > 0) tokens.push(buf);
  }

  for (const tok of tokens) {
    if (tok.startsWith('#')) {
      const id = tok.slice(1);
      if (/^[A-Za-z_][\w-]*$/.test(id)) {
        out.id = id;
      }
      continue;
    }
    if (tok.startsWith('.')) {
      const cls = tok.slice(1);
      if (/^[A-Za-z_][\w-]*$/.test(cls)) {
        out.classes.push(cls);
      }
      continue;
    }
    const eqIdx = tok.indexOf('=');
    if (eqIdx < 0) {
      // boolean flag(name のみ)
      if (/^[A-Za-z_][\w-]*$/.test(tok)) {
        out.kvs[tok] = true;
      }
      continue;
    }
    const key = tok.slice(0, eqIdx);
    let value = tok.slice(eqIdx + 1);
    if (!/^[A-Za-z_][\w-]*$/.test(key)) continue;
    // unquote if quoted(ASCII + smart quote 両方受理)
    if (value.length >= 2) {
      const f = value[0]!;
      const l = value[value.length - 1]!;
      const closeForOpen = matchingClose(f);
      if (closeForOpen && l === closeForOpen) {
        value = value.slice(1, -1);
        // unescape `\"` `\'` `\\`
        value = value.replace(/\\(["'\\])/g, '$1');
      }
    }
    out.kvs[key] = value;
  }

  return out;
}

/** 開き quote(ASCII / smart 両形)判定 */
function isQuoteOpen(c: string): boolean {
  return c === '"' || c === "'" || c === '“' /* " */ || c === '‘' /* ' */
    || c === '”' /* " */ || c === '’' /* ' */;
}

/** 開き quote → 対応する閉じ quote(同じ ASCII or smart pair の close) */
function matchingClose(open: string): string | null {
  switch (open) {
    case '"':
    case "'":
      return open;
    case '“':
      return '”';
    case '”':
      return '”';
    case '‘':
      return '’';
    case '’':
      return '’';
    default:
      return null;
  }
}

/**
 * `:::name{attrs}` の opening line から `name` と attrs を抜き出す。
 * attrs 不在時(`:::name` だけ)も受理。
 *
 *   parseBlockDirectiveOpen(':::quote{author="Smith" year=2020}')
 *     → { name: 'quote', attrs: { id: undefined, classes: [], kvs: { author: 'Smith', year: '2020' } } }
 *
 *   parseBlockDirectiveOpen(':::if')
 *     → { name: 'if', attrs: { id: undefined, classes: [], kvs: {} } }
 *
 *   parseBlockDirectiveOpen('not a directive')
 *     → null
 */
export function parseBlockDirectiveOpen(
  line: string,
): { name: string; attrs: BlockDirectiveAttrs } | null {
  // `:::name{...}` or `:::name`、name は slug-safe
  const m = /^:::([A-Za-z_][\w-]*)(?:\{([^}]*)\})?\s*$/.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const attrsStr = m[2] ?? '';
  return { name, attrs: parseBlockDirectiveAttrs(attrsStr) };
}

/**
 * v4 §12 stack PR 5:Tier 1 class chain simple `:::.cls.cls(#id)?` 形寛容パース。
 *
 * 6 variation を全て BlockDirectiveAttrs に正規化:
 *
 *   :::.highlight.important              ← packed(最短)
 *   ::: .highlight .important            ← space 区切り
 *   ::: {.highlight .important}          ← Pandoc fenced div 互換
 *   ::: highlight                        ← 単 class(`.` 省略可)
 *   :::.highlight#myid                   ← class + id packed
 *   ::: .highlight #myid                 ← space + id
 *
 * 全 variation で `name='format'` 相当として扱うが、本関数は **attrs のみ** を返す。
 * 呼び出し側(`processFormatBlocks`)で format directive として処理する。
 *
 * 戻り値 null は「Tier 1 形ではない」 = 既存 `parseBlockDirectiveOpen` で処理する形。
 */
export function parseTier1FormatOpen(line: string): BlockDirectiveAttrs | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(':::')) return null;
  const rest = trimmed.slice(3); // after :::
  if (rest.length === 0) return null;

  // Variant: brace `:::{.cls .cls #id ...}` or `::: {...}`
  const braceMatch = /^\s*\{([^}]*)\}\s*$/.exec(rest);
  if (braceMatch) {
    const inner = braceMatch[1]!.trim();
    if (!inner) return null;
    const attrs = parseBlockDirectiveAttrs(inner);
    if (attrs.classes.length > 0 || attrs.id) return attrs;
    return null;
  }

  // Variant: packed `:::.cls.cls#id` (rest[0] === '.')
  if (rest[0] === '.') {
    return parsePackedTier1Attrs(rest);
  }

  // Variant: space-separated `::: .cls .cls #id` or `::: bareCls`
  if (rest[0] === ' ' || rest[0] === '\t') {
    const tokens = rest.trim().split(/\s+/);
    if (tokens.length === 0) return null;
    const attrs: BlockDirectiveAttrs = { id: undefined, classes: [], kvs: {} };
    for (const t of tokens) {
      if (t.length === 0) continue;
      if (t.startsWith('.')) {
        const cls = t.slice(1);
        if (!/^[A-Za-z_][\w-]*$/.test(cls)) return null;
        attrs.classes.push(cls);
      } else if (t.startsWith('#')) {
        const id = t.slice(1);
        if (!/^[A-Za-z_][\w-]*$/.test(id)) return null;
        if (attrs.id) return null; // 重複 id
        attrs.id = id;
      } else if (/^[A-Za-z_][\w-]*$/.test(t)) {
        // bare class(dot 省略)
        attrs.classes.push(t);
      } else {
        return null; // 未知 token
      }
    }
    if (attrs.classes.length > 0 || attrs.id) return attrs;
    return null;
  }

  return null;
}

/**
 * v4 §16 Q8(user direction 2026-05-25):block directive value-only 寛容パース。
 *
 * 4 directive 限定で `key=` 省略 + value 直書きを accept、value から key を推論:
 *
 *   :::section{intro}        → role=intro(任意 role 文字列)
 *   :::section{appendix}     → role=appendix
 *   :::if{html}              → format=html
 *   :::toc{2}                → depth=2(integer 1-6)
 *   :::quote{"夏目漱石"}     → author="夏目漱石"(quoted string)
 *
 * 戻り値:`{key, value}` 推論成功 / null 推論不能(directive 対象外 or 形式不一致)。
 * 既存 explicit key=value form は parseBlockDirectiveAttrs で正常 parse される。
 *
 * 6 directive(`:::break` / `:::list` / `:::heading` / `:::code` / `:::blank` /
 * `:::paragraph`)は **対象外**(既存 simple 形 `+++` / `- T` / `## T` / ` ```ts ``` ` /
 * `_3` / `__T` で覆われ済のため、value-only の追加 utility が薄い)。
 */
export function inferQ8ValueOnlyKey(
  directiveName: string,
  inner: string,
): { key: string; value: string } | null {
  const keyMap: Record<string, string> = {
    section: 'role',
    if: 'format',
    toc: 'depth',
    quote: 'author',
  };
  const key = keyMap[directiveName];
  if (!key) return null;
  const trimmed = inner.trim();
  if (!trimmed) return null;
  // double-quoted string
  const dq = /^"([^"]*)"$/.exec(trimmed);
  if (dq) return { key, value: dq[1]! };
  // single-quoted string
  const sq = /^'([^']*)'$/.exec(trimmed);
  if (sq) return { key, value: sq[1]! };
  // bare number(integer or float)
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return { key, value: trimmed };
  // bare keyword(`[A-Za-z_][\w-]*`、空白 / `=` / 特殊 char なし)
  if (/^[A-Za-z_][\w-]*$/.test(trimmed)) return { key, value: trimmed };
  return null;
}

function parsePackedTier1Attrs(rest: string): BlockDirectiveAttrs | null {
  // rest starts with '.' or '#'
  // Format: (.cls)+ (#id)? (順序不問だが id は 1 個まで)
  const attrs: BlockDirectiveAttrs = { id: undefined, classes: [], kvs: {} };
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '.') {
      i++;
      let j = i;
      while (j < rest.length && rest[j] !== '.' && rest[j] !== '#') j++;
      if (j === i) return null; // empty class
      const cls = rest.slice(i, j);
      if (!/^[A-Za-z_][\w-]*$/.test(cls)) return null;
      attrs.classes.push(cls);
      i = j;
    } else if (rest[i] === '#') {
      i++;
      let j = i;
      while (j < rest.length && rest[j] !== '.') j++;
      if (j === i) return null; // empty id
      const id = rest.slice(i, j);
      if (!/^[A-Za-z_][\w-]*$/.test(id)) return null;
      if (attrs.id) return null; // 重複 id
      attrs.id = id;
      i = j;
    } else {
      return null; // 想定外の char
    }
  }
  if (attrs.classes.length === 0 && !attrs.id) return null;
  return attrs;
}

/**
 * `:::` 単独行が directive close か判定。
 *
 * `:::` 単独 + 前後 whitespace のみなら true。
 */
export function isBlockDirectiveClose(line: string): boolean {
  return /^\s*:::\s*$/.test(line);
}
