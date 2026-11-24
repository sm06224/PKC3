/**
 * 🔴 **端末間の同期(#2000)段 2 ── 差分ファイル(`*.pkc3-diff.zip`)の形と読み書き**。
 *
 * ## 中身
 * - `manifest.json`: `format: 'pkc3-diff'` / 版 / 書き出した端末の id・連番・ワークスペースの cid と題名 / 全件か差分か。
 * - `container.json`: ノート(本文つき。**前回の同期の記録から変わった物**、全件のときは全部)/ つながり(全件。小さい)/
 *   削除の記録 / **全件の指紋の一覧**(種の同期の記録・全件の突き合わせ用。設計 doc §12.1 の約束 2・3)/
 *   **送り手が受け手について持っている記録**(`peerBase`。両側が同じ版から直したときの競合の連鎖を止める)/ 添付の目録。
 * - `assets/<key>`: 本文が参照する添付のうち、送り手が運ぶと決めた物の実体(生バイト)。
 *
 * ⚠ 書き出す側は端末 id の決まらない相手を想定する(受け手が id で自分の記録を引く)。
 * ⚠ 中身の形式はバックアップ(`pkc3-archive`)とは別の `format`(`peekZipFormat` が見分ける)。PKC2 は読めない(一方通行)。
 * ⚠ pure module(Blob / zip は browser 標準の物だけ。`pkc3-archive.ts` と同じ層)。
 */
import { ZipWriter, type ZipPart } from '../export/zip-writer';
import {
  readZipDirectory,
  readZipText,
  unwrapSingleTopDir,
  ZipReadError,
  type ReadableAssetSource,
} from '../import/zip-reader';
import { isTooLargeToRead } from '../import/too-large';
import { isDeviceId } from './sync-state';
import { DIFF_ARCHIVE_SUFFIX } from '../export/archive-kind';
import type { Tombstone } from './change-set';
import { isReservedSyncLid, isSyncRelationKind } from './sync-guard';
import { attrKeyTouchesReserved, isAttrKey } from './sync-attr';
import { isNoteLabelColor } from '../note-label';

export { isReservedSyncLid, isSyncRelationKind };

/** つながりのキー(`rel:<from>|<to>|<kind>`)が system の lid に触れるか。 */
function relKeyTouchesReserved(key: string): boolean {
  if (!key.startsWith('rel:')) return false;
  const [from, to] = key.slice(4).split('|');
  return isReservedSyncLid(from ?? '') || isReservedSyncLid(to ?? '');
}
const keyIsReserved = (key: string): boolean => (isAttrKey(key) ? attrKeyTouchesReserved(key) : isReservedSyncLid(key) || relKeyTouchesReserved(key));

export const DIFF_FORMAT = 'pkc3-diff';
/**
 * 書くバージョン。⚠ 2 = 色ラベル・ピン留め(`labels` / `pins`)と印の指紋(`pin:` / `lab:`)を運ぶ(段 3)。
 * 1 を読む古い PKC3 は 2 を断る(印のキーをノートと取り違えて「本文が無い」と言わないため、版を上げた)。
 */
export const DIFF_VERSION = 2;
/** 読めるバージョン(1 = 段 2 の形。印を運ばない ── 取り込み側は印を判定に入れない)。 */
export const DIFF_READABLE_VERSIONS: readonly number[] = [1, 2];
/** 差分ファイルの名前の末尾(二重拡張子。中身の型を名前で言う)。 */
export const DIFF_SUFFIX = DIFF_ARCHIVE_SUFFIX;
const MANIFEST = 'manifest.json';
const CONTAINER = 'container.json';
const ASSET_PREFIX = 'assets/';
const NOTE_CHUNK = 500;

export interface DiffManifest {
  format: string;
  version: number;
  exported_at: string;
  /** 書き出した端末の id。 */
  device: string;
  /** 書き出した端末の連番(相手の連番に追い付く用。端末をまたいだ大小は比べない)。 */
  seq: number;
  /** 書き出し元のワークスペースの cid と題名(受け手が対応づける)。 */
  cid: string;
  title: string;
  /** 全件(前回の同期の記録が無い・古い・「すべて」を選んだ)か、変わった分だけか。 */
  complete: boolean;
  counts: { notes: number; relations: number; deletions: number; assets: number; total: number };
  /**
   * 同期フォルダ(段 3)で、この端末が**全件を書き出してほしい**相手の端末 id(取り込んだ差分に本文が足りなかった)。
   * ⚠ 省略可(手で運ぶ差分ファイルでは付けない)。
   */
  want?: string[];
  /**
   * 同期フォルダ(段 3)で、書き出した端末が**すでに対応づけた相手**(相手の端末 id → 相手のワークスペースの cid)。
   * 受け手は、自分の id と今のワークスペースの cid が載っていれば、相手の側で人が確認済みとして初回の確認を省く。⚠ 省略可。
   */
  pairs?: Record<string, string>;
}

export interface DiffNote {
  lid: string;
  title: string;
  archetype: string;
  /** 親フォルダの lid(ルートは null)。 */
  parentLid: string | null;
  body: string;
}

export interface DiffRelation {
  from: string;
  to: string;
  kind: string;
}

export interface DiffFingerprint {
  key: string;
  c: string;
  p?: string;
}

export interface DiffAssetMeta {
  key: string;
  mime: string;
  size: number;
  hash: string | null;
}

export interface DiffContainer {
  notes: DiffNote[];
  relations: DiffRelation[];
  tombstones: Tombstone[];
  fingerprints: DiffFingerprint[];
  peerBase: DiffFingerprint[];
  assets: DiffAssetMeta[];
  /**
   * 同期フォルダ(段 3)で 1 つのファイルを複数の相手が読むときの、相手ごとの `peerBase`(相手の端末 id → 記録)。
   * 取り込む側は自分の id の分があれば `peerBase` の代わりに使う。⚠ 省略可。
   */
  peerBases?: Record<string, DiffFingerprint[]>;
  /**
   * 色ラベル(全件)。⚠ `undefined` = この差分ファイルは印を運ばない(バージョン 1)。空の配列(印が 1 つも無い)と区別する ──
   * 区別しないと、印を知らない古いファイルを「相手は印を全部外した」と読んでしまう。
   */
  labels?: Array<{ lid: string; color: number }>;
  /** ピン留め(全件の lid)。`undefined` の意味は `labels` と同じ。 */
  pins?: string[];
}

export interface DiffWriteInput {
  manifest: Omit<DiffManifest, 'format' | 'version' | 'counts'>;
  /** ノートを 1 件ずつ(heap に全件を溜めない)。 */
  notes: AsyncIterable<DiffNote>;
  relations: readonly DiffRelation[];
  tombstones: readonly Tombstone[];
  fingerprints: readonly DiffFingerprint[];
  peerBase: readonly DiffFingerprint[];
  /** 相手ごとの `peerBase`(同期フォルダ)。省略可。 */
  peerBases?: Readonly<Record<string, readonly DiffFingerprint[]>>;
  /** 色ラベル・ピン留め(全件)。 */
  labels: ReadonlyArray<{ lid: string; color: number }>;
  pins: readonly string[];
  /** 運ぶ添付の目録。⚠ ノートを書き終えた後に呼ぶ(ノートの本文が参照する物を数えながら溜めるため)。 */
  assets: () => readonly DiffAssetMeta[];
  /** 実体を引く(Blob をそのまま積む。無ければ null = 足りない添付)。 */
  getAssetBlob(key: string): Promise<Blob | null>;
}

const j = (v: unknown): string => JSON.stringify(v);

/** 差分ファイルを書く。戻り = zip と、実体が見つからなかった添付の key。 */
export async function writeDiffZip(input: DiffWriteInput): Promise<{ blob: Blob; counts: DiffManifest['counts']; missingAssets: string[] }> {
  const parts: ZipPart[] = ['{"notes":['];
  let notes = 0;
  let chunk = '';
  let inChunk = 0;
  for await (const n of input.notes) {
    chunk += notes === 0 ? j(n) : `,${j(n)}`;
    notes++;
    inChunk++;
    if (inChunk >= NOTE_CHUNK) {
      parts.push(new Blob([chunk]));
      chunk = '';
      inChunk = 0;
    }
  }
  if (chunk !== '') parts.push(new Blob([chunk]));
  const assets: DiffAssetMeta[] = [];
  const blobs: Array<{ key: string; blob: Blob }> = [];
  const missingAssets: string[] = [];
  for (const a of input.assets()) {
    const blob = await input.getAssetBlob(a.key);
    if (blob === null) {
      missingAssets.push(a.key);
      continue;
    }
    assets.push(a);
    blobs.push({ key: a.key, blob });
  }
  parts.push(
    `],"relations":${j(input.relations)},"tombstones":${j(input.tombstones)},"fingerprints":${j(input.fingerprints)},"peerBase":${j(input.peerBase)},"assets":${j(assets)},"labels":${j(input.labels)},"pins":${j(input.pins)}${input.peerBases === undefined ? '' : `,"peerBases":${j(input.peerBases)}`}}`,
  );
  const counts = {
    notes,
    relations: input.relations.length,
    deletions: input.tombstones.length,
    assets: assets.length,
    total: input.fingerprints.length,
  };
  const w = new ZipWriter();
  await w.add(MANIFEST, [j({ format: DIFF_FORMAT, version: DIFF_VERSION, ...input.manifest, counts })]);
  await w.add(CONTAINER, parts);
  for (const b of blobs) await w.add(`${ASSET_PREFIX}${b.key}`, [b.blob]); // Blob をそのまま(コピーしない)
  return { blob: w.finish(), counts, missingAssets };
}

export interface DiffFile {
  manifest: DiffManifest;
  container: DiffContainer;
  assetSources: Map<string, ReadableAssetSource>;
  warnings: string[];
  /** 取り込まずに捨てた行(system の lid・運べない種類のつながり)の数。結果の一覧で言う。 */
  dropped: { reserved: number; relations: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** ⚠ 指紋は本文・つながりの写しなので、捨てた数は数えない(同じ物を 2 度数えない)。 */
function fpList(v: unknown, what: string): DiffFingerprint[] {
  if (!Array.isArray(v)) throw new ZipReadError(`差分ファイルの${what}が読み取れません`);
  const out: DiffFingerprint[] = [];
  for (const x of v) {
    if (!isObj(x) || !isStr(x.key) || !isStr(x.c) || x.c === '' || (x.p !== undefined && !isStr(x.p))) {
      throw new ZipReadError(`差分ファイルの${what}に、読み取れない行があります`);
    }
    if (keyIsReserved(x.key)) continue;
    // 運べない種類のつながり(structural・知らない種類)の指紋は持たない(判定に入れると、つながりを追加・外す判定が出る)
    if (x.key.startsWith('rel:') && !isSyncRelationKind(x.key.slice(4).split('|')[2] ?? '')) continue;
    out.push(x.p === undefined ? { key: x.key, c: x.c } : { key: x.key, c: x.c, p: x.p });
  }
  return out;
}

/** 相手ごとの記録(同期フォルダ)。⚠ 端末 id でない鍵は捨てる。 */
function peerBasesOf(v: Record<string, unknown>): Record<string, DiffFingerprint[]> {
  const out: Record<string, DiffFingerprint[]> = Object.create(null) as Record<string, DiffFingerprint[]>;
  for (const [k, list] of Object.entries(v)) if (isDeviceId(k)) out[k] = fpList(list, '相手の記録');
  return out;
}

/** 差分ファイルを読む。⚠ 形が違えば必ず throw(部分的に読めた気にさせない)。 */
export async function readDiffZip(zip: Blob): Promise<DiffFile> {
  const dir = unwrapSingleTopDir(await readZipDirectory(zip)).entries;
  const only = (name: string): import('../import/zip-reader').ZipEntry => {
    const hits = dir.filter((e) => e.name === name);
    const what = name === CONTAINER ? '差分ファイルの本体' : '差分ファイルの概要';
    if (hits.length !== 1) throw new ZipReadError(`${what}が ${hits.length === 0 ? '入っていません' : `${hits.length} 個あります`}(この zip は読み取れません)`);
    return hits[0]!;
  };
  const parse = async (name: string, what: string): Promise<unknown> => {
    try {
      return JSON.parse(await readZipText(zip, only(name))) as unknown;
    } catch (e) {
      if (e instanceof ZipReadError || isTooLargeToRead(e)) throw e;
      throw new ZipReadError(`${what}を読み取れません(JSON として読めません)。別の差分ファイルを選んでください`);
    }
  };
  const m = await parse(MANIFEST, '差分ファイルの概要');
  if (!isObj(m) || m.format !== DIFF_FORMAT) throw new ZipReadError('PKC3 の差分ファイルではありません');
  if (typeof m.version !== 'number' || !DIFF_READABLE_VERSIONS.includes(m.version)) {
    throw new ZipReadError(`この PKC3 が読める差分ファイルのバージョンは ${DIFF_READABLE_VERSIONS.join(' / ')} です(このファイルは ${String(m.version)}。PKC3 を新しくしてください)`);
  }
  const version = m.version;
  if (!isDeviceId(m.device) || typeof m.seq !== 'number' || !Number.isInteger(m.seq) || m.seq < 0 || !isStr(m.cid) || m.cid === '' || !isStr(m.title) || typeof m.complete !== 'boolean') {
    throw new ZipReadError('差分ファイルの概要の形が違います(書き出した端末の情報が読み取れません)');
  }
  const manifest: DiffManifest = {
    format: DIFF_FORMAT,
    version,
    exported_at: isStr(m.exported_at) ? m.exported_at : '',
    device: m.device,
    seq: m.seq,
    cid: m.cid,
    title: m.title,
    complete: m.complete,
    ...(Array.isArray(m.want) && m.want.every((x) => isDeviceId(x)) ? { want: m.want as string[] } : {}),
    ...(isObj(m.pairs) ? { pairs: Object.fromEntries(Object.entries(m.pairs).filter((e): e is [string, string] => isDeviceId(e[0]) && isStr(e[1]) && e[1] !== '')) } : {}),
    counts: isObj(m.counts) ? (m.counts as unknown as DiffManifest['counts']) : { notes: 0, relations: 0, deletions: 0, assets: 0, total: 0 },
  };
  const c = await parse(CONTAINER, '差分ファイルの本体');
  if (!isObj(c) || !Array.isArray(c.notes)) throw new ZipReadError('差分ファイルの本体に、ノートの記載がありません');
  const dropped = { reserved: 0, relations: 0 };
  const notes: DiffNote[] = [];
  for (const n of c.notes) {
    if (!isObj(n) || !isStr(n.lid) || n.lid === '' || !isStr(n.title) || !isStr(n.archetype) || !isStr(n.body) || !(n.parentLid === null || isStr(n.parentLid))) {
      throw new ZipReadError('差分ファイルのノートに、読み取れない行があります');
    }
    if (isReservedSyncLid(n.lid)) {
      dropped.reserved++;
      continue;
    }
    // 親が system の lid のときはルートへ(親にできないので宛先なしと同じ扱い)
    notes.push({ lid: n.lid, title: n.title, archetype: n.archetype, parentLid: n.parentLid !== null && isReservedSyncLid(n.parentLid) ? null : n.parentLid, body: n.body });
  }
  const relations: DiffRelation[] = [];
  for (const r of Array.isArray(c.relations) ? c.relations : []) {
    if (!(isObj(r) && isStr(r.from) && isStr(r.to) && isStr(r.kind))) continue;
    if (isReservedSyncLid(r.from) || isReservedSyncLid(r.to)) {
      dropped.reserved++;
      continue;
    }
    if (!isSyncRelationKind(r.kind)) {
      dropped.relations++;
      continue;
    }
    relations.push({ from: r.from, to: r.to, kind: r.kind });
  }
  const tombstones: Tombstone[] = [];
  for (const t of Array.isArray(c.tombstones) ? c.tombstones : []) {
    if (isObj(t) && isStr(t.key) && keyIsReserved(t.key)) {
      dropped.reserved++;
      continue;
    }
    if (
      isObj(t) && isStr(t.key) && isObj(t.lastFp) && isStr(t.lastFp.content) && t.lastFp.content !== '' &&
      (t.lastFp.place === undefined || isStr(t.lastFp.place)) && isDeviceId(t.device) && typeof t.seq === 'number'
    ) {
      tombstones.push({
        key: t.key,
        lastFp: t.lastFp.place === undefined ? { content: t.lastFp.content } : { content: t.lastFp.content, place: t.lastFp.place },
        device: t.device,
        seq: t.seq,
        ...(isStr(t.deletedAt) ? { deletedAt: t.deletedAt } : {}),
      });
    }
  }
  const assets: DiffAssetMeta[] = [];
  for (const a of Array.isArray(c.assets) ? c.assets : []) {
    if (isObj(a) && isStr(a.key) && a.key !== '') {
      assets.push({ key: a.key, mime: isStr(a.mime) ? a.mime : 'application/octet-stream', size: typeof a.size === 'number' ? a.size : 0, hash: isStr(a.hash) ? a.hash : null });
    }
  }
  // ── 色ラベル・ピン留め(バージョン 2 から)。⚠ 1 では `undefined` のまま(印を運ばないファイル)
  let labels: Array<{ lid: string; color: number }> | undefined;
  let pins: string[] | undefined;
  if (version >= 2) {
    if (!Array.isArray(c.labels) || !Array.isArray(c.pins)) throw new ZipReadError('差分ファイルの本体に、色ラベル・ピン留めの記載がありません');
    labels = [];
    const seenLab = new Set<string>();
    for (const x of c.labels) {
      if (!isObj(x) || !isStr(x.lid) || x.lid === '' || !isNoteLabelColor(x.color)) throw new ZipReadError('差分ファイルの色ラベルに、読み取れない行があります');
      if (isReservedSyncLid(x.lid)) {
        dropped.reserved++;
        continue;
      }
      if (seenLab.has(x.lid)) continue;
      seenLab.add(x.lid);
      labels.push({ lid: x.lid, color: x.color });
    }
    pins = [];
    const seenPin = new Set<string>();
    for (const x of c.pins) {
      if (!isStr(x) || x === '') throw new ZipReadError('差分ファイルのピン留めに、読み取れない行があります');
      if (isReservedSyncLid(x)) {
        dropped.reserved++;
        continue;
      }
      if (seenPin.has(x)) continue;
      seenPin.add(x);
      pins.push(x);
    }
  }
  const warnings: string[] = [];
  const assetSources = new Map<string, ReadableAssetSource>();
  for (const e of dir) {
    if (e.isDirectory || !e.name.startsWith(ASSET_PREFIX)) continue;
    const key = e.name.slice(ASSET_PREFIX.length);
    if (key === '' || key.includes('/')) {
      warnings.push('差分ファイルの添付の置き場に、想定外のファイルがあったので無視しました');
      continue;
    }
    if (assetSources.has(key)) throw new ZipReadError(`添付の ID が重複しています: ${key}`);
    assetSources.set(key, { zip, entry: e });
  }
  return {
    manifest,
    container: {
      notes,
      relations,
      tombstones,
      fingerprints: fpList(c.fingerprints, '指紋の一覧'),
      peerBase: fpList(c.peerBase ?? [], '相手の記録'),
      assets,
      ...(isObj(c.peerBases) ? { peerBases: peerBasesOf(c.peerBases) } : {}),
      ...(labels === undefined ? {} : { labels }),
      ...(pins === undefined ? {} : { pins }),
    },
    assetSources,
    warnings,
    dropped,
  };
}
