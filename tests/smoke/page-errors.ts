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

/**
 * 🔴 **console のエラーが「どの面から出たか」を 1 行だけ添える**(#561、2026-08-29)。
 *
 * ⚠ `page.on('console')` は**子 frame の分も上がる** ── PKC3 は html / svg の囲みを
 *   **sandbox の iframe(`srcdoc`)**で描くので、**箱の中でブラウザが出したエラー**が
 *   アプリのエラーと**同じ 1 行**になって見分けが付かない。
 * 🔴 実際に踏んだ:CI で `Error: <svg> attribute width: Expected length, "9…` が出て、
 *   赤からは**アプリが壊れたのか、囲みの中身がまだ書きかけだったのか**が読めなかった。
 *   実測すると出所は `about:srcdoc` = **箱の中**だった(`url: 'about:srcdoc', line: 0`)。
 * 🔑 だから **origin ではなく「どの document か」**を残す ── `about:srcdoc` なら箱の中、
 *   `/assets/....js` ならアプリ本体である。
 *
 * ⚠ **port は落とす**(`firstAppFrame` と同じ理由 ── 走るたびに変わる字を残すと、
 *   同じ赤が毎回違う字面になって前回と突き合わせられない)。
 * ⚠ **採れなければ何も足さない**(「不明」と書かない ── 採れなかったのか、
 *   そこが根なのかが区別できなくなる)。
 * ⚠ 行番号は **0 のとき付けない** ── `about:srcdoc` は常に 0 で、付けると
 *   「1 行目で起きた」と読める。
 */
export function consoleOrigin(
  loc: { url?: string; lineNumber?: number } | null | undefined,
): string {
  const url = loc?.url;
  if (url === undefined || url === '') return '';
  const line = loc?.lineNumber;
  const suffix = typeof line === 'number' && line > 0 ? `:${line}` : '';
  // ⚠ `about:` / `blob:` / `data:` は**そのまま**が最も情報量が多い(箱の中の印である)
  if (!/^https?:/i.test(url)) return ` @ ${url}${suffix}`;
  let rest: string;
  try {
    const u = new URL(url);
    rest = `${u.pathname}${u.search}`;
  } catch {
    rest = url;
  }
  return ` @ ${rest}${suffix}`;
}
