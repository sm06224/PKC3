/**
 * 🔴 GPU グラフの別ウィンドウの起動の分かれ道(v4.1 PR-9)── `main.ts` は起動のいちばん最初で
 * `readChartPopoutToken()` を聞き、真なら通常の起動(storage / worker / shell)へ進まない。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readChartPopoutToken } from '../../src/adapter/platform/deep-link';

const t = (hash: string): { hash: string } => ({ hash });

describe('別ウィンドウかどうか(アドレスの断片)', () => {
  it('#pkc?chart=<token> だけを真と読む', () => {
    expect(readChartPopoutToken(t('#pkc?chart=tok000001'))).toBe('tok000001');
    expect(readChartPopoutToken(t('#pkc?chart=bad'))).toBeNull();
    expect(readChartPopoutToken(t('#pkc?view=calendar'))).toBeNull();
    expect(readChartPopoutToken(t(''))).toBeNull();
    expect(readChartPopoutToken(t('#見出し'))).toBeNull();
  });
});

describe('🔴 main.ts の分かれ道は storage / startApp より前', () => {
  const code = readFileSync('src/main.ts', 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const boot = code.slice(code.indexOf('function bootstrap(): void {'));

  it('bootstrap の冒頭で聞き、軽い起動へ分けて return する(startApp / 名乗り / SW より前)', () => {
    const at = boot.indexOf('readChartPopoutToken()');
    expect(at).toBeGreaterThan(0);
    const branch = boot.slice(at, boot.indexOf('return;', at) + 'return;'.length);
    expect(branch).toContain("import('@adapter/ui/render/chart-popout-window')");
    expect(branch).toContain('bootChartPopoutWindow(root, chartToken)');
    for (const later of ['announceOpenedWindow(', 'serviceWorker', 'showBootProgress(root)', 'startApp(root)']) {
      const k = boot.indexOf(later);
      expect(k, `${later} が見つからない`).toBeGreaterThan(0);
      expect(at, `${later} より前で分ける`).toBeLessThan(k);
    }
  });

  it('⚠ 別ウィンドウの画面は main の bundle に静的に入れない(要るときだけ読む)', () => {
    expect(code).not.toMatch(/^import[^;]*chart-popout-window/m);
  });
});
