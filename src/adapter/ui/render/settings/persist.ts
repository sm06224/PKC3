/**
 * 🔴 **保存が「消えない扱い」か**(#347、user 裁定 2026-08-23
 * 「**気になるから見るだけで**」)。「保存領域」の h4「PKC3 のデータ」の中身。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import type { AppState } from '@adapter/state/app-state';
import type { PersistState } from '@adapter/platform/storage-persist';
import type { SettingsSection } from './section';

/**
 * 🔴 **保存の状態を、user の言葉で書く**(#347、user 指示 2026-08-21
 * 「画面で何が起きるかで書く」)。
 *
 * 🔑 **`denied` / `unsupported` は「次の手」まで書く** ── 「消えることがあります」
 * だけだと、user は不安になるだけで**何もできない**。効く手は
 * 「**ホーム画面(デスクトップ)に追加する**」である(入れると多くのブラウザが
 * 自動で消さない扱いにする)。
 * ⚠ `unknown` を「断られました」と書かない ── **まだ頼んでいない**のであって、
 * 断られたのではない(起動直後は必ずここを通る)。
 */
const PERSIST_TEXT: Record<PersistState, string> = {
  persisted: 'このブラウザは、PKC3 のデータを消さない扱いにしています。',
  denied:
    '空き容量が足りなくなると、このブラウザがデータを消すことがあります。' +
    'ホーム画面(デスクトップ)に追加すると、消さない扱いになることがあります。' +
    'バックアップは左下の「バックアップ」から取れます。',
  unsupported:
    'このブラウザは、消さない扱いに対応していません。' +
    '空き容量が足りなくなると、データが消えることがあります。' +
    'バックアップを定期的に取ってください(左下の「バックアップ」から取れます)。',
  unknown: 'まだ確かめていません。最初に何か保存したときに確かめます。',
};

export function createPersistSection(region: HTMLElement): SettingsSection {
  return {
    id: 'persist',
    group: 'persist',
    /**
     * ⚠ **押せるものは置かない。** ここは**知らせるだけ**である ── 帯にもダイアログにも
     * しないのが裁定で、操作の失敗ではないので user の手を止めない。
     * 🔑 だから `dd` に入るのは説明文 1 つだけ(選択欄もチェックも無い)。
     *
     * 🔴 **2026-09-21(#1017 段③-1)に「表示」から「保存領域」の h4「このアプリの
     *   データ」へ移した**(`ui-total-design-2026-09.md` §3.2)。
     */
    build(): Node[] {
      const st = document.createElement('dt');
      st.textContent = 'PKC3 のデータ';
      const sd = document.createElement('dd');
      const snote = document.createElement('p');
      snote.setAttribute('data-pkc-field', 'settings-note');
      snote.setAttribute('data-pkc-field-persist', 'persist-state');
      sd.append(snote);
      return [st, sd];
    },
    /**
     * ⚠ 保存の状態を映す(#347)。🔴 **器は 1 度しか組まない**ので、映さないと
     * **起動直後の「まだ確かめていません」で凍る** ── 最初の保存で分かった後も
     * 画面だけ古いままになる(この repo が何度も踏んでいる形)。
     */
    sync(state: AppState): void {
      const el = region.querySelector<HTMLElement>('[data-pkc-field-persist="persist-state"]');
      if (!el) return;
      const text = PERSIST_TEXT[state.persistState];
      if (el.textContent !== text) el.textContent = text;
    },
  };
}
