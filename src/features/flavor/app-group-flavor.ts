/**
 * 🔴 **グループ用ノートのフレーバー**(#857 段②)。規約は
 * `features/launcher/app-group-spec.ts`(なぜ別の名前空間か、同名が 2 つのとき、も其処)。
 *
 * ## 旧ビルドが読んだら
 *
 * 綴り `appgroup` を知らないので **text fallback** ── frontmatter 1 行と説明文の
 * 普通のノートとして開ける(`flavor/index.ts` の規約)。schema は 1 バイトも変えていない。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '@features/schedule/schedule-keys';
import { APP_GROUP_ARCHETYPE, appGroupSeed } from '@features/launcher/app-group-spec';

export const appGroupFlavor: FlavorSpec = {
  archetype: APP_GROUP_ARCHETYPE,
  /** 期日と状態は他のフレーバーと同じく写す(`smart-flavor.ts` の 2026-08-27 の理由)。 */
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
  /** PKC2 に対応する archetype は無い ── 恒等で通す(取り込みで落とさない)。 */
  fromPkc2: (body) => body,
  /**
   * ⚠ 作る道は**アプリの一覧で目印を選んだとき**だけ(白紙から作る道は要らないので、
   *   作る種類の帯には出さない ── `stack` と同じ)。`body` を渡さずに作られた保険として、
   *   何をする入れ物かを置く。
   */
  seed: () => appGroupSeed(''),
};
