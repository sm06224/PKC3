/** @vitest-environment happy-dom */
/**
 * 🔴 **音・動画の器から URL を外してから返す**(`media-release.ts`。2026-11-21)。
 * ⚠ 観測点は「返す(`dispose`)その瞬間の `src`」と `load()` が呼ばれたこと ──
 *   `src` を外すだけでは読み込みは止まらない(死んだ blob: を読み直し続ける)。
 */
import { describe, expect, it, vi } from 'vitest';
import { releaseMediaLend, unloadMedia } from '../../src/adapter/ui/render/media-release';

describe('unloadMedia', () => {
  it('🔴 同じ URL の器は pause → src を外す → load()、別の URL の器には触らない', () => {
    const box = document.createElement('div');
    const mine = document.createElement('audio');
    mine.src = 'blob:a';
    const other = document.createElement('video');
    other.src = 'blob:b';
    box.append(mine, other);
    const load = vi.spyOn(mine, 'load');
    const pause = vi.spyOn(mine, 'pause');
    const otherLoad = vi.spyOn(other, 'load');
    unloadMedia(box, 'blob:a');
    expect(mine.getAttribute('src')).toBeNull();
    expect(pause).toHaveBeenCalled();
    expect(load, 'src を外しただけで load() していない').toHaveBeenCalled();
    expect(other.getAttribute('src'), '別の URL の器まで外した').toBe('blob:b');
    expect(otherLoad).not.toHaveBeenCalled();
  });

  it('🔴 url が null なら中の器を全部外す / root 自身が器でも外す', () => {
    const box = document.createElement('div');
    const a = document.createElement('audio');
    a.src = 'blob:x';
    box.append(a);
    unloadMedia(box, null);
    expect(a.getAttribute('src')).toBeNull();
    const v = document.createElement('video');
    v.src = 'blob:y';
    unloadMedia(v, 'blob:y');
    expect(v.getAttribute('src')).toBeNull();
  });
});

describe('releaseMediaLend(章の別ウィンドウの本文の再生機)', () => {
  it('🔴 返す瞬間には、置いた器はもう URL を差していない', () => {
    const el = document.createElement('audio');
    el.src = 'blob:c';
    const load = vi.spyOn(el, 'load');
    const seen: (string | null)[] = [];
    const release = releaseMediaLend([el], 'blob:c', () => seen.push(el.getAttribute('src')));
    expect(seen, '作っただけで返している').toEqual([]);
    release();
    expect(seen, '返す瞬間に器がまだ URL を差している').toEqual([null]);
    expect(load).toHaveBeenCalled();
  });
});
