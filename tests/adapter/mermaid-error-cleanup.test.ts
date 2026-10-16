/** @vitest-environment happy-dom */
/**
 * 構文エラーの図が、mermaid の作業用要素(`div#d<id>`、約 190px)を画面へ残さない。
 * 残るとページ全体にスクロールバーが出て、テーマを替えるたびに増える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { render, initialize } = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn() }));
vi.mock('mermaid', () => ({ default: { initialize, render } }));

import {
  configFor,
  renderToSvg,
  type DiagramPalette,
} from '../../src/adapter/ui/render/mermaid-raster';

const P: DiagramPalette = {
  bg: '#ffffff',
  alt: '#eeeeee',
  fg: '#000000',
  line: '#666666',
  border: '#888888',
  accent: '#0066cc',
  dark: false,
};

describe('mermaid の構文エラーで作業用要素を残さない', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    render.mockReset();
    initialize.mockReset();
  });

  it('設定に suppressErrorRendering: true が入っている', () => {
    expect((configFor(P) as { suppressErrorRendering?: boolean }).suppressErrorRendering).toBe(true);
  });

  it('描画が失敗したら、mermaid が置いた d<id> を消してから投げ直す', async () => {
    render.mockImplementation(async (id: string) => {
      const d = document.createElement('div');
      d.id = `d${id}`;
      document.body.appendChild(d);
      throw new Error('Parse error');
    });
    await expect(renderToSvg('graph TD; A-->', P)).rejects.toThrow('Parse error');
    expect(render).toHaveBeenCalledTimes(1);
    expect(document.body.children.length).toBe(0);
  });

  it('成功したときは何も消さない(対照群)', async () => {
    render.mockResolvedValue({ svg: '<svg/>' });
    const other = document.createElement('div');
    other.id = 'dpkc3-mmd-keep';
    document.body.appendChild(other);
    await expect(renderToSvg('graph TD; A-->B', P)).resolves.toBe('<svg/>');
    expect(document.getElementById('dpkc3-mmd-keep')).not.toBeNull();
  });
});
