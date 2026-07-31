/**
 * YAML mini frontmatter parser (領域 10-6 ζ'' Phase 2a + reform-2026-05 Phase 1 PR-B 拡張).
 *
 * Pure TypeScript, dep-zero. Supports the subset that book / youtube /
 * album / paper / film entries actually need:
 *
 *   - Document fence: `---\n…\n---\n` at byte 0 of body
 *   - Flat key:value pairs, one per line
 *   - Values inferred as `string | number | boolean | null` plus
 *     scalar arrays (`[a, b, c]` / next-line `- a` block)
 *   - Quoted strings (single, double) keep their literal content
 *
 * Out of scope (returns the body untouched if encountered):
 *   - Nested mappings (key with `:\n  child:` indented children)
 *   - Anchors / aliases / merge keys
 *   - Complex multiline scalars (`|`, `>`)
 *   - Type tags (`!!str`)
 *
 * reform-2026-05 Phase 1 PR-B 追加:
 *   - **size cap**:`features/notation/caps.ts` の `resolveCap('frontmatter', 'bytes')`
 *     を使って input size 上限 enforcement(default 16 KB、HARD ceiling 1 MB)。
 *     超過時は warnings に push、parse 中止して body だけ返す。
 *   - **warnings field**:silent fail を避けるため、cap overflow 等を
 *     `result.warnings` に貯める(spec §07.3 silent fail 禁止)。
 *
 * Spec: docs/development/filer-view-and-folder-display-profile-audit-2026-05.md §2.4
 *       docs/development/notation-redesign-2026-05/02-frontmatter-and-globals.md §2.5
 */

import { resolveCap } from '../notation/caps';

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number | boolean | null>;

export interface FrontmatterWarning {
  /** 警告の分類。CSS / display 振り分け用、reform spec §07.3 と整合。 */
  kind: 'size_limit' | 'malformed' | 'forbidden_key' | 'duplicate_key';
  /** Human-readable Japanese reason、可視 warning に流す。 */
  detail: string;
}

export interface FrontmatterResult {
  /** Parsed key/value pairs. Empty object when no frontmatter detected. */
  meta: Record<string, FrontmatterValue>;
  /** Original body with the fenced frontmatter removed (if any). */
  body: string;
  /**
   * `true` when an opening `---` was found AND a matching closing `---`
   * was also found. `false` keeps `body` identical to the input.
   */
  found: boolean;
  /**
   * Soft warnings emitted during parse(reform-2026-05 PR-B 追加)。
   * cap 超過 / forbidden key / 重複 key 等。空配列 = clean parse。
   * caller は inspector / preview 先頭で `<div class="pkc-frontmatter-warning">`
   * として表示する想定(spec §07.3、silent fail 禁止)。
   */
  warnings: FrontmatterWarning[];
}

const OPEN_FENCE = /^---\s*\r?\n/;
const CLOSE_FENCE_LINE = /^---\s*$/;

/** UTF-8 byte length。cap enforcement の size 計測に使う。 */
function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/**
 * Split a body into its frontmatter block and the markdown remainder.
 * Always returns a defined result; on parse failure the meta is empty
 * and body is the original input.
 */
export function parseFrontmatter(body: string): FrontmatterResult {
  const warnings: FrontmatterWarning[] = [];
  const emptyMeta: Record<string, FrontmatterValue> = {};
  if (!body || !OPEN_FENCE.test(body)) {
    return { meta: emptyMeta, body, found: false, warnings };
  }
  // Strip the opening `---\n`.
  const afterOpen = body.replace(OPEN_FENCE, '');
  const lines = afterOpen.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CLOSE_FENCE_LINE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { meta: emptyMeta, body, found: false, warnings };
  }

  const yamlLines = lines.slice(0, closeIdx);

  // reform-2026-05 PR-B:size cap 適用(SOFT_DEFAULTS 16 KB、HARD 1 MB)。
  // 超過時は parse 中止 + 可視 warning(spec §07.3 silent fail 禁止)。
  const fmText = yamlLines.join('\n');
  const fmBytes = byteLength(fmText);
  const sizeCap = resolveCap('frontmatter', 'bytes');
  if (fmBytes > sizeCap) {
    warnings.push({
      kind: 'size_limit',
      detail: `frontmatter サイズが ${sizeCap} bytes を超過(${fmBytes} bytes)、parse 中止`,
    });
    const remainder = lines.slice(closeIdx + 1).join('\n');
    return {
      meta: emptyMeta,
      body: remainder.startsWith('\n') ? remainder.slice(1) : remainder,
      found: true,
      warnings,
    };
  }

  const meta = parseFlatYaml(yamlLines);
  const remainder = lines.slice(closeIdx + 1).join('\n');
  return {
    meta,
    body: remainder.startsWith('\n') ? remainder.slice(1) : remainder,
    found: true,
    warnings,
  };
}

/**
 * 行末 `# comment` を除去する(YAML 慣例: `#` の直前に空白があるときのみ)。
 * ⚠ PKC2 版は `/\s+#.*$/` の一括 replace で **quote 内の `#` まで切り落として
 * いた**(serializeFrontmatter が quote した値が parse で壊れる round-trip バグ)。
 *
 * PKC3 の意味論(parseVarValue / 実 YAML と同じ):**値の先頭が quote 文字の
 * ときだけ** quote を追跡する。plain scalar 中の `'`(例: `title: it's a pen`)
 * は quote 開始ではないので、素朴な行末コメント除去に落ちる(P3-4 review #4)。
 */
function stripTrailingComment(line: string): string {
  const colon = findKeyColon(line);
  let i = colon >= 0 ? colon + 1 : 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const q = line[i];
  if (q === '"' || q === "'") {
    // 閉じ quote を探す(double は `\` escape、single は `''` escape)
    let j = i + 1;
    while (j < line.length) {
      const ch = line[j];
      if (q === '"' && ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === q) {
        if (q === "'" && line[j + 1] === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    if (j >= line.length) return line.trimEnd(); // 非終端 quote は触らない
    const rest = line.slice(j + 1);
    const m = /\s#/u.exec(rest);
    if (m) return line.slice(0, j + 1 + m.index).trimEnd();
    return line.trimEnd();
  }
  if (q === '[') {
    // inline 配列: 要素が quote されうる(serializeScalar)ので quote 外の
    // 空白+`#` だけをコメントと見なす
    let inSingle = false;
    let inDouble = false;
    for (let j = i; j < line.length; j++) {
      const ch = line[j];
      if (ch === '\\' && inDouble) {
        j += 1;
        continue;
      }
      if (!inDouble && ch === "'") inSingle = !inSingle;
      else if (!inSingle && ch === '"') inDouble = !inDouble;
      else if (!inSingle && !inDouble && ch === '#' && /\s/u.test(line[j - 1]!)) {
        return line.slice(0, j).trimEnd();
      }
    }
    return line.trimEnd();
  }
  return line.replace(/\s+#.*$/u, '').trimEnd();
}

function parseFlatYaml(lines: readonly string[]): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    i += 1;
    const line = stripTrailingComment(raw);
    if (line.trim() === '') continue;
    if (line.startsWith('#')) continue;

    const colon = findKeyColon(line);
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key || !/^[A-Za-z_][\w.-]*$/.test(key)) continue;
    const valuePart = line.slice(colon + 1).trim();

    if (valuePart === '') {
      // Could be a block-style array on subsequent indented lines.
      const arr: Array<string | number | boolean | null> = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const m = /^\s*-\s+(.*)$/u.exec(next);
        if (!m) break;
        arr.push(parseScalar(m[1]!.trim()));
        i += 1;
      }
      out[key] = arr;
      continue;
    }

    if (valuePart.startsWith('[') && valuePart.endsWith(']')) {
      out[key] = parseInlineArray(valuePart.slice(1, -1));
      continue;
    }

    out[key] = parseScalar(valuePart);
  }
  return out;
}

function findKeyColon(line: string): number {
  // Find the first `:` outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === ':') return i;
  }
  return -1;
}

function parseInlineArray(inner: string): Array<string | number | boolean | null> {
  if (inner.trim() === '') return [];
  // Naive split on commas outside quotes; sufficient for scalars.
  const parts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      buf += ch + (inner[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => parseScalar(p.trim()));
}

function parseScalar(raw: string): string | number | boolean | null {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;

  // Quoted string — strip quotes, handle a couple of escapes.
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if (first === '"' && last === '"') {
      return raw.slice(1, -1).replace(/\\(["\\nt])/gu, (_m, ch: string) =>
        ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
      );
    }
    if (first === "'" && last === "'") {
      return raw.slice(1, -1).replace(/''/gu, "'");
    }
  }

  // Numeric? Use JSON.parse for strict number validation.
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  // Date-like (YYYY-MM-DD, ISO timestamp) — keep as string. Useful for
  // `read_at: 2024-03-15` etc. without converting to a Date object.
  return raw;
}

/**
 * Public helper: 単一の scalar 文字列(graphical editor の input value 等)を
 * frontmatter 値型に解釈する。`parseFlatYaml` 内の scalar 解釈と同一規則。
 */
export function parseFrontmatterScalar(
  raw: string,
): string | number | boolean | null {
  return parseScalar(raw.trim());
}

/**
 * Public helper: returns the `kind` discriminator if present and valid.
 * Filer subset profiles look this up to decide which entries belong
 * to the `book-base` / `youtube-base` / etc. query.
 */
export function getFrontmatterKind(body: string): string | null {
  const { meta, found } = parseFrontmatter(body);
  if (!found) return null;
  const kind = meta['kind'];
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/**
 * L-? M-7(2026-05-08、wave-10-2 Phase 2):frontmatter から `vars.*` を
 * 抽出して flat `Record<string, string>` に正規化する helper。本文の
 * `{{vars.name}}` 展開で使う(`renderMarkdown(text, { vars })` 経由)。
 *
 * 受理する 2 形式:
 *
 *   1. ネスト object 形式(spec §3.6 例):
 *        vars:
 *          project: ALPHA-7
 *          client: Acme Corp
 *
 *   2. flat dot-notation 形式(YAML 平 parse の延長):
 *        vars.project: ALPHA-7
 *        vars.client: Acme Corp
 *
 * 両形式を併用しても OK(後者が優先される、上書き)。
 *
 * 既存 `parseFrontmatter` は flat 1 階のみ対応で nested object を
 * 解釈しないため、本 helper は raw frontmatter 領域を独自に scan する。
 *
 * 値は string 化して返す(boolean / number は `String()`、null は除外)。
 *
 * frontmatter 不在 / vars 不在 / parse 失敗 → `{}` を返す(safe default)。
 */
export function extractVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || !OPEN_FENCE.test(body)) return out;
  const afterOpen = body.replace(OPEN_FENCE, '');
  const lines = afterOpen.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CLOSE_FENCE_LINE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return out;
  const frontLines = lines.slice(0, closeIdx);

  // 1. nested object 形式:`vars:` 単独行 + 後続の indented `<key>: <value>` 群
  for (let i = 0; i < frontLines.length; i++) {
    const line = frontLines[i] ?? '';
    if (!/^vars\s*:\s*$/.test(line)) continue;
    // 子行を読み込む。1 文字以上のインデント(SP / TAB)+ key: value 形式。
    let j = i + 1;
    while (j < frontLines.length) {
      const child = frontLines[j] ?? '';
      // 空行は break(ネストブロック終了)
      if (child.trim() === '') break;
      const m = /^(\s+)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(child);
      if (!m) break;  // 非インデント or 不正形式 = nested 終了
      const key = m[2]!;
      const rawVal = m[3]!.trim();
      out[key] = parseVarValue(rawVal);
      j++;
    }
    break;  // vars: ブロックは 1 回だけ
  }

  // 2. flat dot-notation 形式:`vars.X: value`
  for (const line of frontLines) {
    const m = /^vars\.([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rawVal = m[2]!.trim();
    out[key] = parseVarValue(rawVal);
  }

  return out;
}

/** quoted string / scalar を string 化して返す。null は空文字。 */
function parseVarValue(raw: string): string {
  if (raw === '' || raw === '~' || /^null$/i.test(raw)) return '';
  if (raw.length >= 2) {
    const f = raw[0];
    const l = raw[raw.length - 1];
    if (f === '"' && l === '"') {
      return raw.slice(1, -1).replace(/\\(["\\nt])/gu, (_m, ch: string) =>
        ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
      );
    }
    if (f === "'" && l === "'") return raw.slice(1, -1).replace(/''/gu, "'");
  }
  // trailing # comment を strip(YAML 慣例)
  return raw.replace(/\s+#.*$/u, '').trim();
}

// ── serialize(parseFrontmatter の逆変換、Phase γ-B1)──
//
// graphical frontmatter editor が編集結果を entry.body に書き戻すための pure
// 関数。flat YAML のみ(spec §3.6、nested 非対応)。serialize → parseFrontmatter
// が round-trip するよう、scalar は parseScalar が別型に解釈し得る場合に quote。

// raw 文字列が parseScalar で string 以外 / 構造文字で壊れる場合に quote が要る。
function scalarNeedsQuote(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/^(~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/u.test(s)) return true;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(s)) return true;
  // `,` を含む値は quote 必須 ── inline 配列要素が parseInlineArray の
  // comma split で分裂する(P3-4 review #1: 無言のデータ破損)。scalar 値でも
  // quote は無害なので一律に含める
  if (/[:#"',[\]]/u.test(s)) return true;
  if (s.startsWith('-')) return true;
  if (/[\n\r]/u.test(s)) return true;
  return false;
}

function quoteScalar(s: string): string {
  const escaped = s
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n')
    .replace(/\t/gu, '\\t');
  return `"${escaped}"`;
}

function serializeScalar(v: string | number | boolean | null): string {
  // null は明示的に `null` と書く。空値 `key:` は parseFlatYaml が block-style
  // 空配列 [] に解釈してしまい round-trip が壊れるため。
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return scalarNeedsQuote(v) ? quoteScalar(v) : v;
}

/**
 * key/value pairs を `---` で挟んだ frontmatter block 文字列に serialize する。
 * 空 meta でも `---\n---` を返す(空 block の判定は呼び出し側 `setFrontmatter`)。
 */
export function serializeFrontmatter(
  meta: Record<string, FrontmatterValue>,
): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(serializeScalar).join(', ')}]`);
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * body の frontmatter block を `meta` で置き換える(無ければ prepend)。
 * meta が空なら frontmatter を除去した本文のみを返す。
 * ⚠ parse view 経由なので本文先頭の空行 1 個が落ちる既知の癖がある ──
 * **既存 body の部分書換には使わず `spliceFrontmatterKeys` を使う**
 * (P3-4 review #5 の規律: 書換は原文 splice で)。
 */
export function setFrontmatter(
  body: string,
  meta: Record<string, FrontmatterValue>,
): string {
  const { body: rest } = parseFrontmatter(body);
  if (Object.keys(meta).length === 0) return rest;
  const fm = serializeFrontmatter(meta);
  return rest === '' ? fm : `${fm}\n${rest}`;
}

/**
 * frontmatter の特定 key だけを**原文 splice**で書き換える(P3-6、かんばん
 * トグル等の構造化操作用)。本文・他 key・空行・コメントは byte 単位で無傷。
 *
 * - key が既存 → その行だけ差し替え(最初の一致。値 undefined なら行を除去)
 * - key が無い → 閉じ fence の直前に追加
 * - frontmatter 自体が無い → fence を前置(本文は無傷のまま後続)
 */
export function spliceFrontmatterKeys(
  body: string,
  updates: Record<string, FrontmatterValue | undefined>,
): string {
  const entries = Object.entries(updates);
  if (entries.length === 0) return body;
  const lineFor = ([key, value]: [string, FrontmatterValue | undefined]):
    | string
    | null =>
    value === undefined
      ? null
      : Array.isArray(value)
        ? `${key}: [${value.map(serializeScalar).join(', ')}]`
        : `${key}: ${serializeScalar(value)}`;

  if (!OPEN_FENCE.test(body)) {
    const lines = entries.map(lineFor).filter((l): l is string => l !== null);
    if (lines.length === 0) return body;
    return `---\n${lines.join('\n')}\n---\n${body}`;
  }

  const open = body.match(OPEN_FENCE)![0];
  const afterOpen = body.slice(open.length);
  // 行末記号(LF / CRLF)を各行に残したまま分割 ── 本文を byte 無傷で戻すため
  const parts = afterOpen.split(/(?<=\n)/);
  let closeAt = -1;
  for (let i = 0; i < parts.length; i++) {
    if (CLOSE_FENCE_LINE.test((parts[i] ?? '').replace(/\r?\n$/, ''))) {
      closeAt = i;
      break;
    }
  }
  if (closeAt === -1) {
    // 開き fence だけで閉じが無い = frontmatter 不在扱い(parseFrontmatter と同じ)
    const lines = entries.map(lineFor).filter((l): l is string => l !== null);
    if (lines.length === 0) return body;
    return `---\n${lines.join('\n')}\n---\n${body}`;
  }

  const eol = body.includes('\r\n') ? '\r\n' : '\n'; // 新規行のみに使う
  const fmParts = parts.slice(0, closeAt);
  for (const [key, value] of entries) {
    const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    // 重複 key は**最後の一致**を書く ── parseFlatYaml は last-wins なので、
    // 先頭行を書くと再抽出が変わらず永久 no-op になる(P3-6a review #5)
    let at = -1;
    for (let i = 0; i < fmParts.length; i++) {
      if (keyRe.test(fmParts[i]!)) at = i;
    }
    const line = lineFor([key, value]);
    if (at >= 0) {
      if (line === null) {
        fmParts.splice(at, 1);
      } else {
        // 既存行の行末記号を保持して差し替え
        const term = fmParts[at]!.match(/\r?\n$/)?.[0] ?? eol;
        fmParts[at] = line + term;
      }
    } else if (line !== null) {
      fmParts.push(line + eol);
    }
  }
  const rest = parts.slice(closeAt).join(''); // 閉じ fence 行から後ろは原文 byte のまま
  return `${open}${fmParts.join('')}${rest}`;
}
