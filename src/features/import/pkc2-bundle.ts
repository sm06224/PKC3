/**
 * P6c 段③: `.text.zip`(`pkc2-text-bundle`)の受理。
 *
 * package(段②)と違い **`container.json` を持たない**ので、PKC3 側で
 * `Pkc2Container` 形の**合成物**を組み立てて `convertPkc2Container` に渡す。
 *
 * ⚠ **「JSON body を作っている」ように見えるが規律違反ではない。**
 * ここで作る attachment の JSON は *PKC2 入力の写し*であって、保存されるのは
 * `getFlavor('attachment').fromPkc2` を通した後の **PKC-Markdown だけ**である。
 * この 1 行を消すと、次のセッションが「JSON body を作るな」の一言で正しい実装を壊す。
 *
 * ## PKC2 の writer を実地で確認した事実(2026-08-01、read-only 調査)
 * `text-bundle.ts:106-160` / `:516-547`:
 * - `manifest.json` / `body.md`(**markdown verbatim**)/ `assets/<key><ext>`
 * - 🔑 **`manifest.assets` が `key → {name, mime}` の正本** ── だから
 *   「ファイル名から拡張子を剥がして key を復元する」必要が**無い**
 *   (PKC2 の読み側は剥がしており、key に `.` や非 ASCII が入ると無言で落ちていた)
 * - `<ext>` は `chooseExtension(name, mime)` 由来で、**空になりうる**
 *   (未知 mime)── 突合は「`assets/<key>` 完全一致」か「`assets/<key>.` で始まる」
 * - `missing_asset_keys` は**原文基準**の監査証跡(compact mode で body から
 *   参照が消えても変わらない)。`body_length` は **compact 後**で、非対称は意図的
 * - attachment の `size` は manifest に無い ── 展開後のバイト長を使う(PKC2 と同じ)
 */
import {
  readZipDirectory,
  readZipText,
  ZipReadError,
  type ZipEntry,
} from './zip-reader';

export interface Pkc2TextBundleManifest {
  format: string;
  version: number;
  source_lid?: string;
  source_title?: string;
  asset_count?: number;
  missing_asset_count?: number;
  missing_asset_keys?: string[];
  assets?: Record<string, { name?: string; mime?: string }>;
  compacted?: boolean;
}

export interface Pkc2Bundle {
  manifest: Pkc2TextBundleManifest;
  /** convert に渡す合成 container(PKC2 入力の写し)。 */
  container: unknown;
  assetEntries: Map<string, ZipEntry>;
  warnings: string[];
}

const MANIFEST = 'manifest.json';
const BODY = 'body.md';
/** 合成 attachment entry の lid(convert が衝突時に再採番する)。 */
const ATTACHMENT_LID = (key: string): string => `bundle-att-${key}`;

/** 同名が複数あるものを 1 件に絞る(0 / 2 以上は呼び出し側が決める)。 */
function only(dir: readonly ZipEntry[], name: string): ZipEntry {
  const hits = dir.filter((e) => e.name === name);
  if (hits.length === 0) throw new ZipReadError(`${name} が入っていません(壊れた ZIP)`);
  if (hits.length > 1) {
    throw new ZipReadError(`${name} が ${hits.length} 個あります(壊れた ZIP)`);
  }
  return hits[0]!;
}

/**
 * `.text.zip` を受理して、convert に渡せる合成 container まで組む。
 * **形が違えば必ず throw**(部分的に読めた気にさせない)。
 */
export async function readTextBundle(zip: Blob): Promise<Pkc2Bundle> {
  const dir = await readZipDirectory(zip);
  const warnings: string[] = [];

  if (dir.some((e) => e.name === '[Content_Types].xml')) {
    throw new ZipReadError(
      'これは Office 文書(.xlsx / .docx / .pptx)です ── 取込対象ではありません',
    );
  }

  let manifest: Pkc2TextBundleManifest;
  try {
    manifest = JSON.parse(await readZipText(zip, only(dir, MANIFEST))) as Pkc2TextBundleManifest;
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${MANIFEST} を解釈できません: ${String(e)}`);
  }
  if (manifest?.format !== 'pkc2-text-bundle') {
    throw new ZipReadError(
      `この段では pkc2-text-bundle のみ扱えます(format=${String(manifest?.format)})`,
    );
  }
  if (manifest.version !== 1) {
    throw new ZipReadError(
      `未対応の bundle version です(version=${String(manifest.version)} ── 対応は 1)`,
    );
  }

  const body = await readZipText(zip, only(dir, BODY));

  // ── asset: **manifest の key を正**として ZIP entry を引く。
  // 拡張子は空になりうるので「完全一致 or `<key>.` 始まり」で照合する
  // (前方一致だけだと key `k1` が `assets/k1x.png` に当たる)
  const declared = manifest.assets ?? {};
  const assetEntries = new Map<string, ZipEntry>();
  const claimed = new Set<string>();
  for (const key of Object.keys(declared)) {
    const exact = `assets/${key}`;
    const hits = dir.filter(
      (e) => !e.isDirectory && (e.name === exact || e.name.startsWith(`${exact}.`)),
    );
    if (hits.length === 0) {
      // manifest にあって実体が無い ── 参照は壊れたまま温存し(壊れシグナルの
      // 保存)、件数を可視化する
      warnings.push(`添付の中身が bundle に入っていません: ${key}`);
      continue;
    }
    if (hits.length > 1) {
      // どれが正か決められない = 片方を静かに捨てる方が危険
      throw new ZipReadError(
        `添付の実体が複数あります(${key}): ${hits.map((h) => h.name).join(' / ')}`,
      );
    }
    assetEntries.set(key, hits[0]!);
    claimed.add(hits[0]!.name);
  }
  // ZIP にあって manifest に無い assets/* ── user が「入れたのに入らない」を
  // 検知できるようにする(PKC2 は無言で無視していた)
  for (const e of dir) {
    if (e.isDirectory || !e.name.startsWith('assets/') || claimed.has(e.name)) continue;
    warnings.push(`manifest に無い添付を無視しました: ${e.name}`);
  }

  // 監査証跡は黙って捨てない
  for (const k of manifest.missing_asset_keys ?? []) {
    warnings.push(`書出し時点で既に失われていた添付: ${k}`);
  }
  if (manifest.compacted === true) {
    warnings.push('書出し時に壊れた添付参照が本文から除かれています(compact mode)');
  }

  // ── 合成 container(§2-5)。attachment × N + text × 1
  const entries: unknown[] = [];
  for (const [key, entry] of assetEntries) {
    const meta = declared[key] ?? {};
    entries.push({
      lid: ATTACHMENT_LID(key),
      title: meta.name || key,
      archetype: 'attachment',
      // PKC2 入力の写し ── fromPkc2 を通した後の PKC-Markdown だけが保存される
      body: JSON.stringify({
        name: meta.name || key,
        mime: meta.mime || 'application/octet-stream',
        size: entry.uncompressedSize, // manifest に無いので展開後の長さ(PKC2 と同じ)
        asset_key: key,
      }),
    });
  }
  entries.push({
    lid: manifest.source_lid || 'bundle-text',
    title: manifest.source_title || '(無題)',
    archetype: 'text',
    body, // markdown verbatim(text 系は fromPkc2 を持たないので素通り)
  });

  return {
    manifest,
    container: { meta: {}, entries, relations: [], revisions: [], assets: {} },
    assetEntries,
    warnings,
  };
}
