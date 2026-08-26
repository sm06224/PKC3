/**
 * 🔴 **本文の画像を資産にする**(#251 の B + C = 貼付の `data:` / `blob:` /
 * #264 段①+② = **外部の `https:`**)。
 *
 * ⚠ **`main.ts` から出してある**(着地前レビュー)── `main.ts` は原文を読む test しか
 * 持てないので、そこへ判断を書くと「全 test 緑のまま取り違える」形になる
 * (CLAUDE.md §2「どの test からも実行されない file に、判断を書かない」)。
 *
 * ## ここが持つ判断は 5 つ
 * 1. **待つ**(`queued`)── 断ると `blob:` は**永久に失われる**。あれは貼った瞬間しか
 *    読めず、しかも貼付には picker が無いので「もう一度選び直してください」が成立しない
 *    (`asset-gate.ts` が `queued` を「選び直せない経路のために在る」と書いている当のもの)
 * 2. 🔴 **入らなかった理由を、1 件ずつ言う**(#264 段②)。
 *    ⚠ 直す前は `catch { continue }` と `if (…) continue` で**理由を捨てて**おり、
 *    呼び側は「N 件を読み込めませんでした」としか言えなかった ── **読めたのに画像で
 *    なかった**ものまで「読み込めませんでした」と嘘の理由が出ていた
 * 3. **画像だけ**受ける ── 読んでみるまで種類は分からないので `fetch` のあとに判定する
 * 4. **1 件ずつ順に**処理して都度捨てる(並べると heap に載る ── 不可侵指示 2026-07-27)
 * 5. 名前の**名乗り**を経路ごとに変える(`貼付画像` / `取込画像`)── 置けなかった
 *    ときの断り文に名前が出るので、どちらの操作で失敗したかが読めるようにする
 */
import type { AssetGate } from './asset-gate';
import { storeAsset, type AttachDeps } from './attach';
import { isImageAssetMime } from '@features/asset/asset-ref-format';
import { pastedImageName } from '@features/asset/pasted-image-name';

/** 貼り付けた本文から拾った画像の名乗り(#251)。 */
export const PASTED_IMAGE_PREFIX = '貼付画像';
/** 押して外から取り込んだ画像の名乗り(#264 段①)。 */
export const ADOPTED_IMAGE_PREFIX = '取込画像';

/**
 * 🔴 **状態番号を落とさずに読む**(#264 段②)。
 *
 * ⚠ `fetch` は **404 でも例外にならない** ── そのまま `.blob()` するとエラーページの
 *   HTML が返り、下の判定で「**画像ではありませんでした**」に化ける。
 *   user から見ると「置き場所が消えている」のに「画像ではない」と言われる形で、
 *   **直しようが無い**(#264 が「404 を言え」と書いている当のもの)。
 */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`置き場所が ${status} を返しました`);
    this.name = 'HttpStatusError';
  }
}

/** 既定の読み口。⚠ `data:` も `blob:` も `https:` も同じ `fetch` で読める。 */
export async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpStatusError(res.status);
  return res.blob();
}

export interface AdoptDeps {
  readonly gate: AssetGate;
  readonly attach: AttachDeps;
  /** URL を bytes にする(既定は `fetchImageBlob`)。 */
  readonly fetchBlob: (url: string) => Promise<Blob>;
  /** 名前に使う時刻(features 層に `Date` を作らせないのと同じ作法)。 */
  readonly now: () => Date;
}

/** 入らなかった 1 件。⚠ **url を落とさない** ── どれが残ったかを呼び側が言える。 */
export interface AdoptFailure {
  readonly url: string;
  /** user が読む 1 行。⚠ **観測したことだけ**書く(推測を書かない)。 */
  readonly why: string;
  /**
   * 🔴 **user が直せるか**(空き容量を空ける・置き場所を直す)。
   * ⚠ 断り文は**これが真のものを先に**出す ── 動ける情報を後ろへ回さない。
   */
  readonly fixable: boolean;
}

export interface AdoptOutcome {
  /** `url → asset:<key>`。⚠ **入らなかった url は入れない**。 */
  readonly adopted: ReadonlyMap<string, string>;
  /**
   * 🔴 **入らなかったもの**(#264 段②)。
   *
   * ⚠ ここで `OP_FAILED` を撃たない(検算で判明)── `state.error` は **1 枠**しか
   * 無く、呼び側が最後に出す件数の総括に**上書きされて消える**。理由は呼び側へ
   * 返し、**1 本の文言に組み立てさせる**(`describeAdoptFailures`)。
   */
  readonly failures: readonly AdoptFailure[];
}

/**
 * 🔴 **断りを 1 本の文言にする**(#264 段②)。⚠ **判定を 2 か所に書かない** ──
 * 貼付の経路も取り込みの経路も、この 1 本を通す(CLAUDE.md §7)。
 *
 * - **理由は種類でまとめる** ── 10 枚とも同じ理由なら 1 回だけ書く
 * - **直せるものを先に** ── 空き容量は user が動ける
 * - ⚠ 種類が 3 つ以上あるときは **2 つ書いて「ほか N 種」** と数える
 *   (黙って切らない ── CLAUDE.md「出し切れないときは件数を書く」)
 */
export function describeAdoptFailures(failures: readonly AdoptFailure[]): string {
  const order = [...failures].sort((a, b) => Number(b.fixable) - Number(a.fixable));
  const whys = [...new Set(order.map((f) => f.why))];
  const head = whys.slice(0, 2).join(' / ');
  const rest = whys.length > 2 ? `(ほか ${whys.length - 2} 種)` : '';
  return `${failures.length} 件を取り込めませんでした: ${head}${rest}`;
}

/**
 * `url → asset:<key>` の対応を返す。⚠ **入らなかった url は入れない** ──
 * 呼び側が「元のまま残した」と言えるようにする(黙って消さない)。
 *
 * @param namePrefix 名前の名乗り(`PASTED_IMAGE_PREFIX` / `ADOPTED_IMAGE_PREFIX`)。
 */
export async function adoptUrls(
  deps: AdoptDeps,
  urls: readonly string[],
  namePrefix: string = PASTED_IMAGE_PREFIX,
): Promise<AdoptOutcome> {
  const out = new Map<string, string>();
  const failures: AdoptFailure[] = [];
  if (urls.length === 0) return { adopted: out, failures };
  // ⚠ 整理(未参照 GC)と排他にする ── 本文へ差すのは put のあとなので、
  //   その窓で整理が走ると貼ったばかりの bytes を「使っていない」と数えて消す
  await deps.gate.queued(async () => {
    const known = new Set((await deps.attach.listMetas().catch(() => [])).map((m) => m.key));
    for (const url of urls) {
      let blob: Blob;
      try {
        blob = await deps.fetchBlob(url);
      } catch (e) {
        /**
         * 🔴 **読めなかった理由を捨てない**(#264 段②)。
         * ⚠ 生の `TypeError: Failed to fetch` は user に読めないので**出さない** ──
         *   代わりに「観測したこと」を書く。⚠ 原因は 1 つに決めつけない
         *   (CORS も、届かないのも、同じ例外で来る ── 区別する手段が無い)。
         * 🔑 状態番号だけは**別扱い**にする(`HttpStatusError`)── これは観測値である。
         */
        failures.push({
          url,
          why:
            e instanceof HttpStatusError
              ? e.message
              : '読み込めませんでした(置き場所が許可していないか、届きませんでした)',
          // ⚠ どちらも**こちら側では直せない**(相手の設定・相手の存在)
          fixable: false,
        });
        continue;
      }
      if (blob.size === 0) {
        failures.push({ url, why: '中身が空でした', fixable: false });
        continue;
      }
      if (!isImageAssetMime(blob.type)) {
        // ⚠ 「読み込めませんでした」に畳まない ── **読めている**。画像でないだけである
        failures.push({
          url,
          why: `画像ではありませんでした(${blob.type === '' ? '種類不明' : blob.type})`,
          fixable: false,
        });
        continue;
      }
      const name = pastedImageName({ type: blob.type }, deps.now(), namePrefix);
      try {
        const stored = await storeAsset(
          deps.attach,
          { name, type: blob.type, size: blob.size, blob },
          known,
        );
        out.set(url, `asset:${stored.assetKey}`);
      } catch (e) {
        // ⚠ **置けない**は user が直せる(空き容量)── 断り文の先頭に出す
        failures.push({ url, why: (e as Error).message, fixable: true });
      }
    }
  });
  return { adopted: out, failures };
}
