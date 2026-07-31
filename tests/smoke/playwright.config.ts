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

// 同梱 Chromium(コンテナ / self-host)を優先、無ければ playwright 管理の
// ブラウザ(CI は install 済みが前提)
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
  webServer: {
    // 実際に配布するビルド(dist)を検品する ── dev server ではなく preview。
    // cwd 既定は config のディレクトリなので repo root を明示(vite project 解決)
    command: `npx vite preview --port ${PORT} --strictPort`,
    cwd: repoRoot,
    url: `http://localhost:${PORT}`,
    // CI では必ず自前で立てる(残留 server が別 dist を検品する事故の防止)
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
