/**
 * text フレーバー = fallback。text / folder / generic / opaque はこの経路
 * (registry に個別登録が無い archetype も同様)。
 *
 * PKC2 のこれらの body は素の text / markdown なので変換は恒等。opaque の
 * 「内容を解釈せず保全する」契約も恒等変換がそのまま満たす。
 */
import type { FlavorSpec } from './flavor-spec';
import { extractSchedule } from '../schedule/schedule-keys';

export const textFlavor: FlavorSpec = {
  archetype: 'text',
  /**
   * 🔴 **普通のノートも `date` / `status` を列に写す**(#276 / #277。
   * user 指示 2026-08-19「frontmatter でのカレンダー情報付与」)。
   *
   * ⚠ 直す前は `NO_EXTRACT` を返していた ── カレンダーとカンバンが
   *   **todo アーキタイプだけ**を引く形だったからである。todo は封印中
   *   (`features/sealed.ts`)なので、**書ける人が誰も居ない**状態だった。
   * ⚠ 鍵の名前と受理形は `schedule-keys.ts` の 1 か所(判定を増やさない)。
   * ⚠ `archived` はここでは写さない ── 理由は `extractSchedule` の docstring。
   */
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
  fromPkc2: (body) => body,
};
