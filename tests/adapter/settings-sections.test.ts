/** @vitest-environment happy-dom */
/**
 * 設定(システム)画面の「節の登録表」(#1382)。
 *
 * 🔑 守る主張:
 * 1. 登録表の並び = 画面の並び(`build` が返した根の要素が、登録の順に DOM に並ぶ)
 * 2. 🔴 **登録した節の `sync` は、最初の組み立ての直後にも、以後の `render()` のたびにも呼ばれる**
 *    (器は 1 度しか組まないので、映す口を呼び忘れると古い値が見える ── CLAUDE.md §7)
 * 3. 名前は一意。`inline`(まだ `render()` が直に組む節)は `build` が `null`
 *
 * ⚠ 守っていないもの:各節が「何を映すか」(節ごとの test が持つ ── `settings-agents.test.ts` ほか)。
 */
import { describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { AgentGrants } from '@adapter/platform/agent-grants';
import { AgentTabStatus } from '@adapter/platform/agent-tab-status';
import { SameOriginGrants } from '@adapter/platform/same-origin-grants';
import { ExtensionGrants } from '@adapter/platform/extension-grants';
import { initialState } from '@adapter/state/app-state';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** 位置引数(末尾に足す決まり)── 許可の台帳 3 つは localStorage に触れない fake を渡す。 */
function setup() {
  document.body.innerHTML = '';
  const region = document.createElement('div');
  document.body.append(region);
  const args: unknown[] = Array.from({ length: 21 }, () => undefined);
  args[5] = new SameOriginGrants(fakeStorage());
  args[6] = new ExtensionGrants(fakeStorage());
  const Ctor = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
  const renderer = new Ctor(
    region,
    ...args,
    new AgentGrants(fakeStorage()),
    new AgentTabStatus(),
  );
  return { region, renderer };
}

/** ファイルへ移した節(`settings/` の下に 1 つずつ在る)。登録表に在ることを等値で見る。 */
const MOVED = [
  'messages',
  'same-origin',
  'extensions',
  'agents',
  'opened-history',
  'search-history',
  'copy-history',
];

describe('設定画面の節の登録表(#1382)', () => {
  it('名前は一意で、ファイルへ移した節は全部載っている', () => {
    const { renderer } = setup();
    const ids = renderer.registeredSections().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of MOVED) expect(ids).toContain(id);
    // 空振り防止:inline(直に組む節)も映す口は載っている
    expect(ids.length).toBeGreaterThan(MOVED.length);
  });

  it('🔴 登録表の並び = 画面の並び(build が返した根が、登録の順に DOM に並ぶ)', () => {
    const { region, renderer } = setup();
    const built: { id: string; el: HTMLElement }[] = [];
    for (const s of renderer.registeredSections()) {
      const orig = s.build.bind(s);
      vi.spyOn(s, 'build').mockImplementation(() => {
        const el = orig();
        if (el !== null) built.push({ id: s.id, el });
        return el;
      });
    }
    renderer.render(initialState);
    // 載っている節のうち build が根を返したもの = ファイルへ移した節 + 外部画像
    expect(built.map((b) => b.id)).toEqual([
      'messages',
      'external-images',
      'same-origin',
      'extensions',
      'agents',
      'opened-history',
      'search-history',
      'copy-history',
    ]);
    for (const b of built) expect(region.contains(b.el)).toBe(true);
    for (let i = 1; i < built.length; i++) {
      const prev = built[i - 1]!.el;
      const cur = built[i]!.el;
      // cur は prev より後ろ(DOM の文書順)
      expect(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // inline の節は build が null(render() が直に組む)
    for (const s of renderer.registeredSections()) {
      if (s.group === 'inline') expect(s.build()).toBeNull();
    }
  });

  it('🔴 登録した節の sync は、最初の組み立ての直後にも、以後の render() のたびにも呼ばれる', () => {
    const { renderer } = setup();
    const spies = renderer
      .registeredSections()
      .map((s) => ({ id: s.id, spy: vi.spyOn(s, 'sync') }));
    expect(spies.length).toBeGreaterThan(0);

    renderer.render(initialState); // 組み立て + 最初の sync
    for (const { id, spy } of spies) expect(spy, `${id}: 組み立て直後`).toHaveBeenCalledTimes(1);

    renderer.render({ ...initialState, messagesUnread: 2 }); // 以後
    for (const { id, spy } of spies) {
      expect(spy, `${id}: 以後の render`).toHaveBeenCalledTimes(2);
      // 最新の state が渡る(古い state を握らない)
      expect(spy.mock.calls[1]![0]!.messagesUnread, id).toBe(2);
    }
  });
});
