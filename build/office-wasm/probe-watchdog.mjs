/**
 * 🔴 **probe の全体の締切**(2026-08-30。**5 時間固まって学んだ**)。
 *
 * ## なぜ 1 か所に寄せるか
 *
 * `open-doc-probe.mjs` に見張りを入れた翌時間に数えたら、
 * **13 本ある probe のうち締切を持つのは 1 本だけ**だった ──
 * 残りは同じ形で何時間でも固まりうる(CLAUDE.md「片側を直したら、
 * 対称の反対側を必ず疑う」)。⚠ 12 か所へ写すと**次に直す人が 12 か所直す**ので、
 * ここへ寄せる。
 *
 * ## 何から守るのか
 *
 * ⚠ **Playwright の `page.evaluate()` に既定の締切は無い。**
 * 版面(LO wasm)が 100% で回り続けると、`await` は**永久に返らない**。
 * 🔴 そして固まった `await` は例外を投げないので **`finally` も走らない** ──
 * JSON が 1 バイトも書かれず、**何段目で止まったのかも残らない**。
 *
 * 実測(2026-08-30、`open-doc-probe` の貼り付けの門):
 * 経過 **4h58m** / renderer の CPU 時間 **5h00m** / RSS **1.07 GB** / log **0 byte**。
 *
 * ## 使い方
 *
 *   import { armWatchdog } from './probe-watchdog.mjs';
 *   const wd = armWatchdog({ result, out: OUT, limitSec: LIMIT_SEC + 600, browser: () => browser });
 *   wd.mark('観測ループ');           // 段の足跡(落ちたとき名前で言える)
 *   ...
 *   wd.disarm();                     // 正常に終わったら止める
 *
 * ⚠ 判定は「できなかった」ではなく **`timedOut: true` = 判定不能**である。
 */

import { writeFileSync } from 'node:fs';

/**
 * @param {object} o
 * @param {object} o.result   probe が書き溜めている結果(そのまま JSON にする)
 * @param {string} o.out      出力 path(空なら stdout)
 * @param {number} o.limitSec 全体の締切(秒)
 * @param {() => (null | { close: () => Promise<unknown> })} [o.browser]
 *        閉じる相手を**遅延で**取る(`armWatchdog` の時点ではまだ無いことがある)
 */
export function armWatchdog({ result, out, limitSec, browser }) {
  const t0 = Date.now();
  let phase = 'start';
  const timer = setTimeout(() => {
    /**
     * ⚠ **`error` だけに書かない**(2026-08-30 に実測で踏んだ)。
     * 閉じると待っていた `await` が reject し、probe 自身の `catch` が
     * `result.error` を**上書き**して、末尾がもう一度 JSON を書く ──
     * 見張りの文言が消え、`page.waitForTimeout: Target page … has been closed`
     * だけが残った。🔑 **自分の欄を持つ**(こちらは誰も触らない)。
     */
    result.timedOut = true;
    result.timedOutError = `時間切れ(${limitSec} 秒)。段 「${phase}」 で戻らなかった`;
    result.timedOutPhase = phase;
    result.error = result.timedOutError;
    result.elapsedMs = Date.now() - t0;
    // ⚠ **同期で書く** ── 非同期の書き込みも固まりうる
    const text = JSON.stringify(result, null, 1);
    if (out) writeFileSync(out, text);
    else process.stdout.write(`${text}\n`);
    process.stderr.write(`${result.timedOutError}\n`);
    /**
     * ⚠ **閉じる猶予を 3 秒だけ与える。** 即座に `process.exit` すると
     * **chrome が残る**(実測 2 個)── 次の probe がそれを拾って変な測り方になる。
     * ⚠ ただし `close()` 自体も固まりうるので**待ち切らない**。
     * ⚠ `unref()` しない ── 閉じが固まったとき、この timer だけが出口である。
     */
    const b = typeof browser === 'function' ? browser() : null;
    if (b !== null && b !== undefined) Promise.resolve(b.close()).catch(() => {});
    setTimeout(() => process.exit(2), 3000);
  }, limitSec * 1000);
  /**
   * 🔴 **`disarm()` を書き忘れても無害にする**(2026-08-30、#624 で配る前に)。
   *
   * ⚠ 忘れると**害が出る側**へ倒れることを実測した ── 仕事が終わっているのに
   * node が締切まで生き残り、**良い JSON の上に偽の「時間切れ」を書いて `exit 2`**
   * する(実測: 3 秒の締切で `elapsedMs: 3003` / `timedOutPhase: "start"`)。
   * 🔑 `unref()` すると「**この timer だけのために node を生かさない**」ので、
   * 仕事が終わった回は素通りして終わる。
   * ⚠ **守りは落ちない** ── 固まる回は browser の socket など**参照つきの handle**が
   * event loop を生かしているので、timer は変わらず発火する(自作の対照群 2 本で確認)。
   * ⚠ 中の猶予 timer(3 秒)は `unref()` しない ── あちらは**出口そのもの**である。
   */
  timer.unref();

  return {
    /** 段の名前を進める。落ちたときこの名前が出る。 */
    mark(name) {
      phase = name;
      result.phases = result.phases ?? [];
      result.phases.push({ name, atMs: Date.now() - t0 });
    },
    /** 正常に終わったら止める(止めないと probe が終わらない)。 */
    disarm() {
      clearTimeout(timer);
    },
  };
}
