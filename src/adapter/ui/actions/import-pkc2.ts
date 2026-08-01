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
import { convertPkc2Container, remapAssetKeys } from '@features/import/pkc2-convert';
import { identifyAsset } from '@adapter/platform/storage/asset-key';
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
  /** 既に持っている asset key(content addressing なので存在確認だけで済む)。 */
  listAssetKeys(): Promise<ReadonlySet<string>>;
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

/** base64 → Blob(gzip されていれば展開する)。1 件ずつ呼び、結果は保持しない。 */
async function decodeAsset(
  base64: string,
  mime: string,
  gzipped: boolean,
): Promise<Blob> {
  const bytes = decodeBase64(base64);
  if (!gzipped) return new Blob([bytes], { type: mime });
  // DecompressionStream はブラウザ標準(依存を増やさない)
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const out = await new Response(stream).blob();
  // mime の付け替えは slice(ゼロコピー)── new Blob([blob]) は中身を複製する
  return out.slice(0, out.size, mime);
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
    const payload = parsePkc2Html(await file.text());
    const gzipped = payload.exportMeta.assetEncoding === 'gzip+base64';
    const light = payload.exportMeta.mode === 'light';

    const result = convertPkc2Container(payload.container as never, {
      existingLids: await deps.existingLids(),
      existingRelationIds: deps.existingRelationIds(),
      orderBase: deps.orderBase(),
      genLid: deps.genLid,
      genAssetKey: deps.genAssetKey,
      genRelationId: deps.genRelationId,
    });
    // ── assets: 1 件ずつ復号 → **中身のハッシュで key を決める** → 未所持なら書く
    // (content addressing / user 指示 2026-08-01「ZFS と同じ発想」)。同じ bytes は
    // 必ず同じ key に落ちるので、再取込も、取込と添付の混在も、1 回の取込の中の
    // 重複も、すべて構造的に 1 部しか持たない
    // ⚠ 順序が規約: **bytes を先に、参照(entries)を後に**。逆順にすると
    // 「参照はあるが bytes が無い」entry が残る ── 逆向き(参照なし bytes)は
    // 明示 purge で回収できる。test は opLog で順序そのものを pin している
    const known = new Set(await deps.listAssetKeys());
    // convert は純関数なので content key を決められない ── 暫定 key を配ってあり、
    // ここで本物へ写す(body の書換は下の remapAssetKeys)
    const keyMap = new Map<string, string>();
    for (const a of result.assets) {
      if (a.base64 === '') continue; // light export(assets 空)
      try {
        const blob = await decodeAsset(a.base64, a.mime, gzipped);
        a.base64 = ''; // 参照を切って GC に返す(生成物の寿命をここで終端する)
        const { key, hash } = await identifyAsset(blob);
        keyMap.set(a.key, key);
        if (!known.has(key)) {
          await deps.putBlob(key, blob);
          await deps.putAssetMeta({ key, mime: a.mime, size: blob.size, hash });
          known.add(key);
        }
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
    try {
      await deps.bulkUpsertEntries(rows);
      entriesWritten = rows.length;
      if (result.relations.length > 0) await deps.bulkUpsertRelations(result.relations);
    } catch (e) {
      // 書けた分は必ず画面へ出す ── 「失敗」と言いながら disk に残すのが最悪
      await deps.reload().catch(() => {});
      return fail(
        entriesWritten > 0
          ? `取込は ${entriesWritten} 件まで書き込まれました。関連の書込で失敗しています(このまま取り込み直すと二重になります): ${reason(e)}`
          : `取込に失敗しました(書込は行われていません): ${reason(e)}`,
      );
    }

    await deps.reload();
    // 具体的な注意(どのファイルが欠けたか)を先に出す ── 総論の light 表示を
    // 先頭に置くと、50 件欠けていても user は何が欠けたか分からない
    const notes = [
      ...result.warnings,
      ...(light ? ['添付の中身は含まれていない export です(light)'] : []),
    ];
    if (notes.length > 0) {
      // 警告は握りつぶさない。ただし**成功を失敗の見た目にしない** ──
      // OP_FAILED は state.error に載って「⚠ エラー」表示になる(review L-11)
      deps.notify?.(
        `取込完了: ${rows.length} 件 ⚠ 注意 ${notes.length} 件 — ${notes[0]}`,
      );
    } else {
      deps.notify?.(`取込完了: ${rows.length} 件`);
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
