/**
 * P6d 段②: アーカイブ ZIP(`.pkc3.zip`)── **バックアップ正本**。
 *
 * `manifest.json` + `container.json` + `assets/<key>`(生バイト)。
 * PKC3 の全形式のうち**これだけが可逆**で、これさえあれば全部戻る。
 *
 * 🔑 **writer と reader を対で置く**。PKC2 は別々に書いて食い違わせていたので、
 * 同じファイルに並べて round-trip test で縛る。
 * 🔴 **復元できないバックアップはバックアップではない** ── reader が無い writer は
 * 出荷しない。
 *
 * ## 常駐量(この段の芯)
 * - `container.json` を**丸ごと文字列にしない**。`{"entries":[` / 1 件 / `,` … と
 *   小さな部品として `ZipWriter` に積む
 * - 本文は `listBodies` で**バッチごと**に取り、そのバッチぶんだけを JSON にして
 *   捨てる ── 全 entry の body を同時に heap へ載せない
 * - asset は Blob をそのまま部品にする(コピーしない)
 *
 * ## PKC2 に読ませない(user 裁定 2026-07-30、一方通行)
 * `format` は `pkc3-archive` なので PKC2 の importer(`pkc2-*` 厳格一致)は
 * 自然に拒否する。**PKC2 の形に寄せる制約が無いので素直な形を選べる。**
 */
import { ZipWriter, type ZipPart } from './zip-writer';
import {
  readZipDirectory,
  readZipText,
  unwrapSingleTopDir,
  ZipReadError,
  type ReadableAssetSource,
} from '../import/zip-reader';
import { createWarnCollector, type WarnCollector } from './warn-cap';
import { isTooLargeToRead } from '../import/too-large';
import { relabeledInFileWarning, relabeledWarning } from '../import/relabel-warning';
import { archiveTooBigRefusal, MAX_EMBED_TEXT_CHARS, notImportableArchiveMessage } from '../storage/image-export-limit';
import { parseTagColorList, type TagColorEntry } from '../tag-color';
import { normalizePinLids } from '../relation/note-pins';
import { safeName } from './file-name';

export const ARCHIVE_FORMAT = 'pkc3-archive';
/**
 * 2: revisions を**保存形の鎖**で出す(P6e)。
 * 1: revisions が全文だが `kind` は保存形を書いていた ── **中身と食い違う**ので、
 *    読み側で `kind: 'full'` へ正規化して受ける(そうしないと復元が壊れる)。
 */
export const ARCHIVE_VERSION = 2;
/** 読める最古の版。 */
const ARCHIVE_MIN_VERSION = 1;
const MANIFEST = 'manifest.json';
const CONTAINER = 'container.json';
const ASSET_PREFIX = 'assets/';
/** 🔴 人が読める本文の置き場(#986。`readableNotes` を立てた書き出しだけが書く。読み込みは見ない)。 */
const NOTES_PREFIX = 'notes/';
/**
 * 🔴 **`notes/` を入れる本文の総量の上限(字数)**(#986)。
 * ⚠ 正直に書く: `notes/*.md` は本文を**もう 1 度** zip の部品(Blob)として持つので、zip が出来上がるまで
 *   本文の総量ぶんの Blob が**container.json の分とは別に**もう 1 組み残る(Blob は heap の外だが、メモリは倍になる)。
 *   壊れた保存領域の復旧は「まれに 1 回」でも、巨大なコレクションで倍にして落とすのは本末転倒なので、
 *   **総量が上限を超えたら notes/ を全部省き**、省いたことを注意で言う(取り込み(container.json)は無傷)。
 * 🔑 200M 字 ≒ 日本語で 600MB 弱。測った値ではなく「container.json の上限(`MAX_EMBED_TEXT_CHARS`)と同じ桁の目安」。
 * ⚠ ゴミ箱のノートは `notes/` に入れない: `notes/` は「いま生きているノートを読む」ための物で、ゴミ箱の物を混ぜると
 *   「消したはずのノートが生きているように見える」(取り込み側も `trash` を別に扱う)。
 */
export const READABLE_NOTES_MAX_CHARS = 200_000_000;
/** 1 バッチで取る本文の目安(postMessage に全量を載せない)。 */
const BODY_BATCH_BYTES = 4 * 1024 * 1024;

export interface ArchiveEntry {
  lid: string;
  title: string;
  archetype: string;
  createdAt: string | null;
  updatedAt: string | null;
  entryOrder: number;
  status: string | null;
  date: string | null;
  archived: boolean;
  body: string;
}

export interface ArchiveRelation {
  id: string;
  fromLid: string;
  toLid: string;
  kind: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 履歴は**鎖のまま**出す(全文へ展開しない ── N×M になり常駐設計が壊れる)。 */
export interface ArchiveRevision {
  id: string;
  entryLid: string;
  revOrder: number;
  createdAt: string | null;
  title: string | null;
  archetype: string | null;
  kind: string;
  snapshot: string;
  /**
   * 🔴 その版の**復元後の本文**のハッシュ(v2 で追加)。
   * 無いと「鎖が tip とズレていても行数さえ合えば通る」= 誤った履歴が静かに
   * 書かれ、書いた側が hash を計算し直すので**永久に自己証明される**。
   * v1 のアーカイブは持たない ── その場合は検査しない。
   * ⚠ **optional にしない**(review H-2)── optional だと writer が代入を
   * 落としても tsc が黙り、**全アーカイブで検査が無効化される**。実際そうなっていた。
   */
  contentHash: string | null;
}

export interface ArchiveAsset {
  key: string;
  mime: string;
  size: number;
  hash: string | null;
}

/**
 * 🔴 **ゴミ箱の中のノート**(台帳 #1852 束 F2 / 依頼 105-2・297 A)。`entries` には**混ぜない** ──
 * 旧い版は `entries` を全部「生きたノート」として取り込むので、混ぜるとゴミ箱の物が一覧に戻ってしまう。
 * 別の鍵(`trash`)に置けば、旧い版は知らないキーとして読み飛ばす(= 今までと同じ:ゴミ箱は入らない)。
 * 本文はゴミ箱へ移した時点の全文(`body`)。それより古い版は `trashRevisions`(保存形の鎖。head は含めない)。
 */
export interface ArchiveTrashNote {
  lid: string;
  title: string;
  archetype: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** ゴミ箱へ移す前の並びの位置(控えが無ければ null)。 */
  entryOrder: number | null;
  /** ゴミ箱へ移した日時。 */
  trashedAt: string | null;
  body: string;
}

/** 書出し元(store に直結せず、test から差せる形にする)。 */
export interface ArchiveSource {
  cid: string;
  title: string;
  /**
   * 🔴 **壊れたときに拾えた分だけ**の zip か(台帳 #1852 束 F2 / 依頼 119-4)。立てると `manifest.partial: true` を書く ──
   * ファイル名を変えても、取り込みの確認が「拾えた分だけ」と言える。⚠ 任意(旧い読み手は知らないキーを読み飛ばす)。
   */
  partial?: boolean;
  /**
   * 🔴 **zip を開けば中身が読める**ように、本文を `notes/<連番>-<題名>.md` としても同梱する(#986 の残り項目)。
   * ⚠ 任意。読み込み(`readArchive`)は `assets/` 以外を見ないので、同梱しても取り込みは変わらない。
   * 本文は 1 件ずつ Blob にして手放す(heap に溜めない)。
   */
  readableNotes?: boolean;
  listEntryMetas(): Promise<
    Array<{
      lid: string;
      title: string;
      archetype: string;
      created_at: string | null;
      updated_at: string | null;
      entry_order: number;
      status: string | null;
      date: string | null;
      archived: number;
    }>
  >;
  /**
   * 1 件だけ本文を引く(P6f)。**1 ノート書出しのため**にある ──
   * 無いと目的の lid に当たるまで全 body をページングで舐める(実測: 300 件 ×
   * 100KB の container で、対象の 300 倍の本文が worker 境界を越えた)。
   * ⚠ 任意 ── test の fake は `listBodies` だけでも動く
   */
  getBody?(lid: string): Promise<string | null>;
  /**
   * 🔴 **ゴミ箱のノートの頭**(台帳 #1852 束 F2 / 依頼 105-2・297 A)。⚠ 任意 ── 無い源(1 ノート / フォルダの書き出し)は
   * ゴミ箱を運ばない。本文と古い版は `getRevisionChain(lid)` で引く(頭の行 = ゴミ箱へ移した時点の全文)。
   */
  listTrashHeads?(): Promise<
    Array<{
      lid: string;
      title: string | null;
      archetype: string | null;
      created_at: string | null;
      updated_at: string | null;
      entry_order: number | null;
      trashed_at: string | null;
    }>
  >;
  listBodies(
    after: { entryOrder: number; lid: string } | undefined,
    maxBytes: number,
  ): Promise<{
    rows: Array<{ lid: string; body: string }>;
    done: boolean;
    next?: { entryOrder: number; lid: string };
  }>;
  listRelations(): Promise<
    Array<{
      id: string;
      from_lid: string;
      to_lid: string;
      kind: string;
      created_at: string | null;
      updated_at: string | null;
    }>
  >;
  listAssetMetas(): Promise<
    /** ⚠ `mime` / `size` は NULL がありうる ── 書出し時に正規化する。 */
    Array<{ key: string; mime: string | null; size: number | null; hash: string | null }>
  >;
  getAssetBlob(key: string): Promise<Blob | null>;
  /**
   * 🔴 **タグの色**(#1457)。⚠ 任意 ── 無い源(1 ノート / フォルダの書き出し・救出)は
   * 色を運ばない(部分の書き出しに、関係の無いタグの名前と色を混ぜない)。
   * 色は `container.json` の `tagColors` に入る。旧ビルドは知らないキーとして読み飛ばす。
   */
  listTagColors?(): Promise<TagColorEntry[]>;
  /**
   * 🔴 **ノートのピン留め**(#1377)。⚠ 任意 ── 無い源(部分の書き出し・救出)は運ばない。
   * 留めた順の lid が `container.json` の `notePins` に入る(書き出すノートに在るものだけ)。旧ビルドは知らないキーとして読み飛ばす。
   */
  listNotePins?(): Promise<string[]>;
  listRevisionLids(): Promise<string[]>;
  /**
   * 鎖を**保存形のまま**取り出す(P6e、新しい → 古い)。
   * ⚠ 版ごとに `getRevision` で全文へ復元してはいけない ── アーカイブが N×M に
   * 膨らみ(鎖の長さに対して O(k²))、しかも `kind` が中身と食い違う。
   */
  getRevisionChain(entryLid: string): Promise<
    Array<{
      revOrder: number;
      createdAt: string | null;
      title: string | null;
      archetype: string | null;
      kind: string;
      snapshot: string;
      contentHash: string | null;
    }>
  >;
}

export interface ArchiveResult {
  blob: Blob;
  warnings: string[];
  counts: { entries: number; relations: number; revisions: number; assets: number; trash: number };
}

/**
 * 🔑 **書き出し行 → アーカイブの形**への写し ── 書き出し(`writeArchive`)と、PKC3 入り HTML の取り込み
 * (`import-portable.ts`。zip を作らず直に `Pkc3Archive` を組む)が**同じ 1 つ**を通る。
 * 規則(null の正規化・field の名前)を 2 か所に持たない。
 */
type EntryMetaRowLike = Awaited<ReturnType<ArchiveSource['listEntryMetas']>>[number];
type RelationRowLike = Awaited<ReturnType<ArchiveSource['listRelations']>>[number];
type AssetMetaRowLike = Awaited<ReturnType<ArchiveSource['listAssetMetas']>>[number];
type RevisionRowLike = Awaited<ReturnType<ArchiveSource['getRevisionChain']>>[number];

export function toArchiveEntry(m: EntryMetaRowLike, body: string): ArchiveEntry {
  return {
    lid: m.lid,
    title: m.title,
    archetype: m.archetype,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    entryOrder: m.entry_order,
    status: m.status,
    date: m.date,
    archived: m.archived !== 0,
    body,
  };
}

export function toArchiveRelation(r: RelationRowLike): ArchiveRelation {
  return {
    id: r.id,
    fromLid: r.from_lid,
    toLid: r.to_lid,
    kind: r.kind,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toArchiveRevision(lid: string, rv: RevisionRowLike): ArchiveRevision {
  return {
    id: `${lid}#${rv.revOrder}`,
    entryLid: lid,
    revOrder: rv.revOrder,
    createdAt: rv.createdAt,
    title: rv.title,
    archetype: rv.archetype,
    kind: rv.kind,
    snapshot: rv.snapshot,
    // 🔴 復元側の噛み合わせ検査に使う ── **落とすと検査が丸ごと無効化される**
    contentHash: rv.contentHash,
  };
}

export function toArchiveAsset(a: AssetMetaRowLike): ArchiveAsset {
  return {
    key: a.key,
    // 読み手に「null かも」を持ち回らせない ── 書出しの時点で決める
    mime: a.mime ?? 'application/octet-stream',
    size: a.size ?? 0,
    hash: a.hash,
  };
}

type TrashHeadLike = NonNullable<Awaited<ReturnType<NonNullable<ArchiveSource['listTrashHeads']>>>>[number];

/**
 * 🔴 **ゴミ箱の頭 + 鎖 → アーカイブの形**(台帳 #1852 束 F2)。書き出し(`writeArchive`)と PKC3 入り HTML の取り込みが
 * **同じ 1 つ**を通る(規則を 2 か所に持たない)。鎖は新しい → 古い。頭の行(最も新しい行)が全文でなければ `null`
 * (本文が復元できない ── 呼び側が黙って落とさず注意に出す)。
 */
export function toArchiveTrash(
  h: TrashHeadLike,
  chain: readonly RevisionRowLike[],
): { note: ArchiveTrashNote; rows: ArchiveRevision[] } | null {
  const head = chain[0];
  if (head === undefined || head.kind !== 'full') return null;
  return {
    note: {
      lid: h.lid,
      title: h.title ?? head.title ?? '(無題)',
      archetype: h.archetype ?? head.archetype ?? 'text',
      createdAt: h.created_at,
      updatedAt: h.updated_at,
      entryOrder: h.entry_order,
      trashedAt: h.trashed_at ?? head.createdAt,
      body: head.snapshot,
    },
    rows: chain.slice(1).map((rv) => toArchiveRevision(h.lid, rv)),
  };
}

const j = (v: unknown): string => JSON.stringify(v);

/**
 * アーカイブ ZIP を書く。
 * @throws 0 件のときは**断る** ── 「書き出したつもりで空」を作らない
 */
export async function writeArchive(
  src: ArchiveSource,
  exportedAt: string,
  /** 試験用: 取り込み直すときに読める `container.json` の字数の上限(既定 = 実際の上限)。 */
  maxContainerChars: number = MAX_EMBED_TEXT_CHARS,
  /**
   * 🔴 取り込み直せない大きさだったときの扱い(台帳 #1852 束 F2 / 依頼 119-3 A)。既定 `'refuse'` = **書き出さずに断る**。
   * `'warn'` は保険の zip(拾い出し・作り直し)だけ ── 大きいコレクションの作り直しを大きさで止めない。
   */
  oversize: 'refuse' | 'warn' = 'refuse',
  /** 試験用: `notes/` を省く本文の総量(字数。既定 = `READABLE_NOTES_MAX_CHARS`)。 */
  readableMaxChars: number = READABLE_NOTES_MAX_CHARS,
): Promise<ArchiveResult> {
  const warnings: string[] = [];
  // 🔑 同種の注意は上限まで(規則は `warn-cap.ts` の 1 本 ── P8 段㉒)
  const warn = createWarnCollector(warnings);
  const metas = await src.listEntryMetas();
  // ⚠ 断るなら**読み出しの前**に断る。末尾の判定だけだと、0 件でも本文・履歴を
  // 舐めて全添付を ZIP に書いてから投げる ── 捨てるためだけの仕事(review L2)
  if (metas.length === 0) throw new Error('書き出せるノートが 1 件もありません');
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  // ── container.json を**部品として**積む(丸ごと文字列にしない)
  const parts: ZipPart[] = [`{"meta":${j({ cid: src.cid, title: src.title })},"entries":[`];
  let entryCount = 0;
  /** 実際に書いたノートの lid(下の relations / revisions を、書いたノートに絞るために持つ)。 */
  const exportedLids = new Set<string>();
  let blobChars = 0;
  /** 人が読める本文(`readableNotes` のとき)。⚠ Blob のまま持つ(文字列を溜めない)。 */
  let readable: Array<{ name: string; blob: Blob }> = [];
  let readableChars = 0;
  /** 総量が上限を超えて、notes/ を省くと決めた(以後は溜めない)。 */
  let readableDropped = false;
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const { rows, done, next } = await src.listBodies(after, BODY_BATCH_BYTES);
    // 🔴 **バッチぶんの JSON は 1 個の Blob にして手放す**(review M-3)。
    // 文字列のまま `parts` に積むと、`finish()` まで全 entry の本文が heap に
    // 残る ── 実測で「本文の総量ぶん(96MB)heap が線形に増える」ことが示された。
    // 「バッチごとに手放している」という当初の主張は**事実に反していた**。
    // Blob にすれば文字列は次の周回で回収でき、Blob 側は実体を heap に持たない
    let chunk = '';
    for (const r of rows) {
      const m = metaOf.get(r.lid);
      if (!m) {
        // 本文はあるが meta が無い = 書出し中に消えた ── 黙って落とさない
        warn.add('orphan-body', '一覧に無いノートの注意', `本文はあるが一覧に無いノートを飛ばしました: ${r.lid}`);
        continue;
      }
      const e = toArchiveEntry(m, r.body);
      chunk += entryCount === 0 ? j(e) : `,${j(e)}`;
      entryCount++;
      exportedLids.add(e.lid);
      if (src.readableNotes === true && !readableDropped) {
        readableChars += r.body.length;
        if (readableChars > readableMaxChars) {
          readable = []; // 溜めた Blob を手放す
          readableDropped = true;
        } else {
          readable.push({
            name: `${NOTES_PREFIX}${String(entryCount).padStart(5, '0')}-${safeName(m.title)}.md`,
            blob: new Blob([r.body]),
          });
        }
      }
    }
    // 🔴 取り込み直す側は container.json を `Blob.text()` で 1 本の文字列にする ── 上限は**字数**で効く。
    //   Blob にすると字数が見えなくなる(bytes は日本語で約 3 倍)ので、手放す前に数える
    blobChars += chunk.length;
    if (chunk !== '') parts.push(new Blob([chunk]));
    if (done) break;
    if (!next) break; // 進めないなら止める(無限ループを作らない)
    after = next;
  }
  if (entryCount < metas.length) {
    warnings.push(`一覧にあって本文が取れなかったノートが ${metas.length - entryCount} 件あります`);
  }

  // ── relations
  const relations = await src.listRelations();
  parts.push('],"relations":[');
  // 🔴 **書いたノートのつながりだけ**を書く(I-4)。ゴミ箱のノートは `entries` に書かないので、
  //   そこへ向かうつながりを書くと、取り込み直したとき「つなぐ先のノートが無い」注意が必ず出る
  //   (バックアップは壊れていないのに)。アーカイブにはゴミ箱の印が無く、取り込み側では
  //   「ゴミ箱の物」と「壊れた物」を見分けられないので、書く側で絞る。取り込み側の注意は壊れた物のために残す。
  let relCount = 0;
  for (const r of relations) {
    if (!exportedLids.has(r.from_lid) || !exportedLids.has(r.to_lid)) continue;
    const rel = toArchiveRelation(r);
    parts.push(relCount === 0 ? j(rel) : `,${j(rel)}`);
    relCount++;
  }

  // ── revisions(**鎖のまま**。全文に展開しない)
  parts.push('],"revisions":[');
  let revCount = 0;
  for (const lid of await src.listRevisionLids()) {
    // 🔴 書いていないノート(ゴミ箱)の履歴は書かない ── 取り込み側は鎖の起点(ノート)が無いと復元できず、
    //   「ノートの無い履歴」の注意が必ず出ていた(I-4。上のつながりと同じ理由)
    if (!exportedLids.has(lid)) continue;
    // 🔴 **保存形のまま**出す(P6e)。以前は版ごとに `getRevision` で全文へ
    // 復元しており、`kind: 'patch'` の行に全文が入る = **中身と食い違う**
    // アーカイブを書いていた(復元を実装した瞬間に壊れる)
    for (const rv of await src.getRevisionChain(lid)) {
      const rev = toArchiveRevision(lid, rv);
      parts.push(revCount === 0 ? j(rev) : `,${j(rev)}`);
      revCount++;
    }
  }

  // ── assets(meta は container.json、bytes は assets/<key>)
  const assetMetas = await src.listAssetMetas();
  parts.push('],"assets":[');
  assetMetas.forEach((a, i) => {
    const meta = toArchiveAsset(a);
    parts.push(i === 0 ? j(meta) : `,${j(meta)}`);
  });
  parts.push(']');

  // ── 🔴 ゴミ箱のノート(台帳 #1852 束 F2 / 依頼 105-2・297 A)── `entries` には混ぜず、別の鍵に置く。
  //   旧い版は知らない鍵を読み飛ばすので、旧い版が読んでも今までと同じ(生きたノートだけが戻る)。
  const trashParts = await writeTrashParts(src, exportedLids, relations, warn);
  if (trashParts.count > 0) {
    parts.push(',"trash":[');
    parts.push(...trashParts.notes);
    parts.push('],"trashRelations":[');
    parts.push(...trashParts.relations);
    parts.push('],"trashRevisions":[');
    parts.push(...trashParts.revisions);
    parts.push(']');
    blobChars += trashParts.blobChars;
  }
  // 🔴 タグの色(#1457)── 1 つも無ければキーごと書かない(旧い読み手にも同じ形のまま)
  const tagColors = (await src.listTagColors?.()) ?? [];
  parts.push(tagColors.length > 0 ? `,"tagColors":${j(tagColors)}` : '');
  // 🔴 ピン留め(#1377)── 書き出すノートに在るものだけ。1 つも無ければキーごと書かない
  const notePins = ((await src.listNotePins?.()) ?? []).filter((l) => exportedLids.has(l));
  parts.push(notePins.length > 0 ? `,"notePins":${j(notePins)}}` : '}');

  const w = new ZipWriter();
  await w.add(
    MANIFEST,
    [
      j({
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        exported_at: exportedAt,
        cid: src.cid,
        title: src.title,
        ...(src.partial === true ? { partial: true } : {}),
        counts: {
          entries: entryCount,
          relations: relCount,
          revisions: revCount,
          assets: assetMetas.length,
          // 🔴 ゴミ箱が無いときは鍵ごと書かない(ゴミ箱の無いバックアップの概要は今までと 1 バイトも変えない)
          ...(trashParts.count > 0 ? { trash: trashParts.count } : {}),
        },
      }),
    ],
  );
  // 🔴 **取り込み直せない大きさの container.json を、黙って書かない**(#1087)。ふつうの書き出しは断る(台帳 #1852 束 F2 /
  //   依頼 119-3 A ── 「書き出しました」と出るのに取り込めないバックアップを作らない)。保険の zip(`'warn'`)だけは
  //   書いたうえで警告する ── 作り直しの前の保険を、大きさで止めると作り直せない
  let containerChars = blobChars;
  for (const p of parts) if (typeof p === 'string') containerChars += p.length;
  if (containerChars > maxContainerChars) {
    // 🔴 断るのは**添付を書く前**(zip の組み立ては捨てる)── 呼び側は何もダウンロードさせない
    if (oversize === 'refuse') throw new Error(archiveTooBigRefusal(containerChars));
    warnings.push(notImportableArchiveMessage(containerChars));
  }
  await w.add(CONTAINER, parts);
  if (readableDropped) {
    warnings.push('本文の総量が大きいため、読む用の notes/ フォルダは入れていません(取り込みには影響しません)');
  }
  // 🔴 人が読める本文(#986)── container.json の後ろ・添付の前。⚠ 連番で名前の重なりを避ける
  for (const n of readable) await w.add(n.name, [n.blob]);

  let assetCount = 0;
  for (const a of assetMetas) {
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      // 参照はあるが bytes が無い(GC の途中失敗など)── 参照は温存して言う
      warn.add('missing-asset', '中身の見つからない添付', `添付の中身が見つかりませんでした: ${a.key}`);
      continue;
    }
    await w.add(`${ASSET_PREFIX}${a.key}`, [blob]); // ⚠ Blob をそのまま(コピーしない)
    assetCount++;
  }

  // 🔴 「書き出したつもりで空」を作らない
  if (entryCount === 0) {
    throw new Error('書き出せるノートが 1 件もありません');
  }

  warn.finish();
  return {
    blob: w.finish(),
    warnings,
    counts: {
      entries: entryCount,
      relations: relCount,
      revisions: revCount,
      assets: assetCount,
      trash: trashParts.count,
    },
  };
}

/**
 * 🔴 **ゴミ箱のノートを container.json の部品にする**(台帳 #1852 束 F2 / 依頼 105-2・297 A)。
 *
 * - ノート 1 件 = 1 個の Blob(本文を heap に溜めない。`writeArchive` の常駐の規律と同じ)
 * - 頭の行(ゴミ箱へ移した時点の全文)が本文。それより古い版は保存形の鎖のまま `trashRevisions` に出す
 * - つながりは「ゴミ箱のノートに触る物」だけ(生きたノート同士の物は `relations` が運ぶ)。両端が書いたノート(生きた物 + ゴミ箱)に居る物だけ
 * - 頭が全文でない・読めない行は、黙って落とさず注意に出す
 */
async function writeTrashParts(
  src: ArchiveSource,
  liveLids: ReadonlySet<string>,
  relations: ReadonlyArray<RelationRowLike>,
  warn: WarnCollector,
): Promise<{
  count: number;
  notes: Blob[];
  relations: string[];
  revisions: Blob[];
  blobChars: number;
}> {
  const out = { count: 0, notes: [] as Blob[], relations: [] as string[], revisions: [] as Blob[], blobChars: 0 };
  if (src.listTrashHeads === undefined) return out;
  const heads = await src.listTrashHeads();
  const trashLids = new Set<string>();
  let revCount = 0;
  for (const h of heads) {
    // 生きているノートと同じ lid は書かない(画面が古い。生きている側が正)
    if (liveLids.has(h.lid) || trashLids.has(h.lid)) continue;
    const got = toArchiveTrash(h, await src.getRevisionChain(h.lid));
    if (got === null) {
      warn.add('trash-skip', 'ゴミ箱のノートの注意', `ゴミ箱の中の読み出せないノートを飛ばしました: ${h.title ?? '(無題)'}`);
      continue;
    }
    const noteJson = out.count === 0 ? j(got.note) : `,${j(got.note)}`;
    out.blobChars += noteJson.length;
    out.notes.push(new Blob([noteJson]));
    trashLids.add(h.lid);
    out.count++;
    let chunk = '';
    for (const rev of got.rows) chunk += `${revCount++ === 0 ? '' : ','}${j(rev)}`;
    if (chunk !== '') {
      out.blobChars += chunk.length;
      out.revisions.push(new Blob([chunk]));
    }
  }
  let first = true;
  for (const r of relations) {
    const touches = trashLids.has(r.from_lid) || trashLids.has(r.to_lid);
    if (!touches) continue;
    const bothIn =
      (trashLids.has(r.from_lid) || liveLids.has(r.from_lid)) && (trashLids.has(r.to_lid) || liveLids.has(r.to_lid));
    if (!bothIn) continue;
    const json = j(toArchiveRelation(r));
    out.relations.push(first ? json : `,${json}`);
    first = false;
  }
  return out;
}

export interface Pkc3Archive {
  manifest: {
    format: string;
    version: number;
    exported_at?: string;
    cid?: string;
    title?: string;
    /** 🔴 拾えた分だけの zip(依頼 119-4)。無い = 全部のバックアップ / 旧い版が書いた物。 */
    partial?: boolean;
  };
  entries: ArchiveEntry[];
  relations: ArchiveRelation[];
  revisions: ArchiveRevision[];
  assets: ArchiveAsset[];
  /** タグの色(#1457)。無いバックアップ・読めない要素は空 / 落とす(`warnings` で言う)。 */
  tagColors: TagColorEntry[];
  /** ノートのピン留め(#1377)。留めた順の lid。無いバックアップ・読めない要素は空。 */
  notePins: string[];
  /** 🔴 ゴミ箱のノート(台帳 #1852 束 F2)。無いバックアップ(旧い版が書いた物・ゴミ箱が空だった物)は空。 */
  trash: ArchiveTrashNote[];
  /** ゴミ箱のノートに触るつながり。 */
  trashRelations: ArchiveRelation[];
  /** ゴミ箱のノートの古い版(保存形の鎖。頭の行は `trash[].body` が持つ)。 */
  trashRevisions: ArchiveRevision[];
  /** asset key → bytes(**まだ読んでいない**。adapter が 1 件ずつ流す)。 */
  assetSources: Map<string, ReadableAssetSource>;
  warnings: string[];
}

/** アーカイブ ZIP を読む。**形が違えば必ず throw**(部分的に読めた気にさせない)。 */
export async function readArchive(zip: Blob): Promise<Pkc3Archive> {
  // 🔑 フォルダごと zip にし直したバックアップも読む(peek と同じ `unwrapSingleTopDir` を通る)
  const dir = unwrapSingleTopDir(await readZipDirectory(zip)).entries;
  const warnings: string[] = [];
  // 🔑 同種の注意は上限まで(規則は `warn-cap.ts` の 1 本 ── P8 段㉒)
  const warn = createWarnCollector(warnings);

  const only = (name: string): import('../import/zip-reader').ZipEntry => {
    const hits = dir.filter((e) => e.name === name);
    // ⚠ 内部の部品名(manifest.json / container.json)を出さない ── user には何が足りないか分からない
    const what = name === CONTAINER ? 'バックアップの本体' : 'バックアップの概要';
    if (hits.length === 0) throw new ZipReadError(`${what}が入っていません(この zip は読み取れません)`);
    if (hits.length > 1) throw new ZipReadError(`${what}が ${hits.length} 個あります(この zip は読み取れません)`);
    return hits[0]!;
  };

  let manifest: Pkc3Archive['manifest'];
  try {
    manifest = JSON.parse(await readZipText(zip, only(MANIFEST))) as Pkc3Archive['manifest'];
  } catch (e) {
    // 🔴 大きすぎて文字列にできないのは「JSON として読めない」ではない ── そのまま上へ(取り込みの口が平らな字で言う。#1087)
    if (e instanceof ZipReadError || isTooLargeToRead(e)) throw e;
    throw new ZipReadError(`構成定義(${MANIFEST})を読み取れません(JSON として読めません)。別のバックアップファイルを選んでください`);
  }
  checkArchiveManifest(manifest);

  let c: ArchiveContainerJson;
  try {
    c = JSON.parse(await readZipText(zip, only(CONTAINER))) as ArchiveContainerJson;
  } catch (e) {
    // 🔴 大きすぎて文字列にできないのは「JSON として読めない」ではない ── そのまま上へ(取り込みの口が平らな字で言う。#1087)
    if (e instanceof ZipReadError || isTooLargeToRead(e)) throw e;
    throw new ZipReadError(`バックアップの中のノートのデータ(${CONTAINER})を読み取れません(JSON として読めません)。別のバックアップファイルを選んでください`);
  }
  checkArchiveContainer(c); // ⚠ 添付の目録(下)より先に断る ── 断る順番は変えない
  const assetSources = new Map<string, ReadableAssetSource>();
  for (const e of dir) {
    if (e.isDirectory || !e.name.startsWith(ASSET_PREFIX)) continue;
    const key = e.name.slice(ASSET_PREFIX.length);
    if (key === '' || key.includes('/')) {
      warn.add('stray-file', '想定外のファイル', `assets/ の中の想定外のファイルを無視しました: ${e.name}`);
      continue;
    }
    if (assetSources.has(key)) throw new ZipReadError(`添付の ID が重複しています: ${key}`);
    assetSources.set(key, { zip, entry: e });
  }

  return assembleArchive(manifest, c, assetSources, warnings, warn);
}

/** 構成定義(manifest)の形を検める。⚠ zip 経路と PKC3 入り HTML の経路が**同じ 1 つ**を通る。 */
export function checkArchiveManifest(manifest: Pkc3Archive['manifest'] | undefined): void {
  if (manifest?.format !== ARCHIVE_FORMAT) {
    throw new ZipReadError(
      `PKC3 のバックアップではありません(format=${String(manifest?.format)})`,
    );
  }
  const version = manifest.version;
  if (
    typeof version !== 'number' ||
    version < ARCHIVE_MIN_VERSION ||
    version > ARCHIVE_VERSION
  ) {
    throw new ZipReadError(
      `PKC3 が読めるバックアップのバージョンは ${ARCHIVE_MIN_VERSION}〜${ARCHIVE_VERSION} です(このファイルは ${String(version)})`,
    );
  }
}

/** ノートの記載(entries)が無いものは断る。 */
export function checkArchiveContainer(c: ArchiveContainerJson): asserts c is ArchiveContainerJson & { entries: ArchiveEntry[] } {
  if (!Array.isArray(c.entries)) {
    throw new ZipReadError(`バックアップの中のノートのデータ(${CONTAINER})に、ノート(entries)の記載がありません。別のバックアップファイルを選んでください`);
  }
}

/** `container.json` の中身(JSON として読んだ形)。 */
export interface ArchiveContainerJson {
  entries?: ArchiveEntry[];
  relations?: ArchiveRelation[];
  revisions?: ArchiveRevision[];
  assets?: ArchiveAsset[];
  tagColors?: unknown;
  /** ノートのピン留め(#1377)。lid の並び。 */
  notePins?: unknown;
  /** 🔴 ゴミ箱のノート(台帳 #1852 束 F2)。旧い版が書いた物には無い。 */
  trash?: ArchiveTrashNote[];
  trashRelations?: ArchiveRelation[];
  trashRevisions?: ArchiveRevision[];
}

/**
 * 🔑 **読んだ中身 → `Pkc3Archive`** の検めと整え。zip を読む `readArchive` と、zip を作らずに
 * 直に組む PKC3 入り HTML の取り込みが、**この 1 つ**を通る(検め・警告・版の読み替えを 2 か所に持たない)。
 * ⚠ `manifest` は `checkArchiveManifest` を通した後のものを渡す。
 */
export function assembleArchive(
  manifest: Pkc3Archive['manifest'],
  c: ArchiveContainerJson,
  assetSources: Map<string, ReadableAssetSource>,
  warnings: string[],
  /** 同じ注意の畳みを zip の目録の注意と共有するときに渡す(無ければここで作る)。 */
  warn: WarnCollector = createWarnCollector(warnings),
): Pkc3Archive {
  const version = manifest.version;
  checkArchiveContainer(c);

  // manifest のカウンタと中身を照合する(PKC2 は読んでさえいなかった)
  const counts = (manifest as { counts?: Record<string, number> }).counts ?? {};
  const actual: Record<string, number> = {
    entries: c.entries.length,
    relations: c.relations?.length ?? 0,
    revisions: c.revisions?.length ?? 0,
  };
  // 🔴 ゴミ箱の数も照合する(書き出しは 1 件以上あるときだけ記録する)
  if (typeof counts['trash'] === 'number') actual['trash'] = c.trash?.length ?? 0;
  const COUNT_LABEL: Record<string, string> = {
    entries: 'ノート',
    relations: 'つながり',
    revisions: '履歴',
    trash: 'ゴミ箱のノート',
  };
  for (const [k, v] of Object.entries(actual)) {
    if (typeof counts[k] === 'number' && counts[k] !== v) {
      warnings.push(
        `バックアップに記録された${COUNT_LABEL[k] ?? k}の数と、実際に入っている数が合いません(記録 ${counts[k]} 件 / 実際 ${v} 件)`,
      );
    }
  }
  // ⚠ assets は「meta はあるが bytes が無い」が正当にありうる(書出し時の欠損)ので
  // meta 数ではなく **bytes の数**で照合する
  for (const a of c.assets ?? []) {
    if (!assetSources.has(a.key)) {
      // 添付の ID(ast-…)は user に読めない ── その添付を持つノートの題名で言う(取り込み側の `assetName` と同じ引き方)
      const owner = c.entries.find((e) => typeof e.body === 'string' && e.body.includes(a.key));
      const name = owner ? `「${owner.title || '(無題)'}」の添付` : '題名の分からないノートの添付';
      warn.add('absent-asset', 'バックアップに入っていない添付', `バックアップに入っていない添付があります: ${name}`);
    }
  }

  // 🔴 **version 1 の `kind` は嘘**(全文を書きながら保存形の kind を刻んでいた)。
  // 読み側で `'full'` へ正規化する ── そうしないと復元がパッチとして適用して壊れる
  const revisions = (c.revisions ?? []).map((r) =>
    version < 2 ? { ...r, kind: 'full' } : r,
  );

  const colors = parseTagColorList(c.tagColors);
  if (colors.dropped > 0) {
    warnings.push(`タグの色のうち取り込めないもの ${colors.dropped} 件は取り込みません(#rrggbb の色だけ・500 個までです)`);
  }

  warn.finish();
  return {
    manifest,
    tagColors: colors.list,
    notePins: normalizePinLids(c.notePins),
    trash: Array.isArray(c.trash) ? c.trash : [],
    trashRelations: Array.isArray(c.trashRelations) ? c.trashRelations : [],
    trashRevisions: Array.isArray(c.trashRevisions) ? c.trashRevisions : [],
    entries: c.entries,
    relations: c.relations ?? [],
    revisions,
    assets: c.assets ?? [],
    assetSources,
    warnings,
  };
}

/**
 * アーカイブを**取込の中間形**へ写す(復元)。
 *
 * ⚠ **PKC2 の convert とは別物**。PKC2 経路は `getFlavor().fromPkc2` で body を
 * PKC-Markdown へ変換するが、アーカイブの body は**既に PKC-Markdown** なので
 * 通してはいけない(通すと二重変換で壊れる)。ここがやるのは
 * 「lid / relation id の衝突回避」と「asset key の写し」だけ。
 *
 * 履歴は**鎖のまま**返す(P6e)。decode は worker の中で行う ── 逆向きパッチの
 * codec をここに持ち込むと符号化側と二重実装になってずれる。
 */
export function restoreArchive(
  archive: Pkc3Archive,
  opts: {
    existingLids: ReadonlySet<string>;
    existingRelationIds: ReadonlySet<string>;
    orderBase: number;
    genLid(): string;
    genRelationId(): string;
  },
): {
  entries: Array<{
    lid: string;
    title: string;
    archetype: string;
    body: string;
    entryOrder: number;
    /** 元の作成・更新時刻(#1087)。書き出しに無ければ null(= 取込時の今)。 */
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>;
  /** ⚠ **key だけでなく mime も返す**(review M-4)── 落とすと Blob の type と
   * meta.mime が空になり、画像が preview されなくなる(無言で) */
  assets: Array<{ key: string; mime: string }>;
  /**
   * 🔴 **ゴミ箱へ入れ直すノート**(台帳 #1852 束 F2 / 依頼 105-2・297 A)。lid は写し先へ写像済み。
   * 本文は書き出したときのまま(添付の key・`entry:` の付け替えは取込側が `remapImportedBody` 1 本で当てる)。
   * `rows` = それより古い版(保存形の鎖。新しい → 古い。lid は写像済み)。
   */
  trash: Array<{
    lid: string;
    title: string;
    archetype: string;
    body: string;
    createdAt: string | null;
    updatedAt: string | null;
    entryOrder: number | null;
    trashedAt: string | null;
    rows: Array<{
      revOrder: number;
      createdAt: string | null;
      title: string | null;
      archetype: string | null;
      kind: string;
      snapshot: string;
      contentHash: string | null;
    }>;
  }>;
  /** 保存形の鎖(新しい → 古い)。lid は写し先へ写像済み。 */
  revisionChains: Array<{
    entryLid: string;
    rows: Array<{
      revOrder: number;
      createdAt: string | null;
      title: string | null;
      archetype: string | null;
      kind: string;
      snapshot: string;
      contentHash: string | null;
    }>;
  }>;
  /** 取り込む色(#1457)。⚠ いま付けている色は動かさない ── 足りない分だけ足すのは取込側。 */
  tagColors: TagColorEntry[];
  /** 取り込むピン留め(#1377)。⚠ 付け替えた lid は写し済み(`lidRemap` と同じ表)。取込側は足りない分だけ足す。 */
  notePins: string[];
  /**
   * 🔴 **付け替えた lid**(旧 → 新。変わった組だけ)。本文の `entry:<lid>` は**ここでは書き換えない** ──
   *   取込側が添付の key と一緒に `remapImportedBody` 1 本で当てる(履歴の鎖にも同じ規則を当てるため。
   *   ここで本文だけ書き換えると、鎖の起点がずれて履歴が全部落ちる)。
   * ⚠ 当てないと、取り込んだノートのリンクが**複製ではなく既存の原本**を指す(つながりは複製を指すのに)。
   */
  lidRemap: Array<readonly [string, string]>;
  /** 書き出し元の容れ物の id(manifest。無ければ空)。本文の `pkc://<cid>/entry/<lid>` を写すのに使う(#1087 N14)。 */
  sourceCid: string;
  warnings: string[];
} {
  const warnings = [...archive.warnings];
  const taken = new Set(opts.existingLids);
  // 🔴 ID の付け替えとつながりの除外は、1 件ずつ並べず**理由ごとの件数 1 行**にまとめる(#1087)。
  //   ⚠ 旧 ID → 新 ID の対は出さない(内部の ID は user には直しようが無い)。
  //   文は PKC2 の取込(`pkc2-convert.ts`)と同じ。
  let relabeled = 0;
  /** 🔴 いまのノートと ID が重なって付け替えた分の題名(#1643。ファイルの中の重なりは `relabeled` だけが数える) */
  const clashTitles: string[] = [];
  const danglingTitles: string[] = [];
  const lidMap = new Map<string, string>();
  // ⚠ アーカイブ内の lid 重複(review H-3)は writer 側では起きない(H-1/H-2 を直した)が、手で組んだ /
  //   壊れたアーカイブでは来る。2 件目以降も下の付け替えで `relabeled` に数える。
  const entries = archive.entries.map((e, i) => {
    let lid = e.lid;
    if (lid === '' || taken.has(lid)) {
      const fresh = opts.genLid();
      if (e.lid !== '' && opts.existingLids.has(e.lid)) clashTitles.push(e.title);
      else relabeled++;
      lid = fresh;
    }
    taken.add(lid);
    // ⚠ 重複した lid は**最初の出現**を関連の宛先にする(後勝ちだと relation が
    // 複製を指す)。2 件目以降は entry としては入るが関連の宛先にはならない
    if (!lidMap.has(e.lid)) lidMap.set(e.lid, lid);
    return {
      lid,
      title: e.title,
      archetype: e.archetype,
      // ⚠ **変換しない**(既に PKC-Markdown)。付け替えた lid の写しは取込側(上の `lidRemap`)
      body: e.body,
      entryOrder: opts.orderBase + i + 1,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  });

  // 🔴 ゴミ箱のノート(台帳 #1852 束 F2)── 生きたノートと同じ付け替えの表(`taken` / `lidMap`)を通す。
  //   ⚠ 並びの位置は持ち込まない(書き出した側の番号は、こちらの並びとは別物)。戻すときは末尾に付く
  const trashEntries = archive.trash.map((t) => {
    let lid = t.lid;
    if (lid === '' || taken.has(lid)) {
      const fresh = opts.genLid();
      if (t.lid !== '' && opts.existingLids.has(t.lid)) clashTitles.push(t.title);
      else relabeled++;
      lid = fresh;
    }
    taken.add(lid);
    if (!lidMap.has(t.lid)) lidMap.set(t.lid, lid);
    return { t, lid };
  });

  const takenRel = new Set(opts.existingRelationIds);
  const relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }> = [];
  for (const r of [...archive.relations, ...archive.trashRelations]) {
    const from = lidMap.get(r.fromLid);
    const to = lidMap.get(r.toLid);
    if (!from || !to) {
      // 端点が居ない = アーカイブが壊れている ── 黙って落とさない
      // 🔴 内部の ID ではなく、残っている側のノートの題名で言う(#1087)
      const missing = from ? r.fromLid : r.toLid;
      const there = archive.entries.find((e) => e.lid === missing) ?? archive.trash.find((e) => e.lid === missing);
      danglingTitles.push(there && (from || to) ? `「${there.title || '(無題)'}」` : '');
      continue;
    }
    let id = r.id;
    if (id === '' || takenRel.has(id)) id = opts.genRelationId();
    takenRel.add(id);
    relations.push({ id, fromLid: from, toLid: to, kind: r.kind });
  }

  // ── 履歴: entry ごとに束ね、**新しい → 古い**へ整える(worker の decode 順)。
  // ⚠ lid は写し先へ写像する ── 原本の lid をそのまま使うと、既存の同名 entry の
  // 履歴に他人の版が並ぶ(P6c review H-1 で実証済みの事故)
  const byLid = new Map<string, typeof archive.revisions>();
  let orphanRevs = 0;
  let orphanTrashRevs = 0;
  for (const r of archive.revisions) {
    const to = lidMap.get(r.entryLid);
    if (!to) {
      orphanRevs++;
      continue;
    }
    const list = byLid.get(to);
    if (list) list.push(r);
    else byLid.set(to, [r]);
  }
  const trashRows = new Map<string, typeof archive.trashRevisions>();
  for (const r of archive.trashRevisions) {
    const to = lidMap.get(r.entryLid);
    if (!to) {
      orphanTrashRevs++;
      continue;
    }
    const list = trashRows.get(to);
    if (list) list.push(r);
    else trashRows.set(to, [r]);
  }
  if (orphanRevs + orphanTrashRevs > 0) {
    // 🔴 持ち主のノートがバックアップの中に居ない履歴。ゴミ箱のノートは `trash` で運ぶようになった(台帳 #1852 束 F2)ので、
    //   ここに来るのは**旧い版が書いた物のゴミ箱の版**か、壊れたバックアップ。復元できない ── 黙って落とさず件数を言う
    warnings.push(`ノートの無い履歴 ${orphanRevs + orphanTrashRevs} 版は復元しませんでした(ゴミ箱の版)`);
  }
  const trash = trashEntries.map(({ t, lid }) => ({
    lid,
    title: t.title,
    archetype: t.archetype,
    body: t.body,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    entryOrder: null,
    trashedAt: t.trashedAt,
    rows: [...(trashRows.get(lid) ?? [])]
      .sort((a, b) => b.revOrder - a.revOrder)
      .map((r) => ({
        revOrder: r.revOrder,
        createdAt: r.createdAt,
        title: r.title,
        archetype: r.archetype,
        kind: r.kind,
        snapshot: r.snapshot,
        contentHash: r.contentHash ?? null,
      })),
  }));
  const revisionChains = [...byLid].map(([entryLid, rows]) => ({
    entryLid,
    rows: [...rows]
      .sort((a, b) => b.revOrder - a.revOrder) // 新しい → 古い
      .map((r) => ({
        revOrder: r.revOrder,
        createdAt: r.createdAt,
        title: r.title,
        archetype: r.archetype,
        kind: r.kind,
        snapshot: r.snapshot,
        // v1 は持たない ── 検査しない(そのころの行は全文なので噛み合わせは不要)
        contentHash: r.contentHash ?? null,
      })),
  }));

  // asset は meta の mime を持ち回る(key だけだと Blob の type が空になる)
  const mimeOf = new Map(archive.assets.map((a) => [a.key, a.mime]));
  const assets = [...archive.assetSources.keys()].map((key) => ({
    key,
    mime: mimeOf.get(key) ?? 'application/octet-stream',
  }));

  for (const w of [relabeledWarning(clashTitles), relabeledInFileWarning(relabeled)]) if (w !== null) warnings.push(w);
  if (danglingTitles.length > 0) {
    const only = danglingTitles[0]!;
    warnings.push(
      danglingTitles.length === 1 && only !== ''
        ? `${only}から、つなぐ先のノートが無いつながりを除きました`
        : `つなぐ先のノートが無いつながり ${danglingTitles.length} 本を除きました`,
    );
  }
  const lidRemap: Array<readonly [string, string]> = [];
  for (const [from, to] of lidMap) if (from !== to) lidRemap.push([from, to]);
  // 🔴 ピン留め(#1377)── 取り込むノート(付け替え後の lid)に在るものだけ
  const importedLids = new Set(entries.map((e) => e.lid));
  const notePins = archive.notePins
    .map((l) => lidMap.get(l) ?? l)
    .filter((l, i, a) => importedLids.has(l) && a.indexOf(l) === i);
  return { entries, relations, assets, trash, revisionChains, tagColors: archive.tagColors, notePins, lidRemap, sourceCid: archive.manifest.cid ?? '', warnings };
}
