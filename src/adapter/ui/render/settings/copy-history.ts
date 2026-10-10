/**
 * 🔴 **コピーの履歴**の節(#1017 段③-1)── 「記録」の h3 の中。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { appCopyHistory } from '@adapter/platform/copy-history-store';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createCopyHistorySection(): SettingsSection {
  /** いま持っている件数の字。⚠ 器は 1 度だけ組む(器は 1 度しか組まないので、映さないと古い値が見える)。 */
  let copyHistoryCount: HTMLElement | null = null;

  const syncCount = (): void => {
    if (!copyHistoryCount) return;
    const n = appCopyHistory.items().length;
    copyHistoryCount.textContent = n > 0 ? `いま ${n} 件あります。` : 'いまは 0 件です。';
  };

  return {
    id: 'copy-history',
    group: 'history',
    /**
     * 🔴 **コピーの履歴**(#1017 段③-1。新設)── 「記録」の h4。
     *
     * ⚠ **消す口は既にメニュー(`copyHistoryMenu`)に在る**(`clear-copy-history`)──
     *   ここは**同じ action** をもう 1 か所から呼べるようにするだけで、
     *   新しい判断は 1 つも持たない(§7「同じ問いに答える口が 2 つ」を避ける ──
     *   判定はどちらも `appCopyHistory.clear()` の 1 本)。
     * ⚠ **一覧そのものは出さない** ── コピーの中身はその場のメニューで貼るものであって、
     *   設定画面で読み返す物ではない(founding「必要十分」)。
     */
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-copy-history');
      const h = document.createElement('h4');
      h.textContent = 'コピーの履歴';
      wrap.append(h);

      const count = document.createElement('p');
      count.setAttribute('data-pkc-field', 'copy-history-count');
      copyHistoryCount = count;
      wrap.append(count);
      // ⚠ 「消す」は binder が store を直に触るので、状態変化では描き直されない ──
      //    store の通知で件数の字を合わせる(器は 1 度しか組まないので購読も 1 度)
      appCopyHistory.onChange(() => syncCount());

      const note = buildSettingsNote('PKC3 の中でコピーした物を、この端末に 20 件まで残します。');
      wrap.append(note);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', 'clear-copy-history');
      btn.textContent = 'コピーの履歴を消す';
      btn.title =
        '貼るときは、貼り先を右クリックして選び直せます。この端末にだけ残ります。';
      wrap.append(btn);
      return wrap;
    },
    /** ⚠ 件数は他の面(貼り付けの右クリック)でも増減するので、毎 state で映す。 */
    sync(): void {
      syncCount();
    },
  };
}
