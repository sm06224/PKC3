/** @vitest-environment happy-dom */
/**
 * 🔴 **素のまま起動を許したアプリの一覧と、取り消しの導線**(#301。user 裁定 2026-08-21)。
 *
 * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
 * > (文字通りの永続化、期間とかない)**」
 *
 * ⚠ **期限が無い以上、取り消す場所が無いと二度と外せない。** マニュアルにも
 *   「設定でいつでも取り消せます」と書いた ── その約束をここで pin する。
 * ⚠ 一覧は**この面の外**(添付の起動)で増えるので、`render` のたびに
 *   組み直すことも見る(隠れている間の変化を取りこぼすと**画面が嘘をつく**)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
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

const rows = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[data-pkc-field="same-origin-list"] li')].map(
    (li) => li.textContent ?? '',
  );

describe('設定 — 素のまま起動を許したアプリ(#301)', () => {
  let host: HTMLElement;
  let st: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    document.body.textContent = '';
    host = document.createElement('div');
    document.body.append(host);
    st = fakeStorage();
  });

  /** 器を 1 つ作って返す ── **同じインスタンスで描き直す**経路を通すため。 */
  const mount = (): { r: SettingsRenderer; grants: SameOriginGrants } => {
    const grants = new SameOriginGrants(st);
    const r = new SettingsRenderer(
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      grants,
    );
    return { r, grants };
  };
  const render = (state: AppState): SameOriginGrants => {
    const { r, grants } = mount();
    r.render(state);
    return grants;
  };

  it('1 件も許していなければ、そう書く(空の枠を出さない)', () => {
    render(stateWith([]));
    expect(rows(host)).toEqual(['まだ許可したアプリはありません']);
  });

  it('🔴 許したアプリが、題名で並ぶ', () => {
    new SameOriginGrants(st).grant(KEY_A);
    render(stateWith([tile('e1', '見積ツール', KEY_A)]));
    expect(rows(host).join(' ')).toContain('見積ツール');
  });

  /**
   * ⚠ 題名が引けないもの(添付を消した / 登録を外した)も**出す** ── 出さないと
   *   一覧から消えて見えるのに許可は残る = **取り消しようがない**。
   */
  it('🔴 題名が引けないものも、鍵の頭を出して取り消せるようにする', () => {
    new SameOriginGrants(st).grant(KEY_B);
    render(stateWith([]));
    expect(rows(host).join(' '), '一覧から消えている(取り消せない)').toContain(
      KEY_B.slice(4, 12),
    );
    expect(
      host.querySelector(`[data-pkc-action="revoke-same-origin"][data-pkc-asset-key="${KEY_B}"]`),
      '取り消しの導線が無い',
    ).not.toBeNull();
  });

  /**
   * 🔴 **一覧はこの面の外で増える。** 添付を起動して許可した後、設定へ戻ってきた
   *   ときに古い姿のままだと、user は「許可されていない」と読む。
   */
  it('🔴 面を開いたまま許可が増えたら、次の render で出る', () => {
    // 🔴 **同じインスタンスで 2 回描く**のが肝 ── 新しい器を作ると初回ビルドの
    //    経路しか通らず、「組み直しの経路」(`built === true` の側)を
    //    **1 度も実行しない**まま緑になる(CLAUDE.md §2)
    const { r, grants } = mount();
    const st1 = stateWith([tile('e1', '見積ツール', KEY_A)]);
    r.render(st1);
    expect(rows(host)).toEqual(['まだ許可したアプリはありません']);
    grants.grant(KEY_A); // ← 添付の画面で許可した、に相当
    r.render(st1);
    expect(rows(host).join(' '), '古い姿のまま凍っている').toContain('見積ツール');
  });

  /**
   * 🔴 **配線** ── 面と services が実際につながっているか。
   * ⚠ どちらの unit も見ていない所である(`update-card.test.ts` と同じ理由)。
   */
  it('🔴 「取り消す」を押すと、その鍵で services が呼ばれる', () => {
    new SameOriginGrants(st).grant(KEY_A);
    render(stateWith([tile('e1', '見積ツール', KEY_A)]));
    const revokeSameOrigin = vi.fn();
    bindActions(host, new Dispatcher(), { revokeSameOrigin });

    host
      .querySelector<HTMLElement>(`[data-pkc-action="revoke-same-origin"]`)!
      .click();
    expect(revokeSameOrigin, '押しても無言(何も起きない)').toHaveBeenCalledWith(KEY_A);
  });
});
