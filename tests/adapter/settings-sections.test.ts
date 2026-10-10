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
  const sameOrigin = new SameOriginGrants(fakeStorage());
  const extension = new ExtensionGrants(fakeStorage());
  const agent = new AgentGrants(fakeStorage());
  args[5] = sameOrigin;
  args[6] = extension;
  const Ctor = SettingsRenderer as unknown as new (...a: unknown[]) => SettingsRenderer;
  const renderer = new Ctor(
    region,
    ...args,
    agent,
    new AgentTabStatus(),
  );
  return { region, renderer, sameOrigin, extension, agent };
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

/** 登録表の全 id(並びが画面の並び)。節を足したらここへ 1 行足す。 */
const ALL_IDS = [
  'messages',
  'theme',
  'page-format',
  'prose-align',
  'text-scale',
  'read-columns',
  'editor-mode',
  'open-in-edit',
  'open-place',
  'app-open-target',
  'alarm-enabled',
  'voice-boost',
  'phone-links',
  'date-links',
  'relative-days',
  'color-swatch',
  'missing-links',
  'code-collapse',
  'inline-code-copy',
  'pdf-reader',
  'external-images',
  'paste-source',
  'same-origin',
  'extensions',
  'agents',
  'persist',
  'notices',
  'too-narrow',
  'opened-history',
  'search-history',
  'copy-history',
];

/** inline(と未移動の外部画像)の id → 呼ばれるべき private メソッド。 */
const INLINE_SYNC: Record<string, string> = {
  theme: 'syncTheme',
  'page-format': 'syncPageFormat',
  'prose-align': 'syncProseAlign',
  'text-scale': 'syncTextScale',
  'read-columns': 'syncReadColumns',
  'editor-mode': 'syncEditorMode',
  'open-in-edit': 'syncOpenInEdit',
  'open-place': 'syncOpenPlace',
  'app-open-target': 'syncAppOpenTarget',
  'alarm-enabled': 'syncAlarmEnabled',
  'voice-boost': 'syncVoiceBoost',
  'phone-links': 'syncPhoneLinks',
  'date-links': 'syncDateLinks',
  'relative-days': 'syncRelativeDays',
  'color-swatch': 'syncColorSwatch',
  'missing-links': 'syncMissingLinks',
  'code-collapse': 'syncCodeCollapse',
  'inline-code-copy': 'syncInlineCodeCopy',
  'pdf-reader': 'syncPdfReader',
  'external-images': 'syncExternalImages',
  'paste-source': 'syncPasteSource',
  persist: 'syncPersist',
  notices: 'syncNotices',
  'too-narrow': 'syncTooNarrow',
};

describe('設定画面の節の登録表(#1382)', () => {
  it('名前は一意で、ファイルへ移した節は全部載っている', () => {
    const { renderer } = setup();
    const ids = renderer.registeredSections().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of MOVED) expect(ids).toContain(id);
    // 全 id を並びごと等値で pin(inline の削除・並べ替え・改名も鳴る)
    expect(ids).toEqual(ALL_IDS);
  });

  it('🔴 inline の節は、id ごとに対応する syncX が render() で呼ばれる(取り違え・空の sync・削除が鳴る)', () => {
    const { renderer } = setup();
    const inlineIds = renderer
      .registeredSections()
      .filter((s) => s.group === 'inline' || s.id === 'external-images')
      .map((s) => s.id);
    // 表が inline の全 id を覆う(行の無い inline が増えたら落ちる)+ 表に余分な行が無い
    expect([...Object.keys(INLINE_SYNC)].sort()).toEqual([...inlineIds].sort());
    const spies = Object.entries(INLINE_SYNC).map(([id, method]) => {
      const spy = vi.spyOn(renderer as unknown as Record<string, () => void>, method);
      return { id, method, spy };
    });
    renderer.render(initialState);
    renderer.render(initialState);
    for (const { id, method, spy } of spies) {
      // 組み立て直後 + 以後の render で 1 回ずつ。他の節の sync が呼ばれて満たされない
      expect(spy, `${id} → ${method}`).toHaveBeenCalledTimes(2);
    }
  });

  it('🔴 位置引数で渡した台帳が、実際に画面へ届いている(引数がずれたら落ちる)', () => {
    const { region, renderer, sameOrigin, extension, agent } = setup();
    const KA = 'ast-' + 'a'.repeat(64);
    const KB = 'ast-' + 'b'.repeat(64);
    sameOrigin.grant(KA);
    extension.grant(KB);
    agent.setAlways('write');
    renderer.render(initialState);
    const keys = (field: string): (string | null)[] =>
      [...region.querySelectorAll(`[data-pkc-field="${field}"] li`)].map((li) =>
        li.getAttribute('data-pkc-asset-key'),
      );
    expect(keys('same-origin-list')).toEqual([KA]);
    expect(keys('extension-list')).toEqual([KB]);
    expect(
      [...region.querySelectorAll('[data-pkc-field="agent-list"] li')].map((li) =>
        li.getAttribute('data-pkc-agent-scope'),
      ),
    ).toEqual(['write']);
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
