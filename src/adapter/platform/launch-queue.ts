/**
 * P7 段③: **`launchQueue` の受け口**(設計 doc §1 / §3)。
 *
 * `manifest.webmanifest` の `file_handlers` は `.md` / `.markdown` を宣言している。
 * OS から md をダブルクリックすると PKC3 が起動し、ブラウザは
 * `window.launchQueue` にファイルを載せてくる ── **読むコードが無ければ、
 * アプリが開くだけで何も起きない**(manifest が嘘をついている状態)。
 *
 * ## 🔴 受け口は **await より前**に登録する
 * `launchQueue.setConsumer` は「起動時に一度だけ」渡される値を受ける契約で、
 * **登録が遅いと落ちる**。boot は storage の初期化で必ず await するので、
 * 「アプリが出来てから登録する」と**取りこぼす**。
 * → ここで同期的に consumer を張って **溜めておき**、アプリが用意できてから流す。
 *
 * ## ⚠ ここは配線だけを持つ
 * 何を受けるか(拡張子)も、どう entry にするかも `import-file.ts` / `plain-markdown.ts`
 * の規則がすでに持っている。**受け口が独自の判定を持つと宣言と実体がまた 3 つに割れる**。
 */

/** 実ブラウザの `LaunchParams`(必要な部分だけ)。 */
export interface LaunchParamsLike {
  files?: ArrayLike<{ getFile(): Promise<File> }>;
}

/** 実ブラウザの `LaunchQueue`(必要な部分だけ)。 */
export interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

/** `launchQueue` を持ちうる入れ物(`window`)。 */
export interface LaunchTarget {
  launchQueue?: LaunchQueueLike;
}

export interface LaunchIntake {
  /** 受け口が張れたか(`launchQueue` の無いブラウザでは false)。 */
  readonly armed: boolean;
  /**
   * 受け取り先を差す。**それまでに届いたファイルはここで流れる**。
   * ⚠ 2 度目以降の launch もこの関数へ届く(起動中に別の md を開いた場合)。
   */
  deliverTo(consume: (files: File[]) => void | Promise<void>): void;
  /** 失敗を可視化する先(ファイル取得に失敗したとき)。 */
  onError?(message: string): void;
}

/**
 * `launchQueue` の受け口を**同期的に**張る。boot の入口で呼ぶこと。
 *
 * @param target 通常は `window`
 * @param onError ファイル取得に失敗したときの可視化(黙って捨てない)
 */
export function armLaunchQueue(
  target: LaunchTarget,
  onError: (message: string) => void = () => {},
): LaunchIntake {
  /** 受け取り先が決まるまでの控え。⚠ ここに溜めないと起動直後の launch を落とす。 */
  let pending: File[] = [];
  let consume: ((files: File[]) => void | Promise<void>) | null = null;

  const flush = (): void => {
    if (!consume || pending.length === 0) return;
    const files = pending;
    pending = [];
    void Promise.resolve(consume(files)).catch((e: unknown) => {
      onError(`開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const queue = target.launchQueue;
  if (queue) {
    queue.setConsumer((params) => {
      void (async () => {
        try {
          // ⚠ 0 件は下の `files.length === 0` が受ける ── ここで重ねると、
          // 消しても誰も気づかない枝になる(変異試験で実際に生き残った)
          const handles = params.files;
          if (!handles) return; // 通常起動(ファイル無し)
          const files: File[] = [];
          for (let i = 0; i < handles.length; i++) {
            try {
              files.push(await handles[i]!.getFile());
            } catch (e) {
              // 1 件が読めなくても残りは開く。⚠ **黙って減らさない**
              onError(`ファイルを読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          // ⚠ 「0 件なら流さない」は `flush` が持つ ── ここで重ねると、
          // 消しても誰も気づかない枝になる(変異試験で実際に生き残った)
          pending.push(...files);
          flush();
        } catch (e) {
          // ⚠ **unhandled rejection にしない**。ここで落ちると原因が
          // どこにも出ないまま「md を開いたのに何も起きない」になる
          onError(`起動時のファイルを扱えませんでした: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    });
  }

  return {
    armed: queue !== undefined,
    deliverTo(next) {
      consume = next;
      flush();
    },
  };
}
