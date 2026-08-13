/**
 * Office の窓が**固まった**ことに、本体側から気づく(#135)。
 *
 * ## 何が起きているか
 *
 * `Table → Insert Table…` を押すと **3 分 30 秒以上タブが固まり、タブを閉じるまで
 * 復帰しない**(検証レポート #5、2026-08-13)。⚠ このとき窓の中では**帯も停止画面も
 * 出ない** ── メインスレッドが wasm の中で回りっぱなしなので、`host.html` の JS も
 * 動けない。**窓の中に置いた検知は全部止まる。**
 *
 * 本体は別タブ(`noopener` = **別 browsing context group = 別 process**、
 * `office-window.ts` の実測表)なので生きている。だから**本体から見る**。
 *
 * ## 🔴 「5 秒途切れたらハング」は、そのままだと誤検知する
 *
 * 生存通知は `setInterval(…, 1500)` で出ている(`host.html`)。ところが Chrome は
 * **背面タブのタイマーを絞る** ── 5 分ほど背面に居ると **1 分に 1 回**まで落ちる。
 * 窓が背面なら **60 秒空くのが正常**なので、4 秒の物差しを当てれば**必ず**鳴る。
 *
 * 🔑 そこで**生存通知に「窓が表に居たか」を載せた**(`alive.visible`)。
 * 物差しを 2 つ持ち、**最後の通知がどちら側で出たか**で使い分ける。
 *
 * | 最後の通知 | 物差し | 根拠 |
 * |---|---|---|
 * | 窓が**表** | {@link HANG_GAP_FOREGROUND_MS}(4 秒) | 絞りが掛からない。1.5 秒間隔の 2.6 倍 |
 * | 窓が**背面** | {@link HANG_GAP_BACKGROUND_MS}(70 秒) | intensive throttling の 1 分周期 + 余裕 |
 *
 * ## 🔴 常駐タイマーを置かない ── **本体タブが表に戻った瞬間に 1 回だけ見る**
 *
 * ⚠ 本体側にタイマーを置くと、**今度は本体が背面のときに絞られる**(user が窓を
 * 見ている間、本体は背面である)。同じ罠の裏返しになる。
 *
 * 🔑 そして**出しても読まれない**: 固まった瞬間 user は窓のタブを見ているので、
 * 本体タブに出した文字は目に入らない。**戻ってきた時に出す**なら必ず読まれる。
 *
 * だから口は 1 つ ── {@link OfficeHangWatch.onMainVisible}。
 * `visibilitychange` の `hidden → visible` で 1 回呼ぶだけで、タイマーは要らない。
 *
 * ## ⚠ 検知できないもの(見逃しは受け入れる)
 *
 * - **1 度も生存通知が来ないうちに固まった場合** ── 窓が開かなかったのか固まったのか
 *   区別が付かない。「開いた形跡がある」ことを条件にする
 * - **窓のタブがブラウザごと落ちた場合** ── `pagehide` が走らないので `closed` が
 *   来ず、ハングと区別が付かない。文言を**どちらでも正しい形**にして逃げる
 *
 * ## ⚠ これは防波堤であって、直しではない
 *
 * 復帰の動線は**既に通っている** ── `ALIVE_TTL_MS` のおかげで、固まった後に
 * 「Office で開く」を押せば使い回し判定が false に落ちて**新しい窓が開く**。
 * ここが足すのは**言葉だけ**である。効果を過大に見積もらない。
 */
import { ALIVE_TTL_MS, type OfficeWindowEvent } from './office-window';

/** 窓が**表**に居たときの物差し。1.5 秒間隔に対して 2.6 倍の余裕。 */
export const HANG_GAP_FOREGROUND_MS = ALIVE_TTL_MS;

/**
 * 窓が**背面**に居たときの物差し。
 * ⚠ intensive throttling は **1 分に 1 回**まで落とすので、60 秒では足りない。
 */
export const HANG_GAP_BACKGROUND_MS = 70_000;

/**
 * 🔴 **固まっていても消えていても正しい文**にする。
 * ⚠ 「固まりました」と言い切ると、タブが落ちていただけのとき嘘になる。
 * ⚠ 押す場所(窓のタブ)と、やること(閉じて開き直す)を**両方**書く ──
 * 「応答していません」だけでは user は何をすればいいか分からない。
 */
export const HANG_MESSAGE =
  'Office の窓が応答していません。窓のタブを閉じて、開き直してください';

export interface OfficeHangWatchDeps {
  readonly now?: () => number;
}

/**
 * 生存通知を折り畳んで、「いま言うことがあるか」だけを答える。
 * ⚠ **pure**(browser API を触らない)。`now` すら差し替えられる。
 */
export class OfficeHangWatch {
  private readonly now: () => number;
  private lastAliveAt = 0;
  /** 最後の生存通知を出したとき、**窓のタブが表に居たか**。 */
  private lastAliveVisible = false;
  /** 生存通知を 1 度でも受けたか(受けていないなら窓の有無が分からない)。 */
  private sawAlive = false;
  /** 窓が自分で「停止した」と言った ── 停止画面は窓が出しているので黙る。 */
  private crashed = false;
  /** 同じ窓について 2 度言わない(タブを行き来するたびに出さない)。 */
  private told = false;

  constructor(deps: OfficeHangWatchDeps = {}) {
    this.now = deps.now ?? ((): number => Date.now());
  }

  /** 放送を 1 件折り込む。 */
  note(ev: OfficeWindowEvent): void {
    if (ev.type === 'alive') {
      this.lastAliveAt = this.now();
      this.lastAliveVisible = ev.visible;
      this.sawAlive = true;
      // ⚠ 生き返った(読み込み直した / 開き直した)なら、また言えるようにする
      this.crashed = false;
      this.told = false;
      return;
    }
    if (ev.type === 'crashed') {
      // 停止は**窓が自分で見せている**(停止画面 + 読み込み直す)。二重に言わない
      this.crashed = true;
      return;
    }
    if (ev.type === 'closed') {
      // 閉じたのは user の意思 ── 言うことは無い
      this.sawAlive = false;
      this.lastAliveAt = 0;
      this.told = false;
    }
  }

  /**
   * 🔴 **本体タブが表に戻った瞬間に 1 回だけ呼ぶ。**
   * 言うことがあれば文を返す。無ければ `null`。
   */
  onMainVisible(): string | null {
    if (!this.sawAlive || this.crashed || this.told) return null;
    const gap = this.now() - this.lastAliveAt;
    const limit = this.lastAliveVisible ? HANG_GAP_FOREGROUND_MS : HANG_GAP_BACKGROUND_MS;
    if (gap < limit) return null;
    this.told = true;
    return HANG_MESSAGE;
  }
}

export interface HangWatchWiring {
  /** 放送の購読口(`OfficeWindow.onEvent`)。 */
  readonly onEvent: (fn: (ev: OfficeWindowEvent) => void) => () => void;
  /** `document`。⚠ 差し替えられるのは test のため。 */
  readonly doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly notify: (text: string) => void;
  readonly watch?: OfficeHangWatch;
}

/**
 * 配線する(`main.ts` の仕事を 1 行にする)。
 *
 * 🔴 **`main.ts` に書かない。** あそこは原文を `readFileSync` で読む test しか
 * 無く、判断を置くと「全 tests 緑のまま取り違える」(CLAUDE.md 2026-08-08)。
 * `office-open.ts` と同じ理由でここへ取り出す ── **配線そのものを test できる**。
 */
export function watchOfficeHang(w: HangWatchWiring): () => void {
  const watch = w.watch ?? new OfficeHangWatch();
  const offEvent = w.onEvent((ev) => { watch.note(ev); });
  const onVisibility = (): void => {
    // ⚠ `hidden` へ落ちる側では何もしない ── 見るのは**戻ってきた瞬間**だけ
    if (w.doc.visibilityState !== 'visible') return;
    const text = watch.onMainVisible();
    if (text !== null) w.notify(text);
  };
  w.doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    offEvent();
    w.doc.removeEventListener('visibilitychange', onVisibility);
  };
}
