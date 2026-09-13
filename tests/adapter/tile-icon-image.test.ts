/** @vitest-environment happy-dom */
/**
 * 🔴 **取り込んだ絵が、アプリの一覧に出る**(#856 段②、描画)。
 *
 * 🔴 守る主張:
 * 1. 鍵が在れば `<img>` を置く(⚠ `src` はここでは入れない ── 借りるのは非同期)
 * 2. 🔴 **絵は字や図案より優先する**(user が最後に選んだ物だから)
 * 3. 🔴 **ボタンの `textContent` は 1 文字も変わらない**
 *    (2026-09-11 に全量 smoke が 5 本落ちた形 ── CLAUDE.md §10)
 * 4. ⚠ 貸し口を渡さなければ、**字と図案はそのまま出る**(段①の逃げ道を塞がない)
 * 5. 🔴 借りた URL が差さり、**一覧を捨てたら返る**
 */
import { describe, expect, it, vi } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { GroupFoldStore } from '../../src/adapter/ui/render/group-fold';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

const tile = (over: Partial<LauncherTile>): LauncherTile => ({
  lid: 'u1',
  title: 'サイト',
  group: '',
  kind: 'url',
  url: 'https://u.test/',
  order: 0,
  ...over,
});

const stateWith = (t: LauncherTile): AppState => ({
  ...initialState,
  launcherTiles: withBuiltinTiles([t], { office: false }),
});

interface Rendered {
  region: HTMLElement;
  renderer: LauncherRenderer;
}

function mount(
  assets: { lend: (k: string) => Promise<{ url: string; dispose: () => void } | null> } | null = null,
): Rendered {
  const region = document.createElement('div');
  document.body.append(region);
  const renderer = new LauncherRenderer(
    region,
    new GroupFoldStore(null),
    assets === null ? null : { ...assets, getBlob: async () => null },
  );
  return { region, renderer };
}

function renderInto(
  state: AppState,
  assets: { lend: (k: string) => Promise<{ url: string; dispose: () => void } | null> } | null = null,
): HTMLElement {
  const m = mount(assets);
  m.renderer.render(state);
  return m.region;
}

/** 自分で足したタイルのボタン(組み込みを混ぜない)。 */
const userTile = (region: HTMLElement): HTMLElement =>
  region.querySelector<HTMLElement>('[data-pkc-tile="u1"]')!;

describe('取り込んだ絵を一覧に出す(#856 段②)', () => {
  it('🔴 鍵が在れば img を置く(src はまだ入れない)', () => {
    const region = renderInto(stateWith(tile({ iconAssetKey: 'k1' })));
    const img = userTile(region).querySelector('img[data-pkc-asset-key]');
    expect(img, '絵の器が出ていない').not.toBeNull();
    expect(img!.getAttribute('data-pkc-asset-key')).toBe('k1');
    expect((img as HTMLImageElement).getAttribute('src'), 'まだ借りていないのに src が在る').toBeNull();
  });

  it('🔴 絵は、字や図案より先に使う', () => {
    const region = renderInto(stateWith(tile({ iconAssetKey: 'k1', icon: '🍎' })));
    const btn = userTile(region);
    expect(btn.querySelector('img[data-pkc-asset-key]'), '絵を出していない').not.toBeNull();
    expect(btn.textContent, '字のほうが勝ってしまった').not.toContain('🍎');
  });

  it('🔴 ボタンの textContent は、絵を足しても変わらない', () => {
    const withIcon = userTile(renderInto(stateWith(tile({ iconAssetKey: 'k1' })))).textContent;
    // ⚠ 対照群 ── 絵の無い同じタイル。⚠ `↗` は「外へ出る」を伝える情報なので残る
    const plain = userTile(renderInto(stateWith(tile({ icon: '' })))).textContent;
    expect(withIcon, '絵を足したら読める字が変わった(読み手が静かに外れる)').toBe(plain);
  });

  it('⚠ 貸し口が無くても、字はそのまま出る(逃げ道を塞がない)', () => {
    const region = renderInto(stateWith(tile({ icon: '🍎' })), null);
    expect(userTile(region).textContent, '字が消えた').toContain('🍎');
  });

  it('🔴 借りた URL が差さる', async () => {
    const disposed: string[] = [];
    const lend = vi.fn(async (k: string) => ({
      url: `blob:${k}`,
      dispose: () => disposed.push(k),
    }));
    const m = mount({ lend });
    m.renderer.render(stateWith(tile({ iconAssetKey: 'k1' })));
    // ⚠ 借りは非同期 ── tick を待つ
    await Promise.resolve();
    await Promise.resolve();
    const img = userTile(m.region).querySelector<HTMLImageElement>('img[data-pkc-asset-key]')!;
    expect(img.src, '借りた URL を差していない').toBe('blob:k1');
    // 前提 ── 本当に借りにいった(空振り防止)
    expect(lend, '借りにいっていない').toHaveBeenCalledWith('k1');
    // ⚠ **この時点ではまだ返していない**(画面に出ているので)── 下の対照群になる
    expect(disposed, '画面に出ているのに返した').toEqual([]);
  });

  /**
   * 🔴 **絵が一覧から消えたら返す**(不可侵指示 2026-07-27)。
   * ⚠ 「面を捨てた」だけでは返らない ── **返す手を呼ぶ所**が要る、というのが主張である。
   */
  it('🔴 その絵を使うタイルが消えたら、返す', async () => {
    const disposed: string[] = [];
    const lend = vi.fn(async (k: string) => ({
      url: `blob:${k}`,
      dispose: () => disposed.push(k),
    }));
    const m = mount({ lend });
    m.renderer.render(stateWith(tile({ iconAssetKey: 'k1' })));
    await Promise.resolve();
    await Promise.resolve();
    // 前提 ── 借りている(ここが崩れると以降は何も見ていない)
    expect(disposed, '前提が崩れている(まだ借りていない)').toEqual([]);

    // 絵を持たないタイルへ組み直す ── 古い `<img>` は器ごと捨てられる
    m.renderer.render(stateWith(tile({ iconAssetKey: undefined, icon: '🍎' })));
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed, '画面から消えた絵を返していない(bytes が残る)').toEqual(['k1']);
  });

  it('🔴 面を畳むときに、借りているものを全部返す', async () => {
    const disposed: string[] = [];
    const lend = vi.fn(async (k: string) => ({
      url: `blob:${k}`,
      dispose: () => disposed.push(k),
    }));
    const m = mount({ lend });
    m.renderer.render(stateWith(tile({ iconAssetKey: 'k1' })));
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed, '前提が崩れている').toEqual([]);
    m.renderer.disposeAssets();
    expect(disposed, '畳んでも返していない').toEqual(['k1']);
  });
});
