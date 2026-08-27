/**
 * 🔴 **例外が「どこから出たか」を 1 行だけ添える**(#387)。
 *
 * ⚠ smoke の `expect(errors).toEqual([])` は「**何か例外が出た**」としか言わない ──
 *   #387 は **2 度観測しても原因に 1 歩も近づいていない**(2026-08-25 / 2026-08-27。
 *   どちらも `Failed to execute 'open' on 'Window'` の 1 行だけが残った)。
 * 🔑 だから**次の赤が理由を持ってくる**形にする ── stack の
 *   **出所を名指しできる最初の 1 フレーム**を添えれば、file:line で指せる。
 *
 * ⚠ **効くのは #387 だけである。** 同じ「間欠で 1 回落ちた」の仲間でも、
 *   #382(2 度目の取込が増えない)/ #410(札が 1 枚も出ない)/ #419(断り文が
 *   出ない)は**例外ではなく `expect` が満たされない**形なので、これは 1 バイトも
 *   助けない ── あちらは**その瞬間の状態**を添える別の道具が要る。
 *   (⚠ 1 稿目はここに 4 件とも書いていた。**確かめずに広く書いた**ので取り下げた)
 *
 * ## 実測(2026-08-27。⚠ 「採れるはず」で書かない)
 *
 * URL を持つ script から投げさせて、収集の出口まで通した:
 *
 * ```
 * stack     … at boom (http://localhost:45732/probe-boom.js:1:41)
 * 収集した行 … pageerror: probe-boom @ /probe-boom.js:1:41 (+685ms)
 * ```
 *
 * ⚠ **URL を持たない script(注入コード / `data:`)は `<anonymous>` になる** ──
 *   そのときは何も添えない(実測済み)。⚠ つまりこれは
 *   **「アプリの file から出た例外」を名指しする道具**であって、
 *   test 自身の `page.evaluate` から出たものには効かない。
 *
 * ⚠ **playwright を import しない**(純関数として単体で検められるように)。
 *   単体検査は `tests/smoke/page-errors.test.ts`(vitest。⚠ playwright が拾うのは
 *   `.smoke.spec.ts` だけなので、こちらは playwright では走らない)。
 */

/**
 * stack から**出所を名指しできる最初の 1 フレーム**を返す(無ければ空文字)。
 *
 * ⚠ **全部は貼らない** ── 赤が読みにくいこと自体が、次の見落としになる。
 * ⚠ **見つからなければ何も足さない**。「不明」と書くと、*採れなかった*のか
 *   *そこが根*なのかが区別できなくなる(CLAUDE.md「判定不能に結果を読まない」)。
 * ⚠ origin は落として **path:line:col** だけにする ── port は走るたびに変わるので、
 *   残すと**同じ赤が毎回違う字面**になり、突き合わせられない。
 */
export function firstAppFrame(stack: string | undefined | null): string {
  if (!stack) return '';
  for (const line of stack.split('\n')) {
    const m = /(https?:\/\/[^\s)]+)/.exec(line);
    const url = m?.[1];
    if (url === undefined) continue;
    let rest: string;
    try {
      const u = new URL(url);
      rest = `${u.pathname}${u.search}`;
      // ⚠ `new URL` は `:12:34` を pathname に含める ── そのままで良い
    } catch {
      rest = url;
    }
    if (rest === '' || rest === '/') continue;
    return ` @ ${rest}`;
  }
  return '';
}
