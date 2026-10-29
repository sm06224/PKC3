/**
 * 🔴 **PKC3 のノートを、PKC2 の「持ち運べる単一 HTML」の中身(container)にする**(台帳 #1416。user 指示 2026-10-07
 * 「PKC2 のポータブル形式のインポートエクスポートを追加。ノートもいじれる単一 HTML での出力と入力」)。
 *
 * ## 経緯(「PKC3 の書き出しは PKC2 に取り込まない = 一方通行」との関係)
 *
 * 2026-07-30 の裁定は「PKC3 のエクスポートは PKC2 にインポートしません」だった。2026-10-07 の user 指示は
 * **PKC2 のポータブル形式の出力と入力**を明示的に求めている(入力は #1552 で入った)── 新しい指示が前の一般方針に
 * 優先するので、出力を足す。⚠ **PKC2 は参照のみ**: ここは PKC2 の公開された仕様(`docs/spec/body-formats.md` /
 * `data-model.md`)の**形に合わせて**、PKC3 の側で書いた変換である(PKC2 のコードは 1 行も持ち込んでいない)。
 *
 * ## 何が落ちる / 変わるか(黙って落とさない ── `warnings` で言う)
 *
 * | PKC3 | PKC2 | |
 * |---|---|---|
 * | ノート(`text`)/ フォルダ | そのまま(本文は原文のまま。前書き `---` は本文に残る) | 前書きの `tags:` は PKC2 のタグにも写す |
 * | ログ(`textlog`) | JSON のログ(`## 日時` の節 1 つ = ログ 1 件) | 日時が読めない前置きは 1 件目の本文 |
 * | ToDo(`todo`)/ フォーム(`form`) | JSON | 前書きの他のキーは落ちる(言う) |
 * | 添付(`attachment`) | JSON + 添付の bytes(base64) | |
 * | 表・スタック・スマートフォルダ・雛形 など PKC3 独自 | **ノート(`text`)**として本文を出す | 件数を言う |
 * | `:::` のブロック・板・本文の `@日付` など | PKC2 には無い記法 | **字のまま**出る(言う) |
 * | 履歴 | 出さない(現在の版だけ) | 言う |
 *
 * 🔑 pure module。DOM も DB も知らない(ブラウザの部分は `adapter/ui/actions/export-pkc2-html.ts`)。
 */
import { parseFrontmatter } from '../markdown/frontmatter';
import { storedInstantIso } from '../datetime/stored-date';
import { escapeForScriptData } from './pkc3-html';
import { readTags } from '../flavor/tags';
import { logDayOfHeading } from '../textlog/log-days';
import { UNDATED_LOG_HEADING } from '../flavor/textlog-flavor';

/** 書き出す 1 件(源 = `ArchiveSource` の `listEntryMetas` + 本文)。 */
export interface Pkc2ExportEntry {
  lid: string;
  title: string;
  archetype: string;
  body: string;
  entryOrder: number;
  /** `YYYY-MM-DD HH:MM:SS`(UTC)か ISO。無ければ書き出す時刻。 */
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Pkc2ExportRelation {
  id: string;
  fromLid: string;
  toLid: string;
  kind: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Pkc2ExportInput {
  title: string;
  /** コンテナの id(PKC2 の `meta.container_id`)。 */
  containerId: string;
  entries: readonly Pkc2ExportEntry[];
  relations: readonly Pkc2ExportRelation[];
  /** 添付の key → 種類(MIME)。key は PKC3 の添付 key。 */
  assets: ReadonlyMap<string, { mime: string; size: number | null }>;
  /** 書き出す時刻。⚠ `new Date()` を読まない(呼び側が渡す)。 */
  now: Date;
  /** PKC2 の `meta.schema_version`(元の HTML の `data-pkc-schema`)。読めなければ 1。 */
  schemaVersion: number;
}

/** PKC2 の Entry(必要な field)。 */
export interface Pkc2Entry {
  lid: string;
  title: string;
  body: string;
  archetype: 'text' | 'textlog' | 'todo' | 'form' | 'attachment' | 'folder' | 'generic' | 'opaque';
  created_at: string;
  updated_at: string;
  tags?: string[];
}

export interface Pkc2Relation {
  id: string;
  from: string;
  to: string;
  kind: 'structural' | 'categorical' | 'semantic' | 'temporal' | 'provenance';
  created_at: string;
  updated_at: string;
}

export interface Pkc2ContainerOut {
  meta: {
    container_id: string;
    title: string;
    created_at: string;
    updated_at: string;
    schema_version: number;
    entry_order: string[];
  };
  entries: Pkc2Entry[];
  relations: Pkc2Relation[];
  revisions: never[];
}

export interface Pkc2ExportPlan {
  container: Pkc2ContainerOut;
  /** PKC3 の添付 key → PKC2 の添付 key。PKC2 の許す字(`[A-Za-z0-9_-]`)でない key だけ付け替える。 */
  assetKeys: Map<string, string>;
  warnings: string[];
}

const PKC2_ASSET_KEY = /^[A-Za-z0-9_-]+$/;
const PKC2_RELATION_KINDS: ReadonlySet<string> = new Set(['structural', 'categorical', 'semantic', 'temporal', 'provenance']);
/** PKC3 で `getFlavor` が持つ型のうち、PKC2 にそのまま対応する物。 */
const NATIVE = new Set(['text', 'textlog', 'todo', 'form', 'attachment', 'folder', 'generic', 'opaque']);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 保存された時刻(`YYYY-MM-DD HH:MM:SS` UTC / ISO)→ ISO。読めなければ `fallback`。 */
export function toIsoStamp(value: string | null, fallback: string): string {
  if (value === null || value === '') return fallback;
  // 🔑 日時の読みは `stored-date.ts` の 1 本(時差の印が無い値は UTC)── ここで日付の切り方を持たない
  const iso = storedInstantIso(value.trim());
  if (iso !== null) return iso;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** ログの見出し(`2026-10-10 12:30:05 ★`)→ ISO(端末のローカル時刻として読む ── 見出しはローカル時刻で書かれている)。 */
function logHeadingToIso(text: string): { iso: string; important: boolean } | null {
  // 🔑 日の読みは `logDayOfHeading` 1 本(実在する日だけ)。ここが読むのは時刻の部分だけ
  const day = logDayOfHeading(text);
  if (day === null) return null;
  const t = /[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
  if (t === null) return null;
  const [y, mo, da] = day.split('-').map(Number) as [number, number, number];
  const d = new Date(y, mo - 1, da, Number(t[1]), Number(t[2]), Number(t[3] ?? '0'));
  if (Number.isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), important: /★\s*$/u.test(text) };
}

export interface LogRow {
  id: string;
  text: string;
  createdAt: string;
  flags: string[];
}

/**
 * ログ(`## 日時` の節)の本文を、PKC2 のログの並びにする。
 *
 * - 見出しの段は 2、字は `logDayOfHeading` が日付と読めるもの(または `(日時なし)`)。それ以外の `##` は本文のまま。
 * - fence の中の `##` は見出しではない。
 * - 最初の日時見出しより前の字は、1 件目のログ(日時は `fallbackIso`)にする ── 捨てない。
 */
export function markdownToLogRows(body: string, fallbackIso: string): LogRow[] {
  const lines = body.split(/\r\n|\r|\n/);
  const rows: Array<{ heading: { iso: string; important: boolean } | null; lines: string[] }> = [];
  let cur: { heading: { iso: string; important: boolean } | null; lines: string[] } = { heading: null, lines: [] };
  let fence: { ch: string; len: number } | null = null;
  const startRow = (heading: { iso: string; important: boolean }): void => {
    rows.push(cur);
    cur = { heading, lines: [] };
  };
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f !== null) {
      const ch = f[1]![0]!;
      const len = f[1]!.length;
      if (fence === null) fence = { ch, len };
      else if (fence.ch === ch && len >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
    }
    if (fence === null) {
      const h = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
      if (h !== null) {
        const text = h[1]!;
        if (text.startsWith(UNDATED_LOG_HEADING)) {
          startRow({ iso: fallbackIso, important: /★\s*$/u.test(text) });
          continue;
        }
        if (logDayOfHeading(text) !== null) {
          const at = logHeadingToIso(text);
          if (at !== null) {
            startRow(at);
            continue;
          }
        }
      }
    }
    cur.lines.push(line);
  }
  rows.push(cur);
  const out: LogRow[] = [];
  for (const r of rows) {
    const text = r.lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (r.heading === null && text === '') continue;
    const createdAt = r.heading?.iso ?? fallbackIso;
    out.push({
      id: `log-${Date.parse(createdAt) || 0}-${out.length}`,
      text,
      createdAt,
      flags: r.heading?.important === true ? ['important'] : [],
    });
  }
  return out;
}

/** 前書きのうち、PKC2 の型が受け取った key。それ以外は落ちるので言う。 */
const CONSUMED: Readonly<Record<string, ReadonlySet<string>>> = {
  todo: new Set(['status', 'date', 'archived']),
  form: new Set(['form.name', 'form.checked']),
  attachment: new Set(['attachment.name', 'attachment.mime', 'attachment.size', 'attachment.asset_key']),
  textlog: new Set([]),
};

/** 添付の key を PKC2 の許す字だけにする(衝突しない付け替え)。 */
function safeAssetKeys(source: Iterable<string>): Map<string, string> {
  // ⚠ 2 度走査するので配列にする(`Map.keys()` の反復子は 1 度で尽きる)
  const keys = [...source];
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const k of keys) if (PKC2_ASSET_KEY.test(k)) used.add(k);
  let n = 0;
  for (const k of keys) {
    if (PKC2_ASSET_KEY.test(k)) {
      out.set(k, k);
      continue;
    }
    let next = `pkc3-${++n}`;
    while (used.has(next)) next = `pkc3-${++n}`;
    used.add(next);
    out.set(k, next);
  }
  return out;
}

export function planPkc2Container(input: Pkc2ExportInput): Pkc2ExportPlan {
  const nowIso = input.now.toISOString();
  const warnings: string[] = [];
  const assetKeys = safeAssetKeys(input.assets.keys());
  const lidSet = new Set(input.entries.map((e) => e.lid));
  let converted = 0;
  let droppedFm = 0;
  let unparsedLogs = 0;
  const entries: Pkc2Entry[] = [];

  for (const e of [...input.entries].sort((a, b) => a.entryOrder - b.entryOrder)) {
    const createdAt = toIsoStamp(e.createdAt, nowIso);
    const updatedAt = toIsoStamp(e.updatedAt, createdAt);
    const native = NATIVE.has(e.archetype);
    const archetype = (native ? e.archetype : 'text') as Pkc2Entry['archetype'];
    if (!native) converted += 1;
    const fm = parseFrontmatter(e.body);
    const consumed = CONSUMED[e.archetype];
    if (consumed !== undefined && fm.found) {
      for (const k of Object.keys(fm.meta)) {
        if (!consumed.has(k) && k !== 'tags') {
          droppedFm += 1;
          break;
        }
      }
    }
    let body = e.body;
    switch (e.archetype) {
      case 'textlog': {
        const rows = markdownToLogRows(fm.found ? fm.body : e.body, createdAt);
        if (rows.length === 0) unparsedLogs += 1;
        body = JSON.stringify({ entries: rows });
        break;
      }
      case 'todo': {
        const status = fm.meta['status'] === 'done' ? 'done' : 'open';
        const date = typeof fm.meta['date'] === 'string' ? fm.meta['date'] : '';
        const todo: Record<string, unknown> = { status, description: fm.found ? fm.body.replace(/^\n/, '') : e.body };
        if (date !== '') todo['date'] = date;
        if (fm.meta['archived'] === true) todo['archived'] = true;
        body = JSON.stringify(todo);
        break;
      }
      case 'form': {
        body = JSON.stringify({
          name: typeof fm.meta['form.name'] === 'string' ? fm.meta['form.name'] : '',
          note: fm.found ? fm.body.replace(/^\n/, '') : e.body,
          checked: fm.meta['form.checked'] === true,
        });
        break;
      }
      case 'attachment': {
        const name = typeof fm.meta['attachment.name'] === 'string' ? fm.meta['attachment.name'] : e.title;
        const mime =
          typeof fm.meta['attachment.mime'] === 'string' ? fm.meta['attachment.mime'] : 'application/octet-stream';
        const key = typeof fm.meta['attachment.asset_key'] === 'string' ? fm.meta['attachment.asset_key'] : null;
        const att: Record<string, unknown> = { name, mime };
        const size =
          typeof fm.meta['attachment.size'] === 'number'
            ? fm.meta['attachment.size']
            : key !== null
              ? (input.assets.get(key)?.size ?? null)
              : null;
        if (size !== null) att['size'] = size;
        if (key !== null && assetKeys.has(key)) att['asset_key'] = assetKeys.get(key);
        body = JSON.stringify(att);
        break;
      }
      default:
        break;
    }
    // 本文の `asset:<key>` を付け替えた key へ(PKC2 の許す字でない key があったときだけ)
    if (archetype === 'text' || archetype === 'folder' || archetype === 'todo' || archetype === 'form' || archetype === 'textlog') {
      for (const [from, to] of assetKeys) {
        if (from !== to && body.includes(from)) body = body.split(`asset:${from}`).join(`asset:${to}`);
      }
    }
    const out: Pkc2Entry = { lid: e.lid, title: e.title, body, archetype, created_at: createdAt, updated_at: updatedAt };
    if (archetype === 'text' || archetype === 'folder' || archetype === 'textlog' || archetype === 'todo') {
      const tags = readTags(e.body);
      if (tags.length > 0) out.tags = tags;
    }
    entries.push(out);
  }

  const relations: Pkc2Relation[] = [];
  let droppedRel = 0;
  for (const r of input.relations) {
    if (!lidSet.has(r.fromLid) || !lidSet.has(r.toLid) || !PKC2_RELATION_KINDS.has(r.kind)) {
      droppedRel += 1;
      continue;
    }
    const createdAt = toIsoStamp(r.createdAt, nowIso);
    relations.push({
      id: r.id,
      from: r.fromLid,
      to: r.toLid,
      kind: r.kind as Pkc2Relation['kind'],
      created_at: createdAt,
      updated_at: toIsoStamp(r.updatedAt, createdAt),
    });
  }

  if (converted > 0) warnings.push(`PKC3 独自の種類(表・スタック・スマートフォルダなど)の ${converted} 件は、PKC2 ではノートとして出ます`);
  if (droppedFm > 0) warnings.push(`${droppedFm} 件の前書き(ToDo・フォーム・ログ・添付の設定)のうち PKC2 に無い項目は渡せませんでした`);
  if (unparsedLogs > 0) warnings.push(`ログ ${unparsedLogs} 件は中身が空のため、PKC2 でも空のログになります`);
  if (droppedRel > 0) warnings.push(`PKC2 に渡せないつながり ${droppedRel} 件は出していません`);
  warnings.push('PKC3 のブロック(:::)・板・本文の @日付 など、PKC2 に無い記法は字のまま出ます。履歴は出していません(現在の版だけ)');

  return {
    container: {
      meta: {
        container_id: input.containerId,
        title: input.title,
        created_at: nowIso,
        updated_at: nowIso,
        schema_version: Number.isFinite(input.schemaVersion) ? input.schemaVersion : 1,
        entry_order: entries.map((x) => x.lid),
      },
      entries,
      relations,
      revisions: [],
    },
    assetKeys,
    warnings,
  };
}

const ASSETS_TOKEN = '__PKC3_PKC2_ASSETS_SPLIT_POINT__';

/**
 * `#pkc-data` の JSON を、部品の並び(結合すると JSON)にする。
 *
 * 🔴 **添付の base64 は 1 件ずつ Blob にして、部品には Blob だけを積む**(巨大な base64 を文字列のまま溜めない ──
 *   呼び側が 1 件渡すたびに文字列は捨てられる)。骨組みの JSON だけが文字列で、`escapeForScriptData`(`<` を全部退避 ──
 *   `<!--` + `<script` の並びで script data が閉じなくなるのを防ぐ。PKC3 入り HTML と同じ 1 関数)を通す。
 *   添付の base64 は `[A-Za-z0-9+/=]` だけで `<` を含まない。
 *
 * @param assets 1 件 = `{ key(PKC2 の key), base64 }` を返す非同期の並び
 */
export async function pkc2DataParts(
  container: Pkc2ContainerOut,
  assets: AsyncIterable<{ key: string; base64: string }>,
): Promise<Array<string | Blob>> {
  const skeleton = JSON.stringify(
    { container: { ...container, assets: ASSETS_TOKEN }, export_meta: { mode: 'full', mutability: 'editable' } },
    null,
    2,
  );
  const token = `"${ASSETS_TOKEN}"`;
  const at = skeleton.indexOf(token);
  const parts: Array<string | Blob> = [escapeForScriptData(skeleton.slice(0, at)), '{'];
  let first = true;
  for await (const a of assets) {
    // key は JSON 文字列(`<` を含みうる)── 骨組みと同じ関数を通す。base64 は escape が要らない
    parts.push(new Blob([escapeForScriptData(`${first ? '' : ','}\n      ${JSON.stringify(a.key)}: "`), a.base64, '"']));
    first = false;
  }
  parts.push(first ? '}' : '\n    }');
  parts.push(escapeForScriptData(skeleton.slice(at + token.length)));
  return parts;
}

export class Pkc2ShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pkc2ShellError';
  }
}

/** 元にする PKC2 の HTML を、`#pkc-data` の前・後ろに割る。⚠ DOM に通さない(数 MB を 2 度作らない)。 */
export function splitPkc2Shell(html: string): { before: string; after: string } {
  const open = /<script\b[^>]*\bid\s*=\s*["']pkc-data["'][^>]*>/i.exec(html);
  if (open === null || !/<script\b[^>]*\bid\s*=\s*["']pkc-meta["']/i.test(html)) {
    throw new Pkc2ShellError('PKC2 の HTML ではないようです(PKC2 の書き出し、または配布の pkc2.html を選んでください)');
  }
  const from = open.index + open[0].length;
  const end = html.indexOf('</script>', from);
  if (end < 0) throw new Pkc2ShellError('PKC2 の HTML の中身が欠けています(データの終わりが見つかりません)');
  return { before: html.slice(0, from), after: html.slice(end) };
}

/** 元の HTML の `data-pkc-schema`(無ければ 1)。 */
export function shellSchemaVersion(html: string): number {
  const m = /data-pkc-schema\s*=\s*["'](\d+)["']/i.exec(html.slice(0, 4000));
  return m === null ? 1 : Number(m[1]);
}

/** 書き出すファイル名(`pkc2-<題名>-<日付>.html`。PKC2 の書き出しと同じ形)。 */
export function pkc2HtmlFileName(title: string, now: Date): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pkc2';
  return `pkc2-${slug}-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}.html`;
}
