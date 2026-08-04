/**
 * 開いた window が閉じるのを待つ(P8 段㉔ に `main.ts` から切り出し)。
 *
 * 🔴 切り出した理由は**測れるようにするため** ── `main.ts` の中に居たときは
 * 誰も test できず、「`pagehide` でも解く」という**害しかない 1 行**が
 * 変異試験で生き残った(この file の test がそれを落とす)。
 */
/**
 * 開いたタブが閉じるまで待つ(ランチャーの blob の寿命終端)。
 *
 * ⚠ **`closed` は poll でしか分からない** ── 別 window の close は event で
 * 飛んでこない。2 秒間隔にしているのは「起動中ずっと回る」ものだからで、
 * user がタブを閉じた 2 秒後には revoke される。
 *
 * 🔴 **`pagehide` で解かない**(P8 段㉔)。かつては「こちらのページが消えるときも
 * 解く」として `pagehide` でも resolve していたが、`pagehide` は本当の unload
 * だけでなく **bfcache へ入るときにも発火する**(`persisted === true`)──
 * PKC3 のタブで前のページへ戻る / 別サイトへ移るだけで、**まだ開いている
 * アプリタブの blob URL が revoke され**、そのタブを再読込すると
 * `net::ERR_FILE_NOT_FOUND` で真っ白になる。
 * ⚠ しかも**買っているものが無い** ── 本当に document が捨てられる場合、
 * blob も interval もどのみち道連れになるので、解いても解かなくても同じ結果である。
 * (初版が「1 秒後に revoke」で必ず死んでいたのと**同じ症状が別の入口から
 *  戻っていた**。終端は「そのタブが閉じたとき」だけでよい)
 */
export function waitForWindowClose(
  win: { closed: boolean },
  /** ⚠ test が時計を差せるようにする(実時間 2 秒を待たない)。 */
  timing: {
    everyMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  } = {},
): Promise<void> {
  return new Promise((resolve) => {
    const setTimer = timing.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    const clearTimer = timing.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    const timer = setTimer(() => {
      if (win.closed) {
        clearTimer(timer);
        resolve();
      }
    }, timing.everyMs ?? 2000);
  });
}
