/**
 * PKC3 視覚 smoke(P3-8)。**PR gate に載るのはこの testDir の全 spec**なので、
 * 総量を「数 spec・秒オーダー」に保つ(CLAUDE.md プロセス指示、user 指示
 * 2026-07-30)。重い検証(15k probe / 実 render の長い待ち)は nightly へ。
 *
 * PKC2 の「遅くなった原因」を最初から避ける(P3-8 調査):
 * - 全量シリアルを PR に載せない(271 spec 15-17 分の再演をしない)
 * - timeout は 30s のまま ── flake を timeout 引き上げで隠さない
 * - 固定 sleep を積まない(待ちは条件 poll で)
 * - ブラウザ profile は spec ごと新規 context(OPFS が spec 間で汚れない)
 */
import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const PORT = Number(process.env.PKC3_SMOKE_PORT ?? 45732);

/**
 * 🔴 **ヘッダを何も足さない server**(#111)。GitHub Pages と同じ条件を立てる。
 *
 * `vite preview` は COOP/COEP を**自分で返す**ので、その上で
 * `crossOriginIsolated` を見ても **SW が働いた証拠にならない** ──
 * 本番だけ分離が成立しない、という穴を 1 度そのまま出荷した。
 * ⚠ `coi.smoke.spec.ts` だけがこちらを使う。
 */
const PLAIN_PORT = Number(process.env.PKC3_PLAIN_PORT ?? PORT + 1);

/**
 * 🔴 **根を配らない配信**(#532 S1)。同じ `plain-server.mjs` を、
 * `PKC3_PLAIN_PREFIX` 付きで**もう 1 本**立てる。
 *
 * ⚠ 既存の 2 本(preview / plain)は**どちらも根で配る**ので、
 * 「絶対 path で参照している生成物」を配っても**通ってしまう**。
 * 🔑 prefix の外を 404 にする配信でだけ、「どこに置いても動く」が検査になる ──
 *   これは Pages の `/dev/` と、セルフホスト(#532)が立つ場所そのものである。
 */
const SUB_PORT = Number(process.env.PKC3_SUBPATH_PORT ?? PORT + 2);
const SUB_PREFIX = '/pkc/';

// 同梱 Chromium(コンテナ / self-host)を優先、無ければ playwright 管理の
// ブラウザ(CI は install 済みが前提)
//
// 🔴 **CI と手元で別のバイナリが動く**(2026-08-05 に実際に踏んだ)。
// 同梱は `chromium-1194/chrome-linux/chrome`(フル Chromium)だが、
// **PR gate は playwright 既定 = `chromium_headless_shell`**。
// ⚠ **nightly は 2 つとも回す**(2026-08-07)── 突き合わせる場所は nightly しか無い。
//    かつて nightly は probe 用の `PKC3_CHROMIUM` を `$GITHUB_ENV` へ書いており、
//    **smoke まで巻き添えでフル chromium** になっていた(片方しか検査していない
//    のに「両方で通している」つもりになる、いちばん質の悪い形)。この 2 つは
// `window.print()` の振る舞いが違い(chrome は `beforeprint` のみ /
// headless_shell は `beforeprint` + `afterprint` を同期発火)、
// **手元で緑・CI で赤**になった。CI を手元で再現するには:
//
//   PKC3_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
//     npx playwright test --config tests/smoke/playwright.config.ts
//
// ⚠ 実ブラウザ依存の挙動に触れる spec を足したら、**両方**で通してから push する。
const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(bundled) ? bundled : undefined;

/**
 * 🔴 **どのバイナリで走るかの判定は、この 1 か所**(#413)。
 *
 * ⚠ `test.use({ launchOptions })` は**丸ごと差し替わる** ── 起動引数を足したい
 *   spec が自前で path を書くと、**そちらだけ別のブラウザ**で走る(CLAUDE.md §5 が
 *   まさにその事故である)。だから spec はこれを読んで混ぜる。
 */
export const chromiumLaunch = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.smoke.spec.ts',
  timeout: 30_000,
  retries: 0,
  /**
   * 🔴 **4 本並べる**(#820。user 指摘 2026-09-09「最近、フルスモークが多すぎる」)。
   *
   * ⚠ ここは長らく **1** で、理由はどこにも書かれていなかった。実測すると
   * **並べても落ちない**うえ、所要が**半分になる**(同じ 6 spec / 106 test を
   * 手元の headless_shell で回した):
   *
   * | workers | 所要 | 結果 |
   * |---|---|---|
   * | **1** | 182 秒 | 106 passed |
   * | **2** | 122 秒 | 106 passed |
   * | **4** | **96 秒 / 92 秒**(2 回) | 106 passed |
   *
   * 🔑 並べると速い。⚠ 箱は 4 コアなので 4 倍にはならない(ブラウザどうしが
   * CPU を奪い合う)。
   *
   * 🔴 **それでも 4 は多すぎた ── 同じ日に 2 へ落とした**(実測)。
   *
   * ⚠ `retries: 0` は動かさない(flake を再実行で隠さない)と決めてあるので、
   *   判定は「**全量を通したときに落ちるか**」である。4 で全量を 4 回通した結果:
   *
   * | 回 | 結果 |
   * |---|---|
   * | 1(被覆の記録つき) | 赤 2 |
   * | 2 | 赤 1(`attach`) |
   * | 3 | 🟢 499 件緑 |
   * | 4 | 🔴 **赤 3**(`attach` / `deep-link` の別窓 / `sub-path` の読み直し) |
   *
   * ⚠ **落ちた 3 本に共通点がある** ── どれも**重い or 窓をもう 1 枚開く**物で、
   *   単独では緑・CI でも緑である。つまり壊れているのは製品ではなく
   *   **4 つのブラウザが 4 コアを奪い合う状態**のほうである
   *   (例:`attach` は「何もしていない間」の欠測が静かなときの **5ms** に対し
   *   この回は **22ms**、貼っている間は **104ms** ── 門は 102ms)。
   * 🔑 だから**落とす**。2 でも **182 秒 → 122 秒(1.5 倍)**で、
   *   全量は 13.2 分 → 約 7 分になる。⚠ 速さのために赤を買わない。
   */
  workers: 2,
  /**
   * ⚠ **同じ file の中は順番どおり**(`fullyParallel: false`)。
   * spec は「作る → 書く → 読み直す」の**物語**で書いてあるので、
   * 中を並べると物語が壊れる ── 並べるのは **spec と spec の間**だけである。
   */
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  // 🔑 spec から使う口(`coi.smoke.spec.ts` だけが plain を見る /
  //    `sub-path.smoke.spec.ts` だけが sub-path を見る)
  metadata: {
    plainBaseURL: `http://localhost:${PLAIN_PORT}`,
    subPathBaseURL: `http://localhost:${SUB_PORT}`,
    subPathPrefix: SUB_PREFIX,
  },
  webServer: [
    {
      // 実際に配布するビルド(dist)を検品する ── dev server ではなく preview。
      // cwd 既定は config のディレクトリなので repo root を明示(vite project 解決)
      command: `npx vite preview --port ${PORT} --strictPort`,
      cwd: repoRoot,
      url: `http://localhost:${PORT}`,
      // CI では必ず自前で立てる(残留 server が別 dist を検品する事故の防止)
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // ⚠ 同じ `dist` を、**ヘッダを足さずに**配る(本番と同じ条件)
      command: `node tests/smoke/plain-server.mjs`,
      cwd: repoRoot,
      url: `http://localhost:${PLAIN_PORT}/index.html`,
      env: { PKC3_PLAIN_PORT: String(PLAIN_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // ⚠ 同じ `dist` を、**`/pkc/` の下だけ**で配る(根は 404)。#532 S1
      command: `node tests/smoke/plain-server.mjs`,
      cwd: repoRoot,
      url: `http://localhost:${SUB_PORT}${SUB_PREFIX}index.html`,
      env: { PKC3_PLAIN_PORT: String(SUB_PORT), PKC3_PLAIN_PREFIX: SUB_PREFIX },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
