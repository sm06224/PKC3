/**
 * P6b: PKC2 ファイルの取込(実行部)。
 *
 * 流れ: 判別 → HTML から container 抽出 → 変換 core(純関数)→ bytes を Blob へ →
 * bulk 書込 → 再 boot。**判別できない / 壊れている入力は可視で断る**
 * (「読めたつもりで 0 件」を作らない ── それが最悪の結果)。
 *
 * ⚠ base64 の復号は**ここで 1 件ずつ**行い、その場で Blob にして捨てる。
 * 復号済み文字列を配列に溜めない(PKC2 の +293MB 常駐と同型の穴を作らない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import type { EntryUpsert } from '@adapter/platform/storage/schema';
import { detectPkc2Format, sniffMagic } from '@features/import/detect-format';
import { parsePkc2Html } from '@features/import/pkc2-html';
import { convertPkc2Container } from '@features/import/pkc2-convert';
import { extractMeta } from '@features/flavor';

export interface ImportDeps {
  /** 既存 entry の lid 集合(衝突の再採番に使う)。 */
  existingLids(): ReadonlySet<string>;
  /** 既存 entryOrder の最大値。 */
  orderBase(): number;
  genLid(): string;
  genAssetKey(): string;
  bulkUpsertEntries(entries: EntryUpsert[]): Promise<void>;
  bulkUpsertRelations(
    relations: Array<{ id: string; fromLid: string; toLid: string; kind: string }>,
  ): Promise<void>;
  putBlob(assetKey: string, blob: Blob): Promise<void>;
  putAssetMeta(meta: {
    key: string;
    mime: string;
    size: number;
    hash: string | null;
  }): Promise<void>;
  /** 取込後の再読込(boot と同じ経路で state を作り直す)。 */
  reload(): Promise<void>;
  /** 進捗の可視化(件数が多いと無反応に見えるため)。 */
  notify?(message: string): void;
}

/** base64 → Blob(gzip されていれば展開する)。1 件ずつ呼び、結果は保持しない。 */
async function decodeAsset(
  base64: string,
  mime: string,
  gzipped: boolean,
): Promise<Blob> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!gzipped) return new Blob([bytes], { type: mime });
  // DecompressionStream はブラウザ標準(依存を増やさない)
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Blob([await new Response(stream).blob()], { type: mime });
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
  if (dispatcher.getState().phase !== 'ready') {
    return fail('編集を終了してから取り込んでください');
  }

  try {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    // ZIP は manifest.format を読まないと形式が確定しない ── 展開器は P6c。
    // ここで「不明」に混ぜると user は原因を誤解するので、ZIP は ZIP として断る
    if (sniffMagic(head) === 'zip') {
      return fail(
        `ZIP 形式(バックアップ / バンドル)の取込はまだ実装されていません(${file.name})── PKC2 の単一 HTML を選んでください`,
      );
    }
    if (detectPkc2Format(head, null, file.name) !== 'html') {
      return fail(`取り込めない形式です(${file.name})── PKC2 の HTML を選んでください`);
    }

    deps.notify?.('取込中…(ファイルを読んでいます)');
    const html = await file.text();
    const payload = parsePkc2Html(html);
    const gzipped = payload.exportMeta.assetEncoding === 'gzip+base64';

    const result = convertPkc2Container(payload.container as never, {
      existingLids: deps.existingLids(),
      orderBase: deps.orderBase(),
      genLid: deps.genLid,
      genAssetKey: deps.genAssetKey,
    });

    // ── assets: 1 件ずつ復号 → Blob → 即手放す(復号済み文字列を溜めない)
    for (const a of result.assets) {
      if (a.base64 === '') continue; // light export(assets 空)
      try {
        const blob = await decodeAsset(a.base64, a.mime, gzipped);
        await deps.putBlob(a.key, blob);
        await deps.putAssetMeta({ key: a.key, mime: a.mime, size: blob.size, hash: null });
      } catch (e) {
        // 1 件の添付が壊れていても取込全体は止めない(欠損は可視化する)
        result.warnings.push(`添付を復元できませんでした(${a.key}): ${String(e)}`);
      }
    }

    // ── entries / relations は bulk(1 行ずつ書かない ── journal 増幅の教訓)
    deps.notify?.(`取込中…(${result.entries.length} 件を書き込んでいます)`);
    await deps.bulkUpsertEntries(
      result.entries.map((e) => {
        const ext = extractMeta(e.archetype, e.body);
        return {
          lid: e.lid,
          title: e.title,
          archetype: e.archetype,
          body: e.body,
          entryOrder: e.entryOrder,
          status: ext.status,
          date: ext.date,
          archived: ext.archived,
        };
      }),
    );
    if (result.relations.length > 0) await deps.bulkUpsertRelations(result.relations);

    await deps.reload();
    if (result.warnings.length > 0) {
      // 警告は握りつぶさない(取り込めなかったものがあると分かるようにする)
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `取込完了(${result.entries.length} 件)。ただし ${result.warnings.length} 件の注意: ${result.warnings[0]}`,
      });
    } else {
      deps.notify?.(`取込完了: ${result.entries.length} 件`);
    }
    return result.entries.length;
  } catch (e) {
    return fail(`取込に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
