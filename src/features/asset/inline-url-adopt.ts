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
 * user は何を失ったのか分からない。
 *
 * 🔴 **理由を言うのはここではない**(#264 段②、2026-08-26 に移した)。
 * ⚠ 直す前はここが返す `failed`(件数)から呼び側が文言を組んでいたが、
 *   件数しか無いので「**読めなかった**」としか書けず、**読めていたのに画像で
 *   なかった**ものにも同じ字が出ていた。いまは理由を持っている側
 *   (`adapter/ui/actions/adopt-urls.ts` の `AdoptFailure`)が言う。
 */
import { rewriteLinkDests, scanLinks, type LinkSite } from '../markdown/link-scan';

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

/**
 * 🔴 **外へ取りに行ってよい宛先か**(#264 段①)。
 *
 * ⚠ **`http(s):` の「画像として書かれたもの」だけ** ── リンクを含めると、
 *   user が単に貼った web ページの URL まで**第三者へ通信する**ことになる
 *   (#264 が「自動で取り込む」を棄却した理由② を、押した瞬間にリンクの数だけやる形)。
 * 🔑 だから**行く前に絞る** ── 「fetch して MIME で捨てる」では遅い(通信そのものが問題)。
 */
export function isExternalImageUrl(dest: string): boolean {
  const t = dest.trim().toLowerCase();
  return t.startsWith('http://') || t.startsWith('https://');
}

/**
 * 本文に在る**外部の画像**の宛先を、重複なく・出てくる順で返す(#264 段①)。
 *
 * 🔴 **`site.image` を見る**(#264 段⓪ が足したもの)── ⚠ 見ないと
 *   `[記事](https://…)` まで拾って、押した瞬間に**リンクの数だけ**外へ飛ぶ。
 * ⚠ **参照形式の定義行は `image: false`** なので、ここでは拾わない ──
 *   定義だけを見て「画像だ」と決めると、**同じ定義をリンクとしても使っている
 *   ノート**で取りに行ってしまう(段⓪ の注記)。
 */
export function externalImageUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const site of scanLinks(text).sites) {
    if (!site.image) continue;
    const dest = site.dest.trim();
    if (!isExternalImageUrl(dest) || seen.has(dest)) continue;
    seen.add(dest);
    out.push(dest);
  }
  return out;
}

/**
 * 🔴 **外部画像の書き換えに使う述語**(#264 段①)。
 * ⚠ **`image` を見る** ── 同じ URL のリンクを巻き込まないため(上の注記)。
 * 🔑 呼び側に組み立てさせない(§7 ── 拾う側と書き換える側で規則を割らない)。
 */
export const acceptsExternalImage = (site: LinkSite): boolean =>
  site.image && isExternalImageUrl(site.dest.trim());

export interface AdoptResult {
  readonly text: string;
  /**
   * 資産へ移せた**宛先の数**(同じ URL が 2 回出ても 1 と数える)。
   * ⚠ **いま製品はこれを読んでいない**(断り文は `adopt-urls.ts` が組む)──
   *   残してあるのは「この書換が何をしたか」の summary だからで、
   *   **user に見える文言の材料ではない**(そう使うと理由が件数に潰れる)。
   */
  readonly adopted: number;
  /** 当てる対象なのに対応表に無く、元のまま残した宛先の数。⚠ 上と同じ扱い。 */
  readonly failed: number;
}

/**
 * `url → asset:<key>` の対応で宛先だけを差し替える。
 * ⚠ 対応に無い(= 読めなかった)ものは**触らない**。
 */
export function rewriteAdopted(
  text: string,
  map: ReadonlyMap<string, string>,
  /**
   * 🔴 **どの site を相手にするか**(#264 段①で引数にした)。
   *
   * ⚠ 直す前は `isAdoptableUrl`(`data:` / `blob:`)を**内部で決め打ち**していた ──
   *   #264 の本文は「`rewriteAdopted` がそのまま使える」と書いていたが、
   *   **半分だけ正しかった**(外部画像を通すには述語が要る)。
   * 🔴 **宛先ではなく site を渡す** ── 宛先だけだと、
   *   `![絵](https://x/a.png)` と `[記事](https://x/a.png)` が**同じ URL のとき**、
   *   ⚠ **リンクのほうまで `asset:` に書き換わる**(押していないのに、
   *   リンクが添付のダウンロード導線に化ける)。site を見れば `image` で分けられる。
   * ⚠ 既定は元のまま ── 貼付の経路は 1 ドットも変わらない。
   */
  accepts: (site: LinkSite) => boolean = (site) => isAdoptableUrl(site.dest.trim()),
): AdoptResult {
  const done = new Set<string>();
  const missed = new Set<string>();
  const out = rewriteLinkDests(text, scanLinks(text).sites, (site) => {
    const dest = site.dest.trim();
    if (!accepts(site)) return undefined;
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
