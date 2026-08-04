/**
 * 添付取込(P4a): **File → Blob 直 put**。
 *
 * PKC2 からの総合的見直し(調査 2026-07-31):
 * - base64 経路(FileReader → container.assets[key] = base64)を書き込み側から
 *   廃止 ── PKC2 の +293MB 常駐と「250MB 上限(根拠が base64 ヒープ)」を持ち込まない。
 *   上限は quota preflight(storage.estimate)に置き換える
 * - asset key 規則は `ast-<ts36>-<rand>` の **1 本**(PKC2 は 3 規則混在。
 *   旧規則は P6 import 側で受理する)
 * - dedupe は **content addressing**(key = bytes の SHA-256)── 台帳を引かずに
 *   構造的に一意になる(user 指示 2026-08-01「ZFS と同じ発想」)。実体は
 *   `storage/asset-key.ts`。PKC2 は base64 文字列 hash で、経路により
 *   「toast のみ / 再利用」が不一致だった
 * - hash/size メタは put と同時に書く(後付け reconcile 走査を構造的に不要にする
 *   ── PKC2 は走査が 500MB データで boot OOM を誘発した)
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { attachmentBody } from '@features/flavor/attachment-flavor';
import { identifyAsset, assetKeyFromHash } from '@adapter/platform/storage/asset-key';
import { generateLid } from './binder';

export interface AttachDeps {
  putBlob(assetKey: string, blob: Blob): Promise<void>;
  putMeta(meta: {
    key: string;
    mime: string;
    size: number;
    hash: string | null;
  }): Promise<void>;
  listMetas(): Promise<
    Array<{ key: string; size: number | null; hash: string | null }>
  >;
  /** quota preflight(無い環境では省略可)。 */
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  /**
   * 🔴 **ハッシュを取る口**(P8 段㉓)。アプリからは**必ずワーカーを渡す**。
   *
   * 省略すると `identifyAsset` にそのまま落ちる = ハッシュがメインで走る。
   * 同じビルドの A/B(32MB の添付)で、メインの最大欠測が
   * **10/14ms(ワーカー)対 500/726ms(メイン)**。
   * user から実機で「添付とかでメインスレッドブロックするのは気になるね」と報告。
   *
   * ⚠ `identifyAsset` を直接 import しているとここで差し替えられない ──
   *   だから attach 側は**この口だけ**を見る。
   */
  hashBlob?(blob: Blob): Promise<string | null>;
}


/** file.type が空のときの拡張子 fallback(PKC2 は無くて後段の補正 hack を生んだ)。 */
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function resolveMime(name: string, declared: string): string {
  if (declared) return declared;
  if (!name.includes('.')) return 'application/octet-stream'; // 拡張子なし
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** 取込本体。file ごとに独立に成否を扱う(1 個の失敗が batch を殺さない)。 */
export async function attachFiles(
  dispatcher: Dispatcher,
  deps: AttachDeps,
  files: readonly File[],
): Promise<void> {
  if (files.length === 0) return;
  // put の**前に**可視で止める ── ready 以外で進めると bytes だけ書かれて
  // CREATE_ENTRY が黙殺され、参照されない asset が残留する(P4a review #1)
  if (dispatcher.getState().phase !== 'ready') {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: '編集を終了してから添付してください',
    });
    return;
  }

  // content addressing なので**台帳を引かない**。同じ bytes は同じ key に落ちる
  // ので、既に持っているかは key の存在だけで決まる(batch 内の重複も自動で潰れる)
  const known = new Set(
    (await deps.listMetas().catch(() => [])).map((m) => m.key),
  );

  for (const file of files) {
    try {
      // quota preflight ── 足りないときは黙って壊れる前に可視で止める
      if (deps.estimate) {
        const est = await deps.estimate();
        if (
          est.quota !== undefined &&
          est.usage !== undefined &&
          est.quota - est.usage < file.size * 1.2
        ) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `添付を保存する空き容量が不足しています: ${file.name}`,
          });
          continue;
        }
      }

      const mime = resolveMime(file.name, file.type);
      // key = 中身のハッシュ。同一 bytes なら**必ず**同じ key に落ちる
      // ⚠ 帰結 2 点(review #5): sqlite assets.mime は**初回 file のまま**
      // (表示は entry frontmatter 側 mime を使うので正しい ── assets.mime を
      // 信じる消費者を作らない)。asset 削除は参照カウント前提になる
      // (PKC3 の GC は body 走査ベースなので元から正しい)
      // 🔑 ハッシュは**ワーカーで取る**(段㉓)。口が無い環境だけその場で回す
      //    ── 返る key は同じ関数(`assetKeyFromHash`)から出るので、
      //    「ワーカーは速さの話であって、正しさの話ではない」が保たれる
      const { key: assetKey, hash } = deps.hashBlob
        ? assetKeyFromHash(await deps.hashBlob(file))
        : await identifyAsset(file);
      if (!known.has(assetKey)) {
        await deps.putBlob(assetKey, file);
        await deps.putMeta({ key: assetKey, mime, size: file.size, hash });
        known.add(assetKey);
      }

      dispatcher.dispatch({
        type: 'CREATE_ENTRY',
        archetype: 'attachment',
        lid: generateLid(),
        title: file.name,
        body: attachmentBody({ name: file.name, mime, size: file.size, assetKey, hash }),
        edit: false, // 添付は editor に入らない(PKC2 の silent attach と同じ)
      });
    } catch (e) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `添付の取込に失敗しました(${file.name}): ${String(e)}`,
      });
    }
  }
}
