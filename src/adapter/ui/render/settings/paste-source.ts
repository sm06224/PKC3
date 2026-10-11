/**
 * 🔴 **貼付でどの形を読むか**(user 指示 2026-08-25)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * 🔑 **診断のフラグ(`paste.inspect`)と対**である ── そちらを点けると
 * 「何が届いて、どれを使ったか」が画面に出るので、**どれに切り替えればよいかが分かる**。
 * ⚠ 「貼り付け」は独立した節(#1017 段③-1 以前からの区画名 `settings-paste-source`)。
 *   読み取る形の dt はその中に在る。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { PASTE_SOURCES } from '@features/markdown/paste-source';
import type { PasteSourceStore } from '../paste-source';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createPasteSourceSection(
  region: HTMLElement,
  store: PasteSourceStore,
): SettingsSection {
  return {
    id: 'paste-source',
    group: 'paste',
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-paste-source');
      const h = document.createElement('h4');
      h.textContent = '貼り付け';
      wrap.append(h);

      const dl = document.createElement('dl');
      const dt = document.createElement('dt');
      dt.textContent = '読み取る形';
      const dd = document.createElement('dd');
      const select = document.createElement('select');
      select.setAttribute('data-pkc-action', 'set-paste-source');
      select.setAttribute('data-pkc-field', 'paste-source-select');
      select.setAttribute('aria-label', '貼り付けで読み取る形');
      for (const m of PASTE_SOURCES) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        opt.title = m.hint;
        select.append(opt);
      }
      select.title =
        'コピーすると同じ内容が複数の形でクリップボードに入り、正確さは相手のアプリで違います。' +
        'フラグ「貼り付けたとき、何が届いてどれを使ったかを画面に出す」で中身の種類が見えます。';
      dd.append(select);
      /**
       * 🔴 **この説明だけ 2 行まで許す**(#1038 段 J の着地前、全量の unit が捕まえた)。
       * ⚠ 1 稿目はフラグへの案内を `title`(乗せたときの字)へ移したので、**画面の字から消えた**
       *   ── この設定とフラグは 2 つで 1 組である(`tests/adapter/settings-paste-source.test.ts`)。
       *   フラグの名前は**画面の字どおり**に書く(縮めると、user がフラグの一覧で探せない)。
       */
      dd.append(buildSettingsNote('貼り付けで読み取る形です(崩れるときは切り替えてください)。フラグの「貼り付けたとき、何が届いてどれを使ったかを画面に出す」を入れると、何が届いたかが見えます。'));
      dl.append(dt, dd);
      wrap.append(dl);
      return wrap;
    },
    /**
     * ⚠ 画面の値を**いまの設定に合わせる**(器は 1 度しか組まない ── 映さないと
     * 古い値が見える。CLAUDE.md §7「設定画面の値の同期」)。
     */
    sync(): void {
      const select = region.querySelector<HTMLSelectElement>(
        '[data-pkc-field="paste-source-select"]',
      );
      const cur = store.get();
      if (select && select.value !== cur) select.value = cur;
    },
  };
}
