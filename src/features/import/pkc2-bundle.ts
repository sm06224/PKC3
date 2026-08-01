/**
 * P6c 段③: 単体 entry バンドル(`.text.zip` / `.textlog.zip`)の受理。
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
 *
 * `.textlog.zip`(`textlog-bundle.ts:49-70`)は **manifest の形がほぼ同じ**で
 * (`body_length` が `entry_count` になるだけ)、payload が `body.md` →
 * `textlog.csv` に替わる。だから受理器も **payload の読み方だけ**が違う。
 */
import {
  readZipDirectory,
  readZipText,
  ZipReadError,
  type ZipEntry,
} from './zip-reader';
import { parseTextlogCsv, TextlogCsvError } from './textlog-csv';

export interface Pkc2TextBundleManifest {
  format: string;
  version: number;
  source_lid?: string;
  source_title?: string;
  entry_count?: number;
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
const TEXTLOG = 'textlog.csv';
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
 * bundle 共通の受理(manifest 検証 + asset 突合)。payload の読み方だけが
 * 形式ごとに違うので、そこは呼び出し側が行う。
 */
async function readBundleCommon(
  zip: Blob,
  expectedFormat: string,
): Promise<{
  dir: ZipEntry[];
  manifest: Pkc2TextBundleManifest;
  assetEntries: Map<string, ZipEntry>;
  warnings: string[];
}> {
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
  if (manifest?.format !== expectedFormat) {
    throw new ZipReadError(
      `この段では ${expectedFormat} のみ扱えます(format=${String(manifest?.format)})`,
    );
  }
  if (manifest.version !== 1) {
    throw new ZipReadError(
      `未対応の bundle version です(version=${String(manifest.version)} ── 対応は 1)`,
    );
  }

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

  return { dir, manifest, assetEntries, warnings };
}

/**
 * 合成 container を組む(§2-5)。attachment × N + 本体 × 1。
 *
 * ⚠ attachment の JSON は *PKC2 入力の写し*であって、保存されるのは
 * `fromPkc2` を通した後の PKC-Markdown だけ ── 規律違反ではない。
 */
function synthesize(
  manifest: Pkc2TextBundleManifest,
  assetEntries: Map<string, ZipEntry>,
  main: { archetype: string; body: string; fallbackLid: string },
): unknown {
  const declared = manifest.assets ?? {};
  const entries: unknown[] = [];
  for (const [key, entry] of assetEntries) {
    const meta = declared[key] ?? {};
    entries.push({
      lid: ATTACHMENT_LID(key),
      title: meta.name || key,
      archetype: 'attachment',
      body: JSON.stringify({
        name: meta.name || key,
        mime: meta.mime || 'application/octet-stream',
        size: entry.uncompressedSize, // manifest に無いので展開後の長さ(PKC2 と同じ)
        asset_key: key,
      }),
    });
  }
  entries.push({
    lid: manifest.source_lid || main.fallbackLid,
    title: manifest.source_title || '(無題)',
    archetype: main.archetype,
    body: main.body,
  });
  return { meta: {}, entries, relations: [], revisions: [], assets: {} };
}

/** `.text.zip` を受理する(`body.md` は markdown verbatim)。 */
export async function readTextBundle(zip: Blob): Promise<Pkc2Bundle> {
  const { dir, manifest, assetEntries, warnings } = await readBundleCommon(
    zip,
    'pkc2-text-bundle',
  );
  const body = await readZipText(zip, only(dir, BODY));
  return {
    manifest,
    container: synthesize(manifest, assetEntries, {
      archetype: 'text',
      body, // text 系は fromPkc2 を持たないので素通り
      fallbackLid: 'bundle-text',
    }),
    assetEntries,
    warnings,
  };
}

/**
 * `.textlog.zip` を受理する。
 *
 * CSV は **PKC2 の TextlogBody JSON へ逆写像**してから合成 container に載せる ──
 * `getFlavor('textlog').fromPkc2` がその JSON を取るので、textlog 専用の変換を
 * 二重に持たずに済む(P6a の anchor 対応表もこの JSON を前提にしている)。
 */
export async function readTextlogBundle(zip: Blob): Promise<Pkc2Bundle> {
  const { dir, manifest, assetEntries, warnings } = await readBundleCommon(
    zip,
    'pkc2-textlog-bundle',
  );
  const csv = await readZipText(zip, only(dir, TEXTLOG));
  let parsed;
  try {
    parsed = parseTextlogCsv(csv);
  } catch (e) {
    if (e instanceof TextlogCsvError) throw new ZipReadError(e.message);
    throw e;
  }
  // PKC2 は log_id の無い行を**黙って**捨てていた ── skip は踏襲しつつ可視化する
  if (parsed.skippedRows > 0) {
    warnings.push(`log_id の無い行を ${parsed.skippedRows} 行読み飛ばしました`);
  }
  if (
    typeof manifest.entry_count === 'number' &&
    manifest.entry_count !== parsed.entries.length
  ) {
    warnings.push(
      `manifest の entry 件数が CSV と違います(${manifest.entry_count} ≠ ${parsed.entries.length})`,
    );
  }
  return {
    manifest,
    container: synthesize(manifest, assetEntries, {
      archetype: 'textlog',
      // PKC2 入力の写し(fromPkc2 が PKC-Markdown へ変換する)
      body: JSON.stringify({ entries: parsed.entries }),
      fallbackLid: 'bundle-textlog',
    }),
    assetEntries,
    warnings,
  };
}
