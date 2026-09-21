/** @vitest-environment happy-dom */
/**
 * 🔴 **「システム」の h3 を型ごとの 6 節へ組み替えた検算**(#1017 段③-1)。
 *
 * `docs/development/ui-total-design-2026-09.md` §3.2 の裁定 ── system 領域
 * (user 向け)を **メッセージ / 設定 / 許可 / 記録 / 保存領域 / お知らせ** の
 * 6 つの型へ分けた。ここが見るのは**型どおりに置かれているか**である。
 *
 * ⚠ **手で数え上げた表を pin するとすぐ腐る**(CLAUDE.md §7 の教訓)── だから
 * 判定は `PORTABLE_KEYS` / `SKIPPED_KEYS`(features/settings/settings-file.ts、
 * 実際に運ぶ / 運ばない鍵の正本)から引く。これらは**別の目的**(設定ファイルの
 * 持ち出し)で既に維持されている表なので、ここが腐っても向こうが先に落ちる。
 */
import { describe, expect, it } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { initialState } from '@adapter/state/app-state';
import { PORTABLE_KEYS, SKIPPED_KEYS } from '@features/settings/settings-file';
import { COLLECTION_PANE_COMMANDS } from '@adapter/ui/render/commands';

function render(): HTMLElement {
  const host = document.createElement('div');
  new SettingsRenderer(host).render(initialState);
  return host;
}

/**
 * 🔑 **鍵 → 実際に描く control の対応**(手で持つしかない ── DOM 側は選択の値を
 * 読み書きするだけで、どの `pkc3.*` 鍵を裏に持っているかを属性で言わない)。
 * ⚠ **完全性は下の空振り防止で見る** ── ここに載っていない鍵は「未実装 / 面を
 * 持たない」として扱う(`pkc3.panes` など、押せる control ではないもの)。
 */
const PORTABLE_FIELD_OF: Record<string, string> = {
  'pkc3.theme': 'theme-select',
  'pkc3.editor-mode': 'editor-mode-select',
  'pkc3.open-in-edit': 'open-in-edit',
  'pkc3.page-format': 'page-format-select',
  'pkc3.prose-align': 'prose-align-select',
  'pkc3.text-scale': 'text-scale-select',
  'pkc3.read-columns': 'read-columns-select',
  'pkc3.column-rule': 'column-rule-select',
  'pkc3.tag-badge': 'tag-badge-select',
  'pkc3.paste-source': 'paste-source-select',
  'pkc3.alarm': 'alarm-enabled',
  'pkc3.voice-boost': 'voice-boost',
  'pkc3.open-place': 'open-place-select',
  'pkc3.app-open-target': 'app-open-target-select',
  'pkc3.phone-links': 'phone-links',
  /**
   * 🔴 **唯一の例外**(裁定 2026-09-20)── メッセージの保管件数は
   * 「メッセージ」節の値で、system 領域の「設定」ではない。
   */
  'pkc3.messages.cap': 'messages-cap-select',
};

const SKIPPED_FIELD_OF: Record<string, string> = {
  'pkc3.external-images': 'external-images-select',
  'pkc3.too-narrow-ok': 'too-narrow-enabled',
};

describe('「システム」の 6 節(#1017 段③-1)', () => {
  it('⚠ 前提: 6 節の h3 が、この順で並んでいる(空振り防止)', () => {
    const host = render();
    const h3s = [...host.querySelectorAll('h3')].map((h) => h.textContent ?? '');
    expect(h3s).toEqual(['メッセージ', '設定', '許可', '記録', '保存領域', 'お知らせ']);
  });

  it('🔴 ① PORTABLE_KEYS の鍵を読む control は「設定」の h3 の下にしか出ない(例外: pkc3.messages.cap)', () => {
    const host = render();
    const configSection = host.querySelector('[data-pkc-region="settings-config"]');
    expect(configSection, '「設定」の区画が無い').not.toBeNull();
    const messagesSection = host.querySelector('[data-pkc-region="settings-messages"]');
    expect(messagesSection, '「メッセージ」の区画が無い').not.toBeNull();

    let checked = 0;
    for (const { key, label } of PORTABLE_KEYS) {
      const field = PORTABLE_FIELD_OF[key];
      if (field === undefined) continue; // 押せる control を持たない鍵(列の幅、等)
      const el = host.querySelector(`[data-pkc-field="${field}"]`);
      expect(el, `${key}(${label})の control が描かれていない`).not.toBeNull();
      checked += 1;
      if (key === 'pkc3.messages.cap') {
        expect(
          messagesSection!.contains(el),
          `${key} は「メッセージ」節に在るはずだが無い`,
        ).toBe(true);
        expect(
          configSection!.contains(el),
          `${key} が「設定」節にも居る(例外のはずが 2 か所に居る)`,
        ).toBe(false);
      } else {
        expect(
          configSection!.contains(el),
          `${key}(${label})が「設定」の h3 の下に無い`,
        ).toBe(true);
      }
    }
    // ⚠ 空振り防止 ── 対応表を引けていなければ、この検査は何も見ていない
    expect(checked, 'PORTABLE_KEYS を 1 つも突き合わせられていない').toBeGreaterThan(10);
  });

  it('🔴 ② 「許可」「記録」の h3 の下の control が読む鍵は、全部 SKIPPED_KEYS に在る', () => {
    const host = render();
    const skippedKeys = new Set(SKIPPED_KEYS.map((k) => k.key));
    const permSection = host.querySelector('[data-pkc-region="settings-permissions"]');
    const historySection = host.querySelector('[data-pkc-region="settings-history"]');
    expect(permSection, '「許可」の区画が無い').not.toBeNull();
    expect(historySection, '「記録」の区画が無い').not.toBeNull();

    let checked = 0;
    for (const [key, field] of Object.entries(SKIPPED_FIELD_OF)) {
      expect(skippedKeys.has(key), `${key} が SKIPPED_KEYS の対応表から漏れている`).toBe(true);
      const el = host.querySelector(`[data-pkc-field="${field}"]`);
      expect(el, `${key} の control が描かれていない`).not.toBeNull();
      const inPerm = permSection!.contains(el);
      const inHistory = historySection!.contains(el);
      expect(inPerm || inHistory, `${key} が「許可」にも「記録」にも無い`).toBe(true);
      checked += 1;
    }
    expect(checked, '許可/記録の対応表を 1 つも突き合わせられていない').toBeGreaterThan(0);
  });

  it('🔴 ③ COLLECTION_PANE_COMMANDS の action は「システム」の DOM に 1 つも居ない', () => {
    const host = render();
    // ⚠ 空振り防止 ── コレクションの型の操作を 1 件も読めていなければ、この検査は何も見ていない
    expect(COLLECTION_PANE_COMMANDS.length, 'コレクションの型の操作を読めていない').toBeGreaterThan(0);
    const leaked = COLLECTION_PANE_COMMANDS.filter(
      (c) => host.querySelector(`[data-pkc-action="${c.action}"]`) !== null,
    ).map((c) => c.action);
    expect(leaked, 'コレクション面の操作が「システム」にも描かれている').toEqual([]);
  });
});
