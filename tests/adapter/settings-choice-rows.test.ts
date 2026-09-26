/** @vitest-environment happy-dom */
/**
 * 🔴 **「システム」の設定を、選択肢 4 つ以下ならボタンの列で描く**
 * (#1038 段J、C18 / Q7 の裁定 A)。
 *
 * `docs/development/touch-and-unity-design-2026-09.md` §3(C18)の裁定:
 * 「システム」の中で選択肢が 4 つ以下の項目がプルダウンではなく「選ばれている物が
 * 濃く表示されるボタンの列」になる(一覧の種類で絞るボタンと同じ形)。
 * 配色 / ページ設定 / 貼り付け元 はプルダウンのまま。**選択肢は 1 つも変わらない**。
 *
 * 🔴 **3 項目は実測でプルダウンへ戻した**(§9 の覆る条件)。
 *   ① **本文のタグの見せ方**:`TAB_SWEEP`(`tests/smoke/layout.smoke.spec.ts`)の
 *   全幅で実測すると **720 / 860 / 901 / 950 / 1101px で 2 行に折れた**
 *   (選択肢の字が長い ──「枠だけのバッジ(下地なし・細い枠)」等)。
 *   ② **編集の仕方**:`TAB_SWEEP` に加えスマホ幅(360 / 390px)まで実測すると
 *   `TAB_SWEEP` の 11 幅は 1 行のままだが、**390px と 360px の両方で 2 行に折れた**
 *   (「1 画面で編集(ライブ)」「2 ペイン(原文とプレビュー)」の字が長い)。
 *   ③ **アプリの開き方**:同じ実測で **360px でだけ 2 行に折れた**(390px と
 *   `TAB_SWEEP` は 1 行)。
 *   doc §9「切替ボタンの列にして…行が 2 段以上に折れる → その項目だけ
 *   プルダウンへ戻す」のとおり、この 3 項目だけプルダウンへ戻した
 *   ── 結果、ボタンの列は **7 項目**(設定 5 / 許可 1 / メッセージ 1)。
 *
 * ここが見るのは 3 つ:
 * ① 選択肢 4 つ以下の項目は、いま `<select>` で描かれていない(一般則。ただし
 *   実測で折れた 3 項目は例外として明示する)
 * ② その 7 項目の field は、ちょうどこの一覧である(数え落とし・数え過ぎを防ぐ)
 * ③ 各項目の選択肢(値・字)が、**その設定の唯一の正本(features 層の表)**と
 *   1 対 1 で一致する(docs-parity ── 「選択肢は 1 つも変わらない」の裏取り。
 *   プルダウンへ戻した 3 項目も含む)
 */
import { describe, expect, it } from 'vitest';
import { SettingsRenderer } from '@adapter/ui/render/settings';
import { initialState } from '@adapter/state/app-state';
import { choiceRowValues } from '../helpers/choice-row';
import { PROSE_ALIGNS } from '@features/prose-align';
import { TEXT_SCALES } from '@features/text-scale';
import { READ_COLUMN_CHOICES } from '@features/read-columns';
import { COLUMN_RULES } from '@features/column-rule';
import { TAG_BADGES } from '@features/tag-badge';
import { EDITOR_MODES } from '@features/editor-mode';
import { OPEN_PLACES } from '@features/open-place';
import { APP_OPEN_TARGETS } from '@features/launcher/open-target';
import { MESSAGE_CAP_OPTIONS } from '@features/message/message-log';
import { EXTERNAL_IMAGE_MODES } from '@features/markdown/external-images';

function render(): HTMLElement {
  const host = document.createElement('div');
  new SettingsRenderer(host).render(initialState);
  return host;
}

/**
 * 🔴 4 つ以下 → ボタンの列になった 7 項目。field 名 + 値を運ぶ属性名 + 正本の表。
 * ⚠ この一覧そのものが「7 項目」の主張なので、ここに足し忘れると③が空振りする
 * (下の空振り防止で検算する)。⚠ `tag-badge-select` / `editor-mode-select` /
 * `app-open-target-select` はここに**入れない**(実測で折れたためプルダウンへ
 * 戻した ── 下の `WRAPPED_TO_SELECT`)。
 */
const CHOICE_ROWS: { field: string; attr: string; source: readonly { id: string; label: string }[] }[] = [
  { field: 'prose-align-select', attr: 'data-pkc-prose-align-value', source: PROSE_ALIGNS },
  { field: 'text-scale-select', attr: 'data-pkc-text-scale-value', source: TEXT_SCALES },
  { field: 'read-columns-select', attr: 'data-pkc-read-columns-value', source: READ_COLUMN_CHOICES },
  { field: 'column-rule-select', attr: 'data-pkc-column-rule-value', source: COLUMN_RULES },
  { field: 'open-place-select', attr: 'data-pkc-open-place-value', source: OPEN_PLACES },
  {
    field: 'messages-cap-select',
    attr: 'data-pkc-message-cap-value',
    source: MESSAGE_CAP_OPTIONS.map((n) => ({ id: String(n), label: `${n} 件` })),
  },
  { field: 'external-images-select', attr: 'data-pkc-external-images-value', source: EXTERNAL_IMAGE_MODES },
];

/** > 4 のまま残るプルダウン 3 つ(配色 / ページ設定 / 貼り付け元)。 */
const REMAINING_SELECT_FIELDS = ['theme-select', 'page-format-select', 'paste-source-select'];

/**
 * 🔴 選択肢は 4 つ以下だが、実測で折れたのでプルダウンへ戻した 3 項目
 * (§9 の覆る条件)。一般則②の対象からは外し、③の一致検算だけ別に見る。
 */
const WRAPPED_TO_SELECT: { field: string; source: readonly { id: string; label: string }[] }[] = [
  { field: 'tag-badge-select', source: TAG_BADGES },
  { field: 'editor-mode-select', source: EDITOR_MODES },
  { field: 'app-open-target-select', source: APP_OPEN_TARGETS },
];

describe('「システム」の設定: 4 つ以下はボタンの列(#1038 段J、C18 / Q7)', () => {
  it('🔴 空振り防止: CHOICE_ROWS はちょうど 7 件(設定 5 / 許可 1 / メッセージ 1)', () => {
    expect(CHOICE_ROWS).toHaveLength(7);
  });

  it('🔴 空振り防止: WRAPPED_TO_SELECT はちょうど 3 件(§9 の覆る条件で戻した数)', () => {
    expect(WRAPPED_TO_SELECT).toHaveLength(3);
  });

  it('🔴 実測で折れた 3 項目だけがプルダウンに残っている(§9 の覆る条件)', () => {
    const host = render();
    for (const { field, source } of WRAPPED_TO_SELECT) {
      const el = host.querySelector<HTMLSelectElement>(`[data-pkc-field="${field}"]`);
      expect(el, `${field} が描かれていない`).not.toBeNull();
      expect(el!.tagName, `${field} が <select> ではない`).toBe('SELECT');
      const opts = [...el!.querySelectorAll<HTMLOptionElement>('option')];
      expect(opts.map((o) => o.value), `${field} の値がずれている`).toEqual(
        source.map((s) => s.id),
      );
      expect(opts.map((o) => o.textContent), `${field} の字がずれている`).toEqual(
        source.map((s) => s.label),
      );
    }
  });

  it('① その 7 項目は、選択肢 4 つ以下で、<select> で描かれていない', () => {
    const host = render();
    for (const { field, source } of CHOICE_ROWS) {
      expect(source.length, `${field} の選択肢が 4 つを超えている(前提が崩れている)`).toBeLessThanOrEqual(4);
      const el = host.querySelector(`[data-pkc-field="${field}"]`);
      expect(el, `${field} が描かれていない`).not.toBeNull();
      expect(el!.tagName, `${field} がまだ <select> のまま`).not.toBe('SELECT');
      // 押す口はボタン(role="group" の子)である
      expect(
        el!.querySelectorAll('button').length,
        `${field} にボタンが 1 つも無い`,
      ).toBeGreaterThan(0);
    }
  });

  it('② 4 つ以下でもプルダウンのままの 3 つ(配色 / ページ設定 / 貼り付け元)は選択肢が 4 つを超えている', () => {
    const host = render();
    for (const field of REMAINING_SELECT_FIELDS) {
      const el = host.querySelector<HTMLSelectElement>(`[data-pkc-field="${field}"]`);
      expect(el, `${field} が描かれていない`).not.toBeNull();
      expect(el!.tagName, `${field} が <select> ではない`).toBe('SELECT');
      expect(
        el!.querySelectorAll('option').length,
        `${field} の選択肢が 4 つ以下(一般則により select ではいけない)`,
      ).toBeGreaterThan(4);
    }
  });

  it('③ 各項目の選択肢が、正本の表と 1 対 1(値も字も。選択肢は 1 つも変わらない)', () => {
    const host = render();
    for (const { field, attr, source } of CHOICE_ROWS) {
      const got = choiceRowValues(host, field, attr);
      expect(got.map((c) => c.value), `${field} の値がずれている`).toEqual(source.map((s) => s.id));
      expect(got.map((c) => c.label), `${field} の字がずれている`).toEqual(source.map((s) => s.label));
    }
  });

  it('④ 押されているボタンは aria-pressed で読み上げにも出る(色だけに頼らない)', () => {
    const host = render();
    for (const { field } of CHOICE_ROWS) {
      const row = host.querySelector(`[data-pkc-field="${field}"]`)!;
      const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons.length, `${field} にボタンが無い`).toBeGreaterThan(0);
      for (const b of buttons) {
        expect(
          ['true', 'false'],
          `${field} のボタンに aria-pressed が無い`,
        ).toContain(b.getAttribute('aria-pressed'));
        // ⚠ ネイティブ <button> は既定でキーボード到達可能(tabindex を書く必要が無い)
        expect(b.tagName, `${field} の押し口が <button> ではない`).toBe('BUTTON');
        expect(b.getAttribute('type'), `${field} のボタンが type="button" ではない`).toBe('button');
      }
    }
  });
});
