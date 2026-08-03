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
import { renderMarkdown, type RenderMarkdownOptions } from '@features/markdown/markdown-render';

/** アイドルで畳むまで。⚠ 短いと連続操作のたびに作り直して**かえって重くなる**。 */
export const MARKDOWN_WORKER_IDLE_MS = 30_000;

export interface MarkdownClientOptions {
  /** worker の作り方(test / bench が差し替える)。 */
  spawn?: () => Worker;
  idleMs?: number;
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
          name: 'markdown worker',
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
  ): { push(text: string, opts?: RenderMarkdownOptions): void; dispose(): void } {
    let inFlight = false;
    let queued: { text: string; opts: RenderMarkdownOptions } | null = null;
    let disposed = false;

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

    return {
      push(text, opts = {}) {
        if (disposed) return;
        queued = { text, opts };
        pump();
      },
      dispose() {
        disposed = true;
        queued = null;
      },
    };
  }

  /** 明示的に畳む。⚠ 待っている依頼は reject される(永久 hang を作らない)。 */
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
