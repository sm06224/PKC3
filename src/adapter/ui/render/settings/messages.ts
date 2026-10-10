/**
 * 🔴 **メッセージ**の節(設計 doc §7、段②a。裁定 2026-09-20)── 先頭(目次の直後)の h3。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { currentMessageCap } from '@adapter/platform/message-post';
import {
  MESSAGE_CAP_OPTIONS,
  SYSTEM_JOB_LID,
  SYSTEM_MESSAGE_LID,
} from '@features/message/message-log';
import type { AppState } from '@adapter/state/app-state';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createMessagesSection(region: HTMLElement): SettingsSection {
  /** メッセージの本文の字。⚠ 未読の数だけ差し替える(器は 1 度だけ組む)。 */
  let messagesUnreadText: HTMLElement | null = null;

  return {
    id: 'messages',
    group: 'top',
    /**
     * 🔴 **メッセージ**(設計 doc §7、段②a。裁定 2026-09-20)。
     *
     * ⚠ **先頭(目次の直後)に置く**(user 裁定「システムのノートで GO」)。
     * ⚠ **新しい面を作らない**(§7「新しい画面も道具も作らない」)── 開くのは
     *   普通のノートと同じ中央の面、書き出すのも普通の `.md` である。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-messages');
      const h = document.createElement('h3');
      h.textContent = 'メッセージ';
      wrap.append(h);

      const unread = document.createElement('p');
      unread.setAttribute('data-pkc-field', 'messages-unread');
      messagesUnreadText = unread;
      wrap.append(unread);

      const open = document.createElement('button');
      open.type = 'button';
      open.setAttribute('data-pkc-action', 'open-messages');
      open.setAttribute('data-pkc-message-lid', SYSTEM_MESSAGE_LID);
      open.textContent = 'メッセージを開く';

      /**
       * 🔴 **処理の記録**(§7「処理」)── 段②b でワーカーの記録を繋ぐまでは
       *   空のまま開く(#7 の注記どおり、それ自体は実害ではない)。
       */
      const openJobs = document.createElement('button');
      openJobs.type = 'button';
      openJobs.setAttribute('data-pkc-action', 'open-messages');
      openJobs.setAttribute('data-pkc-message-lid', SYSTEM_JOB_LID);
      openJobs.textContent = '処理の記録を開く';

      const dl = document.createElement('dl');
      const dt = document.createElement('dt');
      dt.textContent = '保管件数';
      const dd = document.createElement('dd');
      // 🔴 選択肢 3 つ ── プルダウンをボタンの列にする(#1038 段J。メッセージの節の 1 項目)
      const capRow = buildChoiceRow({
        field: 'messages-cap-select',
        ariaLabel: 'メッセージの保管件数',
        action: 'set-message-cap',
        dataAttr: 'data-pkc-message-cap-value',
        choices: MESSAGE_CAP_OPTIONS.map((n) => ({ id: String(n), label: `${n} 件` })),
        currentId: '', // render 末尾の syncMessages が必ず映す
      });
      dd.append(capRow);
      dl.append(dt, dd);

      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.setAttribute('data-pkc-action', 'export-messages');
      exportBtn.setAttribute('data-pkc-message-lid', SYSTEM_MESSAGE_LID);
      exportBtn.textContent = 'メッセージを書き出す';
      exportBtn.title = 'ノートの中身・題名・添付名は書き込まれません。バグ報告に貼れます。';

      const note = buildSettingsNote(
        'アプリの知らせが溜まります(上限を超えると古い分から自動で消えます)。',
      );

      wrap.append(open, openJobs, dl, exportBtn, note);
      return wrap;
    },
    /** ⚠ 未読は毎 state で変わりうる(器は触らない ── 字とボタンの列の押され方だけ差し替える)。 */
    sync(state: AppState): void {
      if (messagesUnreadText)
        messagesUnreadText.textContent =
          state.messagesUnread > 0 ? `未読 ${state.messagesUnread} 件` : '未読はありません';
      syncChoiceRow(
        region,
        'messages-cap-select',
        'data-pkc-message-cap-value',
        String(currentMessageCap()),
      );
    },
  };
}
