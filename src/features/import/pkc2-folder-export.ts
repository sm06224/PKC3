/**
 * P6c 段⑤: `pkc2-folder-export-bundle`(フォルダ書出し)の受理と**階層の復元**。
 *
 * 段④(batch)の内側 bundle ループをそのまま再利用し、`folders[]` と
 * `entries[].parent_folder_lid` から **folder entry + structural relation** を組む。
 * PKC3 の木の規約は `features/relation/tree.ts`(folder = archetype 'folder'、
 * 辺 = kind 'structural'、**fromLid = 親**)── 合成 container に載せれば
 * `convertPkc2Container` がそのまま通す(adapter に新しい機構は要らない)。
 *
 * ## PKC2 の実地確認(2026-08-01、read-only 調査)
 * - `version` は **1 | 2**。`other_count > 0` で 2 になり、`.entry.zip`
 *   (`pkc2-entry-bundle`)が混ざる。**v1 の archetype は 'text' / 'textlog' の 2 値だけ**
 *   ── manifest に書かれるのは実 archetype ではなく**リテラル**だから
 * - `scope` は `'recursive'` 固定で、PKC2 の reader は**読んでさえいない**
 * - `folders[0]` = **export root**(`parent_lid: null` はここだけ)。root は
 *   `folders[]` に入るが `entries[]` には入らない
 * - **空フォルダも `folders[]` に入る**(件数フィルタが無い)
 * - `folders` が **無い**旧 bundle が存在しうる(型が optional で reader も許容)
 *
 * ## PKC2 から変えた点(どれも「静かな損失」を減らす方向)
 * | | PKC2 | PKC3 |
 * |---|---|---|
 * | 壊れた辺が 1 本 | **階層を丸ごと捨てて平坦取込**、warning は 1 件で打ち切り | 壊れた辺**だけ**直して木は保つ。直した箇所は全部見せる(§4-K) |
 * | 空フォルダ | 「選択 entry の祖先チェーン」しか作らず**無言で消える** | **全部作る**(§4-M) |
 * | `.entry.zip`(v2) | **無言 skip**。件数表示とチェックボックス数が食い違う | 名指しで warning + 残りは取り込む(段⑥ で受理予定) |
 * | 添字 | preview は manifest 添字・取込は圧縮配列で、**選んだ entry が落ちる**実バグ | `main` と manifest entry を**組で持つ**(添字空間が存在しない) |
 */
import { readZipDirectory, readZipText, ZipReadError } from './zip-reader';
import {
  COMPACTED_WARNING,
  MANIFEST,
  onlyEntry,
  sourcesOf,
  synthesize,
  type BundleMain,
  type SynthRelation,
} from './pkc2-bundle';
import {
  readInnerBundles,
  type OuterEntry,
  type Pkc2ContainerBundle,
} from './pkc2-container-bundle';
import { buildFolderGraph, type FolderNode } from './folder-graph';

export const FOLDER_EXPORT_FORMAT = 'pkc2-folder-export-bundle';

interface RawFolder {
  lid?: unknown;
  title?: unknown;
  parent_lid?: unknown;
}

export interface Pkc2FolderExportManifest {
  format: string;
  version: number;
  exported_at?: string;
  source_cid?: string;
  source_folder_lid?: string;
  source_folder_title?: string;
  /** `'recursive'` 固定(PKC2 の reader も読んでいない ── 記録のためだけに持つ)。 */
  scope?: string;
  text_count?: number;
  textlog_count?: number;
  /** v2 のみ(0 のとき key ごと不在)。 */
  other_count?: number;
  compact?: boolean;
  entries?: OuterEntry[];
  /** 旧 bundle には**無い**。無ければ平坦取込 + warning。 */
  folders?: RawFolder[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * v1 は 'text' / 'textlog' だけ。v2 はそれ以外の archetype が混ざるので
 * **'skip' を返して段⑥ へ回す**(黙って飛ばさない ── 呼び出し側が warning にする)。
 */
function resolveArchetype(
  me: OuterEntry,
  where: string,
  warnings: string[],
): 'text' | 'textlog' | 'skip' {
  const a = me.archetype;
  if (a === 'text' || a === 'textlog') return a;
  if (typeof a !== 'string' || a === '') {
    // PKC2 はここで bundle 全体を落としていた ── 1 件の欠落で全部失わない
    warnings.push(`${where}: archetype が書かれていません ── この 1 件を飛ばします`);
    return 'skip';
  }
  return 'skip';
}

/** `pkc2-folder-export-bundle` を受理する。 */
export async function readFolderExportBundle(zip: Blob): Promise<Pkc2ContainerBundle> {
  const dir = await readZipDirectory(zip);
  const warnings: string[] = [];

  if (dir.some((e) => e.name === '[Content_Types].xml')) {
    throw new ZipReadError(
      'これは Office 文書(.xlsx / .docx / .pptx)です ── 取込対象ではありません',
    );
  }

  let manifest: Pkc2FolderExportManifest;
  try {
    manifest = JSON.parse(
      await readZipText(zip, onlyEntry(dir, MANIFEST)),
    ) as Pkc2FolderExportManifest;
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(`${MANIFEST} を解釈できません: ${String(e)}`);
  }
  if (manifest?.format !== FOLDER_EXPORT_FORMAT) {
    throw new ZipReadError(
      `この受理器は ${FOLDER_EXPORT_FORMAT} のみ扱えます(format=${String(manifest?.format)})`,
    );
  }
  // v2 も受ける ── `.entry.zip` だけ飛ばして残りは取り込む(段⑥ で受理予定)
  if (manifest.version !== 1 && manifest.version !== 2) {
    throw new ZipReadError(
      `未対応の bundle version です(version=${String(manifest.version)} ── 対応は 1 と 2)`,
    );
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ZipReadError('manifest に entries の配列がありません(壊れた ZIP)');
  }

  const inner = await readInnerBundles(zip, dir, manifest.entries, resolveArchetype);
  warnings.push(...inner.warnings);

  if (inner.skipped.length > 0) {
    // PKC2 は**無言 skip** で、しかも件数表示だけ manifest の総数を出していた
    warnings.push(
      `まだ扱えない形式の ${inner.skipped.length} 件を飛ばしました` +
        `(${inner.skipped.join(' / ')})── ノート以外の entry です`,
    );
  }
  if (inner.failed.length > 0) {
    warnings.push(`${inner.failed.length} 件の bundle を取り込めませんでした(残りは取り込みます)`);
  }
  // 🔴 内側が**全部失敗**したなら断る(段④ と同じ方針)── 空フォルダだけ作って
  // 「成功」に見せない
  if (inner.bundles.length === 0 && inner.failed.length > 0) {
    throw new ZipReadError(
      `内側の bundle を 1 件も取り込めませんでした(${inner.failed.length} 件すべて失敗)` +
        ` ── ${warnings.join(' / ')}`,
    );
  }

  // ── 階層。`folders` が無い旧 bundle は**平坦取込 + 明示 warning**(§4-K)
  const mains: BundleMain[] = inner.bundles.map((b) => b.main);
  let folderEntries: BundleMain[] = [];
  let relations: SynthRelation[] = [];

  if (!Array.isArray(manifest.folders) || manifest.folders.length === 0) {
    warnings.push(
      'フォルダ構造を復元できませんでした(書出しにフォルダ情報が入っていません)' +
        `── ${mains.length} 件を最上位に取り込みます`,
    );
  } else {
    const nodes: FolderNode[] = manifest.folders.map((f) => {
      // ⚠ **型違いを黙って root にしない**(review M-4)。dangling には warning を
      // 出すのに数値・オブジェクトだけ無警告で 1 段消えるのは非対称
      const raw = f.parent_lid;
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        warnings.push(
          `フォルダの親 lid が文字列ではありません(${str(f.lid) || '?'}: ${typeof raw})` +
            ' ── 最上位に置きます',
        );
      }
      return {
        lid: str(f.lid),
        title: str(f.title),
        // ⚠ `parent_lid: null` は export root だけ。欠落も root 扱いにする
        parentLid: typeof raw === 'string' && raw !== '' ? raw : null,
      };
    });

    // 🔴 **folder lid と本体 lid の衝突を先に解く**(review H-2)。
    // `synthesize` は folder を先に並べるので、convert の再採番は必ず**本体側**に
    // 当たり、参照書換表が旧 lid → 本体の新 lid を指す ── その結果 folder が
    // 張った structural relation の端点が**本体 entry へ付け替えられ、階層が全滅する**
    // (warning は「lid 衝突を再採番」しか出ず、階層が消えたことは誰も言わない)。
    // reader は「どちらが folder か」を知っている唯一の場所なので、ここで避ける
    const mainLids = new Set(mains.map((m) => m.lid));
    const taken = new Set([...mainLids, ...nodes.map((n) => n.lid)]);
    const renamed = new Map<string, string>();
    for (const n of nodes) {
      if (!mainLids.has(n.lid)) continue;
      let fresh = `folder-${n.lid}`;
      for (let i = 2; taken.has(fresh); i++) fresh = `folder-${n.lid}-${i}`;
      taken.add(fresh);
      renamed.set(n.lid, fresh);
      warnings.push(
        `フォルダとノートで lid がぶつかっています(${n.lid})── フォルダ側を ${fresh} にずらします`,
      );
    }
    if (renamed.size > 0) {
      for (const n of nodes) {
        const self = renamed.get(n.lid);
        if (self !== undefined) n.lid = self;
        if (n.parentLid !== null) n.parentLid = renamed.get(n.parentLid) ?? n.parentLid;
      }
    }
    // 🔑 `main` と manifest entry を**組で**持っているので、飛ばした件があっても
    // 対応がずれない(PKC2 はここで選んだ entry を落としていた)
    const childOf = new Map<string, string>();
    for (const b of inner.bundles) {
      const p = str(b.outer.parent_folder_lid);
      if (p === '') continue;
      // 重複 lid の 2 件目は所属が上書きされて**片方が黙って消える**(review H-1)。
      // `readInnerBundles` が lid の重複自体は言うが、所属が落ちたことは別に言う
      if (childOf.has(b.main.lid)) {
        warnings.push(
          `${b.filename}: lid が重複しているためフォルダ所属を復元できません(${b.main.lid})` +
            ' ── 最上位に置きます',
        );
        continue;
      }
      childOf.set(b.main.lid, renamed.get(p) ?? p);
    }
    const graph = buildFolderGraph(nodes, childOf, mainLids);
    warnings.push(...graph.warnings);
    folderEntries = graph.entries;
    relations = graph.edges.map((e, i) => ({
      // id は convert が衝突時に再採番する(空だと全部 '' で衝突して 1 本しか残らない)
      id: `fx-${i}`,
      from: e.fromLid,
      to: e.toLid,
      kind: 'structural',
    }));
  }

  // 🔴 「読めたつもりで 0 件」を作らない ── 判定は **実際に作れた entry 数**で行う
  // (manifest の配列長で見ると、lid の無いフォルダ 1 件だけの書出しが素通りする)
  if (folderEntries.length + mains.length === 0) {
    throw new ZipReadError(
      `取り込めるものが 1 件もありませんでした ── ${warnings.join(' / ') || '空の書出しです'}`,
    );
  }

  if (inner.anyCompacted || manifest.compact === true) warnings.push(COMPACTED_WARNING);

  // 件数照合(PKC2 は読んでさえいない)
  const declared: Array<[string, number | undefined, number]> = [
    ['text', manifest.text_count, inner.counted.text],
    ['textlog', manifest.textlog_count, inner.counted.textlog],
    // ⚠ `other_count` も照合する(review M-5)── 宣言だけして読まないのは
    // まさに PKC2 を批判している振る舞い。v1 では key ごと不在なので照合されない
    ['ノート以外', manifest.other_count, inner.skipped.length],
  ];
  for (const [label, want, got] of declared) {
    if (typeof want === 'number' && want !== got) {
      warnings.push(`manifest の ${label} 件数が中身と違います(${want} ≠ ${got})`);
    }
  }
  for (const e of dir) {
    if (e.isDirectory || e.name === MANIFEST || inner.used.has(e.name)) continue;
    warnings.push(`manifest に無いファイルを無視しました: ${e.name}`);
  }

  return {
    manifest,
    container: synthesize(inner.assets, [...folderEntries, ...mains], relations),
    assetSources: sourcesOf(inner.assets),
    assetAlternates: inner.alternates,
    warnings,
  };
}
