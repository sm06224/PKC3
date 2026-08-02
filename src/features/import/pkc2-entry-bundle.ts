/**
 * P6c 段⑥: `pkc2-entry-bundle`(`.entry.zip`)の受理。**P6c の最後の形式**。
 *
 * これだけ PKC2 に**読む実装が無い**(書きっぱなしの形式)。folder-export v2 が
 * `.entry.zip` を同梱するが、PKC2 の batch importer は**無言で skip** していた
 * ── つまり PKC2 で書き出して PKC2 で読み戻せない唯一の形式である。
 *
 * ## 実物で確認した事実(2026-08-02、PKC2 の writer を直接動かして生成)
 * `tests/fixtures/pkc2/single.entry.zip` / `attachment.entry.zip` / `text-meta.entry.zip`:
 * - `manifest.json` は **7 field だけ**(`format` / `version` / `archetype` / `lid` /
 *   `title` / `asset_count` / `missing_asset_count`)── `assets` 索引も
 *   `missing_asset_keys` も `compacted` も**無い**
 * - `entry.json` は **Entry を verbatim**。text/textlog bundle が落とす
 *   `created_at` / `tags` / `color_tag` が**ここにだけ残る**
 * - 🔑 `assets/<key>` は **base64 テキスト**(拡張子なし)。text/textlog bundle が
 *   `assets/<key><ext>` に**生バイト**を書くのと**非互換** ── 実物で確認済み
 *   (`iVBORw0KGgo...` が入っており、復号すると PNG 署名 `\x89PNG` が出る)
 *
 * ## 落ちるもの(現時点の PKC3 スキーマの限界。黙って落とさず言う)
 * `entry.json` の `created_at` / `tags` / `color_tag` は、PKC3 の `EntryUpsert` にも
 * `entries` 表にも受け皿が無い(tags は「全 body = PKC-Markdown」の方針からすると
 * frontmatter へ入るべきだが、その規約はまだ決まっていない)。**取込時に件数を言う**。
 */
import { readZipDirectory, readZipText, ZipReadError, type AssetSource } from './zip-reader';
import {
  MANIFEST,
  onlyEntry,
  sourcesOf,
  synthesize,
  type BundleAsset,
  type BundleParts,
  type Pkc2Bundle,
} from './pkc2-bundle';

export const ENTRY_BUNDLE_FORMAT = 'pkc2-entry-bundle';
const ENTRY_JSON = 'entry.json';
/** `assets/<key>`(**拡張子なし**)── text/textlog bundle と違い剥がす対象が無い。 */
const ASSET_PREFIX = 'assets/';

export interface Pkc2EntryBundleManifest {
  format: string;
  version: number;
  archetype?: string;
  lid?: string;
  title?: string;
  asset_count?: number;
  missing_asset_count?: number;
}

/** PKC3 が受け皿を持たない field(取込時に「落ちた」と言うために数える)。 */
const DROPPED_FIELDS = ['created_at', 'updated_at', 'tags', 'color_tag', 'display_profile'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * `.entry.zip` の中身を取り出す(batch から再入するときはこちらを使う)。
 * @returns `dropped` = entry.json にあったが PKC3 に持ち込めない field 名
 */
export async function readEntryBundleParts(
  zip: Blob,
): Promise<BundleParts & { dropped: string[] }> {
  const dir = await readZipDirectory(zip);
  const warnings: string[] = [];

  if (dir.some((e) => e.name === '[Content_Types].xml')) {
    throw new ZipReadError(
      'これは Office 文書(.xlsx / .docx / .pptx)です ── 取込対象ではありません',
    );
  }

  let manifest: Pkc2EntryBundleManifest;
  try {
    manifest = JSON.parse(
      await readZipText(zip, onlyEntry(dir, MANIFEST)),
    ) as Pkc2EntryBundleManifest;
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${MANIFEST} を解釈できません: ${String(e)}`);
  }
  if (manifest?.format !== ENTRY_BUNDLE_FORMAT) {
    throw new ZipReadError(
      `この受理器は ${ENTRY_BUNDLE_FORMAT} のみ扱えます(format=${String(manifest?.format)})`,
    );
  }
  if (manifest.version !== 1) {
    throw new ZipReadError(
      `未対応の bundle version です(version=${String(manifest.version)} ── 対応は 1)`,
    );
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(await readZipText(zip, onlyEntry(dir, ENTRY_JSON))) as Record<
      string,
      unknown
    >;
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${ENTRY_JSON} を解釈できません: ${String(e)}`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ZipReadError(`${ENTRY_JSON} の形が想定と違います`);
  }

  // 🔑 **正は entry.json**(Entry verbatim)。manifest は目次の写しなので、
  // 食い違うのは組み立ての事故 ── 黙って選ばず言う
  const archetype = str(record.archetype) || str(manifest.archetype);
  if (archetype === '') {
    throw new ZipReadError(`${ENTRY_JSON} に archetype がありません`);
  }
  for (const [label, a, b] of [
    ['lid', str(manifest.lid), str(record.lid)],
    ['タイトル', str(manifest.title), str(record.title)],
    ['archetype', str(manifest.archetype), str(record.archetype)],
  ] as const) {
    if (a !== '' && b !== '' && a !== b) {
      warnings.push(`目次と中身で ${label} が違います(${a} ≠ ${b})── 中身を採ります`);
    }
  }

  // ── asset: `assets/<key>` の**完全一致**(拡張子は付かない)。
  // ⚠ 中身は **base64 テキスト**なので、読み手に復号が要ることを型で伝える
  const assets = new Map<string, BundleAsset>();
  for (const e of dir) {
    if (e.isDirectory || !e.name.startsWith(ASSET_PREFIX)) continue;
    const key = e.name.slice(ASSET_PREFIX.length);
    if (key === '' || key.includes('/')) {
      warnings.push(`assets/ の中の想定外のファイルを無視しました: ${e.name}`);
      continue;
    }
    if (assets.has(key)) {
      throw new ZipReadError(`asset key が重複しています: ${key}(壊れた ZIP)`);
    }
    assets.set(key, {
      source: { zip, entry: e, base64: true },
      name: key,
      mime: 'application/octet-stream',
    });
  }
  if (typeof manifest.asset_count === 'number' && manifest.asset_count !== assets.size) {
    warnings.push(`manifest の asset 件数が中身と違います(${manifest.asset_count} ≠ ${assets.size})`);
  }
  // ⚠ この形式には `missing_asset_keys` が**無い**ので、これが唯一の監査証跡
  // (review M-3)── text/textlog bundle は key を名指しできるが、ここは件数だけ。
  // 宣言だけして読まないのは PKC2 を批判している当の振る舞い
  if (typeof manifest.missing_asset_count === 'number' && manifest.missing_asset_count > 0) {
    warnings.push(
      `書出し時点で既に失われていた添付が ${manifest.missing_asset_count} 件あります` +
        '(この形式は key を記録しないので、どれかは分かりません)',
    );
  }

  const dropped = DROPPED_FIELDS.filter((f) => record[f] !== undefined && record[f] !== null);

  return {
    manifest: { format: ENTRY_BUNDLE_FORMAT, version: 1 },
    main: {
      lid: str(record.lid) || str(manifest.lid) || 'bundle-entry',
      title: str(record.title) || str(manifest.title) || '(無題)',
      archetype,
      body: str(record.body),
    },
    assets,
    warnings,
    dropped,
  };
}

/**
 * 添付そのものを書き出した `.entry.zip` は、**entry 自身が attachment**なので
 * `synthesize` に同じ key を渡すと attachment が 2 つできる。entry が宣言している
 * key を除いてから渡す(在り処は全部返す ── bytes は要る)。
 */
export function assetsForSynthesis(
  assets: ReadonlyMap<string, BundleAsset>,
  mains: readonly { archetype: string; body: string }[],
): Map<string, BundleAsset> {
  const declared = new Set<string>();
  for (const m of mains) {
    if (m.archetype !== 'attachment') continue;
    try {
      const k = (JSON.parse(m.body) as { asset_key?: unknown }).asset_key;
      if (typeof k === 'string' && k !== '') declared.add(k);
    } catch {
      // body が JSON でない = PKC2 の attachment ではない ── 何も宣言していない
    }
  }
  const out = new Map<string, BundleAsset>();
  for (const [k, a] of assets) if (!declared.has(k)) out.set(k, a);
  return out;
}

/**
 * 落ちる field を 1 行の warning にまとめる。
 * ⚠ **件数を必ず出す**(review M-2)── 300 件の書出しで 1 件なのか 300 件なのかが
 * 分からないと、user は「無視してよい注意」か「取り込み直すべき」かを判断できない。
 */
export function droppedFieldsWarning(dropped: readonly string[], entries = 1): string[] {
  if (dropped.length === 0 || entries === 0) return [];
  const uniq = [...new Set(dropped)].join(' / ');
  return [
    `${entries} 件の entry で、この形式にしか無い情報を取り込めませんでした(${uniq})` +
      ' ── PKC3 側に受け皿がまだありません',
  ];
}

/** 単体 `.entry.zip` を受理する。 */
export async function readEntryBundle(zip: Blob): Promise<Pkc2Bundle> {
  const parts = await readEntryBundleParts(zip);
  const mains = [parts.main];
  return {
    manifest: parts.manifest,
    container: synthesize(assetsForSynthesis(parts.assets, mains), mains),
    assetSources: sourcesOf(parts.assets) as Map<string, AssetSource>,
    warnings: [...parts.warnings, ...droppedFieldsWarning(parts.dropped, 1)],
  };
}
