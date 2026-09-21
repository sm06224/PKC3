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
import { NOTICES, NOTICE_SHOW_MAX, noticeDate, type Notice } from '@features/notice/notice-log';

function render(): HTMLElement {
  const host = document.createElement('div');
  new SettingsRenderer(host).render(initialState);
  return host;
}

/**
 * ⚠ **「これまでのお知らせ」の一覧を注入して描く**(#1017 段③-2)。
 * `noticeList` は `SettingsRenderer` の**末尾**の位置引数(この file の
 * `constructor` docstring 群が戒めているとおり、途中に入れると他の test を壊す)。
 */
function renderWithNotices(list: readonly Notice[]): HTMLElement {
  const host = document.createElement('div');
  new SettingsRenderer(
    host,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    list,
  ).render(initialState);
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

/**
 * 🔴 **「これまでのお知らせ」の一覧(#1017 段③-2)。**
 *
 * 裁定 2026-09-20 6 巡目「お知らせの入口はシステムへ移す。ヘルプにもリンク
 * 1 行を残す」── ここが見るのは**移した先**である(移す前に `help-pane.test.ts`
 * が守っていた 3 本 + 1 本をそのまま持ってきた。属性名は変えていない)。
 */
describe('「これまでのお知らせ」の一覧(#1017 段③-2)', () => {
  it('🔴 一覧が「お知らせ」の h3 の中に在る(ヘルプから移した)', () => {
    const host = render();
    const section = host.querySelector('[data-pkc-region="settings-notices-section"]');
    expect(section, '「お知らせ」の区画が無い').not.toBeNull();
    const list = section!.querySelector('[data-pkc-region="help-notices"]');
    expect(list, '一覧が「お知らせ」の中に無い').not.toBeNull();
    const h4s = [...section!.querySelectorAll('h4')].map((h) => h.textContent);
    expect(h4s, 'h4「これまでのお知らせ」がトグルの下に無い').toEqual([
      'お知らせ',
      'これまでのお知らせ',
    ]);
  });

  it('🔴 お知らせが新しい順に、上限まで出る', () => {
    const host = renderWithNotices(NOTICES);
    const ids = [...host.querySelectorAll('[data-pkc-help-notice]')].map(
      (e) => e.getAttribute('data-pkc-help-notice') ?? '',
    );
    expect(ids.length, 'お知らせが 1 件も出ていない(fixture の空振り)').toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(NOTICE_SHOW_MAX);
    /**
     * 🔴 **「新しい順」は日付の順である**(2026-08-29 の動線レビュー 欠陥 5。
     *   `help-pane.test.ts` から移した ── 中身は変えていない)。
     */
    const dates = ids.map(noticeDate);
    expect([...dates].sort().reverse(), '日付が新しい順に並んでいない').toEqual(dates);
    const order = new Map(NOTICES.map((n, i) => [n.id, i]));
    const ranks = ids.map((id) => order.get(id) ?? -1);
    expect(ranks, '登記表に無いお知らせが出ている(空振り)').not.toContain(-1);
    expect([...ranks].sort((a, b) => a - b), '同じ日が登記表の順で出ていない').toEqual(ranks);
    // 日付は id から引く(field を二重に持たない)
    const first = host.querySelector('[data-pkc-field="notice-title"]')?.textContent ?? '';
    expect(first, '日付が出ていない').toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  /**
   * 🔴 **切るのは `recentNotices` だけ**(P11 の決まり)。
   * ⚠ 1 巡目は登記表が **1 件**だったので、上限も並びも「測っていない次元」だった
   *   ── 丸ごと出す変異が素通りした(変異試験で判明)。登記表を注入して試す。
   */
  it('🔴 登記表が上限より多くても、出るのは上限まで(新しい順)', () => {
    const many = Array.from({ length: NOTICE_SHOW_MAX + 4 }, (_, i) => ({
      id: `2026-02-${String(i + 1).padStart(2, '0')}-x`,
      title: `t${i}`,
      items: ['本文'],
    }));
    expect(many.length, 'fixture が上限を超えていない(空振り)').toBeGreaterThan(NOTICE_SHOW_MAX);
    const host = renderWithNotices(many);
    const ids = [...host.querySelectorAll('[data-pkc-help-notice]')].map(
      (e) => e.getAttribute('data-pkc-help-notice') ?? '',
    );
    expect(ids, '上限まで切っていない').toHaveLength(NOTICE_SHOW_MAX);
    expect(ids[0], '新しい順になっていない').toBe(`2026-02-${NOTICE_SHOW_MAX + 4}-x`);
  });

  /**
   * 🔴 **素のテキストで出す**(帯とは**別の描画経路**である)。
   * ⚠ CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」──
   *   帯だけ見ていたので、こちら側を `innerHTML` にする変異が素通りした。
   */
  it('🔴 お知らせが素のテキストで出る(HTML として描かない)', () => {
    const host = renderWithNotices([
      { id: '2026-08-08-x', title: 't', items: ['<b>太字</b>と <img src="x"> を書いた'] },
    ]);
    const li = host.querySelector('[data-pkc-help-notice] li')!;
    expect(li.children.length, 'HTML として描いている').toBe(0);
    expect(li.textContent, '原文が消えている').toContain('<b>太字</b>');
  });

  /**
   * 🔴 **これまでのお知らせは題名だけ並ぶ**(#719 案 A)。
   * ⚠ 直す前は 11 件の中身が全部開いたまま**面の先頭**に居た。
   */
  it('🔴 お知らせは畳まれて出て、押すと中身が開く', () => {
    const host = renderWithNotices(NOTICES);
    const items = [...host.querySelectorAll<HTMLDetailsElement>('[data-pkc-help-notice]')];
    expect(items.length, 'お知らせが 1 件も出ていない(空振り)').toBeGreaterThan(0);
    for (const item of items) {
      expect(item.tagName, 'お知らせが畳める形になっていない').toBe('DETAILS');
      expect(item.open, '最初から開いている(題名だけ並べる裁定に反する)').toBe(false);
      expect(
        item.querySelector('[data-pkc-field="notice-title"]')?.tagName,
        '題名が summary になっていない(押しても開かない)',
      ).toBe('SUMMARY');
      // ⚠ 中身は**在る**(畳んだのであって、落としたのではない)
      expect(item.querySelectorAll('li').length, 'お知らせの中身が落ちている').toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **「お知らせを出すか」の断りが、この下の一覧を指す(ヘルプではない)**
   *   (#1017 段③-2。`tests/adapter/announce.test.ts` の同種の突合と対)。
   */
  it('🔴 「出さなくても読める」の断りが、この下の一覧を指す(ヘルプではない)', () => {
    const host = render();
    const section = host.querySelector('[data-pkc-region="settings-notices-section"]')!;
    const notes = [...section.querySelectorAll('[data-pkc-field="settings-note"]')].map(
      (n) => n.textContent ?? '',
    );
    expect(
      notes.some((t) => t.includes('これまでのお知らせ')),
      '一覧の在り処が書かれていない',
    ).toBe(true);
    expect(notes.some((t) => t.includes('ヘルプ')), 'まだヘルプを指している').toBe(false);
  });
});
