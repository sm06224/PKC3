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
import { readZipDirectory, readZipText, ZipReadError } from '../import/zip-reader';

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
   */
  contentHash?: string | null;
}

export interface ArchiveAsset {
  key: string;
  mime: string;
  size: number;
  hash: string | null;
}

/** 書出し元(store に直結せず、test から差せる形にする)。 */
export interface ArchiveSource {
  cid: string;
  title: string;
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
  counts: { entries: number; relations: number; revisions: number; assets: number };
}

const j = (v: unknown): string => JSON.stringify(v);

/**
 * アーカイブ ZIP を書く。
 * @throws 0 件のときは**断る** ── 「書き出したつもりで空」を作らない
 */
export async function writeArchive(src: ArchiveSource, exportedAt: string): Promise<ArchiveResult> {
  const warnings: string[] = [];
  const metas = await src.listEntryMetas();
  // ⚠ 断るなら**読み出しの前**に断る。末尾の判定だけだと、0 件でも本文・履歴を
  // 舐めて全添付を ZIP に書いてから投げる ── 捨てるためだけの仕事(review L2)
  if (metas.length === 0) throw new Error('書き出せる entry が 1 件もありません');
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  // ── container.json を**部品として**積む(丸ごと文字列にしない)
  const parts: ZipPart[] = [`{"meta":${j({ cid: src.cid, title: src.title })},"entries":[`];
  let entryCount = 0;
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
        warnings.push(`本文はあるが一覧に無い entry を飛ばしました: ${r.lid}`);
        continue;
      }
      const e: ArchiveEntry = {
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        entryOrder: m.entry_order,
        status: m.status,
        date: m.date,
        archived: m.archived !== 0,
        body: r.body,
      };
      chunk += entryCount === 0 ? j(e) : `,${j(e)}`;
      entryCount++;
    }
    if (chunk !== '') parts.push(new Blob([chunk]));
    if (done) break;
    if (!next) break; // 進めないなら止める(無限ループを作らない)
    after = next;
  }
  if (entryCount < metas.length) {
    warnings.push(`一覧にあって本文が取れなかった entry が ${metas.length - entryCount} 件あります`);
  }

  // ── relations
  const relations = await src.listRelations();
  parts.push('],"relations":[');
  relations.forEach((r, i) => {
    const rel: ArchiveRelation = {
      id: r.id,
      fromLid: r.from_lid,
      toLid: r.to_lid,
      kind: r.kind,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
    parts.push(i === 0 ? j(rel) : `,${j(rel)}`);
  });

  // ── revisions(**鎖のまま**。全文に展開しない)
  parts.push('],"revisions":[');
  let revCount = 0;
  for (const lid of await src.listRevisionLids()) {
    // 🔴 **保存形のまま**出す(P6e)。以前は版ごとに `getRevision` で全文へ
    // 復元しており、`kind: 'patch'` の行に全文が入る = **中身と食い違う**
    // アーカイブを書いていた(復元を実装した瞬間に壊れる)
    for (const rv of await src.getRevisionChain(lid)) {
      const rev: ArchiveRevision = {
        id: `${lid}#${rv.revOrder}`,
        entryLid: lid,
        revOrder: rv.revOrder,
        createdAt: rv.createdAt,
        title: rv.title,
        archetype: rv.archetype,
        kind: rv.kind,
        snapshot: rv.snapshot,
      };
      parts.push(revCount === 0 ? j(rev) : `,${j(rev)}`);
      revCount++;
    }
  }

  // ── assets(meta は container.json、bytes は assets/<key>)
  const assetMetas = await src.listAssetMetas();
  parts.push('],"assets":[');
  assetMetas.forEach((a, i) => {
    const meta: ArchiveAsset = {
      key: a.key,
      // 読み手に「null かも」を持ち回らせない ── 書出しの時点で決める
      mime: a.mime ?? 'application/octet-stream',
      size: a.size ?? 0,
      hash: a.hash,
    };
    parts.push(i === 0 ? j(meta) : `,${j(meta)}`);
  });
  parts.push(']}');

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
        counts: {
          entries: entryCount,
          relations: relations.length,
          revisions: revCount,
          assets: assetMetas.length,
        },
      }),
    ],
  );
  await w.add(CONTAINER, parts);

  let assetCount = 0;
  for (const a of assetMetas) {
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      // 参照はあるが bytes が無い(GC の途中失敗など)── 参照は温存して言う
      warnings.push(`添付の中身が見つかりませんでした: ${a.key}`);
      continue;
    }
    await w.add(`${ASSET_PREFIX}${a.key}`, [blob]); // ⚠ Blob をそのまま(コピーしない)
    assetCount++;
  }

  // 🔴 「書き出したつもりで空」を作らない
  if (entryCount === 0) {
    throw new Error('書き出せる entry が 1 件もありません');
  }

  return {
    blob: w.finish(),
    warnings,
    counts: {
      entries: entryCount,
      relations: relations.length,
      revisions: revCount,
      assets: assetCount,
    },
  };
}

export interface Pkc3Archive {
  manifest: { format: string; version: number; exported_at?: string; cid?: string; title?: string };
  entries: ArchiveEntry[];
  relations: ArchiveRelation[];
  revisions: ArchiveRevision[];
  assets: ArchiveAsset[];
  /** asset key → bytes(**まだ読んでいない**。adapter が 1 件ずつ流す)。 */
  assetSources: Map<string, { zip: Blob; entry: import('../import/zip-reader').ZipEntry }>;
  warnings: string[];
}

/** アーカイブ ZIP を読む。**形が違えば必ず throw**(部分的に読めた気にさせない)。 */
export async function readArchive(zip: Blob): Promise<Pkc3Archive> {
  const dir = await readZipDirectory(zip);
  const warnings: string[] = [];

  const only = (name: string): import('../import/zip-reader').ZipEntry => {
    const hits = dir.filter((e) => e.name === name);
    if (hits.length === 0) throw new ZipReadError(`${name} が入っていません(壊れた ZIP)`);
    if (hits.length > 1) throw new ZipReadError(`${name} が ${hits.length} 個あります`);
    return hits[0]!;
  };

  let manifest: Pkc3Archive['manifest'];
  try {
    manifest = JSON.parse(await readZipText(zip, only(MANIFEST))) as Pkc3Archive['manifest'];
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${MANIFEST} を解釈できません: ${String(e)}`);
  }
  if (manifest?.format !== ARCHIVE_FORMAT) {
    throw new ZipReadError(
      `PKC3 のアーカイブではありません(format=${String(manifest?.format)})`,
    );
  }
  const version = manifest.version;
  if (
    typeof version !== 'number' ||
    version < ARCHIVE_MIN_VERSION ||
    version > ARCHIVE_VERSION
  ) {
    throw new ZipReadError(
      `未対応のアーカイブ版です(version=${String(version)} ── 対応は ${ARCHIVE_MIN_VERSION}〜${ARCHIVE_VERSION})`,
    );
  }

  let c: {
    entries?: ArchiveEntry[];
    relations?: ArchiveRelation[];
    revisions?: ArchiveRevision[];
    assets?: ArchiveAsset[];
  };
  try {
    c = JSON.parse(await readZipText(zip, only(CONTAINER))) as typeof c;
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${CONTAINER} を解釈できません: ${String(e)}`);
  }
  if (!Array.isArray(c.entries)) {
    throw new ZipReadError(`${CONTAINER} の形が想定と違います(entries)`);
  }

  const assetSources = new Map<string, { zip: Blob; entry: import('../import/zip-reader').ZipEntry }>();
  for (const e of dir) {
    if (e.isDirectory || !e.name.startsWith(ASSET_PREFIX)) continue;
    const key = e.name.slice(ASSET_PREFIX.length);
    if (key === '' || key.includes('/')) {
      warnings.push(`assets/ の中の想定外のファイルを無視しました: ${e.name}`);
      continue;
    }
    if (assetSources.has(key)) throw new ZipReadError(`asset key が重複しています: ${key}`);
    assetSources.set(key, { zip, entry: e });
  }

  // manifest のカウンタと中身を照合する(PKC2 は読んでさえいなかった)
  const counts = (manifest as { counts?: Record<string, number> }).counts ?? {};
  const actual: Record<string, number> = {
    entries: c.entries.length,
    relations: c.relations?.length ?? 0,
    revisions: c.revisions?.length ?? 0,
  };
  for (const [k, v] of Object.entries(actual)) {
    if (typeof counts[k] === 'number' && counts[k] !== v) {
      warnings.push(`manifest の ${k} 件数が中身と違います(${counts[k]} ≠ ${v})`);
    }
  }
  // ⚠ assets は「meta はあるが bytes が無い」が正当にありうる(書出し時の欠損)ので
  // meta 数ではなく **bytes の数**で照合する
  for (const a of c.assets ?? []) {
    if (!assetSources.has(a.key)) {
      warnings.push(`添付の中身がアーカイブに入っていません: ${a.key}`);
    }
  }

  // 🔴 **version 1 の `kind` は嘘**(全文を書きながら保存形の kind を刻んでいた)。
  // 読み側で `'full'` へ正規化する ── そうしないと復元がパッチとして適用して壊れる
  const revisions = (c.revisions ?? []).map((r) =>
    version < 2 ? { ...r, kind: 'full' } : r,
  );

  return {
    manifest,
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
  }>;
  relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>;
  /** ⚠ **key だけでなく mime も返す**(review M-4)── 落とすと Blob の type と
   * meta.mime が空になり、画像が preview されなくなる(無言で) */
  assets: Array<{ key: string; mime: string }>;
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
  warnings: string[];
} {
  const warnings = [...archive.warnings];
  const taken = new Set(opts.existingLids);
  const lidMap = new Map<string, string>();
  // 🔴 **アーカイブ内の lid 重複を先に言う**(review H-3)── 後勝ちで lidMap が
  // 上書きされると、relation の端点が原本ではなく**複製**に付け替わる。
  // 重複は本来 writer 側で起きない(H-1/H-2 を直した)が、手で組んだ / 壊れた
  // アーカイブでは来る
  const seenLid = new Set<string>();
  for (const e of archive.entries) {
    if (seenLid.has(e.lid)) {
      warnings.push(`アーカイブの中で lid が重複しています: ${e.lid}(別の entry として取り込みます)`);
    }
    seenLid.add(e.lid);
  }

  const entries = archive.entries.map((e, i) => {
    let lid = e.lid;
    if (lid === '' || taken.has(lid)) {
      const fresh = opts.genLid();
      warnings.push(`lid が既存と衝突したので付け替えました: ${e.lid || '(空)'} → ${fresh}`);
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
      body: e.body, // ⚠ **変換しない**(既に PKC-Markdown)
      entryOrder: opts.orderBase + i + 1,
    };
  });

  const takenRel = new Set(opts.existingRelationIds);
  const relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }> = [];
  for (const r of archive.relations) {
    const from = lidMap.get(r.fromLid);
    const to = lidMap.get(r.toLid);
    if (!from || !to) {
      // 端点が居ない = アーカイブが壊れている ── 黙って落とさない
      warnings.push(`端点の無い関連を除きました: ${r.id}`);
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
  if (orphanRevs > 0) {
    // entry が居ない履歴 = ゴミ箱の版。**今は復元しない**(entry が無いと鎖の
    // 起点 = tip が無く、decode できない)── 黙って落とさず件数を言う
    warnings.push(`entry の無い履歴 ${orphanRevs} 版は復元しませんでした(ゴミ箱の版)`);
  }
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

  return { entries, relations, assets, revisionChains, warnings };
}
