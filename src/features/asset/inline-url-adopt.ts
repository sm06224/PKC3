/**
 * 貼り付けた本文の **`data:` / `blob:` を資産へ逃がす**(#251 の B + C)。
 *
 * 🔴 なぜ要るか ── どちらも**本文に置いたままでは壊れる**:
 * - `blob:` は**その document のもの**。閉じれば読めなくなる ── 貼った本人が
 *   翌日開くと**画像が消える**(PKC2 の user 報告 2026-05-28 と同じ形)
 * - `data:` は読めるが、数 MB の base64 が**本文の中に居座る**。編集・保存・
 *   描画のたびに丸ごと運ぶことになり、常駐メモリと応答の両方を殺す
 *   (不可侵指示 2026-08-03「効くのは定常」)
 *
 * ## 役割の切れ目(CLAUDE.md「判定を増やさない」)
 * ここは**純関数**だけ ── どこが宛先かは `markdown/link-scan.ts` の 1 本を使い、
 * **拾う**(`adoptableUrls`)と**書き換える**(`rewriteAdopted`)しか持たない。
 * 実際に読み込んで資産にするのは adapter(`fetch` と資産庫を持つ側)である。
 *
 * ⚠ **読めなかったものは元のまま残す**。消すと「貼ったのに何も無い」になり、
 * user は何を失ったのか分からない ── 数(`failed`)を返して呼び側に言わせる。
 */
import { rewriteLinkDests, scanLinks } from '../markdown/link-scan';

/** 資産へ逃がすべき宛先か(`data:` / `blob:` のみ)。 */
export function isAdoptableUrl(dest: string): boolean {
  const t = dest.trim().toLowerCase();
  return t.startsWith('blob:') || t.startsWith('data:');
}

/**
 * 本文に在る `data:` / `blob:` の宛先を**重複なく**・**出てくる順**で返す。
 * ⚠ 同じ URL が 2 回出たら 1 回だけ読む(同じ bytes を 2 度取らない)。
 */
export function adoptableUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const site of scanLinks(text).sites) {
    const dest = site.dest.trim();
    if (!isAdoptableUrl(dest) || seen.has(dest)) continue;
    seen.add(dest);
    out.push(dest);
  }
  return out;
}

export interface AdoptResult {
  readonly text: string;
  /** 資産へ移せた**宛先の数**(同じ URL が 2 回出ても 1 と数える)。 */
  readonly adopted: number;
  /** 読めずに元のまま残した宛先の数。 */
  readonly failed: number;
}

/**
 * `url → asset:<key>` の対応で宛先だけを差し替える。
 * ⚠ 対応に無い(= 読めなかった)ものは**触らない**。
 */
export function rewriteAdopted(text: string, map: ReadonlyMap<string, string>): AdoptResult {
  const done = new Set<string>();
  const missed = new Set<string>();
  const out = rewriteLinkDests(text, scanLinks(text).sites, (site) => {
    const dest = site.dest.trim();
    if (!isAdoptableUrl(dest)) return undefined;
    const next = map.get(dest);
    if (next === undefined) {
      missed.add(dest);
      return undefined;
    }
    done.add(dest);
    return next;
  });
  return { text: out, adopted: done.size, failed: missed.size };
}
