/**
 * P6d 段④: md ZIP(`.md.zip`)── **PKC3 を捨てても読める形で外に出す**。
 *
 * 1 entry = 1 `.md`、添付は `assets/<key>.<ext>`。本文中の `asset:<key>` は
 * **相対パスへ書き換える**ので、展開したフォルダをそのまま任意の markdown
 * ビューアで開ける ── ここが「外に出す」の意味であって、書き換えないと
 * PKC3 の外では画像が 1 枚も出ない。
 *
 * ⚠ **片道**。frontmatter に居場所の無いもの(relations / revisions)は落ちる。
 * PKC2 は落ちたことを user に言わずに出していた ── PKC3 は
 * **manifest に刻み、書出し後に画面で言う**(設計 doc §3-2)。
 *
 * ## 履歴の「落ちた件数」を数えない理由
 * revision の**本数**を数えるには entry ごとに `listRevisionMetas` を呼ぶしかなく、
 * 5000 件のノートで 5000 往復する ── **数字 1 個のために**。`listRevisionLids`
 * は 1 往復で済むので、**履歴を持つノートの件数**で言う。
 * 「N 本の履歴」ではなく「N 件のノートの履歴」と言えば嘘にならない。
 */
import { parseFrontmatter, serializeFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { ZipWriter } from './zip-writer';
import type { ArchiveSource } from './pkc3-archive';

export const MD_FORMAT = 'pkc3-markdown';
export const MD_VERSION = 1;
const BODY_BATCH_BYTES = 4 * 1024 * 1024;
const ASSET_DIR = 'assets/';
/** 閲覧側・可搬 HTML と**同じ**書式(食い違うと片方だけ見える)。 */
const ASSET_REF_RE = /asset:([A-Za-z0-9_.-]+)/g;

export interface MarkdownZipResult {
  blob: Blob;
  warnings: string[];
  counts: { entries: number; assets: number };
  /** 片道で落ちたもの。**manifest と同じ数字**を UI へ渡す。 */
  dropped: { relations: number; revisionEntries: number };
}

/**
 * mime → 拡張子。⚠ **付けないと外で開けない**(OS はほぼ拡張子で判定する)。
 * 知らない mime は `.bin` ── 嘘の拡張子を付けるより開けない方がまし。
 */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function extForMime(mime: string | null): string {
  if (!mime) return 'bin';
  return EXT_BY_MIME[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
}

/** Windows が**ファイル名として使えない**予約語(拡張子を付けても駄目)。 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 題名 → ファイル名。**CJK は残す**(実データの題名はほぼ日本語で、
 * ローマ字化すると user が自分のノートを見つけられない)。
 */
export function slugForTitle(title: string): string {
  // ⚠ 制御文字は正規表現に書かない(no-control-regex。範囲を読み違えやすく、
  // PKC2 では生バイトがファイル名に入っていた)
  const cleaned = [...title]
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch === '\u007f' ? '-' : ch))
    .join('');
  const s = cleaned
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-.\s]+|[-.\s]+$/g, '');
  // ⚠ `slice` はサロゲートペアを割る(絵文字や一部の漢字が壊れる)
  const capped = [...s].slice(0, 60).join('').replace(/[-.\s]+$/, '');
  if (capped === '') return 'untitled';
  // `CON.md` は Windows で作れない ── 展開できない ZIP を作らない
  return RESERVED.has(capped.toLowerCase()) ? `${capped}-` : capped;
}

/** 衝突したら `-2` を**拡張子の直前**に挿す(PKC2 と同じ規則 = user の目に馴染む)。 */
function uniqueName(base: string, ext: string, taken: Set<string>): string {
  let name = `${base}.${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.${ext}`;
  taken.add(name);
  return name;
}

/** PKC3 側が正とするメタ(最小)。⚠ 順序が `.md` の見た目になるので固定する。 */
function pkc3Meta(m: {
  title: string;
  archetype: string;
  created_at: string | null;
  updated_at: string | null;
}): Record<string, FrontmatterValue> {
  const meta: Record<string, FrontmatterValue> = { title: m.title, archetype: m.archetype };
  if (m.created_at) meta['created_at'] = m.created_at;
  if (m.updated_at) meta['updated_at'] = m.updated_at;
  return meta;
}

/**
 * md ZIP を書く。
 * @throws entry 0 件のときは**断る**(「書き出したつもりで空」を作らない)
 */
export async function writeMarkdownZip(
  src: ArchiveSource,
  exportedAt: string,
): Promise<MarkdownZipResult> {
  const warnings: string[] = [];
  const metas = await src.listEntryMetas();
  // ⚠ 断るなら読み出しの前に断る(捨てるためだけに store を舐めない)
  if (metas.length === 0) throw new Error('書き出せる entry が 1 件もありません');
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  // 添付の拡張子は**本文を書く前に**要る(参照を相対パスへ書き換えるため)
  const assetMetas = await src.listAssetMetas();
  const pathOf = new Map(assetMetas.map((a) => [a.key, `${ASSET_DIR}${a.key}.${extForMime(a.mime)}`]));

  const w = new ZipWriter();
  const taken = new Set<string>();
  const used = new Set<string>();
  let entryCount = 0;
  let after: { entryOrder: number; lid: string } | undefined;

  for (;;) {
    const { rows, done, next } = await src.listBodies(after, BODY_BATCH_BYTES);
    for (const r of rows) {
      const m = metaOf.get(r.lid);
      if (!m) {
        warnings.push(`本文はあるが一覧に無い entry を飛ばしました: ${r.lid}`);
        continue;
      }
      const parsed = parseFrontmatter(r.body);
      // PKC3 が正とする値を後ろに置いて勝たせる(title / archetype は表が真)。
      // ⚠ 上書きで**値が変わる**ときは黙らない ── user が本文に書いた値が消える
      const own = parsed.meta;
      const mine = pkc3Meta(m);
      for (const [k, v] of Object.entries(mine)) {
        if (k in own && own[k] !== v) {
          warnings.push(`frontmatter の ${k} を entry の値で上書きしました: ${m.title || m.lid}`);
        }
      }
      const merged = { ...own, ...mine };

      // 🔑 `asset:<key>` → 相対パス。**ここを書き換えないと外では画像が出ない**
      ASSET_REF_RE.lastIndex = 0;
      const text = parsed.body.replace(ASSET_REF_RE, (whole, key: string) => {
        const p = pathOf.get(key);
        if (!p) return whole; // 知らない key は**そのまま**残す(黙って壊さない)
        used.add(key);
        return p;
      });

      // 添付 entry は body が frontmatter だけ ── 何も書かないと**空の .md** になる。
      // 外で開いて中身に辿り着けるよう、参照行を 1 本だけ足す
      const extra: string[] = [];
      for (const [k, v] of Object.entries(merged)) {
        if (!k.endsWith('asset_key') || typeof v !== 'string' || v === '') continue;
        const p = pathOf.get(v);
        if (!p) continue;
        used.add(v);
        const name = typeof merged[`${k.slice(0, -'asset_key'.length)}name`] === 'string'
          ? String(merged[`${k.slice(0, -'asset_key'.length)}name`])
          : m.title || v;
        const isImage = (assetMetas.find((a) => a.key === v)?.mime ?? '').startsWith('image/');
        if (!text.includes(p)) extra.push(`${isImage ? '!' : ''}[${name}](${p})`);
      }

      const name = uniqueName(slugForTitle(m.title), 'md', taken);
      const parts = [serializeFrontmatter(merged), '\n'];
      if (text !== '') parts.push(text.endsWith('\n') ? text : `${text}\n`);
      if (extra.length > 0) parts.push(`\n${extra.join('\n')}\n`);
      await w.add(name, parts);
      entryCount++;
    }
    if (done || !next) break;
    if (
      after !== undefined &&
      !(next.entryOrder > after.entryOrder ||
        (next.entryOrder === after.entryOrder && next.lid > after.lid))
    ) {
      throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
    }
    after = next;
  }

  if (entryCount === 0) throw new Error('書き出せる entry が 1 件もありません');

  // ── 添付: **参照されているものだけ**。中身は Blob をそのまま(コピーしない)
  const missing: string[] = [];
  let assetCount = 0;
  for (const a of assetMetas) {
    if (!used.has(a.key)) continue;
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      // 参照は本文に残したまま ── 壊れた参照を隠さない(P6c §4-A と同じ規約)
      missing.push(a.key);
      warnings.push(`添付の中身が見つかりませんでした: ${a.key}`);
      continue;
    }
    await w.add(pathOf.get(a.key)!, [blob]);
    assetCount++;
  }
  const skipped = assetMetas.length - used.size;
  if (skipped > 0) {
    warnings.push(`どの本文からも参照されていない添付 ${skipped} 件は含めませんでした`);
  }

  // ── 落ちるものを刻む(§3-2)
  const relations = (await src.listRelations()).length;
  const revisionEntries = (await src.listRevisionLids()).length;
  if (relations > 0) warnings.push(`関連 ${relations} 件は markdown に居場所が無いので落ちます`);
  if (revisionEntries > 0) {
    warnings.push(`履歴を持つノート ${revisionEntries} 件の履歴は落ちます`);
  }

  await w.add(
    'manifest.json',
    [
      JSON.stringify(
        {
          format: MD_FORMAT,
          version: MD_VERSION,
          exported_at: exportedAt,
          source_cid: src.cid,
          title: src.title,
          // 🔴 「戻せない」を**機械可読に**刻む。後から見分けられない形にしない
          reversible: false,
          note: 'PKC3 から外へ出すための片道形式です。関連・履歴は含まれません。',
          entry_count: entryCount,
          asset_count: assetCount,
          dropped: { relations, revision_entries: revisionEntries },
          missing_assets: missing,
        },
        null,
        2,
      ),
    ],
  );

  return {
    blob: w.finish(),
    warnings,
    counts: { entries: entryCount, assets: assetCount },
    dropped: { relations, revisionEntries },
  };
}
