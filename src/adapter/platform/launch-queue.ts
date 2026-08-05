/**
 * P7 段③: **`launchQueue` の受け口**(設計 doc §1 / §3)。
 *
 * `manifest.webmanifest` の `file_handlers` は `.md` / `.markdown` を宣言している。
 * OS から md をダブルクリックすると PKC3 が起動し、ブラウザは
 * `window.launchQueue` にファイルを載せてくる ── **読むコードが無ければ、
 * アプリが開くだけで何も起きない**(manifest が嘘をついている状態)。
 *
 * ## 🔴 自前でバッファしない ── ブラウザが既に持っている
 * 仕様(WICG/web-app-launch)は明言している:
 *
 * > LaunchParams are **buffered indefinitely** until they are consumed.
 * > Crucially, if any LaunchParams are buffered into a LaunchQueue **before** a call
 * > to `setConsumer()`, they will be **immediately passed into the consumer afterwards**.
 * > …avoids the race condition where scripts may "miss" events if they're too slow to
 * > register their event listeners.
 *
 * ⚠ 当初これを逆に読み、「await より前に張らないと取りこぼす」と書いて自前バッファを
 * 持った。**取りこぼしの責任がブラウザからアプリへ移るだけ**で、boot が失敗すれば
 * ファイルは消え(再読込しても戻らない)、取込が断られても消える ── 早期 arm は
 * リスクを増やす方向だった。**アプリが受け取れるようになってから `setConsumer` する**。
 *
 * ## ⚠ ここは配線だけを持つ
 * 何を受けるか(拡張子)も、どう entry にするかも `import-file.ts` / `plain-markdown.ts`
 * の規則がすでに持っている。**受け口が独自の判定を持つと宣言と実体がまた 3 つに割れる**。
 */
import type { LaunchedHandle } from './launched-files';

/**
 * `LaunchParams.files` の要素。⚠ 仕様上 **directory handle が来うる**。
 *
 * 🔑 型は `launched-files.ts` が正本(書き戻し・同一判定に必要な面まで含む)──
 * ここで別に宣言すると、受け口が渡せる物と使う側が要る物が静かにずれる。
 */
export type LaunchHandleLike = LaunchedHandle;

/**
 * 受け取った 1 件。🔴 **handle を捨てない**(2026-08-05、user 報告
 * 「スポットの編集プレビュー導線も存在しない」)── 直す前は `getFile()` の
 * 結果だけを渡していたので、取り込んだ後に「元がどのファイルか」を誰も知らず、
 * 同じ md を開くたびにノートが増え、元ファイルへ戻す道も無かった。
 */
export interface LaunchedItem {
  file: File;
  handle: LaunchHandleLike;
}

/** 実ブラウザの `LaunchParams`(必要な部分だけ)。 */
export interface LaunchParamsLike {
  files?: ArrayLike<LaunchHandleLike> | null;
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
  /** 受け口が張れたか(`launchQueue` の無いブラウザ / 登録が拒まれた場合は false)。 */
  readonly armed: boolean;
}

/**
 * `launchQueue` の受け口を張る。**アプリが受け取れるようになってから**呼ぶこと。
 *
 * @param target 通常は `window`
 * @param consume 受け取り先。⚠ ここが**断らない**こと ── 断ると OS の launch は
 *   一発限りなので、user には選び直す手段が無い(picker が開かない)
 * @param onError 可視化する先。黙って捨てない
 */
export function armLaunchQueue(
  target: LaunchTarget,
  consume: (items: LaunchedItem[]) => void | Promise<void>,
  onError: (message: string) => void = () => {},
): LaunchIntake {
  const queue = target.launchQueue;
  if (!queue) return { armed: false };

  try {
    queue.setConsumer((params) => {
      void (async () => {
        try {
          const handles = params.files;
          if (!handles) return; // 通常起動(ファイル無し)
          const items: LaunchedItem[] = [];
          for (let i = 0; i < handles.length; i++) {
            const handle = handles[i]!;
            // ⚠ **フォルダが来うる**(仕様の `files` は `FileSystemHandle[]`)。
            // そのまま `getFile()` を呼ぶと開発者語の TypeError が user に出る
            if (handle.kind === 'directory' || typeof handle.getFile !== 'function') {
              onError('フォルダは開けません(ファイルを選んでください)');
              continue;
            }
            try {
              items.push({ file: await handle.getFile(), handle });
            } catch (e) {
              // 1 件が読めなくても残りは開く。⚠ **黙って減らさない**
              onError(`ファイルを読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (items.length === 0) return;
          await consume(items);
        } catch (e) {
          // ⚠ **unhandled rejection にしない**。ここで落ちると原因が
          // どこにも出ないまま「md を開いたのに何も起きない」になる
          onError(`開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    });
  } catch (e) {
    // ⚠ 登録そのものが投げてもアプリは動く ── boot を道連れにしない
    onError(`起動時のファイル受け取りを準備できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return { armed: false };
  }
  return { armed: true };
}
