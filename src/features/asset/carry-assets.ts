/**
 * 🔴 **章・囲み・板を、添付ごと他の PKC へ持っていく**(#677 の残り「`asset:` を含む塊は、別の入れ物へ貼ると絵が出ない」)。
 *
 * `asset:<key>` の鍵は**入れ物ごと**に違うので、原文のままコピーして別の PKC へ貼ると絵が出ない。
 * 持っていくときは、画像の宛先を `data:` の字に置き換えてコピーする。貼る側には既に
 * 「`data:` / `blob:` を添付へ逃がす」経路があり(`inline-url-adopt.ts`。#251)、そのまま貼れば貼り先の
 * 入れ物の添付として取り込まれる ── 新しい貼付の口は要らない。
 *
 * ⚠ 運べるのは**画像だけ**(貼る側の取り込みが画像だけを受けるため。#264 段②と同じ線)。画像でない添付
 *   (PDF など)の参照は元のまま残し、その件数を呼び側が user に言う。
 * ⚠ ここは純関数だけ ── どこが宛先かは `markdown/link-scan.ts` の 1 本を使う。bytes を読むのは adapter。
 */
import { rewriteLinkDests, scanLinks } from '../markdown/link-scan';

const ASSET_PREFIX = 'asset:';

/** `asset:<key>` の宛先なら鍵を返す。 */
function assetKeyOf(dest: string): string | null {
  const t = dest.trim();
  if (!t.toLowerCase().startsWith(ASSET_PREFIX)) return null;
  const key = t.slice(ASSET_PREFIX.length);
  return key === '' ? null : key;
}

export interface AssetRefs {
  /** 画像として書かれた `asset:` の鍵(出てくる順・重複なし)。運べる物。 */
  readonly images: readonly string[];
  /** 画像でない `asset:` の参照の数(リンクの数。運べない物)。 */
  readonly others: number;
}

/** 本文に在る添付の参照を数える。⚠ コードの中に書いてあるだけの字は `scanLinks` が除く。 */
export function assetRefsOf(text: string): AssetRefs {
  const images: string[] = [];
  const seen = new Set<string>();
  let others = 0;
  for (const site of scanLinks(text).sites) {
    const key = assetKeyOf(site.dest);
    if (key === null) continue;
    if (!site.image) {
      others += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(key);
  }
  return { images, others };
}

/** 添付の参照が 1 つでも在るか(メニューに「添付ごと」を出す条件)。 */
export function hasAssetRefs(text: string): boolean {
  for (const site of scanLinks(text).sites) if (assetKeyOf(site.dest) !== null) return true;
  return false;
}

/**
 * 画像の `asset:<key>` を `data:` の字に置き換える。
 * ⚠ 対応表に無い鍵(読めなかった)と、画像でない参照は**触らない**(黙って消さない)。
 */
export function carryAssets(text: string, dataUrls: ReadonlyMap<string, string>): string {
  return rewriteLinkDests(text, scanLinks(text).sites, (site) => {
    if (!site.image) return undefined;
    const key = assetKeyOf(site.dest);
    return key === null ? undefined : dataUrls.get(key);
  });
}
