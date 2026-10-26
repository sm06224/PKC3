/**
 * 🔴 **本文に書いた「入力欄の定義」(` ```yaml form `)から、入力欄を出す**(#1456)。
 *
 * > user の物語:日報・問い合わせ管理・タスクなどの**定型のノート**を、毎回同じ見出しと表を
 * > 手で組まずに作りたい。項目を定義しておけば、入力欄が出て、打った値がそのノートに入る。
 *
 * ## 何が決まっているか(「何ができたら煮詰まったと言うか」── `sealed.ts` の問いへの答え)
 *
 * 封印した `form` アーキタイプ(`sealed.ts`)の再開ではない。**新しいノートの種類も、新しい本文の形も作らない**:
 *
 * 1. 定義は本文の ` ```yaml form ` の囲み(色づけは yaml のまま ── 描かない面でも定義として読める)
 * 2. 入力した値は、そのノートの**先頭の設定欄**に `vars.<項目名>: 値` の行として入る。
 *    ⚠ これは `{{vars.<項目名>}}` の差し込みが前から読んでいる綴り(`extractVars`)── つまり
 *    **入力欄は、既にある差し込みの入力口**であり、本文のどこからでも `{{vars.氏名}}` で使える。
 * 3. 表(` ```csv name=日報一覧 `)との連携は **押したときだけ**(「表に追加」「表の行を更新」「表の行を読み込む」)。
 *    勝手に同期しない ── 双方向だが、どちらも user が押した 1 回の操作で、1 つの書込の道(`REQUEST_BODY_REWRITE`)を通る。
 * 4. 入力できるのは**読む画面だけ**。書き出した HTML・印刷・Word・別ウィンドウは、いまの値を**表で見せるだけ**
 *    (受け手の居ない面に押せる欄を出さない)。
 *
 * ## 定義の書き方(YAML の一部だけを読む)
 *
 * ```yaml form
 * title: 日報
 * table: 日報一覧          # 省略可。表の連携先(```csv name=日報一覧)
 * fields:
 *   - name: 氏名
 *     label: お名前        # 省略すると name
 *     type: text           # text / textarea / number / select / date / checkbox(省略すると text)
 *   - name: 区分
 *     type: select
 *     options: [通常, 休み]
 *     required: true
 * ```
 *
 * ⚠ 読めない行は**黙って捨てず、理由を囲みの中に出す**(`errors`)。項目名に使えるのは差し込みの名前と同じ字だけ
 *   (`VAR_NAME_SOURCE`)── 違う字を許すと、入れても `{{vars.…}}` で引けない。
 *
 * ⚠ ここは pure。DOM は持たず、HTML の文字列を返す。
 */
import { VAR_NAME_SOURCE } from './frontmatter';

export const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'date', 'checkbox'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly type: FormFieldType;
  readonly options: readonly string[];
  readonly required: boolean;
  readonly placeholder: string;
}

export interface FormDef {
  readonly title: string;
  /** 表の連携先(` ```csv name=… ` の名前)。無ければ `''`。 */
  readonly table: string;
  readonly fields: readonly FormField[];
  /** 読めなかった所の理由(画面の言葉)。 */
  readonly errors: readonly string[];
}

/** 囲みの見出しが入力欄の定義か(` ```yaml form ` / ` ```yml form `)。 */
export function isFormInfo(info: string | null | undefined): boolean {
  if (typeof info !== 'string') return false;
  const words = info.trim().split(/\s+/u);
  const lang = (words[0] ?? '').toLowerCase();
  return (lang === 'yaml' || lang === 'yml') && words.slice(1).some((w) => w.toLowerCase() === 'form');
}

const NAME_RE = new RegExp(`^${VAR_NAME_SOURCE}$`, 'u');
/** 表の名前(` ```csv name=… `)の字。⚠ 予約語などの細かい断りは表を引く側が理由つきで言う(`csv-tables.ts`)。 */
const TABLE_NAME_RE = /^[\p{L}\p{N}_]+$/u;

/** 値の外側の引用符を外す。 */
function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const f = t[0];
    const l = t[t.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return t.slice(1, -1);
  }
  return t;
}

/** 行末の ` # コメント` を落とす(引用符の中の # は残す)。 */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/u.test(raw[i - 1]!))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** `[a, b, "c, d"]` → 並び。`[` で始まらなければ単一の値。 */
function parseList(raw: string): string[] {
  const t = raw.trim();
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out.filter((s) => s !== '');
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', 'はい', '必須', '1']);

/** 定義の字を読む。⚠ 読めない行は `errors` に理由を積む(捨てない)。 */
export function parseFormDef(src: string): FormDef {
  const errors: string[] = [];
  let title = '';
  let table = '';
  type Draft = { line: number; map: Map<string, string> };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  const lines = src.split(/\r?\n/u);
  lines.forEach((rawLine, i) => {
    const no = i + 1;
    const line = stripComment(rawLine).replace(/\s+$/u, '');
    if (line.trim() === '') return;
    const trimmed = line.trim();
    const indented = /^\s/u.test(line);
    if (trimmed.startsWith('-')) {
      const rest = trimmed.slice(1).trim();
      cur = { line: no, map: new Map() };
      drafts.push(cur);
      if (rest === '') return;
      const m = /^([^:]+?)\s*:\s*(.*)$/u.exec(rest);
      if (m === null) cur.map.set('name', unquote(rest));
      else cur.map.set(m[1]!.trim().toLowerCase(), m[2]!.trim());
      return;
    }
    const m = /^([^:]+?)\s*:\s*(.*)$/u.exec(trimmed);
    if (m === null) {
      errors.push(`${String(no)} 行目を読めませんでした(「キー: 値」の形で書いてください)`);
      return;
    }
    const key = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    if (!indented) {
      if (key === 'title') title = unquote(value);
      else if (key === 'table') {
        table = unquote(value);
        // 🔴 表の名前は ` ```csv name=… ` に書く名前と同じ字だけ(空白・記号は入れられない ── 引けない名前を黙って受けない)
        if (table !== '' && !TABLE_NAME_RE.test(table)) {
          errors.push(`表の名前「${table}」は使えません(文字・数字・_ だけです。空白や記号は入れられません)`);
          table = '';
        }
      }
      else if (key === 'fields') cur = null;
      else errors.push(`${String(no)} 行目の「${key}」は使えません(title / table / fields だけです)`);
      return;
    }
    if (cur === null) {
      errors.push(`${String(no)} 行目が、どの項目(- で始まる行)にも属していません`);
      return;
    }
    cur.map.set(key, value);
  });

  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const name = unquote(d.map.get('name') ?? '');
    if (name === '') {
      errors.push(`${String(d.line)} 行目の項目に name がありません`);
      continue;
    }
    if (!NAME_RE.test(name)) {
      errors.push(`項目名「${name}」は使えません(文字・数字・_・- だけです。空白や記号は入れられません)`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`項目名「${name}」が重なっています`);
      continue;
    }
    const typeRaw = unquote(d.map.get('type') ?? 'text').toLowerCase();
    const type = (FORM_FIELD_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as FormFieldType) : null;
    if (type === null) {
      errors.push(`項目「${name}」の type「${typeRaw}」は使えません(${FORM_FIELD_TYPES.join(' / ')})`);
      continue;
    }
    const options = parseList(d.map.get('options') ?? '');
    if (type === 'select' && options.length === 0) {
      errors.push(`項目「${name}」は select なのに options がありません`);
      continue;
    }
    seen.add(name);
    fields.push({
      name,
      label: unquote(d.map.get('label') ?? '') || name,
      type,
      options: type === 'select' ? options : [],
      required: TRUE_WORDS.has(unquote(d.map.get('required') ?? '').toLowerCase()),
      placeholder: unquote(d.map.get('placeholder') ?? ''),
    });
  }
  if (fields.length === 0 && errors.length === 0) errors.push('項目がありません(- name: 項目名 の行を書いてください)');
  return { title, table, fields, errors };
}

const CHECKED_WORDS = new Set(['true', '1', 'yes', 'on', 'はい', '済', '○', '✓', 'x', 'checked']);

/** 値(`vars` の字や表のセルの字)がチェックありか。 */
export function isCheckedValue(v: string | undefined): boolean {
  return v !== undefined && CHECKED_WORDS.has(v.trim().toLowerCase());
}

function esc(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** 見出し行の前に付ける印(必須)。 */
const REQUIRED_MARK = '*';
/** 値が空のときに静的な表へ出す字。 */
export const FORM_EMPTY_TEXT = '(未入力)';

function labelHtml(f: FormField): string {
  return `<span class="pkc-form-label">${esc(f.label)}${f.required ? `<span class="pkc-form-required" aria-hidden="true">${REQUIRED_MARK}</span>` : ''}</span>`;
}

function fieldHtml(f: FormField, value: string | undefined): string {
  const v = value ?? '';
  // 🔑 受け手(binder)は DOM から項目の名前・表示名・種類を読む(定義を持ち回らない)
  const common = `data-pkc-form-field="${esc(f.name)}" data-pkc-form-label="${esc(f.label)}" data-pkc-form-type="${f.type}"${f.required ? ' data-pkc-form-required="true"' : ''}`;
  const ph = f.placeholder === '' ? '' : ` placeholder="${esc(f.placeholder)}"`;
  switch (f.type) {
    case 'textarea':
      return `<textarea ${common} rows="3"${ph}>${esc(v)}</textarea>`;
    case 'number':
      return `<input type="number" step="any" ${common} value="${esc(v)}"${ph}>`;
    case 'date':
      return `<input type="date" ${common} value="${esc(v)}">`;
    case 'checkbox':
      return `<input type="checkbox" ${common}${isCheckedValue(v) ? ' checked' : ''}>`;
    case 'select': {
      const opts = f.options.slice();
      // 値が選択肢に無い(定義を直した後の古い値)ときも落とさず並べる
      if (v !== '' && !opts.includes(v)) opts.push(v);
      return `<select ${common}><option value="">(選んでください)</option>${opts
        .map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`)
        .join('')}</select>`;
    }
    default:
      return `<input type="text" ${common} value="${esc(v)}"${ph}>`;
  }
}

function errorsHtml(def: FormDef): string {
  return def.errors.map((e) => `<p class="pkc-form-error" data-pkc-form-error="">${esc(e)}</p>`).join('');
}

export interface FormRenderOptions {
  /** 入力欄を出すか(受け手が居る読む面だけ)。`false` は値を表で見せるだけ。 */
  readonly interactive: boolean;
  /** 本文の `vars`(いまの値)。 */
  readonly vars: Readonly<Record<string, string>>;
  /** 囲みに付ける原文の行の印(` data-pkc-source-line="…"`)。 */
  readonly sourceAttrs?: string;
}

/**
 * 入力欄(または値の表)の HTML。
 * ⚠ 値は全部 `esc` を通す(vars はノートの本文から来た字)。
 */
export function formHtml(src: string, opts: FormRenderOptions): string {
  const def = parseFormDef(src);
  const attrs = opts.sourceAttrs ?? '';
  const title = def.title === '' ? '' : `<p class="pkc-form-title">${esc(def.title)}</p>`;
  if (!opts.interactive) {
    const rows = def.fields
      .map((f) => {
        const raw = opts.vars[f.name];
        let cell: string;
        if (f.type === 'checkbox') cell = isCheckedValue(raw) ? '☑' : '☐';
        else cell = raw === undefined || raw === '' ? `<span class="pkc-form-empty">${FORM_EMPTY_TEXT}</span>` : esc(raw);
        return `<tr><th scope="row">${esc(f.label)}</th><td>${cell}</td></tr>`;
      })
      .join('');
    return `<div class="pkc-form pkc-form-static" data-pkc-form-static=""${attrs}>${title}${errorsHtml(def)}${
      rows === '' ? '' : `<table><tbody>${rows}</tbody></table>`
    }</div>`;
  }
  const rows = def.fields
    .map((f) => {
      const control = fieldHtml(f, opts.vars[f.name]);
      return f.type === 'checkbox'
        ? `<label class="pkc-form-row pkc-form-row-check">${control}${labelHtml(f)}</label>`
        : `<label class="pkc-form-row">${labelHtml(f)}${control}</label>`;
    })
    .join('');
  const tableName = def.table;
  const save =
    def.fields.length === 0
      ? ''
      : `<button type="button" class="pkc-form-btn" data-pkc-action="form-save">入力を保存</button>`;
  const sheet =
    tableName === '' || def.fields.length === 0
      ? ''
      : `<span class="pkc-form-sheet"><button type="button" class="pkc-form-btn" data-pkc-action="form-row-add" title="いまの入力を、表「${esc(tableName)}」の末尾へ 1 行足します(表が無ければ作ります)">表に追加</button>` +
        `<label class="pkc-form-rowno">行 <input type="number" min="1" step="1" data-pkc-form-rowno="" aria-label="表の行の番号"></label>` +
        `<button type="button" class="pkc-form-btn" data-pkc-action="form-row-load" title="表「${esc(tableName)}」のその行を、入力欄へ読み込みます">読み込む</button>` +
        `<button type="button" class="pkc-form-btn" data-pkc-action="form-row-update" title="いまの入力で、表「${esc(tableName)}」のその行を書き換えます">表の行を更新</button></span>`;
  const note =
    tableName === ''
      ? ''
      : `<p class="pkc-form-hint">表: ${esc(tableName)}(\`csv name=${esc(tableName)}\` のブロック)</p>`;
  const source =
    `<details class="pkc-form-source"><summary>定義を見る</summary><pre><code>${esc(src.replace(/\n+$/u, ''))}</code></pre></details>`;
  return (
    `<div class="pkc-form" data-pkc-form=""${tableName === '' ? '' : ` data-pkc-form-table="${esc(tableName)}"`}${attrs}>` +
    title +
    errorsHtml(def) +
    rows +
    (save === '' ? '' : `<div class="pkc-form-actions">${save}${sheet}</div>`) +
    note +
    source +
    `</div>`
  );
}
