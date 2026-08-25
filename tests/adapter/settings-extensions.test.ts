/** @vitest-environment happy-dom */
/**
 * 🔴 **目次を見せているアプリの一覧と、取り消しの導線**(#195 / C-5 段①-b)。
 *
 * ⚠ **期限が無い以上、取り消す場所が無いと二度と外せない**(#301 と同じ理屈)。
 * 🔑 守る主張:
 * 1. 一覧に出る / 1 件も無ければ**そう言う**(空欄にしない)
 * 2. 🔴 **取り消せる**(押した鍵が呼び側へ届く)
 * 3. 🔴 **素のまま起動の一覧とは別**(片方を消してももう片方は残る)
 * 4. ⚠ **毎回組み直す**(許可はこの面の外で増える ── 隠れている間の変化を取りこぼさない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { ExtensionGrants } from '@adapter/platform/extension-grants';
import { SameOriginGrants } from '@adapter/platform/same-origin-grants';
import { bindActions } from '@adapter/ui/actions/binder';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState, type AppState } from '@adapter/state/app-state';
import type { LauncherTile } from '@features/launcher/tiles';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const hashKey = (seed: string): string => `ast-${seed.repeat(64).slice(0, 64)}`;
const KEY_A = hashKey('a');
const KEY_B = hashKey('b');

const tile = (lid: string, title: string, assetKey: string): LauncherTile => ({
  lid,
  title,
  group: '',
  kind: 'app',
  assetKey,
});

function stateWith(tiles: LauncherTile[]): AppState {
  return { ...initialState, launcherTiles: tiles };
}

function setup(store: ReturnType<typeof fakeStorage>) {
  const root = document.createElement('div');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  const grants = new ExtensionGrants(store);
  // ⚠ 位置引数 ── `region, monitor, externalImages, notices, editorMode, openInEdit,
  //   sameOriginGrants, extensionGrants` の 8 番目が拡張の台帳である
  const renderer = new SettingsRenderer(
    region,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new SameOriginGrants(store),
    grants,
  );
  return { root, region, renderer, grants };
}

const rows = (region: HTMLElement): HTMLElement[] => [
  ...region.querySelectorAll<HTMLElement>('[data-pkc-field="extension-list"] li'),
];

describe('目次を見せているアプリ(#195 / C-5 段①-b)', () => {
  let store: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    document.body.innerHTML = '';
    store = fakeStorage();
  });

  it('1 件も無ければ、無いと言う(空欄にしない)', () => {
    const { region, renderer } = setup(store);
    renderer.render(stateWith([]));
    expect(rows(region)).toHaveLength(1);
    expect(rows(region)[0]!.textContent).toContain('ありません');
  });

  it('許したアプリが題名つきで並ぶ', () => {
    const { region, renderer, grants } = setup(store);
    grants.grant(KEY_A);
    renderer.render(stateWith([tile('a1', '見積ツール', KEY_A)]));
    expect(rows(region).map((li) => li.textContent)).toEqual([
      expect.stringContaining('見積ツール'),
    ]);
  });

  /** ⚠ 一覧から消えたアプリでも**取り消せる**(空欄にすると外しようがない)。 */
  it('⚠ 一覧に無いアプリでも、鍵の頭を出して取り消せる', () => {
    const { region, renderer, grants } = setup(store);
    grants.grant(KEY_B);
    renderer.render(stateWith([]));
    expect(rows(region)[0]!.textContent).toContain('一覧に無いアプリ');
    expect(
      rows(region)[0]!.querySelector('[data-pkc-action="revoke-extension"]'),
      '取り消す口が無い',
    ).not.toBeNull();
  });

  /** 🔴 **押した鍵が呼び側へ届く**(押しても何も起きないボタンを作らない)。 */
  it('🔴 取り消しを押すと、その鍵が呼び側へ届く', () => {
    const { root, region, renderer, grants } = setup(store);
    grants.grant(KEY_A);
    renderer.render(stateWith([tile('a1', '見積ツール', KEY_A)]));
    const revokeExtension = vi.fn();
    bindActions(root, new Dispatcher(), { revokeExtension });
    region
      .querySelector<HTMLButtonElement>('[data-pkc-action="revoke-extension"]')!
      .click();
    expect(revokeExtension).toHaveBeenCalledWith(KEY_A);
  });

  /**
   * 🔴 **素のまま起動の一覧とは別**。
   * ⚠ 混ざっていると、片方を取り消したつもりでもう片方まで消える(逆も同じ)。
   */
  it('🔴 素のまま起動の一覧とは別の場所に出る', () => {
    const { region, renderer, grants } = setup(store);
    grants.grant(KEY_A);
    new SameOriginGrants(store).grant(KEY_B);
    renderer.render(stateWith([tile('a1', '目次のアプリ', KEY_A), tile('b1', '素のまま', KEY_B)]));
    const ext = region.querySelector('[data-pkc-field="extension-list"]')!.textContent ?? '';
    const same = region.querySelector('[data-pkc-field="same-origin-list"]')!.textContent ?? '';
    expect(ext, '目次の一覧に素のままが混ざっている').not.toContain('素のまま');
    expect(same, '素のままの一覧に目次のアプリが混ざっている').not.toContain('目次のアプリ');
  });

  /**
   * ⚠ **毎回組み直す** ── 許可はこの面の外(添付の起動)で増えるので、
   *   「開いている間に変わらない」という前提が成り立たない。
   */
  it('⚠ 面の外で許可が増えても、描き直せば出る', () => {
    const { region, renderer, grants } = setup(store);
    renderer.render(stateWith([]));
    expect(rows(region)[0]!.textContent).toContain('ありません');
    grants.grant(KEY_A);
    renderer.render(stateWith([tile('a1', '後から許したアプリ', KEY_A)]));
    expect(rows(region).map((li) => li.textContent)).toEqual([
      expect.stringContaining('後から許したアプリ'),
    ]);
  });
});
