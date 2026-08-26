/** @vitest-environment happy-dom */
/**
 * 🔴 **設定の持ち出し ── 画面との繋がり**(#414)。
 *
 * ⚠ **仕分けと文言**(何を運ぶか / 何が変わるか)は
 *   `tests/features/settings-file.test.ts`。ここが見るのは**繋がり**である ──
 *   選んだら下見が出るか / 押したら本当に書かれるか / 押せない場面で押せないか。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { SETTINGS_FILE_KIND } from '../../src/features/settings/settings-file';

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function setup() {
  document.body.innerHTML = '';
  localStorage.clear();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  /**
   * ⚠ **設定の面は `buildShell` に含まれない** ── 自分で組む
   *   (`announce.test.ts` と同じ作法)。⚠ `root` の中に置く ── binder は
   *   `root` への委譲で押し口を拾うので、外に置くと**押しても何も起きない**。
   */
  const settingsHost = document.createElement('div');
  root.append(settingsHost);
  new SettingsRenderer(settingsHost).render(initialState);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d);
  return { root, d, sent };
}

const apply = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>('[data-pkc-field="settings-file-apply"]')!;
const summary = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="settings-file-summary"]')!;
const changes = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-field="settings-file-changes"]')!;

/** file を選んだことにする(`change` を撃つ)。 */
async function choose(root: HTMLElement, text: string): Promise<void> {
  const input = root.querySelector<HTMLInputElement>('[data-pkc-field="settings-file-input"]')!;
  const file = new File([text], 'settings.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
}

const fileText = (entries: { key: string; value: string }[]): string =>
  JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, entries });

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('設定の持ち出しの配線(#414)', () => {
  it('🔴 選ぶ前は押せない(dead click を作らない)', () => {
    const { root } = setup();
    expect(apply(root).disabled, '選ぶ前から押せる').toBe(true);
    expect(summary(root).hidden, '何も選んでいないのに文が出ている').toBe(true);
  });

  /** 🔴 **選んだ時点では当てない** ── 下見を出すだけ。 */
  it('🔴 選ぶと下見が出るが、まだ当たっていない', async () => {
    const { root } = setup();
    localStorage.setItem('pkc3.theme', 'light');
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'dark' }]));
    expect(summary(root).hidden, '下見が出ていない').toBe(false);
    expect(changes(root).textContent, '何が変わるかが出ていない').toContain('見た目');
    expect(apply(root).disabled, '変わるのに押せない').toBe(false);
    // 🔴 **まだ書かれていない**(押す前に当たっていたら取り消せない)
    expect(localStorage.getItem('pkc3.theme'), '選んだだけで当たった').toBe('light');
  });

  it('🔴 押すと書かれ、下見は畳まれる', async () => {
    const { root, sent } = setup();
    localStorage.setItem('pkc3.theme', 'light');
    await choose(root, fileText([{ key: 'pkc3.theme', value: 'dark' }]));
    sent.length = 0;
    apply(root).click();
    await tick();
    expect(localStorage.getItem('pkc3.theme'), '押しても書かれていない').toBe('dark');
    expect(apply(root).disabled, '押した後も押せるまま').toBe(true);
    expect(summary(root).hidden, '下見が残っている').toBe(true);
    /**
     * 🔴 **読み直しが要ることを言う** ── 鍵の割当も紙面も起動時に読むので、
     *   当てただけでは画面が変わらない。⚠ 言わないと「効かなかった」と読まれる。
     */
    const said = sent.find((a) => a.type === 'OP_FAILED');
    expect(said, '何も言わずに終えた').toBeDefined();
    const msg = said?.type === 'OP_FAILED' ? said.error : '';
    expect(msg, '読み直しが要ることを言っていない').toContain('読み直');
  });

  /** 🔴 **運ばない鍵は、file に書いてあっても書き込まない**(許可・フラグ)。 */
  it('🔴 運ばない鍵は、file に在っても書き込まない', async () => {
    const { root } = setup();
    await choose(
      root,
      fileText([
        { key: 'pkc3.theme', value: 'dark' },
        { key: 'pkc3.same-origin-grants', value: '["https://evil.example"]' },
        { key: 'pkc3.flags', value: '{"x":true}' },
      ]),
    );
    apply(root).click();
    await tick();
    expect(localStorage.getItem('pkc3.theme')).toBe('dark');
    expect(localStorage.getItem('pkc3.same-origin-grants'), '許可を書き込んだ').toBeNull();
    expect(localStorage.getItem('pkc3.flags'), 'フラグを書き込んだ').toBeNull();
    // ⚠ 黙って捨てない ── 件数を言う
    expect(summary(root).textContent ?? '', '運ばなかった分を言っていない').not.toBe('');
  });

  it('🔴 別の形の file は、そう言って押せないままにする', async () => {
    const { root } = setup();
    await choose(root, JSON.stringify({ kind: 'pkc3-backup' }));
    expect(apply(root).disabled, '読めない file で押せる').toBe(true);
    expect(summary(root).textContent, '理由が出ていない').toContain('設定ファイルではありません');
  });

  /** 🔴 **持ち出す物が無いのに空の file を落とさない**(押した user は「入った」と読む)。 */
  it('🔴 設定が 1 つも無ければ、落とさずに理由を出す', async () => {
    const { root, sent } = setup();
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      clicks.push(this.getAttribute('download') ?? '');
    });
    sent.length = 0;
    root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    expect(clicks, '空の file を落とした').toEqual([]);
    expect(sent.some((a) => a.type === 'OP_FAILED'), '無言で終えた').toBe(true);
    vi.restoreAllMocks();
  });

  it('🔴 設定が在れば、日付つきの名前で落ちる', async () => {
    const { root } = setup();
    localStorage.setItem('pkc3.theme', 'dark');
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      clicks.push(this.getAttribute('download') ?? '');
    });
    root.querySelector<HTMLElement>('[data-pkc-action="export-settings"]')!.click();
    await tick();
    expect(clicks, '落ちていない').toHaveLength(1);
    expect(clicks[0], '名前に日付が入っていない').toMatch(/^PKC3-settings-\d{4}-\d{2}-\d{2}\.json$/);
    vi.restoreAllMocks();
  });
});
