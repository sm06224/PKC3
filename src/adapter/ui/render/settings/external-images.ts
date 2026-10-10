/**
 * 🔑 **外部の画像**(2026-08-06、user 裁定「設定で常にオン / 常に確認 /
 * 常にオフをとりましょう」)── 「許可」の h3 の中。
 *
 * ⚠ **「表示」には入れない** ── これは見た目の好みではなく、**外へ何が伝わるか**の
 *   判断である。同じ場所に混ぜると、配色を選ぶ気分で押される。
 * ⚠ 何が起きるのかを書く ── 「外部画像を許可」だけでは判断できない。
 * (#1382 で `settings.ts` から移した。中身は変えていない。)
 */
import { EXTERNAL_IMAGE_MODES } from '@features/markdown/external-images';
import { buildChoiceRow, syncChoiceRow } from '../choice-buttons';
import type { ExternalImagePolicy } from '../external-images';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createExternalImagesSection(
  region: HTMLElement,
  policy: ExternalImagePolicy,
): SettingsSection {
  return {
    id: 'external-images',
    group: 'permissions',
    build(): HTMLElement {
      const wrap = document.createElement('section');
      wrap.setAttribute('data-pkc-region', 'settings-external-images');
      const h = document.createElement('h4');
      h.textContent = '外部の画像';
      wrap.append(h);

      const dl = document.createElement('dl');
      const dt = document.createElement('dt');
      dt.textContent = '読み込む';
      const dd = document.createElement('dd');
      // 🔴 選択肢 3 つ ── プルダウンをボタンの列にする(#1038 段J。許可の節の 1 項目)
      const eiRow = buildChoiceRow({
        field: 'external-images-select',
        ariaLabel: '外部の画像を読み込む',
        action: 'set-external-images',
        dataAttr: 'data-pkc-external-images-value',
        choices: EXTERNAL_IMAGE_MODES,
        currentId: '', // render 末尾の sync が必ず映す
      });
      eiRow.title =
        '「常に確認」ではノートごとに聞き、答えはタブを閉じるまで覚えます。' +
        '書き出した HTML に画像が入るのは「常にオン」のときだけです。';
      dd.append(eiRow);
      dd.append(
        buildSettingsNote(
          '本文と html コードの外部画像を読み込むかです(読み込むと先方に伝わります)。',
        ),
      );
      dl.append(dt, dd);
      wrap.append(dl);
      return wrap;
    },
    /**
     * ⚠ 画面の値を**いまの設定に合わせる**(2026-08-06)。合わせないと、
     * 設定を変えた後に別の面へ行って戻ってきたとき、選択肢が**古い値のまま**見える
     * ── そして user は「変えたのに戻っている」と読む(配色と同じ理由)。
     */
    sync(): void {
      syncChoiceRow(region, 'external-images-select', 'data-pkc-external-images-value', policy.getMode());
    },
  };
}
