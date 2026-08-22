/**
 * 🔴 **組み込みアプリを別窓で開く**(#300 段③、2026-08-22)。
 *
 * > 「**組み込みのアプリに関しては全て別窓で作業したい Office みたいに!**」
 * > 「**メインの PKC の機能を阻害する方向で PKC のセンターペインを占有するなって話**」
 * > (user 要望 2026-08-21 / 指摘 2026-08-22)
 *
 * ## なぜ「中央の面」ではいけないのか
 *
 * カレンダー / やることの板 / 2 ペインは `ViewMode` = **中央の面**なので、開くと
 * **本文が消える**。user は「アプリを見たかった」だけで「本文を閉じたかった」わけでは
 * ない。⚠ しかも帰り道は「同じタイルをもう一度押す」だけで、それを知っているのは
 * 実装した本人だけだった。
 *
 * ## 🔴 開き方は `noopener`(段① と段③ の実測で決めた)
 *
 * | | `noopener` | 後から `opener` を切る |
 * |---|---|---|
 * | follower になる / 昇格する | ✅ / ✅ | ✅ / ✅ |
 * | 2 枚目の増分 | +31.7 MB / **プロセス +1** | +17.2 MB / プロセス +0 |
 * | 閉じたときに還る量 | **−32.2 MB** | **−4.6 MB** |
 *
 * 🔑 後者は同じ browsing context group に残る = **同じ renderer プロセスを共有**する。
 * 増分は小さく見えるが ①**閉じても還らない**(開け閉めするほど積む)
 * ②**メインスレッドを共有する**(カレンダーの描画が本文の打鍵と取り合う)。
 * ⚠ user 不可侵指示は「**効くのは定常 / もっさりだと嫌**」なので、こちらを取らない。
 *
 * ## 🔴 だから「開けたか」が分からない ── 名乗りで見分ける
 *
 * ⚠ `noopener` は戻り値が**常に `null`** なので、ポップアップが塞がれても分からない
 * (`launch-tile.ts` が URL タイルで既に測って諦めている ── 見分ける形にすると
 * referrer が漏れる)。
 * 🔑 だがこの窓は**同一 origin の PKC 自身**である。PKC は起動時に
 * `store-proxy` の放送へ**必ず名乗る**(follower は `hello`、本体は `holder-here`)。
 * だから**それを待つ**。
 *
 * 🔑 **待つのは失敗したときだけ痛い形にする**:
 * - 開く → **中央の面は触らない**(成功すれば本文はそのまま = user が望んだ形)
 * - 名乗りが来なかったら → **そのとき初めて**中央の面で開き、理由を出す(段⑤ の退避先)
 *
 * ⚠ 逆(先に面を開いて、名乗ったら閉じる)にすると、**成功した回に面が一瞬ちらつく**。
 */
import { formatViewDeepLink } from '../../features/link/permalink';
import { STORE_PROXY_CHANNEL } from './storage/store-proxy';
import type { ViewMode } from '../state/app-state';

/** 新しい PKC が名乗るのを待つ猶予。⚠ **失敗した回だけ**この時間がかかる。 */
export const VIEW_WINDOW_ANNOUNCE_MS = 2500;

export interface ViewWindowDeps {
  /** 窓を開く。⚠ `noopener` で開くこと(戻り値は見ない ── 常に `null`)。 */
  readonly open: (url: string) => void;
  /** 断片を除いたいまのアドレス。 */
  readonly baseUrl: () => string;
  /**
   * 新しい PKC が名乗るのを `ms` まで待つ。名乗ったら `true`。
   * ⚠ 差し替えられるようにしておく(test は放送を持たずに通す)。
   */
  readonly waitForAnnounce: (ms: number) => Promise<boolean>;
  /** 退避:中央の面で開く(段⑤)。 */
  readonly openInPane: (view: ViewMode) => void;
  /** 理由を画面へ出す。 */
  readonly fail: (message: string) => void;
}

/** どこで開いたか。⚠ 呼び側が数えるためではなく、**test の観測点**として返す。 */
export type ViewWindowResult = 'window' | 'pane';

/**
 * 面を別窓で開く。開けなければ中央の面へ退避して理由を出す。
 *
 * ⚠ **窓の使い回しはしない**(#300 段③ の裁定)── 同じタイルを 2 回押したら
 * 2 枚開く。PKC3 の面は 2 枚あってよい(Office の heartbeat は 1 窓 750MB を
 * 2 枚立てないための仕掛けで、こちらには要らない)。
 */
export async function openViewInWindow(
  view: ViewMode,
  deps: ViewWindowDeps,
): Promise<ViewWindowResult> {
  const url = formatViewDeepLink(deps.baseUrl(), view);
  if (url === null) {
    // ⚠ 組めないのは base に `#` が残っているとき ── **黙って本文で開かない**
    deps.openInPane(view);
    deps.fail('別の窓を開けませんでした(この画面で開きました)');
    return 'pane';
  }
  deps.open(url);
  if (await deps.waitForAnnounce(VIEW_WINDOW_ANNOUNCE_MS)) return 'window';
  // 🔑 名乗らなかった = 窓が出ていない。**ここで初めて**中央の面を使う
  deps.openInPane(view);
  deps.fail(
    'ブラウザが新しい窓を塞いだようです(この画面で開きました)。別の窓で使うには、ポップアップの許可を出してください',
  );
  return 'pane';
}

/**
 * 🔴 **新しい PKC の名乗りを待つ**(既定の実装)。
 *
 * ⚠ 見るのは `hello`(follower)と `holder-here`(本体)だけ ── どちらも
 * **起動のときにしか飛ばない**。`changed` などを数えると、別のタブの保存で
 * 「開いた」と誤読する。
 * ⚠ それでも**同じ瞬間に別のタブが起動すれば取り違える**。⚠ そのとき起きるのは
 * 「退避しそこねる」だけで、ブラウザ自身の遮断表示は出たままである ── 実害は小さい。
 */
export function waitForPkcAnnounce(ms: number): Promise<boolean> {
  if (typeof BroadcastChannel !== 'function') return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const ch = new BroadcastChannel(STORE_PROXY_CHANNEL);
    const done = (answer: boolean): void => {
      clearTimeout(timer);
      ch.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), ms);
    ch.onmessage = (ev: MessageEvent) => {
      const kind = (ev.data as { kind?: unknown } | null)?.kind;
      if (kind === 'hello' || kind === 'holder-here') done(true);
    };
  });
}
