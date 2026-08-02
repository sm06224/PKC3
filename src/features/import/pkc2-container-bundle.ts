/**
 * P6c 段④: batch(複数 entry を 1 ZIP に束ねた)形式の受理。
 *
 * 段③(単体 bundle)の**再帰適用**。新しい機構は「内側 ZIP を Blob として
 * reader に再入する」1 点だけで、それは段①の Blob ベース設計で既に用意済み。
 *
 * 🔑 **store ならゼロコピーが最後まで保たれる**(user 指示 2026-07-27、不可侵)。
 * PKC2 の writer は外側も内側も **method 0(store)固定**なので、
 * `readZipEntry` は `Blob.slice`(= view)を返す。内側 ZIP は外側の view、
 * 内側の asset はさらにその view ── **どの段でもコピーを 1 部も作らない**。
 * ⚠ **deflate の内側 ZIP は実体化される**(`DecompressionStream` の出力を Blob に
 * 起こすため)。PKC3 が deflate も受理するのは「ZIP ツールで再梱包したファイルも
 * 読める」ためで、その経路の常駐量は**測っていない** ── ゼロコピーを主張しない。
 *
 * ⚠ **1 個の合成 container にまとめて 1 回 convert する**(設計 doc §2-5)。
 * entry ごとに convert すると lid 衝突検査と asset key 採番検査が分断される。
 *
 * ## PKC2 の writer を実地で確認した事実(2026-08-01、read-only 調査)
 * 設計 doc は「3 形式は外側 manifest の形が違うだけ」と書いていたが、**違った**:
 *
 * | format | 件数の field | `archetype` |
 * |---|---|---|
 * | `pkc2-texts-container-bundle` | `entry_count` | **無い**(format から決まる) |
 * | `pkc2-textlogs-container-bundle` | `entry_count` | **無い** |
 * | `pkc2-mixed-container-bundle` | `text_count` + `textlog_count` | **ある** |
 *
 * - 🔑 **`compact`(外側 top-level)と `compacted`(内側 top-level)は別綴りの別 field**
 * - `body_length` / `log_entry_count` は**どちらか一方だけ書かれ、他方は key ごと不在**
 * - 外側 ZIP は **flat**(`entries/` のようなディレクトリは無い)。内側 ZIP は
 *   `manifest.entries[].filename` が正本で、同名衝突は `-2` を**拡張子の直前**に挿す
 * - 内側 ZIP は**単体 export とまったく同じ構造**(内側 `format` も
 *   `pkc2-text-bundle` / `pkc2-textlog-bundle` のまま。batch である印は内側に無い)
 * - 🔑 **asset は内側 ZIP それぞれに完全複製される**。1 個の画像を 2 ノートが
 *   参照していると、同じバイナリが 2 つの `.text.zip` に丸ごと入る。PKC2 は
 *   取込時にこれを統合せず **attachment entry 2 個・asset 2 本**を作っていた
 *   (共有関係が失われる)── PKC3 は content addressing で bytes を 1 本に畳み、
 *   attachment entry も asset key で 1 件に畳む
 *
 * ## この段では受けない形式
 * `pkc2-folder-export-bundle`(段⑤)/ `pkc2-entry-bundle`(段⑥)は**名指しで断る**。
 * 「読めるところだけ読む」は静かな欠損を作る。
 */
import {
  readZipDirectory,
  readZipEntry,
  readZipText,
  ZipReadError,
  type AssetSource,
  type ZipEntry,
} from './zip-reader';
import {
  COMPACTED_WARNING,
  MANIFEST,
  onlyEntry,
  readBundleParts,
  sourcesOf,
  synthesize,
  type BundleAsset,
  type BundleMain,
} from './pkc2-bundle';
import { readEntryBundleParts } from './pkc2-entry-bundle';

/** batch 形式 → 内側 archetype(null = `entries[].archetype` が正本)。 */
const BATCH_FORMATS: Record<string, 'text' | 'textlog' | null> = {
  'pkc2-texts-container-bundle': 'text',
  'pkc2-textlogs-container-bundle': 'textlog',
  'pkc2-mixed-container-bundle': null,
};

/**
 * ⚠ `format in BATCH_FORMATS` と書いてはいけない(review H-1)。`in` は
 * prototype chain を見るので `'toString'` / `'constructor'` / `'valueOf'` が
 * **batch 形式として受理され**、`BATCH_FORMATS[format]` が `Object.prototype` の
 * 関数を返す ── それが archetype として通り、textlog が
 * 「JSON 文字列を本文に持つ text ノート」として無警告で保存される
 * (PKC3 の「JSON 文字列 body を作らない」に真っ向から反する状態が生まれる)。
 */
export const isBatchFormat = (format: string): boolean =>
  Object.hasOwn(BATCH_FORMATS, format);

export interface OuterEntry {
  lid?: unknown;
  title?: unknown;
  archetype?: unknown;
  filename?: unknown;
  /** folder-export のみ(段⑤)。直近の structural 親 folder の lid。 */
  parent_folder_lid?: unknown;
}

/**
 * 内側 bundle 1 件の読み取り結果。
 *
 * 🔑 **`outer` を `main` と組で持つ**のが要点(PKC2 の実バグ回避)。PKC2 は
 * preview を **manifest 配列の添字**で持ちながら、取込は **未対応形式を飛ばして
 * 詰めた配列**を返し、planner がその圧縮配列を**選択添字で引いて**いた ──
 * 結果、v2 の folder-export で **選ばなかった entry が入り、選んだ entry が落ちる**
 * (調査 S-2)。組で持てば添字の空間を混ぜる余地が構造的に無い。
 */
export interface InnerBundle {
  main: BundleMain;
  outer: OuterEntry;
  filename: string;
}

/** 内側 bundle の読み方(未対応形式は 'skip' を返す ── 段⑤ v2 の `.entry.zip`)。 */
export type ArchetypeResolver = (
  me: OuterEntry,
  where: string,
  warnings: string[],
) => 'text' | 'textlog' | 'entry' | 'skip';

export interface InnerBundlesResult {
  bundles: InnerBundle[];
  assets: Map<string, BundleAsset>;
  alternates: Map<string, AssetSource[]>;
  counted: { text: number; textlog: number; entry: number };
  /** `.entry.zip` にあったが PKC3 に持ち込めない field(段⑥)。 */
  dropped: { fields: string[]; entries: number };
  failed: string[];
  skipped: string[];
  anyCompacted: boolean;
  used: Set<string>;
  warnings: string[];
}

export interface Pkc2ContainerBundleManifest {
  format: string;
  version: number;
  exported_at?: string;
  source_cid?: string;
  source_title?: string;
  /** texts / textlogs のみ(mixed には**無い**)。 */
  entry_count?: number;
  /** mixed のみ。 */
  text_count?: number;
  /** mixed のみ。 */
  textlog_count?: number;
  /** ⚠ 内側の `compacted` とは**別綴りの別 field**。 */
  compact?: boolean;
  entries?: OuterEntry[];
}

export interface Pkc2ContainerBundle {
  manifest: Pkc2ContainerBundleManifest;
  container: unknown;
  assetSources: Map<string, AssetSource>;
  /**
   * 同じ key の**別の複製**(review M-5)。batch では同じ添付が内側 ZIP ごとに
   * 丸ごと複製されるので、先頭が読めなくても他から復元できる ── 畳み込みで
   * 冗長性まで捨てると PKC2 より弱くなる。先頭は `assetSources` と同じ。
   */
  assetAlternates: Map<string, AssetSource[]>;
  warnings: string[];
}

/**
 * 内側 archetype を決める。
 * texts / textlogs は **format から**(`entries[].archetype` は writer が書かない)、
 * mixed は `entries[].archetype` から。
 */
function resolveArchetype(
  format: string,
  me: OuterEntry,
  where: string,
  warnings: string[],
): 'text' | 'textlog' {
  // ⚠ `where` は **filename**(review L-2)── 「3 件目」では 50 件あるとき
  // どのノートか分からない。この PR が解決しようとした問題そのもの
  const fixed = BATCH_FORMATS[format];
  if (fixed !== null && fixed !== undefined) {
    // writer は書かない field なので、**在るのに食い違う**なら手で組んだ ZIP。
    // PKC2 は完全に無視していた ── 黙って無視せず見せる(判断は format を採る)
    if (typeof me.archetype === 'string' && me.archetype !== fixed) {
      warnings.push(
        `${where}: 目次の archetype(${me.archetype})は形式(${fixed})と違います ── 形式を採ります`,
      );
    }
    return fixed;
  }
  const a = me.archetype;
  if (a === 'text' || a === 'textlog') return a;
  // 決められないものを「たぶん text」で通すと、textlog が本文 1 行に潰れる
  throw new ZipReadError(
    `${where}: archetype が text / textlog ではありません(${String(a)})── この形式はまだ扱えません`,
  );
}

/**
 * 同じ key の添付を畳む。
 *
 * 🔑 **同じ key が複数の内側 bundle に出るのは正常**(PKC2 は同じ添付を
 * それぞれの bundle に丸ごと複製する)。中身が同じなら 1 件に畳む ── ZFS の発想。
 *
 * ⚠ 中身が違うなら**断る**。片方を静かに捨てると、あるノートが別ノートの画像を
 * 表示する(= 静かなデータ破損)。判定は ZIP の中央ディレクトリが**読まずに**
 * 持っている CRC-32 とサイズで行う ── bytes を 1 バイトも読まずに済む。
 * 正規の PKC2 書出しは 1 container 由来なので原理的に起きない。
 */
function mergeAssets(
  into: Map<string, BundleAsset>,
  alternates: Map<string, AssetSource[]>,
  from: ReadonlyMap<string, BundleAsset>,
  filename: string,
  warnings: string[],
): void {
  for (const [key, a] of from) {
    const prev = into.get(key);
    if (!prev) {
      into.set(key, a);
      alternates.set(key, [a.source]);
      continue;
    }
    // 🔴 **符号化が違うだけの同一添付は「違う中身」ではない**(2026-08-02、実物で判明)。
    // PKC2 は添付を貼ると `ASSETS` サブフォルダを自動生成して attachment entry を
    // そこへ置く(`app-state.ts:863-886`)。folder-export は descendant を再帰収集
    // するので、**画像を貼ったノートを含むフォルダを書き出すと必ず**
    // 「`.text.zip`(`assets/<key>.png` = 生バイト)」と
    // 「`ASSETS/….entry.zip`(`assets/<key>` = base64)」が同居する。
    // ⚠ ここを crc/size だけで見て断っていたので、**既定の形の書出しが全滅**して
    // いた ── しかも「手で組み替えた ZIP の可能性」と user のデータを疑う文面で
    const prevB64 = prev.source.base64 === true;
    const aB64 = a.source.base64 === true;
    if (prevB64 !== aB64) {
      // 生バイト側を採る(復号が要らず、name/mime も bundle manifest 由来で正しい)
      const list = alternates.get(key)!;
      if (prevB64 && !aB64) {
        into.set(key, a);
        list.unshift(a.source); // 先頭 = 採用したもの
      } else {
        list.push(a.source);
      }
      continue;
    }
    if (
      prev.source.entry.crc32 !== a.source.entry.crc32 ||
      prev.source.entry.uncompressedSize !== a.source.entry.uncompressedSize
    ) {
      throw new ZipReadError(
        `同じ添付 key が違う中身で入っています(${key}: ${filename})── 取り込めません`,
      );
    }
    // 🔑 **複製を控えに残す**(review M-5)。判定は中央ディレクトリの crc/size
    // だけで bytes を読まないので、**データ部だけが腐って CD が無傷**なら
    // 「同一」と判定して畳んでしまう。PKC2 は畳まなかったので健全な複製が生き残り
    // 添付を表示できていた ── 畳み込みで冗長性まで捨てると **PKC2 より弱くなる**。
    // 読めなかったら控えへ回す(adapter が順に試す)
    alternates.get(key)?.push(a.source);
    if (prev.name !== a.name || prev.mime !== a.mime) {
      // bytes は同じなので畳めるが、見え方が変わる ── 黙って選ばない
      warnings.push(
        `${filename}: 添付 ${key} の名前(${prev.name} / ${a.name})か種別` +
          `(${prev.mime} / ${a.mime})が bundle ごとに違います ── 先の方を採ります`,
      );
    }
  }
}

/**
 * 外側 ZIP の索引を作り、`manifest.entries[]` の順に内側 bundle を読む。
 * batch 3 形式(段④)と folder-export(段⑤)で**共有**する。
 */
export async function readInnerBundles(
  zip: Blob,
  dir: readonly ZipEntry[],
  entries: readonly OuterEntry[],
  archetypeOf: ArchetypeResolver,
): Promise<InnerBundlesResult> {
  const warnings: string[] = [];
  // ZIP 側の索引。**同名は断る** ── PKC2 は Map 後勝ちで静かに片方を捨てていた
  const byName = new Map<string, ZipEntry>();
  // NFC に畳んだ副索引(完全一致で引けなかったときだけ使う ── M-7)。
  // 畳んだ結果ぶつかるものは**曖昧なので載せない**(黙って別物を掴まない)
  const byNfc = new Map<string, ZipEntry>();
  const nfcDup = new Set<string>();
  for (const e of dir) {
    if (e.isDirectory) continue;
    if (byName.has(e.name)) {
      throw new ZipReadError(`同じ名前のファイルが 2 つあります: ${e.name}(壊れた ZIP)`);
    }
    byName.set(e.name, e);
    const n = e.name.normalize('NFC');
    if (byNfc.has(n)) nfcDup.add(n);
    byNfc.set(n, e);
  }
  for (const n of nfcDup) byNfc.delete(n);

  const bundles: InnerBundle[] = [];
  const assets = new Map<string, BundleAsset>();
  const alternates = new Map<string, AssetSource[]>();
  const used = new Set<string>();
  const counted = { text: 0, textlog: 0, entry: 0 };
  const dropped: string[] = [];
  let droppedEntries = 0;
  const failed: string[] = [];
  const skipped: string[] = [];
  const lidSeen = new Map<string, string>();
  let anyCompacted = false;

  for (let i = 0; i < entries.length; i++) {
    const me = entries[i] ?? {};
    const where = `${i + 1} 件目`;
    const filename = typeof me.filename === 'string' ? me.filename : '';
    // PKC2 は preview で**無言 skip**・import で hard fail という非対称を持つ
    // (user は「一覧に出たのに入らない」を経験しうる)── PKC3 は常に断る
    if (filename === '') {
      throw new ZipReadError(`${where}: manifest に filename がありません(壊れた ZIP)`);
    }
    // PKC2 は同じ filename が 2 回並ぶと**同じ内容を 2 回取り込んで**いた
    if (used.has(filename)) {
      throw new ZipReadError(`manifest が同じファイルを 2 回並べています: ${filename}`);
    }
    used.add(filename);

    const archetype = archetypeOf(me, where, warnings);
    if (archetype === 'skip') {
      // 未対応形式(段⑤ v2 の `.entry.zip`)── 名指しで言って残りは取り込む
      skipped.push(filename);
      continue;
    }
    let inner = byName.get(filename);
    if (!inner) {
      // ⚠ macOS の FS / Finder 経由で再梱包すると **名前が NFD** になる。
      // PKC2 の batch filename はノート題名由来なので、**日本語題名で現実的に
      // 踏む**(review M-7)。完全一致で断ると「在るファイルを無いと言われる」
      // ── 原因に辿り着けない。正規化して引き直し、当たったら**言う**
      const hit = byNfc.get(filename.normalize('NFC'));
      if (!hit) {
        throw new ZipReadError(`manifest にあるファイルが ZIP に入っていません: ${filename}`);
      }
      warnings.push(
        `${filename}: 目次と ZIP でファイル名の正規化形が違います(${hit.name} を使います)`,
      );
      inner = hit;
    }

    // ⚠ store なら slice = **view**。内側 ZIP は外側の view で、その中の asset は
    // さらにその view ── どの段でもコピーを作らない
    const innerZip = await readZipEntry(zip, inner);
    let parts;
    try {
      // 内側 format と宣言 archetype の一致は readBundleParts が検査する
      // (texts の中に textlog bundle が入っていたら断る ── PKC2 も hard fail)
      // 段⑥: `.entry.zip` は payload の形が違う(entry.json + base64 assets)
      if (archetype === 'entry') {
        const ep = await readEntryBundleParts(innerZip);
        if (ep.dropped.length > 0) {
          dropped.push(...ep.dropped);
          droppedEntries++;
        }
        parts = ep;
      } else {
        parts = await readBundleParts(innerZip, archetype);
      }
    } catch (e) {
      // 🔑 **1 件の事故で全部を失わない**(設計 doc §5-③ の裁定 = partial + 可視)。
      // P6c の目的は「PKC2 バックアップからの救出」なので、100 件中 1 件が
      // 未対応形式や破損だったときに 0 件になるのは方針と衝突する。
      // 「読めるところだけ読む」が悪いのは**黙って**やるからで、
      // どのファイルを何の理由で落としたかを言うなら静かではない
      failed.push(filename);
      warnings.push(`${filename}: 取り込めませんでした ── ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (archetype !== 'entry') counted[archetype]++;
    else counted.entry++;
    // 外側 manifest は preview 用の写しで、**正は内側**(PKC2 も内側を採る)。
    // 食い違うのは組み立ての事故なので見せる
    const innerLid = parts.manifest.source_lid ?? '';
    if (typeof me.lid === 'string' && me.lid !== '' && innerLid !== '' && me.lid !== innerLid) {
      warnings.push(`${filename}: 目次と中身で lid が違います(${me.lid} ≠ ${innerLid})`);
    }
    const innerTitle = parts.manifest.source_title ?? '';
    if (
      typeof me.title === 'string' &&
      me.title !== '' &&
      innerTitle !== '' &&
      me.title !== innerTitle
    ) {
      warnings.push(`${filename}: 目次と中身でタイトルが違います(${me.title} ≠ ${innerTitle})`);
    }

    // 🔴 内側 lid の重複を**言う**(review H-1)。`readBundleParts` は
    // `source_lid` が無いと `bundle-<archetype>` という**定数**に落ちるので、
    // source_lid 欠落の bundle が 2 件あれば必ずぶつかる。段⑤ ではこれが
    // 「ノートのフォルダ所属が片方消える」に化ける(convert は entry 自体は
    // 再採番して救うので、消えるのは所属だけ = 見て気づきにくい)
    const dupOf = lidSeen.get(parts.main.lid);
    if (dupOf !== undefined) {
      warnings.push(
        `${filename}: 中身の lid が ${dupOf} と同じです(${parts.main.lid})` +
          ' ── 別の entry として取り込みます',
      );
    } else {
      lidSeen.set(parts.main.lid, filename);
    }
    bundles.push({ main: parts.main, outer: me, filename });
    for (const w of parts.warnings) {
      // compact は **export 単位**の性質なので、内側の件数ぶん繰り返さない
      // (50 件あると 50 行出る)── 外側で 1 回だけ言う
      if (w === COMPACTED_WARNING) {
        anyCompacted = true;
        continue;
      }
      warnings.push(`${filename}: ${w}`);
    }
    mergeAssets(assets, alternates, parts.assets, filename, warnings);
  }

  return {
    bundles,
    assets,
    alternates,
    counted,
    dropped: { fields: dropped, entries: droppedEntries },
    failed,
    skipped,
    anyCompacted,
    used,
    warnings,
  };
}

/** batch 3 形式を受理する。**形が違えば必ず throw**(部分的に読めた気にさせない)。 */
export async function readContainerBundle(zip: Blob): Promise<Pkc2ContainerBundle> {
  const dir = await readZipDirectory(zip);
  const warnings: string[] = [];

  if (dir.some((e) => e.name === '[Content_Types].xml')) {
    throw new ZipReadError(
      'これは Office 文書(.xlsx / .docx / .pptx)です ── 取込対象ではありません',
    );
  }

  let manifest: Pkc2ContainerBundleManifest;
  try {
    manifest = JSON.parse(
      await readZipText(zip, onlyEntry(dir, MANIFEST)),
    ) as Pkc2ContainerBundleManifest;
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${MANIFEST} を解釈できません: ${String(e)}`);
  }
  const format = String(manifest?.format);
  if (!isBatchFormat(format)) {
    throw new ZipReadError(`この受理器は batch 形式のみ扱えます(format=${format})`);
  }
  if (manifest.version !== 1) {
    throw new ZipReadError(
      `未対応の bundle version です(version=${String(manifest.version)} ── 対応は 1)`,
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ZipReadError('manifest に entries の配列がありません(壊れた ZIP)');
  }

  const inner = await readInnerBundles(zip, dir, manifest.entries, (me, where, w) =>
    resolveArchetype(format, me, where, w),
  );
  const mains = inner.bundles.map((b) => b.main);
  const { assets, alternates, counted, failed, used } = inner;
  warnings.push(...inner.warnings);
  const anyCompacted = inner.anyCompacted || manifest.compact === true;

  if (anyCompacted) warnings.push(COMPACTED_WARNING);

  // manifest のカウンタは PKC2 が**読んでさえいない** ── PKC3 は照合して warning
  // に出す(断りはしない: 正当な差がありうる)
  const declared: Array<[string, number | undefined, number]> =
    format === 'pkc2-mixed-container-bundle'
      ? [
          ['text', manifest.text_count, counted.text],
          ['textlog', manifest.textlog_count, counted.textlog],
        ]
      : [['entry', manifest.entry_count, mains.length]];
  for (const [label, want, got] of declared) {
    if (typeof want === 'number' && want !== got) {
      warnings.push(`manifest の ${label} 件数が中身と違います(${want} ≠ ${got})`);
    }
  }

  // manifest に無いファイル ── PKC2 は無言で捨てていた
  for (const e of dir) {
    if (e.isDirectory || e.name === MANIFEST || used.has(e.name)) continue;
    warnings.push(`manifest に無いファイルを無視しました: ${e.name}`);
  }

  // 🔴 「読めたつもりで 0 件」を作らない ── この repo が一番嫌う結果。
  // 全部落ちたなら理由ごと断る(取込完了 0 件で成功したように見せない)
  if (mains.length === 0) {
    throw new ZipReadError(
      failed.length > 0
        ? `内側の bundle を 1 件も取り込めませんでした(${failed.length} 件すべて失敗)── ${warnings.join(' / ')}`
        : '取り込める entry が 1 件も入っていません(空の bundle)',
    );
  }
  if (failed.length > 0) {
    warnings.push(`${failed.length} 件の bundle を取り込めませんでした(残りは取り込みます)`);
  }

  return {
    manifest,
    container: synthesize(assets, mains),
    assetSources: sourcesOf(assets),
    assetAlternates: alternates,
    warnings,
  };
}
