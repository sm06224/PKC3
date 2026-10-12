/**
 * 🔴 **可搬単一 HTML に焼いた添付を、器へ戻す**(#400 段④)。
 *
 * DB 画像が持っているのは添付の**目録の行**だけで、**bytes は IDB Blob** に在る
 * (設計 doc §4.2 ── bytes を sqlite の wasm メモリに通さないための分離)。
 * だから可搬バンドルは bytes も焼き、起動時にここで器へ戻す。
 *
 * ## ⚠ 1 件ずつ流す(1 件が大きいときは要素ごとにも)
 *
 * 全部いっぺんに復号すると、**添付の総量ぶんが同時に heap に載る**。
 * 🔑 1 件ごとに「復号 → 器へ put → **その `<script>` を DOM から外す**」まで
 * やって、次へ行く ── ピークは**いちばん大きい添付 1 件**になる。
 *
 * ## ⚠ 2 回目の起動では何もしない
 *
 * 器に既に在る key は飛ばす(節点だけ外す)── 再読込のたびに全添付を
 * 書き直すと、起動が添付の量に比例して遅くなる。
 */

import { decodeImageParts, groupAssetParts } from '@features/portable/bundle';

export const ASSET_SELECTOR = 'script[data-pkc-asset]';

export interface EmbeddedAssetSink {
  listKeys(cid: string): Promise<string[]>;
  put(cid: string, assetKey: string, blob: Blob): Promise<void>;
}

export interface RestoreAssetsResult {
  readonly restored: number;
  /** 器に既に在ったので飛ばした数。 */
  readonly skipped: number;
  /** 読めなかった数。⚠ **黙って 0 に畳まない**(呼び側が user へ出す)。 */
  readonly failed: number;
}

export async function restoreEmbeddedAssets(
  doc: Document,
  cid: string,
  sink: EmbeddedAssetSink,
): Promise<RestoreAssetsResult> {
  const nodes = [...doc.querySelectorAll(ASSET_SELECTOR)];
  if (nodes.length === 0) return { restored: 0, skipped: 0, failed: 0 };

  /**
   * ⚠ **器の中身は 1 回だけ聞く** ── 1 件ごとに `get` すると、
   *   「在るか」を知るために **bytes を全部読む**ことになる(いちばんやりたくない)。
   */
  let have: Set<string>;
  try {
    have = new Set(await sink.listKeys(cid));
  } catch {
    have = new Set();
  }

  let restored = 0;
  let skipped = 0;
  let failed = 0;
  /**
   * 🔴 **添付は 3MiB ごとの要素に割って焼いてある**(#1416 §7-4d。割る前の版の 1 要素 = 1 件も読める)。
   * 文書の順に**塊**(同じ key の続き)にして、1 件ずつ「復号 → 器へ put → 要素を外す」。
   * 揃っているか(欠け・重複・順の乱れ)は、中身を読む前に印だけで見る ── 揃っていなければその 1 件だけ `failed`。
   */
  const items = nodes.map((el) => ({
    key: el.getAttribute('data-pkc-asset') ?? '',
    mark: el.getAttribute('data-pkc-asset-part') ?? '',
  }));
  for (const run of groupAssetParts(items)) {
    const els = nodes.slice(run.start, run.start + run.count);
    const key = items[run.start]!.key;
    const mime = els[0]!.getAttribute('data-pkc-asset-mime') || 'application/octet-stream';
    // 🔑 要素を外す口は 1 つ ── 以下のどこで落ちても、base64 の文字列は残さない
    const drop = (): void => {
      for (const el of els) {
        el.textContent = '';
        el.remove();
      }
    };
    if (key === '' || run.broken !== null) {
      drop();
      failed++;
      continue;
    }
    if (have.has(key)) {
      drop();
      skipped++;
      continue;
    }
    try {
      // 読んだ要素は**その場で**外す(復号は 1 本へ直に書く。`decodeImageParts` は貯めない)
      const bytes = decodeImageParts(
        els.map((el) => () => {
          const t = el.textContent ?? '';
          el.textContent = '';
          el.remove();
          return t;
        }),
      );
      if (bytes === null) {
        failed++; // 空の添付は戻さない(割る前の版と同じ)
        continue;
      }
      await sink.put(cid, key, new Blob([bytes as unknown as BlobPart], { type: mime }));
      restored++;
    } catch {
      failed++;
    } finally {
      drop();
    }
  }
  return { restored, skipped, failed };
}
