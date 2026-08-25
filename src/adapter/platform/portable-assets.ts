/**
 * 🔴 **可搬単一 HTML に焼いた添付を、器へ戻す**(#400 段④)。
 *
 * DB 画像が持っているのは添付の**目録の行**だけで、**bytes は IDB Blob** に在る
 * (設計 doc §4.2 ── bytes を sqlite の wasm メモリに通さないための分離)。
 * だから可搬バンドルは bytes も焼き、起動時にここで器へ戻す。
 *
 * ## ⚠ 1 件ずつ流す
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

function decodeBase64(text: string): ArrayBuffer {
  const bin = atob(text);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
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
  for (const el of nodes) {
    const key = el.getAttribute('data-pkc-asset') ?? '';
    const mime = el.getAttribute('data-pkc-asset-mime') || 'application/octet-stream';
    const text = (el.textContent ?? '').trim();
    // 🔑 **先に外す** ── 以下のどこで落ちても、base64 の文字列は残さない
    el.remove();
    if (key === '') {
      failed++;
      continue;
    }
    if (have.has(key)) {
      skipped++;
      continue;
    }
    if (text === '') {
      failed++;
      continue;
    }
    try {
      await sink.put(cid, key, new Blob([decodeBase64(text)], { type: mime }));
      restored++;
    } catch {
      failed++;
    }
  }
  return { restored, skipped, failed };
}
