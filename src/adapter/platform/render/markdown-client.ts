/**
 * markdown 描画の**メインスレッド側の口**(P8 段⑨)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行を
 * > バッファして、ワーカーにディスパッチします」
 *
 * 遅延起動・バッファ・アイドル kill は `WorkerLease` が持つ。ここが足すのは
 * **打鍵に対する畳み込み**である:
 *
 * 🔑 **最新だけ勝つ**(latest-wins)。1 打鍵ごとに投げると、遅い文書では
 * 依頼が列になって「打ち終わってから何秒も描き続ける」になる。飛ばすのは常に
 * **1 件だけ**にして、その間に来た変更は**最後の 1 つに畳む**。
 *
 * ⚠ 途中の結果は捨てる ── 古い結果を DOM に載せると、打った文字が消えて見える。
 * ⚠ **失敗したら呼び側へ知らせる**(白紙にしない)。呼び側は同期描画へ落とす。
 */
import { WorkerLease } from '../worker-lease';
import { appJobMonitor, type JobMonitor } from '../job-monitor';
import { renderMarkdown, type RenderMarkdownOptions } from '@features/markdown/markdown-render';

/** アイドルで畳むまで。⚠ 短いと連続操作のたびに作り直して**かえって重くなる**。 */
export const MARKDOWN_WORKER_IDLE_MS = 30_000;

/**
 * 🔴 **打鍵が止まってから描くまで**(P8 段⑩)。
 * > user 指示 2026-08-03「**1 打鍵ではなく、3 秒周期で差分反映してください /
 * > 1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * ⚠ **固定周期にはしない**。3 秒の時計は「打っている最中に発火する」ことも
 * 「止めてから 3 秒待たされる」ことも起きる。止まった瞬間に出るほうが速く感じ、
 * かつ打鍵中の仕事は減る ── なので **止まって 500ms** で描く。
 */
export const PREVIEW_QUIET_MS = 500;
/**
 * ⚠ ただし**打ち続けている間も置いていかれない**ように上限を置く ── これが
 * user の言う「3 秒周期」。連続入力でも 3 秒に 1 回は必ず反映される。
 */
export const PREVIEW_MAX_WAIT_MS = 3000;

export interface MarkdownClientOptions {
  /** worker の作り方(test / bench が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
  /** 可視化(P8 段⑩)。⚠ 既定でアプリ共通のものへ流す ── 付け忘れると
   *  「設定の表に出ない」形で静かに死ぬので、既定を持たせる。 */
  monitor?: JobMonitor;
}

export class MarkdownClient {
  private readonly lease: WorkerLease | null;

  constructor(options: MarkdownClientOptions = {}) {
    // 🔴 **ワーカーが無い環境では同じ処理をその場で回す**。
    // `file://`・古い環境・test(happy-dom は `Worker` を持たない)── ここで
    // 落ちると**プレビューが白紙**になる。⚠ 出口を 2 本作っているのではなく、
    // 「ワーカーは速さの話であって、正しさの話ではない」という位置づけ:
    // 返る HTML は**同じ関数から出る**(`tests/adapter/markdown-worker.test.ts`
    // が両経路の一致を pin する)
    const spawn = options.spawn ?? defaultSpawn();
    this.lease = spawn
      ? new WorkerLease({
          spawn,
          idleMs: options.idleMs ?? MARKDOWN_WORKER_IDLE_MS,
          name: 'markdown',
          monitor: options.monitor ?? appJobMonitor,
        })
      : null;
  }

  /** worker が生きているか(計測と test の観測点)。 */
  get alive(): boolean {
    return this.lease?.alive ?? false;
  }

  /** ワーカーを使う環境か(使えないなら同じ処理をその場で回している)。 */
  get offloaded(): boolean {
    return this.lease !== null;
  }

  /** 1 件描く(畳み込みなし ── 選択のたびに 1 回だけ呼ぶ面はこちら)。 */
  render(text: string, opts: RenderMarkdownOptions = {}): Promise<string> {
    if (!this.lease) return Promise.resolve(renderMarkdown(text, opts));
    return this.lease.run<string>({ text, opts });
  }

  /**
   * 打鍵に追従する口を作る。**1 つの表示面につき 1 つ**作る。
   *
   * 🔑 飛ばすのは 1 件だけ。飛んでいる間に来たものは最後の 1 つだけ残す。
   * @param onHtml 描けたら呼ぶ。⚠ **最新のものだけ**呼ぶ(古い結果は来ない)。
   * @param onError 落ちたら呼ぶ(呼び側が同期描画へ落とす)。
   */
  follower(
    onHtml: (html: string) => void,
    onError?: (e: unknown) => void,
    timing: {
      quietMs?: number;
      maxWaitMs?: number;
      setTimer?: (fn: () => void, ms: number) => unknown;
      clearTimer?: (h: unknown) => void;
      now?: () => number;
    } = {},
  ): { push(text: string, opts?: RenderMarkdownOptions): void; flush(): void; dispose(): void } {
    const quietMs = timing.quietMs ?? PREVIEW_QUIET_MS;
    const maxWaitMs = timing.maxWaitMs ?? PREVIEW_MAX_WAIT_MS;
    const setTimer = timing.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = timing.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const now = timing.now ?? (() => Date.now());
    let inFlight = false;
    let queued: { text: string; opts: RenderMarkdownOptions } | null = null;
    let disposed = false;
    let timer: unknown = null;
    /** 溜め始めた時刻(上限の起点)。null = 溜めていない。 */
    let since: number | null = null;

    const pump = (): void => {
      if (disposed || inFlight || !queued) return;
      const job = queued;
      queued = null;
      inFlight = true;
      this.render(job.text, job.opts)
        .then((html) => {
          inFlight = false;
          // ⚠ もっと新しいものが来ているなら、この結果は**載せない**
          //    (載せると打った文字が一瞬消えて見える)
          if (disposed) return;
          if (queued) return pump();
          onHtml(html);
        })
        .catch((e) => {
          inFlight = false;
          if (disposed) return;
          if (queued) return pump();
          onError?.(e);
        });
    };

    const cancel = (): void => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    };
    const fire = (): void => {
      cancel();
      since = null;
      pump();
    };
    /**
     * 打鍵ごとに予約を張り直す。⚠ ただし**溜め始めから上限を超えたら伸ばさない**
     * ── 伸ばし続けると、打ち続けている間ずっと反映されない
     */
    const schedule = (): void => {
      const t = now();
      if (since === null) since = t;
      cancel();
      const remaining = Math.max(0, since + maxWaitMs - t);
      timer = setTimer(fire, Math.min(quietMs, remaining));
    };

    return {
      push(text, opts = {}) {
        if (disposed) return;
        queued = { text, opts };
        schedule();
      },
      /** すぐ出す(編集に入った直後など、待つ意味が無いとき)。 */
      flush() {
        if (disposed) return;
        fire();
      },
      dispose() {
        disposed = true;
        queued = null;
        cancel();
      },
    };
  }

  /**
   * 明示的に畳む。⚠ 待っている依頼は reject される(永久 hang を作らない)。
   * ⚠ **常駐を返すのはアイドル kill の仕事**(30 秒で terminate)── ここは
   * test / 面の破棄用で、アプリの通常経路からは呼ばれない(P8 段㉔ で明記)。
   */
  dispose(): void {
    this.lease?.dispose();
  }
}

/**
 * 既定の作り方。⚠ **`Worker` が無い環境では `null`** を返す ── ここで
 * `new Worker` を試すと、環境によっては投げずに**永久に返らない**(白紙になる)。
 * 能力を先に見るほうが確実で、しかも理由が読める。
 */
function defaultSpawn(): (() => Worker) | null {
  if (typeof Worker !== 'function') return null;
  // 計測用の逃がし口(URL のみ・保存しない)。⚠ **新しい経路を作っていない** ──
  // ワーカーが無い環境と**同じ**同期経路へ落とすだけなので、対照群が
  // 「同じビルドの、測りたい違いだけが違うもの」になる
  if (
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('pkc-md-inline')
  )
    return null;
  return () => new Worker(new URL('./markdown-worker.ts', import.meta.url), { type: 'module' });
}
