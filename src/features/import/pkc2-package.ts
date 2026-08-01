/**
 * P6c 段②: `pkc2-package` ZIP(PKC2 のバックアップ正本)の受理。
 *
 * **変換 core をそのまま再利用できる唯一の形式** ── `container.json` が
 * Container そのものなので、P6a/P6b が pin 済みの `convertPkc2Container` に直結する。
 * ここが通れば「PKC2 のバックアップから救出できる」が成立する。
 *
 * ## PKC2 の writer を実地で確認した事実(2026-08-01、read-only 調査)
 * `zip-package.ts:139-165` / `:600-690`:
 * - `manifest.json` = `{format:'pkc2-package', version:1, exported_at, source_cid,
 *   entry_count, relation_count, revision_count, asset_count}`(2 space の整形 JSON)
 * - `container.json` = Container 全体から **`assets` を空にしたもの**
 * - asset は `assets/<key>.bin` に **生バイナリ**(base64 ではない)
 * - writer は **method 0(store)固定** + **flag 0x0800(UTF-8 名)常時**
 *   + **本物の CRC-32**(同じ多項式)── PKC3 の reader の検証と噛み合う
 * - PKC2 自身の reader は method 0 しか読めない ── PKC3 は deflate も受理するので
 *   「ZIP ツールで開いて再梱包した」ファイルまで読める
 *
 * ⚠ **bytes はここで読まない**。返すのは「どの ZIP entry か」までで、実際の
 * 読取りは adapter が 1 件ずつ行って即 `putBlob` する(base64 を一切経由しない)。
 */
import {
  readZipDirectory,
  readZipText,
  ZipReadError,
  type AssetSource,
} from './zip-reader';

/** PKC2 の PackageManifest(zip-package.ts:36-45 と同一の field 集合)。 */
export interface Pkc2PackageManifest {
  format: string;
  version: number;
  exported_at?: string;
  source_cid?: string;
  entry_count?: number;
  relation_count?: number;
  revision_count?: number;
  asset_count?: number;
}

export interface Pkc2Package {
  manifest: Pkc2PackageManifest;
  /** `container.json` の中身(shape 検査済み ── 変換は adapter が convert へ渡す)。 */
  container: unknown;
  /** PKC2 の asset key → その bytes の在り処(**まだ読んでいない**)。 */
  assetEntries: Map<string, AssetSource>;
  warnings: string[];
}

const MANIFEST = 'manifest.json';
const CONTAINER = 'container.json';
const ASSET_RE = /^assets\/(.+)\.bin$/;
/** PKC2 の asset key の字種(3 系統 + 派生。`.` を含む派生があるので許す)。 */
const VALID_KEY = /^[A-Za-z0-9_.-]+$/;

/**
 * ZIP の `manifest.json` から `format` だけを覗く(どの受理器に渡すかの判別)。
 * ⚠ **`detectPkc2Format` は 1 段ぶんしか受けない**ので、ネストの各段でこれを呼ぶ。
 * manifest が無い / 読めない場合は null(呼び出し側が可視で断る)。
 */
export async function peekZipFormat(zip: Blob): Promise<string | null> {
  const dir = await readZipDirectory(zip);
  if (dir.some((e) => e.name === '[Content_Types].xml')) {
    throw new ZipReadError(
      'これは Office 文書(.xlsx / .docx / .pptx)です ── 取込対象ではありません',
    );
  }
  const hits = dir.filter((e) => e.name === MANIFEST);
  if (hits.length !== 1) return null;
  try {
    const m = JSON.parse(await readZipText(zip, hits[0]!)) as { format?: unknown };
    return typeof m.format === 'string' ? m.format : null;
  } catch {
    return null;
  }
}

/**
 * ZIP を `pkc2-package` として受理する。
 * **形が違えば必ず throw**(部分的に読めた気にさせない ── P6b で確立した規律)。
 */
export async function readPkc2Package(zip: Blob): Promise<Pkc2Package> {
  const dir = await readZipDirectory(zip);
  const warnings: string[] = [];

  // 同じ入口に落ちてくる PKC2 由来でない ZIP を**名指しで**断る。
  // 「manifest.json が無い = 不明」に混ぜると user は原因を誤解する
  if (dir.some((e) => e.name === '[Content_Types].xml')) {
    throw new ZipReadError(
      'これは Office 文書(.xlsx / .docx / .pptx)です ── 取込対象ではありません',
    );
  }

  const manifests = dir.filter((e) => e.name === MANIFEST);
  if (manifests.length === 0) {
    throw new ZipReadError(
      `${MANIFEST} が無い ZIP です ── PKC2 のバックアップ(.pkc2.zip)を選んでください`,
    );
  }
  // 重複は **断る**(PKC2 は first-wins + warning だが、どちらが正か決められない
  // 以上、片方を静かに捨てる方が危険 ── 設計 doc §4-D)
  if (manifests.length > 1) {
    throw new ZipReadError(`${MANIFEST} が ${manifests.length} 個あります(壊れた ZIP)`);
  }

  let manifest: Pkc2PackageManifest;
  try {
    manifest = JSON.parse(await readZipText(zip, manifests[0]!)) as Pkc2PackageManifest;
  } catch (e) {
    throw new ZipReadError(`${MANIFEST} を解釈できません: ${String(e)}`);
  }
  if (manifest?.format !== 'pkc2-package') {
    throw new ZipReadError(
      `この段では pkc2-package のみ扱えます(format=${String(manifest?.format)})`,
    );
  }
  // 未知の版は**明示 reject** ── 「読めるところだけ読む」は静かな欠損を作る
  if (manifest.version !== 1) {
    throw new ZipReadError(
      `未対応の package version です(version=${String(manifest.version)} ── 対応は 1)`,
    );
  }

  const containers = dir.filter((e) => e.name === CONTAINER);
  if (containers.length === 0) {
    throw new ZipReadError(`${CONTAINER} が入っていません(壊れた ZIP)`);
  }
  if (containers.length > 1) {
    throw new ZipReadError(`${CONTAINER} が ${containers.length} 個あります(壊れた ZIP)`);
  }
  let container: unknown;
  try {
    container = JSON.parse(await readZipText(zip, containers[0]!));
  } catch (e) {
    throw new ZipReadError(`${CONTAINER} の JSON を解釈できません: ${String(e)}`);
  }
  const c = container as { meta?: unknown; entries?: unknown } | null;
  if (!c || typeof c !== 'object' || !c.meta || !Array.isArray(c.entries)) {
    throw new ZipReadError('container.json の形が想定と違います(meta / entries)');
  }

  // ── asset: `assets/<key>.bin` の**完全一致**で引く。
  // (bundle 系のように拡張子を剥がす突合はしない ── key に `.` が入ると
  //  マッチせず無言欠落する。package は writer が `.bin` 固定なので厳密に引ける)
  const assetEntries = new Map<string, AssetSource>();
  for (const e of dir) {
    if (e.isDirectory) continue;
    if (!e.name.startsWith('assets/')) continue;
    const m = ASSET_RE.exec(e.name);
    if (!m) {
      // PKC2 は `.bin` 以外を**無警告で無視**していた ── 黙って落とさない
      warnings.push(`assets/ の中の想定外のファイルを無視しました: ${e.name}`);
      continue;
    }
    const key = m[1]!;
    // 名前の無害化は **key として使う側**の責務(reader は純機構)。
    // `..` / 絶対パス / null バイト等は PKC3 では FS に書かないので traversal 自体は
    // 無害だが、key としては不正 ── PKC2 も `INVALID_ASSET_KEY` で弾いていた
    if (!VALID_KEY.test(key)) {
      warnings.push(`asset key として不正な名前を無視しました: ${e.name}`);
      continue;
    }
    if (assetEntries.has(key)) {
      throw new ZipReadError(`asset key が重複しています: ${key}(壊れた ZIP)`);
    }
    assetEntries.set(key, { zip, entry: e });
  }

  // manifest のカウンタは PKC2 importer が一切照合していない ── PKC3 は照合して
  // **warning に出す**(断りはしない: 正当な差がありうる)
  const counts: Array<[string, number | undefined, number]> = [
    ['entry', manifest.entry_count, (c.entries as unknown[]).length],
    [
      'relation',
      manifest.relation_count,
      Array.isArray((c as { relations?: unknown }).relations)
        ? ((c as { relations: unknown[] }).relations).length
        : 0,
    ],
    [
      'revision',
      manifest.revision_count,
      Array.isArray((c as { revisions?: unknown }).revisions)
        ? ((c as { revisions: unknown[] }).revisions).length
        : 0,
    ],
    ['asset', manifest.asset_count, assetEntries.size],
  ];
  for (const [label, declared, actual] of counts) {
    if (typeof declared === 'number' && declared !== actual) {
      warnings.push(`manifest の ${label} 件数が中身と違います(${declared} ≠ ${actual})`);
    }
  }

  return { manifest, container, assetEntries, warnings };
}
