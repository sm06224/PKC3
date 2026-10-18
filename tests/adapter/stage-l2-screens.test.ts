/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 L2 の画面の直し(依頼 80 / 84 / 103 / 358 / 92-3)。
 *
 * 守るもの:
 *   ① フラグの各行は、日本語の説明が先に(大きく)、英語の名前はその下に小さく添えられる(依頼 92-3 A)
 *   ② ヘルプの「使っているオープンソース」は、初めは閉じた 1 つの欄(依頼 103 B / 358 B)
 *   ③ PKC3 入り HTML の中では、「PKC3 入り HTML で書き出す」は押せない見た目で、理由がいつも書いてある(依頼 84-4 B)
 *   ④ 開発版のときだけ、窓の題名に「(開発版)」が付く(依頼 84-3 C)
 * 守っていないもの:折りたたみの開閉の実ブラウザでの見え方 / スマホ幅で目次まで届く距離(smoke)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlagsRenderer } from '../../src/adapter/ui/render/flags';
import { FlagStore } from '../../src/adapter/platform/flag-store';
import { registeredFlags } from '../../src/features/flags';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { ossNoticesLabel } from '../../src/features/oss-notices/oss-notices';
import OSS_NOTICES from 'virtual:pkc-oss-notices';
import { initialState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { INSIDE_BUNDLE_REFUSAL } from '../../src/adapter/ui/actions/export-portable';
import { COLLECTION_PANE_COMMANDS } from '../../src/adapter/ui/render/commands';
import { windowTitleBase, windowTitleFor } from '../../src/adapter/platform/deep-link';

describe('フラグの行は、日本語の説明が先(依頼 92-3 A)', () => {
  it('🔴 見出しの行(チェック欄の字)は日本語の説明で、英語の名前は下に小さく添えられる', () => {
    localStorage.clear();
    const region = document.createElement('div');
    new FlagsRenderer(region, new FlagStore('')).render();
    const flags = registeredFlags();
    expect(flags.length, '前提:フラグが 1 つも無い').toBeGreaterThan(0);
    for (const f of flags) {
      const input = region.querySelector(`[data-pkc-flag="${f.name}"]`) as HTMLInputElement;
      const label = input.closest('label')!;
      expect(label.textContent, `${f.name}: 大きい字が日本語の説明でない`).toContain(f.summary);
      expect(label.textContent, `${f.name}: 英語の名前が大きい字に残っている`).not.toContain(f.name);
      // 英語の名前は消さず、同じ行の下に(アドレスに ?pkc-flag=名前 と書くときに使うので)
      const dd = input.closest('dt')!.nextElementSibling!;
      const name = dd.querySelector('[data-pkc-field="flag-name"]');
      expect(name?.textContent, `${f.name}: 名前の行が無い`).toContain(f.name);
      expect(name?.className).toContain('settings-note');
    }
  });
});

describe('ヘルプの「使っているオープンソース」は閉じた 1 つの欄(依頼 103 B / 358 B)', () => {
  it('🔴 件数つきの見出し 1 つで、初めは閉じている。中の一覧は欄の中', () => {
    const region = document.createElement('div');
    new HelpRenderer(region).render();
    const oss = region.querySelector('[data-pkc-region="help-oss"]') as HTMLDetailsElement;
    expect(oss.tagName).toBe('DETAILS');
    expect(oss.open, '初めから開いていて、目次まで遠い').toBe(false);
    expect(oss.querySelector(':scope > summary')?.textContent).toBe(ossNoticesLabel(OSS_NOTICES));
    // 一覧(全文の欄つき)は畳んだ欄の中にあり、外には出ていない
    expect(oss.querySelectorAll('[data-pkc-oss]').length).toBe(OSS_NOTICES.length);
    expect(region.querySelectorAll('[data-pkc-oss]').length).toBe(OSS_NOTICES.length);
    // 版・保存先・開発者・ソースは畳まず上に残る(困ったときにすぐ見る事実)
    expect(region.querySelector('[data-pkc-field="help-version"]')).not.toBeNull();
    expect(oss.contains(region.querySelector('[data-pkc-field="help-version"]'))).toBe(false);
  });
});

describe('PKC3 入り HTML の中では書き出しを押せない見た目にして、理由を書く(依頼 84-4 B)', () => {
  let tag: HTMLScriptElement | null = null;
  beforeEach(() => {
    document.body.textContent = '';
  });
  afterEach(() => {
    tag?.remove();
    tag = null;
  });

  function render(): { btn: HTMLButtonElement; note: Element } {
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    inspector.render(initialState);
    const btn = root.querySelector('[data-pkc-action="export-portable"]') as HTMLButtonElement;
    return { btn, note: root.querySelector('[data-pkc-field="export-portable-note"]')! };
  }

  it('🔴 PKC3 入り HTML の中(目印が在る)では、ボタンは押せず、理由が見える字で隣にある', () => {
    tag = document.createElement('script');
    tag.setAttribute('type', 'application/json');
    tag.setAttribute('data-pkc-bundle', '');
    tag.textContent = JSON.stringify({ id: 'bundle-test-0001', exportedAt: 1 });
    document.head.append(tag);
    const { btn, note } = render();
    expect(btn.disabled, '押せるまま(押すと断られるだけ)').toBe(true);
    expect(note.textContent, '理由がマウスを載せないと読めない').toBe(INSIDE_BUNDLE_REFUSAL);
    expect(btn.title).toBe(INSIDE_BUNDLE_REFUSAL);
    expect(note.textContent).toContain('ブラウザで開いた PKC3 から書き出してください');
  });

  it('対照群:ふつうの PKC3 では押せて、説明は元のまま', () => {
    const { btn, note } = render();
    expect(btn.disabled).toBe(false);
    const original = COLLECTION_PANE_COMMANDS.find((c) => c.action === 'export-portable')!.title;
    expect(note.textContent).toBe(original);
    expect(note.textContent).not.toContain('ここからは');
  });
});

describe('開発版のときだけ、窓の題名に「(開発版)」(依頼 84-3 C)', () => {
  it('🔴 dev だけ付く。公開版・検証版は何も足さない', () => {
    expect(windowTitleBase('PKC3', 'dev')).toBe('PKC3(開発版)');
    expect(windowTitleBase('PKC3', 'product')).toBe('PKC3');
    expect(windowTitleBase('PKC3', 'stage')).toBe('PKC3');
  });

  it('付けた根は、ノートの窓の題名にもそのまま乗る(「別のウィンドウで開いています」の案内と同じ字を引く)', () => {
    expect(windowTitleFor(windowTitleBase('PKC3', 'dev'), '買い物')).toBe('買い物 — PKC3(開発版)');
  });
});
