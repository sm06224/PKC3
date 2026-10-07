/** @vitest-environment happy-dom */
/**
 * 🔴 **ブラウザの AI に許したことの一覧と、取り消しの導線**(#1407 段①)。
 *
 * ⚠ 「常に許す」は期限なしで憶えるので、**取り消す場所が無いと二度と外せない**
 *   (`settings-extensions.test.ts` と同じ理屈)。
 * 🔑 守る主張:
 * 1. 1 件も無ければ**そう言う**(空欄にしない)
 * 2. 許した範囲(読む / 作る)と最終の呼び出し日時が並ぶ。まだ呼ばれていなければそう言う
 * 3. 🔴 押した範囲が呼び側へ届く(押しても何も起きないボタンを作らない)
 * 4. 🔴 **他の許可の一覧と同じ節(「許可」)に並ぶ**・新しい見出しを作らない
 * 5. ⚠ 毎回組み直す(許可はこの画面の外 ── AI が呼んだときのダイアログ ── で増える)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { AgentGrants } from '@adapter/platform/agent-grants';
import { AgentTabStatus } from '@adapter/platform/agent-tab-status';
import { WEBMCP_TAB_STATUS_TEXT, type WebMcpTabStatus } from '@features/agent/webmcp-types';
import { bindActions } from '@adapter/ui/actions/binder';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState } from '@adapter/state/app-state';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** `agentGrants` より前の引数の数(region の後ろの、既定つきの引数)。 */
const BEFORE_AGENT_GRANTS = 21;

function setup(grants: AgentGrants, tab: AgentTabStatus = new AgentTabStatus()) {
  const root = document.createElement('div');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  // ⚠ 位置引数(末尾に足す決まり)── 型が追えないので、末尾の台帳が実際に使われること(一覧に出る)を各 it が見る
  const Ctor = SettingsRenderer as unknown as new (...args: unknown[]) => SettingsRenderer;
  const renderer = new Ctor(
    region,
    ...Array.from({ length: BEFORE_AGENT_GRANTS }, () => undefined),
    grants,
    tab,
  );
  return { root, region, renderer };
}

const rows = (region: HTMLElement): HTMLElement[] => [
  ...region.querySelectorAll<HTMLElement>('[data-pkc-field="agent-list"] li'),
];

describe('ブラウザの AI に許したこと(#1407)', () => {
  let store: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    document.body.innerHTML = '';
    store = fakeStorage();
  });

  it('1 件も無ければ、無いと言う(空欄にしない)', () => {
    const { region, renderer } = setup(new AgentGrants(store));
    renderer.render(initialState);
    expect(rows(region)).toHaveLength(1);
    expect(rows(region)[0]!.textContent).toContain('まだ許したことはありません');
    expect(region.querySelector('[data-pkc-action="revoke-agent"]')).toBeNull();
  });

  it('許した範囲と最終の呼び出し日時が並ぶ。まだ呼ばれていなければそう言う', () => {
    const grants = new AgentGrants(store);
    grants.setAlways('read');
    grants.touch('read', new Date(2026, 9, 7, 9, 5).getTime());
    grants.setAlways('write');
    const { region, renderer } = setup(grants);
    renderer.render(initialState);
    const [read, write] = rows(region);
    expect(read!.getAttribute('data-pkc-agent-scope')).toBe('read');
    expect(read!.textContent).toContain('ノートを探す・読む');
    expect(read!.textContent).toContain('最後に使われた: 2026-10-07 09:05');
    expect(write!.getAttribute('data-pkc-agent-scope')).toBe('write');
    expect(write!.textContent).toContain('ノートを作る');
    expect(write!.textContent).toContain('まだ使われていません');
  });

  it('「今回だけ」(touch だけ)は一覧に出ない', () => {
    const grants = new AgentGrants(store);
    grants.touch('read', 1);
    const { region, renderer } = setup(grants);
    renderer.render(initialState);
    expect(rows(region)[0]!.textContent).toContain('まだ許したことはありません');
  });

  it('🔴 取り消しを押すと、その範囲が呼び側へ届く(read と write を取り違えない)', () => {
    const grants = new AgentGrants(store);
    grants.setAlways('read');
    grants.setAlways('write');
    const { root, region, renderer } = setup(grants);
    renderer.render(initialState);
    const revokeAgent = vi.fn();
    bindActions(root, new Dispatcher(), { revokeAgent });
    const buttons = region.querySelectorAll<HTMLButtonElement>('[data-pkc-action="revoke-agent"]');
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    expect(revokeAgent).toHaveBeenLastCalledWith('write');
    buttons[0]!.click();
    expect(revokeAgent).toHaveBeenLastCalledWith('read');
  });

  it('🔴 他の許可の一覧と同じ節(許可)に並ぶ ── 新しい見出し(h3)を作らない', () => {
    const { region, renderer } = setup(new AgentGrants(store));
    renderer.render(initialState);
    const section = region.querySelector('[data-pkc-region="settings-permissions"]')!;
    const mine = section.querySelector('[data-pkc-region="settings-agents"]');
    expect(mine, '「許可」の節の中に無い').not.toBeNull();
    // 同じ節に、ノート一覧を見せているアプリの一覧も在る(並べ方の対照群)
    expect(section.querySelector('[data-pkc-region="settings-extensions"]')).not.toBeNull();
    // 見出しは h4(許可の節の h3 は 1 つのまま)
    expect(mine!.querySelector('h4')?.textContent).toBe('ブラウザの AI に許したこと');
    expect(section.querySelectorAll('h3')).toHaveLength(1);
  });

  it('⚠ 毎回組み直す: 画面の外で許可が増えたら、次の描画で並ぶ。取り消せば消える', () => {
    const grants = new AgentGrants(store);
    const { region, renderer } = setup(grants);
    renderer.render(initialState);
    expect(rows(region)[0]!.textContent).toContain('まだ許したことはありません');
    grants.setAlways('read'); // AI が呼んだときのダイアログで「常に許す」が選ばれた
    renderer.render(initialState);
    expect(rows(region)[0]!.getAttribute('data-pkc-agent-scope')).toBe('read');
    grants.revoke('read');
    renderer.render(initialState);
    expect(rows(region)[0]!.textContent).toContain('まだ許したことはありません');
  });

  describe('🔴 このタブの状態を 1 行で言う', () => {
    const CASES: ReadonlyArray<[WebMcpTabStatus, string]> = [
      ['ready', 'このタブ: 使えます'],
      ['unsupported', 'このタブ: このブラウザは対応していません'],
      ['not-holder', 'このタブ: メインのタブではありません(別のタブが使えます)'],
      ['flag-off', 'このタブ: フラグがオフです'],
    ];

    it.each(CASES)('%s → %s', (status, text) => {
      const tab = new AgentTabStatus();
      tab.set(status);
      const { region, renderer } = setup(new AgentGrants(fakeStorage()), tab);
      renderer.render(initialState);
      const line = region.querySelector('[data-pkc-field="agent-tab-status"]');
      expect(line?.textContent).toBe(text);
      expect(WEBMCP_TAB_STATUS_TEXT[status]).toBe(text);
    });

    it('一覧が空でも状態は出る(節は常に出す ── 同じ物が同じ場所に)。状態が変わったら次の描画で変わる', () => {
      const tab = new AgentTabStatus();
      const { region, renderer } = setup(new AgentGrants(fakeStorage()), tab);
      tab.set('flag-off');
      renderer.render(initialState);
      expect(region.querySelector('[data-pkc-region="settings-agents"]')).not.toBeNull();
      expect(rows(region)[0]!.textContent).toBe('まだ許したことはありません');
      tab.set('ready');
      renderer.render(initialState);
      expect(region.querySelector('[data-pkc-field="agent-tab-status"]')?.textContent).toBe(
        'このタブ: 使えます',
      );
    });
  });

  it('🔴 ダイアログの答えで許可が増えたら、手で render を呼ばなくても一覧に出る(onChange で描き直す配線)', () => {
    const grants = new AgentGrants(fakeStorage());
    const { region, renderer } = setup(grants);
    renderer.render(initialState);
    // main.ts と同じ配線: 台帳の変化 → 描き直し
    grants.onChange(() => renderer.render(initialState));
    expect(rows(region)[0]!.textContent).toBe('まだ許したことはありません');
    grants.setAlways('read');
    expect(rows(region)[0]!.getAttribute('data-pkc-agent-scope')).toBe('read');
    grants.touch('read', new Date(2026, 9, 7, 9, 5).getTime());
    expect(rows(region)[0]!.textContent).toContain('2026-10-07 09:05');
    grants.revoke('read');
    expect(rows(region)[0]!.textContent).toBe('まだ許したことはありません');
  });
});
