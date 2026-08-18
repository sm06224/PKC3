/**
 * 🔴 **貼り付けた本文の `data:` / `blob:` を資産にする**(#251 の B + C の実体)。
 *
 * ⚠ **`main.ts` から出してある**(着地前レビュー)── `main.ts` は原文を読む test しか
 * 持てないので、そこへ判断を書くと「全 test 緑のまま取り違える」形になる
 * (CLAUDE.md §2「どの test からも実行されない file に、判断を書かない」)。
 *
 * ## ここが持つ判断は 4 つ
 * 1. **待つ**(`queued`)── 断ると `blob:` は**永久に失われる**。あれは貼った瞬間しか
 *    読めず、しかも貼付には picker が無いので「もう一度選び直してください」が成立しない
 *    (`asset-gate.ts` が `queued` を「選び直せない経路のために在る」と書いている当のもの)
 * 2. **読めない**と**置けない**を分ける ── 前者は元の参照のまま残して数え、後者は
 *    理由を言う(空き容量など、user が直せる原因を黙らせない)
 * 3. **画像だけ**受ける ── 読んでみるまで種類は分からないので `fetch` のあとに判定する
 * 4. **1 件ずつ順に**処理して都度捨てる(並べると heap に載る ── 不可侵指示 2026-07-27)
 */
import type { AssetGate } from './asset-gate';
import { storeAsset, type AttachDeps } from './attach';
import { isImageAssetMime } from '@features/asset/asset-ref-format';
import { pastedImageName } from '@features/asset/pasted-image-name';

export interface AdoptDeps {
  readonly gate: AssetGate;
  readonly attach: AttachDeps;
  /** URL を bytes にする(既定は `fetch`)。⚠ `data:` も `blob:` も同じ口で読める。 */
  readonly fetchBlob: (url: string) => Promise<Blob>;
  /** 名前に使う時刻(features 層に `Date` を作らせないのと同じ作法)。 */
  readonly now: () => Date;
}

export interface AdoptOutcome {
  /** `url → asset:<key>`。⚠ **読めなかった url は入れない**。 */
  readonly adopted: ReadonlyMap<string, string>;
  /**
   * 🔴 **置けなかった理由**(空き容量など、user が直せるもの)。
   *
   * ⚠ ここで `OP_FAILED` を撃たない(検算で判明)── `state.error` は **1 枠**しか
   * 無く、呼び側が最後に出す件数の総括に**上書きされて消える**。理由は呼び側へ
   * 返し、**1 本の文言に組み立てさせる**のが正しい。
   */
  readonly problems: readonly string[];
}

/**
 * `url → asset:<key>` の対応を返す。⚠ **読めなかった url は入れない** ──
 * 呼び側が「元のまま残した」と件数で言えるようにする(黙って消さない)。
 */
export async function adoptPastedUrls(
  deps: AdoptDeps,
  urls: readonly string[],
): Promise<AdoptOutcome> {
  const out = new Map<string, string>();
  const problems: string[] = [];
  if (urls.length === 0) return { adopted: out, problems };
  // ⚠ 整理(未参照 GC)と排他にする ── 本文へ差すのは put のあとなので、
  //   その窓で整理が走ると貼ったばかりの bytes を「使っていない」と数えて消す
  await deps.gate.queued(async () => {
    const known = new Set((await deps.attach.listMetas().catch(() => [])).map((m) => m.key));
    for (const url of urls) {
      let blob: Blob;
      try {
        blob = await deps.fetchBlob(url);
      } catch {
        // 読めない 1 件で全部を失わない ── その 1 件だけ元の参照のまま残る
        continue;
      }
      if (blob.size === 0 || !isImageAssetMime(blob.type)) continue;
      const name = pastedImageName({ type: blob.type }, deps.now(), '貼付画像');
      try {
        const stored = await storeAsset(
          deps.attach,
          { name, type: blob.type, size: blob.size, blob },
          known,
        );
        out.set(url, `asset:${stored.assetKey}`);
      } catch (e) {
        // ⚠ **置けない**は理由を残す ── 「読み込めませんでした」に畳むと、
        //   user は直せる原因(空き容量)を知らないまま同じ操作を繰り返す
        problems.push((e as Error).message);
      }
    }
  });
  return { adopted: out, problems };
}
