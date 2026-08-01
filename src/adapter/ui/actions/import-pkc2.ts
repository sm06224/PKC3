/**
 * P6b: PKC2 ファイルの取込(実行部)。
 *
 * 流れ: 判別 → HTML から container 抽出 → 変換 core(純関数)→ bytes を Blob へ →
 * bulk 書込 → 再 boot。**判別できない / 壊れている入力は可視で断る**
 * (「読めたつもりで 0 件」を作らない ── それが最悪の結果)。
 *
 * ⚠ base64 の復号は**ここで 1 件ずつ**行い、その場で Blob にして捨てる。
 * 復号済み文字列を配列に溜めない(PKC2 の +293MB 常駐と同型の穴を作らない)。
 * 復号**前**の base64 も、使い終わったら参照を切って GC に返す(review M-9 ──
 * 「溜めない」だけでは不十分で、実測で asset 実体の 3.2 倍が常駐していた)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { sniffMagic, detectPkc2Format } from '@features/import/detect-format';
import { parsePkc2Html } from '@features/import/pkc2-html';
import { readPkc2Package, peekZipFormat } from '@features/import/pkc2-package';
import { readTextBundle, readTextlogBundle } from '@features/import/pkc2-bundle';
import { readContainerBundle, isBatchFormat } from '@features/import/pkc2-container-bundle';
import { readAssetSource, type AssetSource } from '@features/import/zip-reader';
import {
  convertPkc2Container,
  remapAssetKeys,
  type RevisionChain,
} from '@features/import/pkc2-convert';
import {
  identifyBytes,
  generateAssetKey,
  HASH_MAX_BYTES,
} from '@adapter/platform/storage/asset-key';
import { extractMeta } from '@features/flavor';

export interface ImportDeps {
  /**
   * 衝突判定に使う lid 集合。**生存 entry だけでは足りない** ── ゴミ箱の lid
   * (entries に居ないが revisions を持つ)と衝突すると、その item がゴミ箱から
   * 消え、取り込んだ entry が他人の履歴を背負う(review H-1)。
   */
  existingLids(): Promise<ReadonlySet<string>>;
  /** 既存 relation id 集合(upsert が後勝ちで潰すため、衝突は再採番する)。 */
  existingRelationIds(): ReadonlySet<string>;
  /** 既存 entryOrder の最大値。 */
  orderBase(): number;
  genLid(): string;
  genAssetKey(): string;
  genRelationId(): string;
  bulkUpsertEntries(entries: EntryUpsert[]): Promise<void>;
  bulkUpsertRelations(
    relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>,
  ): Promise<void>;
  /** 履歴を鎖として積む(全文では積まない ── P5c の符号化に合流させる)。 */
  importRevisionChains(chains: RevisionChain[]): Promise<{
    added: number;
    skippedNoChange: number;
    droppedOverLimit: number;
    skippedEntries: string[];
  }>;
  /**
   * 既に **bytes を持っている** key の集合。
   * ⚠ **meta 行で代用しない**(review H-1)── bytes は IDB、meta は sqlite と
   * 別ストアで、GC は `deleteBlob` → `deleteMeta` の順に消して途中失敗を
   * 「次回 purge が回収する」設計にしている。つまり「bytes なし / meta あり」は
   * **到達しうる状態**であり、そこで put を省くと参照だけが書かれる。
   */
  listStoredBlobKeys(): Promise<ReadonlySet<string>>;
  putBlob(assetKey: string, blob: Blob): Promise<void>;
  putAssetMeta(meta: {
    key: string;
    mime: string;
    size: number;
    hash: string | null;
  }): Promise<void>;
  /** 取込後の再読込(boot と同じ経路で state を作り直す)。 */
  reload(): Promise<void>;
  /** 進捗・完了の可視化(件数が多いと無反応に見えるため)。 */
  notify?(message: string): void;
  /**
   * ハッシュを取る上限(既定 `HASH_MAX_BYTES` = 64MB)。
   *
   * ⚠ **test の観測点として在る**(review M-1)。この閾値は WebCrypto に
   * streaming digest が無いことに由来する実運用上の分岐だが、64MB の fixture は
   * test で作れないため、下げられないと**分岐ごと消しても誰も気づかない**
   * (実際に mutation が生存していた)。
   */
  hashMaxBytes?: number;
}

/** base64 → bytes。`fromBase64` があれば中間のバイナリ文字列を作らない。 */
function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const fast = (
    Uint8Array as unknown as { fromBase64?(s: string): Uint8Array<ArrayBuffer> }
  ).fromBase64;
  if (fast) return fast.call(Uint8Array, base64);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * base64 → bytes(gzip されていれば展開する)。1 件ずつ呼び、結果は保持しない。
 * **Blob ではなく bytes を返す** ── 呼び出し側が hash を取るので、Blob に
 * してから `arrayBuffer()` で読み直すとコピーが 1 部増える(review M-5)。
 */
async function decodeAssetBytes(
  base64: string,
  gzipped: boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  const raw = decodeBase64(base64);
  if (!gzipped) return raw;
  // DecompressionStream はブラウザ標準(依存を増やさない)
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * base64 を **取り出すと同時に手放す**。生成物の寿命をここで終端する規律を
 * 1 箇所に閉じ込める(review M-15 ── 参照を切る行は消えても誰も気づかなかった)。
 */
export function consumeBase64(a: { base64: string }): string {
  const b = a.base64;
  a.base64 = '';
  return b;
}

/**
 * 在り処を **引くと同時に手放す**(`consumeBase64` と対称。review M-4)。
 *
 * ⚠ `AssetSource` は **内側 ZIP の Blob を強参照する**。batch では内側 ZIP が
 * 添付の数だけ map に載るので、参照を切らないと**全内側 ZIP が取込の最後まで
 * 同時に生存する**。store なら view なので実体は増えないが、deflate の内側 ZIP は
 * 実体化されている ── 「最大の内側 ZIP 1 個」を保つには参照を切る側が要る。
 */
function consumeSource(
  map: Map<string, AssetSource> | null,
  oldKey: string | null,
): AssetSource | null {
  if (map === null || oldKey === null) return null;
  const src = map.get(oldKey) ?? null;
  map.delete(oldKey);
  return src;
}

/** 1 メッセージに載せる履歴の目安(postMessage に全履歴を一度に載せない)。 */
const REVISION_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * 履歴を「1 メッセージあたりの全文量」で切って渡す。**鎖は割らない** ──
 * 1 entry の履歴は隣接差分で符号化されるうえ、worker は「既に履歴を持つ entry」を
 * 丸ごと skip するので、割ると **1 entry につき最古の 1 版しか入らず残りが黙って
 * 落ちる**(review M-6 で実証)。
 *
 * ⚠ **1 本の鎖が巨大なとき予算は効かない**(鎖と鎖の間でしか切れないため)。
 * 1 entry × 500 版で 10M chars を 1 メッセージで送る ── 既知の限界として記録する
 * (割るには worker 側に「続きを積む」口が要る。P6c 以降の課題)。
 *
 * snapshot の暫定 asset key は **in-place** で写す ── 写しを作ると元と写しが
 * 同時生存して 2 倍になる(review M-8)。`chains` は呼び出し側の作業用データで、
 * この関数の外では使わない
 */
function* batchChains(
  chains: readonly RevisionChain[],
  keyMap: ReadonlyMap<string, string>,
): Generator<RevisionChain[]> {
  let batch: RevisionChain[] = [];
  let bytes = 0;
  for (const chain of chains) {
    let size = 0;
    for (const s of chain.snapshots) {
      if (keyMap.size > 0) s.body = remapAssetKeys(s.body, keyMap);
      size += s.body.length;
    }
    if (batch.length > 0 && bytes + size > REVISION_BATCH_BYTES) {
      yield batch;
      // 送り終えた鎖は手放す(次の batch を作る前に GC に返す)
      for (const c of batch) c.snapshots = [];
      batch = [];
      bytes = 0;
    }
    batch.push(chain);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

/**
 * 取込本体。**失敗は必ず可視**(OP_FAILED)で終える。
 * @returns 取り込んだ entry 数(失敗時は null)
 */
export async function importPkc2File(
  dispatcher: Dispatcher,
  deps: ImportDeps,
  file: File,
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  if (dispatcher.getState().phase !== 'ready') {
    return fail('編集を終了してから取り込んでください');
  }

  // 書込の到達点。失敗時に「どこまで書けたか」を user に言うために持つ ──
  // 「失敗しました」とだけ言って disk に残すと、素直な再取込が二重取込になる
  let entriesWritten = 0;
  const revStats = { added: 0, dropped: 0, skipped: 0 };

  try {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const isZip = sniffMagic(head) === 'zip';
    if (!isZip && detectPkc2Format(head, null, file.name) !== 'html') {
      return fail(`取り込めない形式です(${file.name})── PKC2 の HTML か .pkc2.zip を選んでください`);
    }

    deps.notify?.('取込中…(ファイルを読んでいます)');

    // ── 入力の違いは「container をどう得るか」と「bytes をどこから取るか」だけ。
    // それ以降(変換 → asset → entries → 履歴 → 再読込)は **1 本の経路**に合流する
    // ── 経路ごとに取込の作法が違う状態を作らない
    let container: unknown;
    let gzipped = false;
    let light = false;
    let zipAssets: Map<string, AssetSource> | null = null;
    const preWarnings: string[] = [];

    if (isZip) {
      // ⚠ 形式は **manifest.format** で決まる(拡張子でもファイル名でもない)。
      // ネストした ZIP でも各段でこれを呼ぶ ── 判別は 1 段ぶんしか効かない
      const format = await peekZipFormat(file);
      if (format === null) {
        return fail(
          `${file.name}: manifest.json が無い ZIP です ── PKC2 の書出しファイルを選んでください`,
        );
      }
      const read =
        format === 'pkc2-package'
          ? readPkc2Package
          : format === 'pkc2-text-bundle'
            ? readTextBundle
            : format === 'pkc2-textlog-bundle'
              ? readTextlogBundle
              : // batch 3 形式(段④)。folder-export / entry-bundle は**受けない**
                isBatchFormat(format)
                ? readContainerBundle
                : null;
      if (!read) {
        // 未対応の形式は**名指しで**断る(「不明」に混ぜると原因を誤解する)
        return fail(`${format} の取込はまだ実装されていません(${file.name})`);
      }
      const pkg = await read(file);
      container = pkg.container;
      zipAssets = pkg.assetSources;
      preWarnings.push(...pkg.warnings);
    } else {
      const payload = parsePkc2Html(await file.text());
      container = payload.container;
      gzipped = payload.exportMeta.assetEncoding === 'gzip+base64';
      light = payload.exportMeta.mode === 'light';
    }

    const result = convertPkc2Container(container as never, {
      // ZIP では bytes が container の外(ZIP entry)にある ── convert には
      // **key だけ**を渡す(`assetsIn[oldKey] ?? ''` がそのまま効く)
      ...(zipAssets
        ? { assetKeys: [...zipAssets.keys()] }
        : {}),
      existingLids: await deps.existingLids(),
      existingRelationIds: deps.existingRelationIds(),
      orderBase: deps.orderBase(),
      genLid: deps.genLid,
      genAssetKey: deps.genAssetKey,
      genRelationId: deps.genRelationId,
    });
    result.warnings.unshift(...preWarnings);
    // ── assets: 1 件ずつ復号 → **中身のハッシュで key を決める** → 未所持なら書く
    // (content addressing / user 指示 2026-08-01「ZFS と同じ発想」)。同じ bytes は
    // 必ず同じ key に落ちるので、再取込も、取込と添付の混在も、1 回の取込の中の
    // 重複も、すべて構造的に 1 部しか持たない
    // ⚠ 順序が規約: **bytes を先に、参照(entries)を後に**。逆順にすると
    // 「参照はあるが bytes が無い」entry が残る ── 逆向き(参照なし bytes)は
    // 明示 purge で回収できる。test は opLog で順序そのものを pin している
    const known = new Set(await deps.listStoredBlobKeys());
    // convert は純関数なので content key を決められない ── 暫定 key を配ってあり、
    // ここで本物へ写す(body の書換は下の remapAssetKeys)
    const keyMap = new Map<string, string>();
    for (const a of result.assets) {
      try {
        // ⚠ gzip は **export 単位**の符号化なので、body 内蔵だった legacy data
        // (oldKey === null)には掛かっていない(review M-9 ── 一律に展開すると
        //  legacy 添付だけが必ず復号に失敗して死んだ参照になる)
        const src = consumeSource(zipAssets, a.oldKey);
        // 🔴 ZIP 経路では base64 が常に空なので、在り処を引けないまま下へ落ちると
        // **SHA-256("") の key で 0 バイトの添付を無警告で書く**(review H-2)。
        // 壊れた参照(= 開けない)ではなく「中身が空のファイル」として開けてしまう
        // ので、user は欠損に気づけない。既存の per-asset catch に合流させて
        // 「復元できませんでした」を出し、参照は壊れたまま温存する(§4-B)。
        //
        // ⚠ **いまは到達不能で、したがって test で pin できていない**(正直に書く)。
        // convert は `assetKeys` に渡した key ぶんしか asset を返さず、その
        // `assetKeys` は `zipAssets.keys()` から作っているため。**tripwire として置く**
        // ── ① 上の `consumeSource` は引くと同時に消すので、同じ oldKey が 2 回来たら
        // 2 回目がここに落ちる ② 段⑤以降で「複数 bundle の map を合成する」際に
        // key 集合がずれると、その瞬間ここが唯一の防壁になる
        if (zipAssets !== null && a.oldKey !== null && src === null) {
          throw new Error(`ZIP の中に添付の実体がありません(${a.oldKey})`);
        }
        // ⚠ 閾値超の asset は **heap に載せない** ── ハッシュを取らない
        // (= dedupe 対象外)ので読む理由が無く、読めばそのまま常駐する。
        // **破損検査は落とさない**: reader は stream で舐めて検証し view を返すので、
        // 全量を載せずに CRC を確かめられる(重複排除だけが外れる)
        if (src && src.entry.uncompressedSize > (deps.hashMaxBytes ?? HASH_MAX_BYTES)) {
          const key = generateAssetKey();
          keyMap.set(a.key, key);
          await deps.putBlob(key, await readAssetSource(src));
          await deps.putAssetMeta({
            key,
            mime: a.mime,
            size: src.entry.uncompressedSize,
            hash: null,
          });
          result.warnings.push(
            `大きすぎる添付は重複排除の対象外です(破損検査は行いました): ${a.oldKey}`,
          );
          continue;
        }
        // bytes の出どころは 2 通り。**それ以外は同じ**
        // ⚠ gzip は **export 単位**の符号化なので、body 内蔵だった legacy data
        // (oldKey === null)には掛かっていない(review M-9 ── 一律に展開すると
        //  legacy 添付だけが必ず復号に失敗して死んだ参照になる)
        // ⚠ 読むのは **`src.zip`**(外側の `file` ではない)── batch では内側 ZIP の
        // entry なので、外側から読むと別位置を読んで壊れる
        const bytes = src
          ? new Uint8Array(await (await readAssetSource(src)).arrayBuffer())
          : await decodeAssetBytes(consumeBase64(a), gzipped && a.oldKey !== null);
        const { key, hash } = await identifyBytes(bytes);
        keyMap.set(a.key, key); // ⚠ put を省いた時も**必ず**写す(review M-30)
        if (!known.has(key)) {
          await deps.putBlob(key, new Blob([bytes], { type: a.mime }));
          known.add(key);
        }
        // meta は bytes を書いたかに関わらず入れる ── upsert なので冪等で、
        // 「bytes はあるが meta が無い」状態(GC の途中失敗)も自己修復する
        await deps.putAssetMeta({ key, mime: a.mime, size: bytes.byteLength, hash });
      } catch (e) {
        // 1 件の添付が壊れていても取込全体は止めない(欠損は可視化する)
        a.base64 = '';
        result.warnings.push(`添付を復元できませんでした(${a.key}): ${reason(e)}`);
      }
    }

    const rows: EntryUpsert[] = result.entries.map((e) => {
      const body = keyMap.size > 0 ? remapAssetKeys(e.body, keyMap) : e.body;
      const ext = extractMeta(e.archetype, body);
      return {
        lid: e.lid,
        title: e.title,
        archetype: e.archetype,
        body,
        entryOrder: e.entryOrder,
        status: ext.status,
        date: ext.date,
        archived: ext.archived,
      };
    });

    // ── entries / relations は bulk(1 行ずつ書かない ── journal 増幅の教訓)
    deps.notify?.(`取込中…(${rows.length} 件を書き込んでいます)`);
    // どの段で落ちたかを user に正しく伝える(review L-11 ── 履歴で落ちても
    // 「関連の書込で失敗」と出ていた)
    let stage = '本文';
    try {
      await deps.bulkUpsertEntries(rows);
      entriesWritten = rows.length;
      if (result.relations.length > 0) {
        stage = '関連';
        await deps.bulkUpsertRelations(result.relations);
      }
      // 履歴は entries の**後**(worker が tip = entries.body を基準に符号化する)
      if (result.revisionChains.length > 0) {
        stage = '履歴';
        for (const batch of batchChains(result.revisionChains, keyMap)) {
          const r = await deps.importRevisionChains(batch);
          revStats.added += r.added;
          revStats.dropped += r.droppedOverLimit;
          revStats.skipped += r.skippedEntries.length;
        }
      }
    } catch (e) {
      // 書けた分は必ず画面へ出す ── 「失敗」と言いながら disk に残すのが最悪
      await deps.reload().catch(() => {});
      return fail(
        entriesWritten > 0
          ? `取込は ${entriesWritten} 件まで書き込まれました。${stage}の書込で失敗しています(このまま取り込み直すと二重になります): ${reason(e)}`
          : `取込に失敗しました(書込は行われていません): ${reason(e)}`,
      );
    }

    await deps.reload();
    // 具体的な注意(どのファイルが欠けたか)を先に出す ── 総論の light 表示を
    // 先頭に置くと、50 件欠けていても user は何が欠けたか分からない
    const notes = [
      ...result.warnings,
      ...(revStats.dropped > 0
        ? [`保持上限を超えた古い版 ${revStats.dropped} 件は取り込みませんでした`]
        : []),
      ...(revStats.skipped > 0
        ? [`${revStats.skipped} 件の entry は既に履歴を持つため見送りました`]
        : []),
      ...(light ? ['添付の中身は含まれていない export です(light)'] : []),
    ];
    const revNote = revStats.added > 0 ? `(履歴 ${revStats.added} 版)` : '';
    if (notes.length > 0) {
      // 警告は握りつぶさない。ただし**成功を失敗の見た目にしない** ──
      // OP_FAILED は state.error に載って「⚠ エラー」表示になる(review L-11)
      deps.notify?.(
        `取込完了: ${rows.length} 件${revNote} ⚠ 注意 ${notes.length} 件 — ${notes[0]}`,
      );
    } else {
      deps.notify?.(`取込完了: ${rows.length} 件${revNote}`);
    }
    return rows.length;
  } catch (e) {
    if (entriesWritten > 0) {
      await deps.reload().catch(() => {});
      return fail(
        `取込は ${entriesWritten} 件まで書き込まれましたが、その後で失敗しました(このまま取り込み直すと二重になります): ${reason(e)}`,
      );
    }
    return fail(`取込に失敗しました: ${reason(e)}`);
  }
}
