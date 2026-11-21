/**
 * 🔴 **取り込み専用の最小 YAML 読み手**(#2002 段 3。旧版 PKC のテンプレート zip を読むためだけに使う)。
 *
 * 入力欄の定義(` ```yaml form `)を読む `form-def.ts` は**入れ子を読めない**(項目の並びだけの部分集合)ので、
 * テンプレートの `template.yaml` / `forms/*.yaml` が使う形だけを読む別の読み手を、依存を増やさずにここに置く。
 *
 * ## 読める形(これだけ)
 * - ブロックのマップ(`key: 値`)と並び(`- 値` / `- key: 値` の続き)。字下げは空白(タブは断る)
 * - 1 行の `[a, "b", 3]` の並び
 * - 値: 引用符つき(`"…"` は `\n \t \" \\ \uXXXX`、`'…'` は `''`)/ 素の字 / 数 / `true` `false` / `null` `~`
 * - 複数行の字(`|` / `>` と `-` `+`)
 * - 行末と行頭の `# コメント`、先頭の `---` 1 つ
 *
 * ## 断る形(データだけ読む。**実行も展開もしない**)
 * - タグ(`!!python/…` / `!tag`)・アンカー(`&a`)・エイリアス(`*a`)・合成キー(`<<`)・`{ }` のマップ・複数文書(2 つ目の `---` / `...`)
 * - 重なったキー・タブの字下げ・深さ {@link YAML_MAX_DEPTH} 超・{@link YAML_MAX_BYTES} 超・{@link YAML_MAX_NODES} 超の節
 * - 読めない行は**行番号つき**で {@link YamlSubsetError} にする(読めた気にして一部だけ返さない)
 *
 * ⚠ pure。値は `null | boolean | number | string | YamlValue[] | {[k]: YamlValue}`(プロトタイプを持たない)。
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

export const YAML_MAX_BYTES = 1024 * 1024;
export const YAML_MAX_DEPTH = 32;
export const YAML_MAX_NODES = 20000;

export class YamlSubsetError extends Error {
  constructor(
    message: string,
    /** 1 始まりの行番号(行に結べない誤りは 0)。 */
    readonly line: number,
  ) {
    super(line > 0 ? `${String(line)} 行目: ${message}` : message);
    this.name = 'YamlSubsetError';
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

/** 引用符の外の ` #` 以降を落とす。 */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote !== null) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      // 素の字の途中のアポストロフィ(don't)は引用の始まりではない
      if (i === 0 || /[\s[,:]/u.test(raw[i - 1]!)) quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/u.test(raw[i - 1]!))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function unescapeDouble(inner: string, no: number): string {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = inner[i + 1];
    i += 1;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '0') out += '\0';
    else if (n === '"' || n === '\\' || n === '/') out += n;
    else if (n === 'u') {
      const hex = inner.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new YamlSubsetError('\\u の後ろは 16 進数 4 桁です', no);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else throw new YamlSubsetError(`\\${n ?? ''} は読めない書き方です`, no);
  }
  return out;
}

/** 引用符つきの字なら中身。**閉じていなければ断る**。引用符でなければ null。 */
function quoted(raw: string, no: number): string | null {
  const q = raw[0];
  if (q !== '"' && q !== "'") return null;
  let i = 1;
  let out = '';
  for (; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (q === '"') {
      if (ch === '\\') {
        out += raw.slice(i, i + (raw[i + 1] === 'u' ? 6 : 2));
        i += raw[i + 1] === 'u' ? 5 : 1;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    } else {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        break;
      }
      out += ch;
    }
  }
  if (i >= raw.length) throw new YamlSubsetError('引用符が閉じていません(複数行にまたがる引用符は読めません)', no);
  if (raw.slice(i + 1).trim() !== '') throw new YamlSubsetError('引用符の後ろに余分な字があります', no);
  return q === '"' ? unescapeDouble(out, no) : out;
}

function refuseSpecial(raw: string, no: number): void {
  const c = raw[0];
  if (c === '!') throw new YamlSubsetError('タグ(! ではじまる指定)は読めません', no);
  if (c === '&') throw new YamlSubsetError('アンカー(&)は読めません', no);
  if (c === '*') throw new YamlSubsetError('エイリアス(*)は読めません', no);
  if (c === '{') throw new YamlSubsetError('{ } のマップは読めません(字下げの書き方にしてください)', no);
  if (c === '@' || c === '`') throw new YamlSubsetError(`「${c}」ではじまる値は読めません`, no);
}

function scalar(raw: string, no: number): YamlValue {
  const t = raw.trim();
  if (t === '') return null;
  const q = quoted(t, no);
  if (q !== null) return q;
  refuseSpecial(t, no);
  if (t === 'null' || t === '~' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(t)) return Number(t);
  return t;
}

function flowSeq(raw: string, no: number): YamlValue[] {
  const t = raw.trim();
  if (!t.endsWith(']')) throw new YamlSubsetError('[ ] の並びは 1 行で閉じてください', no);
  const inner = t.slice(1, -1);
  const out: YamlValue[] = [];
  let cur = '';
  let quote: string | null = null;
  const push = (): void => {
    if (cur.trim() !== '') out.push(scalar(cur, no));
    cur = '';
  };
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote !== null) {
      cur += ch;
      if (quote === '"' && ch === '\\') {
        cur += inner[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') push();
    else if (ch === '[' || ch === '{') throw new YamlSubsetError('[ ] の中に入れ子は書けません', no);
    else cur += ch;
  }
  if (quote !== null) throw new YamlSubsetError('引用符が閉じていません', no);
  push();
  return out;
}

/** `key:` の位置を返す(引用符の外の「: 」または行末の「:」)。無ければ -1。 */
function colonAt(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (quote === '"' && ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && i === 0) quote = ch;
    else if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) return i;
  }
  return -1;
}

/** YAML の部分集合を読む。誤りは {@link YamlSubsetError}(行番号つき)。 */
export function parseYamlSubset(src: string): YamlValue {
  if (src.length > YAML_MAX_BYTES) {
    throw new YamlSubsetError(`大きすぎます(${String(YAML_MAX_BYTES / 1024)} KB まで)`, 0);
  }
  const rawLines = src.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u);
  let docStarted = false;
  /** コメントと空行を除いた行。複数行の字は元の行から読む(`raw`)。 */
  const lines: Line[] = [];
  const raw: string[] = rawLines;
  const rawIndexOf: number[] = [];
  rawLines.forEach((r, i) => {
    const no = i + 1;
    if (r.trim() === '' || r.trimStart().startsWith('#')) return;
    if (/^---(\s|$)/u.test(r)) {
      if (docStarted || lines.length > 0) throw new YamlSubsetError('複数の文書(---)は読めません', no);
      docStarted = true;
      return;
    }
    if (/^\.\.\.(\s|$)/u.test(r)) throw new YamlSubsetError('文書の終わり(...)は読めません', no);
    if (/^\s*\t/u.test(r) || /^ *\t/u.test(r)) throw new YamlSubsetError('字下げにタブは使えません(空白にしてください)', no);
    const indent = r.length - r.trimStart().length;
    lines.push({ indent, text: stripComment(r.trim()).trimEnd(), no });
    rawIndexOf.push(i);
  });
  if (lines.length === 0) throw new YamlSubsetError('中身がありません', 0);

  let pos = 0;
  let nodes = 0;
  const countNode = (no: number): void => {
    nodes += 1;
    if (nodes > YAML_MAX_NODES) throw new YamlSubsetError(`項目が多すぎます(${String(YAML_MAX_NODES)} 個まで)`, no);
  };

  const blockScalar = (head: string, parentIndent: number, no: number): string => {
    // head は `|` `>` `|-` `>+` など。読み取りは元の行から(空行・コメント風の行も中身)
    const m = /^([|>])([+-]?)$/u.exec(head);
    if (m === null) throw new YamlSubsetError('複数行の字の指定を読めません(| か > だけ)', no);
    const startRaw = rawIndexOf[pos - 1]! + 1;
    const body: string[] = [];
    let i = startRaw;
    for (; i < raw.length; i += 1) {
      const r = raw[i]!;
      if (r.trim() === '') {
        body.push('');
        continue;
      }
      const ind = r.length - r.trimStart().length;
      if (ind <= parentIndent) break;
      body.push(r);
    }
    // 末尾の空行は keep(+)のときだけ残す
    let trailing = 0;
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
      trailing += 1;
    }
    const indents = body.filter((l) => l !== '').map((l) => l.length - l.trimStart().length);
    const common = indents.length > 0 ? Math.min(...indents) : 0;
    const cut = body.map((l) => (l === '' ? '' : l.slice(common)));
    // 読み終えた行(次の論理行)まで pos を進める
    while (pos < lines.length && rawIndexOf[pos]! < i) pos += 1;
    let text: string;
    if (m[1] === '|') text = cut.join('\n');
    else {
      // 折り畳み: 空行は改行、字のある行は空白でつなぐ
      let acc = '';
      for (let k = 0; k < cut.length; k += 1) {
        const l = cut[k]!;
        if (k === 0) acc = l;
        else if (l === '') acc += '\n';
        else if (cut[k - 1] === '') acc += l;
        else acc += ` ${l}`;
      }
      text = acc;
    }
    if (m[2] === '-') return text;
    if (cut.length === 0) return '';
    return m[2] === '+' ? `${text}\n${'\n'.repeat(trailing)}` : `${text}\n`;
  };

  const parseValue = (rest: string, no: number): YamlValue => {
    if (rest.startsWith('[')) return flowSeq(rest, no);
    return scalar(rest, no);
  };

  const parseBlock = (indent: number, depth: number): YamlValue => {
    if (depth > YAML_MAX_DEPTH) throw new YamlSubsetError(`入れ子が深すぎます(${String(YAML_MAX_DEPTH)} 段まで)`, lines[pos]?.no ?? 0);
    const first = lines[pos]!;
    if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(indent, depth);
    return parseMap(indent, depth);
  };

  const parseSeq = (indent: number, depth: number): YamlValue[] => {
    const out: YamlValue[] = [];
    while (pos < lines.length) {
      const ln = lines[pos]!;
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlSubsetError('字下げがそろっていません', ln.no);
      if (!(ln.text === '-' || ln.text.startsWith('- '))) break;
      countNode(ln.no);
      const rest = ln.text.slice(1).trim();
      if (rest === '') {
        pos += 1;
        const next = lines[pos];
        if (next !== undefined && next.indent > indent) out.push(parseBlock(next.indent, depth + 1));
        else out.push(null);
        continue;
      }
      // `- key: 値` は、`key` の位置を字下げとするマップの 1 行目として読み直す
      if (colonAt(rest) >= 0 && !rest.startsWith('[') && quoted(rest, ln.no) === null) {
        const offset = ln.text.length - rest.length;
        lines[pos] = { indent: indent + offset, text: rest, no: ln.no };
        out.push(parseMap(indent + offset, depth + 1));
        continue;
      }
      pos += 1;
      out.push(parseValue(rest, ln.no));
    }
    return out;
  };

  const parseMap = (indent: number, depth: number): { [key: string]: YamlValue } => {
    const out: { [key: string]: YamlValue } = Object.create(null) as { [key: string]: YamlValue };
    while (pos < lines.length) {
      const ln = lines[pos]!;
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlSubsetError('字下げがそろっていません', ln.no);
      if (ln.text === '-' || ln.text.startsWith('- ')) {
        if (Object.keys(out).length === 0) throw new YamlSubsetError('並びの途中にキーがあります', ln.no);
        break;
      }
      countNode(ln.no);
      const c = colonAt(ln.text);
      if (c < 0) throw new YamlSubsetError('「キー: 値」の形ではありません', ln.no);
      let key: string;
      const keyRaw = ln.text.slice(0, c).trim();
      const kq = keyRaw === '' ? null : quoted(keyRaw, ln.no);
      if (kq !== null) key = kq;
      else {
        refuseSpecial(keyRaw, ln.no);
        key = keyRaw;
      }
      if (key === '') throw new YamlSubsetError('キーが空です', ln.no);
      if (key === '<<') throw new YamlSubsetError('合成キー(<<)は読めません', ln.no);
      if (key === '__proto__') throw new YamlSubsetError('このキーは使えません', ln.no);
      if (key in out) throw new YamlSubsetError(`キー「${key}」が重なっています`, ln.no);
      const rest = ln.text.slice(c + 1).trim();
      pos += 1;
      if (rest === '') {
        const next = lines[pos];
        if (next !== undefined && next.indent > indent) out[key] = parseBlock(next.indent, depth + 1);
        else if (next !== undefined && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
          out[key] = parseSeq(indent, depth + 1);
        } else out[key] = null;
      } else if (rest.startsWith('|') || rest.startsWith('>')) {
        out[key] = blockScalar(rest, indent, ln.no);
      } else {
        out[key] = parseValue(rest, ln.no);
      }
    }
    return out;
  };

  const rootIndent = lines[0]!.indent;
  const value = parseBlock(rootIndent, 0);
  if (pos < lines.length) throw new YamlSubsetError('字下げがそろっていません', lines[pos]!.no);
  return value;
}
