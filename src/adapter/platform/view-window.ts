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
 * ## 🔴 だから「開けたか」が分からない ── 合図を持たせて返させる
 *
 * ⚠ `noopener` は戻り値が**常に `null`** なので、ポップアップが塞がれても分からない
 * (`launch-tile.ts` が URL タイルで既に測って諦めている ── 見分ける形にすると
 * referrer が漏れる)。
 * 🔑 だがこの窓は**同一 origin の PKC 自身**である。だから**こちらが渡した
 * 1 回限りの合図**(URL の `w=`)を、開いた窓に**起動の最初で放送させる**。
 *
 * ⚠ **初稿は「PKC が起動時に撒く名乗り(`hello` / `holder-here`)を待つ」だった。
 *   着地前レビューが誤爆経路を 4 つ数え上げて否定した** ── docstring に書いてあったのは
 *   1 つだけだった:⑴ 別のタブが起動した ⑵ その返答(`holder-here`)
 *   ⑶ **自タブの昇格**(待っている間に本体タブが閉じる)
 *   ⑷ **「別のタブで開いています…」の待機画面が 2 秒ごとに再接続する**。
 *   ⚠ 誤爆すると「開いた」と読むので**退避も理由も出ない = 完全に無言の dead click**
 *   になる(この repo がいちばん嫌う形)。🔑 合図なら**自分の窓しか答えられない**。
 *
 * 🔑 **待つのは失敗したときだけ痛い形にする**:
 * - 開く → **中央の面は触らない**(成功すれば本文はそのまま = user が望んだ形)
 * - 合図が返らなかったら → **そのとき初めて**中央の面で開き、理由を出す(段⑤ の退避先)
 *
 * ⚠ 逆(先に面を開いて、合図が返ったら閉じる)にすると、**成功した回に面が一瞬ちらつく**。
 */
import { formatViewDeepLink } from '../../features/link/permalink';
import type { Broadcaster } from './storage/store-proxy';
import type { ViewMode } from '../state/app-state';

/**
 * 合図が返るのを待つ猶予。⚠ **失敗した回だけ**この時間がかかる。
 *
 * 🔑 **実測で決めた値である**(2026-08-22、`tests/probe/run-view-window-probe.mjs`)──
 * 合図は `main.ts` の**いちばん最初**(storage の初期化より前)で放送するので、
 * かかるのは「窓が出て bundle が動き出すまで」だけである。
 * ⚠ 数字は probe の docstring に置く(ここへ書き写すと二重帳簿になる)。
 */
export const VIEW_WINDOW_ANNOUNCE_MS = 2500;

/** 合図をやり取りする放送路。⚠ store の protocol とは**別にする**(混ぜない)。 */
export const VIEW_WINDOW_CHANNEL = 'pkc3-view-window';

/** 合図の便りの種別。⚠ 名前を付ける ── 将来この路に別の便りが乗っても取り違えない。 */
export const VIEW_WINDOW_OPEN = 'view-window-open';

/** ⚠ 差し替えられるようにしておく(test は本物の放送を持たずに通す)。 */
export type MakeChannel = (name: string) => Broadcaster;

function openChannel(make: MakeChannel | undefined): Broadcaster | null {
  if (make !== undefined) return make(VIEW_WINDOW_CHANNEL);
  if (typeof BroadcastChannel !== 'function') return null;
  return new BroadcastChannel(VIEW_WINDOW_CHANNEL) as unknown as Broadcaster;
}

export interface ViewWindowDeps {
  /** 窓を開く。⚠ `noopener` で開くこと(戻り値は見ない ── 常に `null`)。 */
  readonly open: (url: string) => void;
  /** 断片を除いたいまのアドレス。 */
  readonly baseUrl: () => string;
  /**
   * 🔴 **いま見ていたノート**(#300 段③ の直し、2026-08-22)。⚠ **連れて行く** ──
   * 渡さないと、別窓のカレンダーは「日を押す前に、左の一覧からノートを選んで
   * ください」で立ち上がる(= **その窓では日付を付けられない**)。動線レビューが
   * 「さっきまで読んでいたノートを探し直させている」として拾った当の穴である。
   * ⚠ `null` を返してよい(何も選んでいないときは連れて行くものが無い)。
   */
  readonly selected: () => { containerId: string; lid: string } | null;
  /** 1 回限りの合図を作る。⚠ test は固定値を返す。 */
  readonly newToken: () => string;
  /**
   * 合図 `token` が返るのを `ms` まで待つ。返ったら `true`。
   * ⚠ **`open` より前に呼ぶ**(購読を張ってから開く ── 取りこぼさない)。
   */
  readonly waitForOpen: (token: string, ms: number) => Promise<boolean>;
  /**
   * 退避:中央の面で開く(段⑤)。
   * 🔴 **開けたかを返す** ── 編集中は `SET_VIEW_MODE` が断られる
   * (`app-state.ts` の「編集中は…を開けません」)ので、返り値を見ずに
   * 「この画面で開きました」と言うと**嘘になる**(着地前レビュー 6)。
   */
  readonly openInPane: (view: ViewMode) => boolean;
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
 *
 * 🔴 **退避は「開く」であって「トグル」ではない**(着地前レビュー 1)。
 * ⚠ 初稿は退避を `nextViewMode` に通していたので、**塞がれて反応が無いから
 * もう一度押した**回に 2 本目の退避が走り、**開いたばかりの面を閉じて**
 * 「この画面で開きました」と言っていた。⚠ `Alt+6` で 2 ペインを開いてから
 * タイルを押しても同じ(既にその面に居ると閉じる)。
 */
export async function openViewInWindow(
  view: ViewMode,
  deps: ViewWindowDeps,
): Promise<ViewWindowResult> {
  const token = deps.newToken();
  const here = deps.selected();
  const url = formatViewDeepLink(deps.baseUrl(), view, {
    ...(here === null ? {} : { containerId: here.containerId, entry: here.lid }),
    token,
  });
  if (url === null) {
    // ⚠ 組めないのは base に `#` が残っているとき ── **黙って本文で開かない**
    fallback(view, deps, '別のウィンドウを開けませんでした');
    return 'pane';
  }
  // 🔑 **聞く耳を先に張ってから開く** ── 逆にすると、速い窓の合図を取りこぼす
  const answered = deps.waitForOpen(token, VIEW_WINDOW_ANNOUNCE_MS);
  deps.open(url);
  if (await answered) return 'window';
  // 🔑 合図が返らなかった = 窓が出ていない。**ここで初めて**中央の面を使う
  fallback(view, deps, 'ブラウザが新しいウィンドウをブロックしたようです');
  return 'pane';
}

/**
 * 退避して理由を出す。
 * ⚠ **文言は「実際に起きたこと」で分ける** ── 面が開かなかった回に
 * 「この画面で開きました」と言うと、user は**開いていない面を探す**。
 */
function fallback(view: ViewMode, deps: ViewWindowDeps, why: string): void {
  const landed = deps.openInPane(view);
  deps.fail(
    landed
      ? `${why}(この画面で開きました)。別のウィンドウで使うには、ポップアップの許可を出してください`
      : `${why}。編集を終えてから、もう一度お試しください`,
  );
}

/**
 * 🔴 **自分が渡した合図が返るのを待つ**(既定の実装)。
 *
 * ⚠ 見るのは**種別と合図の一致**だけ ── 「何か放送が来た」で真にすると、
 * 背面のタブの保存や別のタブの起動で「開いた」と誤読する(冒頭の誤爆経路)。
 */
export function waitForViewWindow(
  token: string,
  ms: number,
  makeChannel?: MakeChannel,
): Promise<boolean> {
  const ch = openChannel(makeChannel);
  // ⚠ 放送路が無い環境では**見分けられない** ── 退避すると「開いているのに
  //    面まで奪う」ことになるので、開いた側に倒す
  if (ch === null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (answer: boolean): void => {
      clearTimeout(timer);
      ch.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), ms);
    ch.onmessage = (ev: MessageEvent) => {
      const wire = ev.data as { kind?: unknown; token?: unknown } | null;
      if (wire?.kind === VIEW_WINDOW_OPEN && wire.token === token) done(true);
    };
  });
}

/**
 * 🔴 **開いた窓が「出ましたよ」と返す**(#300 段③ の直し)。
 *
 * ⚠ **起動のいちばん最初に呼ぶ** ── storage の初期化を待ってから放送すると、
 * 開けているのに待ち時間を使い切って**退避してしまう**(そして本文が消える =
 * user の苦情そのものの再現)。
 */
export function announceViewWindow(token: string, makeChannel?: MakeChannel): void {
  const ch = openChannel(makeChannel);
  if (ch === null) return;
  ch.postMessage({ kind: VIEW_WINDOW_OPEN, token });
  ch.close();
}

/**
 * 🔴 **アプリの窓で `× 閉じる` を押したら、窓ごと閉じる**(#300 段③ の直し、2026-08-22)。
 *
 * ⚠ 直す前は、別窓のカレンダーで `× 閉じる` を押すと **`SET_VIEW_MODE 'detail'`**
 * が飛ぶだけだった ── **窓は残り、そこに「本文」が出る**。user から見ると
 * 「アプリを閉じたら、なぜか PKC がもう 1 つ増えた」である
 * (しかもその窓の左列からタイルを押せば 3 枚目が開く)。動線レビュー §7。
 *
 * ## 🔴 「閉じられる窓」かは**実測で決めた**
 *
 * `window.close()` は**script で開いた窓**にしか効かない(HTML 仕様
 * script-closable)。⚠ `noopener` で開いた窓もその仲間かは仕様の読みが割れるので、
 * **両方の Chromium で測った**(2026-08-22):
 *
 * | 開き方 | `close()` で閉じたか |
 * |---|---|
 * | `window.open(url, '_blank', 'noopener')` | ✅ 閉じた |
 * | `window.open(url, '_blank')` | ✅ 閉じた |
 * | **user が開いた窓(対照群)** | ❌ 閉じない |
 *
 * 🔑 対照群が閉じなかったので、この計器は**空振りしていない**。
 * ⚠ ただし **user がブックマークから開いた窓は閉じられない** ── そのときは
 * 黙って何もしないのではなく、**理由を出して本文へ畳む**(下の `'refused'`)。
 *
 * ## ⚠ 「アプリの窓か」は**断片を握っている間だけ**
 *
 * 🔑 断片(`#pkc?view=…`)から離れた窓は、もう**ふつうの PKC** である
 * (段② の裁定「見ている間は残す。離れたら消す」がそのまま使える)──
 * そこで `× 閉じる` が窓を閉じたら、user は本文の作業ごと失う。
 */
export interface CloseViewWindowDeps {
  /** いま断片が面を指しているか(= この窓はアプリの窓か)。 */
  readonly holding: () => boolean;
  readonly close: () => void;
  /** 閉じたか。⚠ **試した後に読む** ── 「呼べた」は「閉じた」ではない。 */
  readonly isClosed: () => boolean;
}

export type CloseViewWindowResult =
  /** 窓ごと閉じた ── 呼び側は面を畳まない(もう画面が無い)。 */
  | 'closed'
  /** アプリの窓だが閉じられなかった ── 理由を出して本文へ畳む。 */
  | 'refused'
  /** ふつうの窓 ── 今までどおり面を畳むだけ。 */
  | 'not-a-window';

export function closeViewWindow(deps: CloseViewWindowDeps): CloseViewWindowResult {
  if (!deps.holding()) return 'not-a-window';
  deps.close();
  return deps.isClosed() ? 'closed' : 'refused';
}

/** `'refused'` のときに出す理由。⚠ **次に何をすればよいか**まで書く。 */
export const CLOSE_VIEW_WINDOW_REFUSED =
  'このウィンドウはブラウザの制限で閉じられません(ブラウザのウィンドウ枠にある × で閉じてください)。本文に戻りました';
