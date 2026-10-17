/**
 * 🔴 **色を付けたタグの一覧**の節(#1645 項目 1。Gemini 裁定 = #1163 の依頼 39-1=A「推薦どおり」)。
 *
 * 直す前は、どのタグに色を付けたかを見渡す場所も、まとめて外す場所も無かった
 * (外すには、そのタグが付いたノートを開いて右のペインの「色を外す」を押すしかなかった)。
 * ⚠ 色を**付ける**のは今までどおりノートの右のペインから(付けるのはノートの上、見渡して外すのは
 *   ここ ── 往復をそろえる)。⚠ 外す処理は情報ペインと同じ `tag-color-clear` の 1 本。
 * ⚠ 一覧の中身は `render/tag-color.ts` の `syncTagColorList` が組む(色の一覧が変わるたびに
 *   `applyTagColors` からも呼ばれるので、開きっぱなしの設定画面にも映る)。
 */
import { syncTagColorList, TAG_COLOR_LIST_FIELD } from '../tag-color';
import { buildSettingsNote } from './note';
import type { SettingsSection } from './section';

export function createTagColorListSection(region: HTMLElement): SettingsSection {
  return {
    id: 'tag-color-list',
    group: 'display',
    build(): Node[] {
      const dt = document.createElement('dt');
      dt.textContent = '色を付けたタグ';
      const dd = document.createElement('dd');
      const box = document.createElement('div');
      box.setAttribute('data-pkc-field', TAG_COLOR_LIST_FIELD);
      dd.append(
        box,
        buildSettingsNote(
          '色を付けたタグの一覧です。ここで色を外せます(色を付けるのは、ノートの右のペインのタグの横の「色」から)。',
        ),
      );
      return [dt, dd];
    },
    sync(): void {
      syncTagColorList(region);
    },
  };
}
