/** @vitest-environment happy-dom */
/**
 * 🔴 **絵を選んだ外部リンクのタイルにも、外へ出る印 `↗` を残す**(#852 案 1)。
 *
 * 直す前は左端の `↗` が「絵も絵文字も無いときだけ」で、絵を選ぶと一覧のどれが PKC の外へ出るのかが読めなくなっていた。
 * 観測点は 3 つ: ① 絵が無い側は左端の字、絵が有る側は右端のホスト名の前に印が付く
 * ② 印は字で入れない(ボタンの `textContent` を変えない) ③ 外部リンクでないタイルには付けない(対照群)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import type { LauncherTile } from '../../src/features/launcher/tiles';

function render(tiles: LauncherTile[]): HTMLElement {
  document.body.textContent = '';
  const region = document.createElement('div');
  document.body.append(region);
  const r = new LauncherRenderer(region);
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles });
  r.render(d.getState());
  return region;
}

const tileEl = (region: HTMLElement, lid: string): HTMLElement =>
  region.querySelector<HTMLElement>(`[data-pkc-action="open-tile"][data-pkc-tile="${lid}"]`)!;

describe('外へ出る印(#852 案 1)', () => {
  const url = { kind: 'url', url: 'https://example.com/x', group: '' } as const;
  const region = (): HTMLElement =>
    render([
      { lid: 'plain', title: '素', ...url },
      { lid: 'sym', title: '図案', symbol: 'book', ...url },
      { lid: 'emoji', title: '絵文字', icon: '★', ...url },
      { lid: 'app', title: '添付', group: '', kind: 'app' } as LauncherTile,
    ]);

  it('🔴 絵が無い物は左端の字 ↗、絵を選んだ物は右端のホスト名の前に印が付く', () => {
    const r = region();
    expect(tileEl(r, 'plain').querySelector('[data-pkc-field="tile-icon"]')!.textContent).toBe('↗');
    expect(
      tileEl(r, 'plain').querySelector('[data-pkc-field="tile-url"]')!.hasAttribute('data-pkc-external'),
    ).toBe(false);
    for (const lid of ['sym', 'emoji']) {
      const where = tileEl(r, lid).querySelector('[data-pkc-field="tile-url"]')!;
      expect(where.hasAttribute('data-pkc-external'), `${lid}: 絵を選んだら外へ出る印が消えた`).toBe(true);
      expect(where.textContent, '印を字で入れた(textContent が変わる)').toBe('example.com');
    }
  });

  it('対照群: 外部リンクでないタイルには付かない', () => {
    const r = region();
    expect(tileEl(r, 'app').querySelector('[data-pkc-external]')).toBeNull();
  });

  it('その印を描く CSS が在る(右端のホスト名の前)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    expect(css).toMatch(/\[data-pkc-field='tile-url'\]\[data-pkc-external\]::before\s*\{\s*content:\s*'↗ ';/);
  });
});
