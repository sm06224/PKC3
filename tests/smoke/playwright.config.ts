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

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.smoke.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  // 🔑 spec から使う口(`coi.smoke.spec.ts` だけが plain を見る)
  metadata: { plainBaseURL: `http://localhost:${PLAIN_PORT}` },
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
  ],
});
