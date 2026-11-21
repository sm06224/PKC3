/**
 * 🔴 **旧版 PKC のテンプレート zip(`template.yaml` + `forms/*.yaml`)を、PKC3 のふつうのノートに直す**(#2002 段 3)。
 *
 * > user の物語:旧版 PKC で作った定型のフォルダ・入力フォーム・ログの雛形を、PKC3 へそのまま持ってきたい。
 *
 * ## 決まりごと(user 裁定 2026-11-21、#2002)
 * - **取り込むだけ**(書き出しは `.pkc3-notes.zip` のまま)。
 * - 作るのは**ふつうのノートとフォルダ**だけ。新しい種類も JSON の本文も作らない。テンプレートの中の物は**実行しない**(データとして読むだけ)。
 * - **取り込めない物は、取り込み結果に 1 件ずつ出す**(黙って落とさない)。出どころ(どのファイルのどのキーか)を添える。
 *
 * ## 変換
 * | 旧版 | PKC3 |
 * |---|---|
 * | `folders[]` | フォルダ(定義の順) |
 * | `entries[]` の `text` | テキストのノート(`body` がそのまま本文) |
 * | `entries[]` の `textlog` | ログのノート(`lines` ごとに `## 日時` の節。`flag: red` / `important` は ★) |
 * | `entries[]` の `form` | 説明 + ` ```yaml form ` + ` ```csv name=… ` の入ったノート(`forms/<id>.yaml` から) |
 *
 * 入力欄の型: `radio` は `select`、`checkbox-group` は 1 つの値の複数選択(段 1)、`datetime` はそのまま。
 * 項目名(`key`)は {@link VAR_NAME_SOURCE} に合う字だけにし、**変えたときは変換表を結果に出す**。
 *
 * ⚠ pure。zip の読み書き・保存は adapter(`import-template.ts`)。
 */
import { VAR_NAME_SOURCE } from '../markdown/frontmatter';
import { parseFormDef } from '../markdown/form-def';
import { formatHeadingTimestamp } from '../flavor/textlog-flavor';
import { parseYamlSubset, YamlSubsetError, type YamlValue } from './yaml-subset';

export class TemplateImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateImportError';
  }
}

export const TEMPLATE_MAX_FOLDERS = 500;
export const TEMPLATE_MAX_ENTRIES = 2000;
export const TEMPLATE_MAX_FORMS = 200;
export const TEMPLATE_MAX_FIELDS = 500;

/** zip の名前の一覧から、`template.yaml` の在る階層(`''` か `X/`)を探す。無ければ null。 */
export function findTemplateRoot(names: readonly string[]): string | null {
  const isT = (n: string): boolean => n === 'template.yaml' || n === 'template.yml';
  if (names.some(isT)) return '';
  const deep = new Set<string>();
  for (const n of names) {
    const m = /^([^/]+\/)(template\.ya?ml)$/u.exec(n);
    if (m !== null && !n.startsWith('__MACOSX/')) deep.add(m[1]!);
  }
  return deep.size === 1 ? [...deep][0]! : null;
}

export interface TemplateSource {
  /** `template.yaml` の字。 */
  readonly template: string;
  /** `forms/*.yaml` の字(キーは `forms/` の後ろのファイル名)。 */
  readonly forms: ReadonlyMap<string, string>;
  /** 取り込まない他のファイルの名前(`template.yaml` と `forms/` 以外。ディレクトリは含めない)。 */
  readonly otherFiles: readonly string[];
}

export interface TemplateNote {
  readonly lid: string;
  readonly title: string;
  readonly archetype: 'folder' | 'text' | 'textlog';
  readonly body: string;
  /** 親フォルダの lid(根なら null)。 */
  readonly parent: string | null;
}

export interface TemplateResult {
  /** フォルダが先、ノートは定義の順。 */
  readonly notes: readonly TemplateNote[];
  readonly relations: ReadonlyArray<{ id: string; fromLid: string; toLid: string; kind: string }>;
  readonly name: string;
  readonly counts: {
    readonly folders: number;
    readonly notes: number;
    readonly forms: number;
    readonly textlogs: number;
    readonly texts: number;
    readonly fields: number;
  };
  /** 項目名を変えた対応表(`forms/x.yaml: 旧 → 新`)。 */
  readonly renamed: readonly string[];
  /** 取り込めなかった物(出どころつき)。 */
  readonly ignored: readonly string[];
}

export interface TemplateOptions {
  readonly genLid: () => string;
  readonly genRelationId: () => string;
  readonly now: Date;
}

type Obj = { [key: string]: YamlValue };
const isObj = (v: YamlValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: YamlValue | undefined): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

const NAME_RE = new RegExp(`^${VAR_NAME_SOURCE}$`, 'u');
const NAME_CHAR_BAD = /[^\p{L}\p{M}\p{N}_-]/gu;

function readYaml(text: string, where: string): YamlValue {
  try {
    return parseYamlSubset(text);
  } catch (e) {
    if (e instanceof YamlSubsetError) throw new TemplateImportError(`${where} を読めませんでした(${e.message})`);
    throw e;
  }
}

/** 項目名を VAR_NAME_SOURCE に合わせる。重なったら `_2` `_3`。 */
function toName(raw: string, taken: Set<string>): string {
  let n = raw.replace(NAME_CHAR_BAD, '_');
  if (n === '' || !NAME_RE.test(n)) n = `_${n}`.replace(/^_+$/u, 'field');
  if (!NAME_RE.test(n)) n = 'field';
  let out = n;
  for (let i = 2; taken.has(out); i += 1) out = `${n}_${String(i)}`;
  taken.add(out);
  return out;
}

/** 入力欄の定義に書く値。⚠ 引用符・改行で定義を壊さない。 */
function yq(s: string): string {
  const flat = s.replace(/[\r\n]+/gu, ' ');
  if (!flat.includes('"')) return `"${flat}"`;
  if (!flat.includes("'")) return `'${flat}'`;
  return `"${flat.replace(/"/gu, '”')}"`;
}

const CONDITIONAL_KEY = /(?:_if$|^when$|^condition|^visib|^show|^hide|^hidden|^depends|^enabled)/iu;
const FIELD_KNOWN = new Set(['key', 'label', 'type', 'required', 'options', 'placeholder']);
const SIMPLE_TYPES = new Set(['text', 'textarea', 'number', 'select', 'date', 'datetime', 'checkbox']);

interface ConvertedForm {
  readonly title: string;
  readonly fence: string;
  readonly table: string;
  readonly header: readonly string[];
  readonly sections: ReadonlyArray<{ name: string; labels: string[] }>;
  readonly fields: number;
}

function convertForm(file: string, y: YamlValue, ignored: string[], renamed: string[]): ConvertedForm {
  const where = `forms/${file}`;
  if (!isObj(y)) throw new TemplateImportError(`${where} の形が違います(キーと値の並びではありません)`);
  for (const k of Object.keys(y)) {
    if (!['schema_version', 'form_id', 'title', 'sections'].includes(k)) ignored.push(`${where} のキー「${k}」(未知のキー)`);
  }
  const title = str(y.title) || str(y.form_id) || file.replace(/\.ya?ml$/iu, '');
  const sectionsRaw = y.sections;
  if (!Array.isArray(sectionsRaw)) throw new TemplateImportError(`${where} に sections(項目の区分の並び)がありません`);
  const taken = new Set<string>();
  const out: string[] = [];
  const header: string[] = [];
  const sections: Array<{ name: string; labels: string[] }> = [];
  let count = 0;
  sectionsRaw.forEach((s, si) => {
    if (!isObj(s)) {
      ignored.push(`${where} の sections[${String(si)}](区分の形が違うため読み飛ばし)`);
      return;
    }
    for (const k of Object.keys(s)) {
      if (k !== 'section' && k !== 'fields') ignored.push(`${where} の sections[${String(si)}] のキー「${k}」(未知のキー)`);
    }
    const sec = { name: str(s.section), labels: [] as string[] };
    sections.push(sec);
    if (!Array.isArray(s.fields)) {
      ignored.push(`${where} の sections[${String(si)}](fields が無い)`);
      return;
    }
    s.fields.forEach((f, fi) => {
      const at = `${where} の sections[${String(si)}].fields[${String(fi)}]`;
      if (!isObj(f)) {
        ignored.push(`${at}(項目の形が違うため読み飛ばし)`);
        return;
      }
      count += 1;
      if (count > TEMPLATE_MAX_FIELDS) throw new TemplateImportError(`${where} の項目が多すぎます(${String(TEMPLATE_MAX_FIELDS)} 個まで)`);
      const keyRaw = str(f.key) || str(f.label);
      if (keyRaw === '') {
        ignored.push(`${at}(key も label も無いため読み飛ばし)`);
        count -= 1;
        return;
      }
      const name = toName(keyRaw, taken);
      if (name !== keyRaw) renamed.push(`${where}: ${keyRaw} → ${name}`);
      const label = str(f.label) || keyRaw;
      for (const k of Object.keys(f)) {
        if (FIELD_KNOWN.has(k)) continue;
        ignored.push(
          CONDITIONAL_KEY.test(k)
            ? `${at}「${keyRaw}」の「${k}」(条件つきの必須・表示は取り込みません)`
            : `${at}「${keyRaw}」のキー「${k}」(未知のキー)`,
        );
      }
      const typeRaw = (str(f.type) || 'text').toLowerCase();
      let type = typeRaw === 'radio' ? 'select' : typeRaw;
      let options: string[] = [];
      if (Array.isArray(f.options)) options = f.options.map((o) => str(o)).filter((o) => o !== '');
      if (!SIMPLE_TYPES.has(type) && type !== 'checkbox-group') {
        ignored.push(`${at}「${keyRaw}」の type「${typeRaw}」(未対応の型。text として取り込みました)`);
        type = 'text';
      }
      if ((type === 'select' || type === 'checkbox-group') && options.length === 0) {
        ignored.push(`${at}「${keyRaw}」は ${typeRaw} なのに options が無い(text として取り込みました)`);
        type = 'text';
      }
      if (type === 'checkbox-group' && options.some((o) => o.includes(','))) {
        options = options.map((o) => o.replace(/,/gu, '，'));
        ignored.push(`${at}「${keyRaw}」の選択肢の「,」(全角の「，」に変えました)`);
      }
      let required = false;
      if (f.required === true) required = true;
      else if (f.required !== undefined && f.required !== false && f.required !== null) {
        ignored.push(`${at}「${keyRaw}」の required(true / false 以外の値は条件つきの必須として取り込みません)`);
      }
      out.push(`  - name: ${name}`);
      if (label !== name) out.push(`    label: ${yq(label)}`);
      out.push(`    type: ${type}`);
      if (type === 'select' || type === 'checkbox-group') out.push(`    options: [${options.map(yq).join(', ')}]`);
      if (required) out.push('    required: true');
      const ph = str(f.placeholder);
      if (ph !== '') out.push(`    placeholder: ${yq(ph)}`);
      header.push(name);
      sec.labels.push(label);
    });
  });
  const table = title.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/gu, '') || '記録';
  const fence = ['```yaml form', `title: ${yq(title)}`, `table: ${table}`, 'fields:', ...out, '```'].join('\n');
  return { title, fence, table, header, sections, fields: count };
}

function formBody(entryTitle: string, templateName: string, f: ConvertedForm): string {
  const lines = [
    `# ${entryTitle}`,
    '',
    `旧版 PKC のテンプレート「${templateName}」から取り込んだ入力欄です。下の入力欄に入れて「表に追加」を押すと、その下の表に 1 行たまります。`,
    '',
  ];
  const named = f.sections.filter((s) => s.name !== '' && s.labels.length > 0);
  if (named.length > 0) {
    lines.push('## 項目の区分', '');
    for (const s of named) lines.push(`- ${s.name}: ${s.labels.join('、')}`);
    lines.push('');
  }
  lines.push(f.fence, '', `## ${f.table}`, '', `\`\`\`csv name=${f.table}`, f.header.join(','), '```', '');
  return lines.join('\n');
}

function textlogBody(
  entryTitle: string,
  linesRaw: YamlValue | undefined,
  now: Date,
  ignored: string[],
): string {
  if (linesRaw === undefined || linesRaw === null) return '';
  if (!Array.isArray(linesRaw)) {
    ignored.push(`template.yaml の entries「${entryTitle}」の lines(並びではないため取り込みません)`);
    return '';
  }
  const stamp = formatHeadingTimestamp(now.toISOString());
  const parts: string[] = [];
  linesRaw.forEach((l, i) => {
    const at = `template.yaml の entries「${entryTitle}」の lines[${String(i)}]`;
    let body: string;
    let flag = 'none';
    if (isObj(l)) {
      body = str(l.body);
      flag = (str(l.flag) || 'none').toLowerCase();
      for (const k of Object.keys(l)) if (k !== 'body' && k !== 'flag') ignored.push(`${at} のキー「${k}」(未知のキー)`);
    } else body = str(l);
    const star = flag === 'important' || flag === 'red';
    if (!star && flag !== 'none') ignored.push(`${at} の flag「${flag}」(未対応のフラグ。行は取り込み、★ は付けません)`);
    parts.push(`## ${stamp}${star ? ' ★' : ''}${body === '' ? '' : `\n\n${body}`}`);
  });
  return parts.join('\n\n');
}

/** テンプレートを変換する。誤りは {@link TemplateImportError}(**1 件も作らずに**断る)。 */
export function convertTemplate(src: TemplateSource, opts: TemplateOptions): TemplateResult {
  const ignored: string[] = [];
  const renamed: string[] = [];
  const t = readYaml(src.template, 'template.yaml');
  if (!isObj(t)) throw new TemplateImportError('template.yaml の形が違います(キーと値の並びではありません)');
  const meta = isObj(t.meta) ? t.meta : {};
  const name = str(meta.name) || str(t.template_name) || 'テンプレート';
  const TOP = ['meta', 'folders', 'entries', 'schema_version', 'template_id', 'template_name', 'template_version', 'description'];
  for (const k of Object.keys(t)) if (!TOP.includes(k)) ignored.push(`template.yaml のキー「${k}」(未知のキー)`);
  const identKeys = ['id', 'version', 'pkc_min_version', 'author', 'description'].filter((k) => k in meta);
  const topIdent = ['schema_version', 'template_id', 'template_name', 'template_version', 'description'].filter((k) => k in t);
  if (identKeys.length + topIdent.length > 0) {
    ignored.push(
      `template.yaml の識別情報(${[...identKeys.map((k) => `meta.${k}`), ...topIdent].join('・')})は記録しません`,
    );
  }
  if ('trust_level' in meta) ignored.push(`template.yaml の meta.trust_level(${str(meta.trust_level)})は取り込みません`);
  if ('required_capabilities' in meta) {
    const rc = Array.isArray(meta.required_capabilities) ? meta.required_capabilities.map((x) => str(x)).join('・') : str(meta.required_capabilities);
    ignored.push(`template.yaml の meta.required_capabilities(${rc})は取り込みません`);
  }
  for (const k of Object.keys(meta)) {
    if (!['id', 'name', 'version', 'pkc_min_version', 'description', 'author', 'trust_level', 'required_capabilities'].includes(k)) {
      ignored.push(`template.yaml の meta.${k}(未知のキー)`);
    }
  }

  // 他のファイル(assets / snippets / その他)── 実行も取り込みもしない
  const group = (prefix: string): string[] => src.otherFiles.filter((n) => n.startsWith(prefix));
  const assets = group('assets/');
  const snippets = group('snippets/');
  const rest = src.otherFiles.filter((n) => !n.startsWith('assets/') && !n.startsWith('snippets/'));
  if (assets.length > 0) ignored.push(`assets/ のファイル ${String(assets.length)} 個(${assets.map((n) => n.slice(7)).join('・')})は取り込みません`);
  if (snippets.length > 0) ignored.push(`snippets/ のファイル ${String(snippets.length)} 個(${snippets.map((n) => n.slice(9)).join('・')})は取り込みません`);
  if (rest.length > 0) ignored.push(`その他のファイル ${String(rest.length)} 個(${rest.slice(0, 5).join('・')}${rest.length > 5 ? ' ほか' : ''})は取り込みません`);

  const foldersRaw = t.folders === undefined || t.folders === null ? [] : t.folders;
  const entriesRaw = t.entries;
  if (!Array.isArray(foldersRaw)) throw new TemplateImportError('template.yaml の folders が並びではありません');
  if (!Array.isArray(entriesRaw)) throw new TemplateImportError('template.yaml に entries(ノートの並び)がありません');
  if (foldersRaw.length > TEMPLATE_MAX_FOLDERS) throw new TemplateImportError(`フォルダが多すぎます(${String(TEMPLATE_MAX_FOLDERS)} 個まで)`);
  if (entriesRaw.length > TEMPLATE_MAX_ENTRIES) throw new TemplateImportError(`ノートが多すぎます(${String(TEMPLATE_MAX_ENTRIES)} 個まで)`);
  if (src.forms.size > TEMPLATE_MAX_FORMS) throw new TemplateImportError(`forms/ のファイルが多すぎます(${String(TEMPLATE_MAX_FORMS)} 個まで)`);

  // forms/*.yaml は先に全部読む(1 つでも壊れていたら何も作らない)
  const formById = new Map<string, { file: string; y: YamlValue }>();
  for (const [file, text] of src.forms) {
    const y = readYaml(text, `forms/${file}`);
    const id = isObj(y) && str(y.form_id) !== '' ? str(y.form_id) : file.replace(/\.ya?ml$/iu, '');
    if (!formById.has(id)) formById.set(id, { file, y });
  }

  const notes: TemplateNote[] = [];
  const relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }> = [];
  const folderLid = new Map<string, string>();
  foldersRaw.forEach((f, i) => {
    if (!isObj(f)) {
      ignored.push(`template.yaml の folders[${String(i)}](形が違うため読み飛ばし)`);
      return;
    }
    for (const k of Object.keys(f)) if (k !== 'id' && k !== 'name') ignored.push(`template.yaml の folders[${String(i)}] のキー「${k}」(未知のキー)`);
    const id = str(f.id);
    if (id === '') {
      ignored.push(`template.yaml の folders[${String(i)}](id が無いため読み飛ばし)`);
      return;
    }
    if (folderLid.has(id)) throw new TemplateImportError(`template.yaml のフォルダ id「${id}」が重なっています`);
    const lid = opts.genLid();
    folderLid.set(id, lid);
    notes.push({ lid, title: str(f.name) || id, archetype: 'folder', body: '', parent: null });
  });
  const folderCount = notes.length;

  const used = new Set<string>();
  let forms = 0;
  let textlogs = 0;
  let texts = 0;
  let fields = 0;
  entriesRaw.forEach((e, i) => {
    if (!isObj(e)) {
      ignored.push(`template.yaml の entries[${String(i)}](形が違うため読み飛ばし)`);
      return;
    }
    const type = str(e.type);
    const title = str(e.title) || '無題';
    if (str(e.title) === '') ignored.push(`template.yaml の entries[${String(i)}](title が無いため「無題」にしました)`);
    const at = `template.yaml の entries「${title}」`;
    if (type !== 'form' && type !== 'textlog' && type !== 'text') {
      ignored.push(`${at}の type「${type}」(未対応の種類のためノートは作りません)`);
      return;
    }
    const known = type === 'form' ? ['type', 'title', 'folder', 'form'] : type === 'textlog' ? ['type', 'title', 'folder', 'lines'] : ['type', 'title', 'folder', 'body'];
    for (const k of Object.keys(e)) if (!known.includes(k)) ignored.push(`${at}のキー「${k}」(未知のキー)`);
    let parent: string | null = null;
    const fid = str(e.folder);
    if (fid !== '') {
      parent = folderLid.get(fid) ?? null;
      if (parent === null) ignored.push(`${at}の folder「${fid}」(定義に無いフォルダ。いちばん上に置きました)`);
    }
    let body: string;
    let archetype: 'text' | 'textlog';
    if (type === 'form') {
      const id = str(e.form);
      const hit = formById.get(id);
      if (hit === undefined) {
        ignored.push(`${at}の form「${id}」(forms/ に定義が無いためノートは作りません)`);
        return;
      }
      used.add(id);
      const cf = convertForm(hit.file, hit.y, ignored, renamed);
      const errs = parseFormDef(cf.fence.split('\n').slice(1, -1).join('\n')).errors;
      for (const er of errs) ignored.push(`forms/${hit.file} の変換結果: ${er}`);
      fields += cf.fields;
      forms += 1;
      body = formBody(title, name, cf);
      archetype = 'text';
    } else if (type === 'textlog') {
      body = textlogBody(title, e.lines, opts.now, ignored);
      archetype = 'textlog';
      textlogs += 1;
    } else {
      body = e.body === undefined || e.body === null ? '' : str(e.body);
      archetype = 'text';
      texts += 1;
    }
    notes.push({ lid: opts.genLid(), title, archetype, body, parent });
  });
  for (const [id, h] of formById) {
    if (!used.has(id)) ignored.push(`forms/${h.file}(どのノートからも使われていないため取り込みません)`);
  }
  for (const n of notes) {
    if (n.parent !== null) relations.push({ id: opts.genRelationId(), fromLid: n.parent, toLid: n.lid, kind: 'structural' });
  }
  return {
    notes,
    relations,
    name,
    counts: { folders: folderCount, notes: notes.length - folderCount, forms, textlogs, texts, fields },
    renamed,
    ignored,
  };
}
