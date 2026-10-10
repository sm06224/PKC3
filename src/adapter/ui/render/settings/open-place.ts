/**
 * 🔴 **別の窓で開くか、この画面で開くか**(#826。user 指摘 2026-09-09
 * 「**普通に別窓で開くとここで開くは共存で、デフォをどちらとするかは
 * ユーザー設定では？**」)。
 *
 * ⚠ **flag ではない**(正規設定)── 恒久の好みで、畳む予定が無い。
 * ⚠ **2026-09-21(#1017 段③-1)に「表示」から h4「開き方」へ移した** ──
 *   「アプリの開き方」の**すぐ上**に置く(どちらも「開く」の話である)。
 * 🔑 **いま効く先を書く** ── 効かない所まで効くと読まれると、
 *   「設定したのに変わらない」になる(この repo がいちばん嫌う形)。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { OPEN_PLACES } from '@features/open-place';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import { currentOpenPlace } from '../open-place';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createOpenPlaceSection(region: HTMLElement): SettingsSection {
  return {
    id: 'open-place',
    group: 'open',
    build(): Node[] {
      const plt = document.createElement('dt');
      plt.textContent = 'zip ファイルを開く場所';
      const pld = document.createElement('dd');
      // 🔴 選択肢 2 つ ── プルダウンをボタンの列にする(#1038 段J)
      const plRow = buildChoiceRow({
        field: 'open-place-select',
        ariaLabel: 'zip ファイルを開く場所',
        action: 'set-open-place',
        dataAttr: 'data-pkc-open-place-value',
        choices: OPEN_PLACES,
        currentId: '', // render 末尾の sync が必ず映す
      });
      plRow.title =
        '別のウィンドウなら本文を見ながら確かめられます。ブラウザが別のウィンドウを止めている場合は' +
        'この画面の上に出し、理由を画面の下に出します。電話の画面ではどちらでもこの' +
        '画面に出ます。予定表や連絡先など、ほかのウィンドウの開き方はここでは変わりません。';
      pld.append(plRow);
      pld.append(
        buildSettingsNote('添付の zip ファイルの一覧を、別のウィンドウかこの画面のどちらに出すかです。'),
      );
      return [plt, pld];
    },
    /**
     * ⚠ 画面の値を**いまの開き場所に合わせる**(#826)。器は 1 度しか組まないので、
     *   映さないと**別の面へ行って戻ると古い値が見える**(§7 の「設定画面の値の同期」)。
     * ⚠ ここだけ **DOM ではなく保存が正本**である ── この設定は画面に出ない
     *   (見え方のトークンではない)ので、当てる先が無い。
     */
    sync(): void {
      syncChoiceRow(region, 'open-place-select', 'data-pkc-open-place-value', currentOpenPlace());
    },
  };
}
