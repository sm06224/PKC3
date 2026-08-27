/**
 * 🔴 **囲みが指している添付を、字として読む**(#444 段①/段②)。
 *
 * 🔑 **読み方の規則を 1 本にする**(CLAUDE.md §7)── 読む人は 2 人いる:
 *   - **画面**(`detail.ts` の hydrator)── 器を後から埋める
 *   - **書き出し**(`pkc3-html.ts` / `export-archive.ts`)── その場で焼き込む
 *   別々に書くと、**片方だけ上限が効かない / 断り文が違う**が静かに起きる。
 *
 * ⚠ ここは bytes を触るので `core` には置けない。⚠ 逆に DOM は 1 行も触らない
 *   ので adapter にも置かない ── 入口は「鍵 → Blob」の口 1 つだけである。
 */
import { MAX_FENCE_ASSET_BYTES } from '../markdown/fence-asset';
import { humanBytes } from './human-bytes';

/** 添付 1 件の読み。⚠ 失敗は**理由つき**で返す(黙って空にしない)。 */
export type FenceAssetRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: string };

/** 鍵 → bytes。⚠ 無ければ `null`(投げてもよい ── ここで受ける)。 */
export type FenceAssetBlobSource = (key: string) => Promise<Blob | null>;

/**
 * 1 件読む。⚠ **大きすぎるものは読まない**(不可侵指示 2026-08-03「効くのは定常」)
 * ── 50MB の字を毎回運ぶと、開くたびにその分を払うことになる。黙って切らない。
 */
export async function readFenceAssetText(
  getBlob: FenceAssetBlobSource,
  key: string,
): Promise<FenceAssetRead> {
  let blob: Blob | null;
  try {
    blob = await getBlob(key);
  } catch {
    blob = null;
  }
  if (!blob) return { ok: false, why: 'その添付が見つかりません' };
  if (blob.size > MAX_FENCE_ASSET_BYTES) {
    return {
      ok: false,
      why: `大きすぎます(${humanBytes(blob.size)} / 上限 ${humanBytes(MAX_FENCE_ASSET_BYTES)})`,
    };
  }
  try {
    return { ok: true, text: await blob.text() };
  } catch {
    return { ok: false, why: '字として読めません' };
  }
}

/**
 * 🔴 **書き出しのために、鍵の束をまとめて読む**(#444 段②)。
 *
 * ⚠ 読めなかったものは**束に入れない** ── 描く側が器のまま理由を出すので、
 *   「持ち出したら中身が空だった」にはならない。⚠ 代わりに `onSkip` で
 *   **書き出しの注意へ積む**(黙って落とさない)。
 */
export async function readFenceAssets(
  getBlob: FenceAssetBlobSource,
  keys: readonly string[],
  onSkip?: (key: string, why: string) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const got = await readFenceAssetText(getBlob, key);
    if (got.ok) out[key] = got.text;
    else onSkip?.(key, got.why);
  }
  return out;
}
