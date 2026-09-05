/**
 * 🔴 **スタックのフレーバー**(#633 段③。user 裁定 2026-08-30
 * 「**スタックをグループとして参照のみのフォルダとして保存する機能もつけろ**」)。
 *
 * 本文は **`- [題名](entry:<lid>)` の箇条書き**で、**並び = 出現順 = スタックの上から**。
 * それ以外の規約は持たない ── 読むのは `bodyLinkTargets`、書くのは `formatEntryLink`
 * (どちらも既に在る 1 本。ここで 2 本目の綴りを作らない ── §7)。
 *
 * ## ⚠ なぜ既存の 4 系統(スマートフォルダ / タグ / フォルダ / 板)に乗せないか
 *
 * - スマートフォルダは **AND の絞り**で、順序つきの名指しを表せない(`smart-spec.ts`)。
 *   しかも `smart-flavor.ts` 自身が「この入れ物に手で子を入れることはできない」と戒めている
 * - タグは**相手の本文にタグを書く**(参照のみ、と逆向き)
 * - フォルダは **1 親**(1 つのノートは 1 つのフォルダにしか居られない)
 * - 板は**座標**で、並びの意味を持たない
 *
 * 🔑 「参照のみ」= **メンバーの本文は 1 バイトも書かない**。元のノートを消しても
 *   この本文の行は残る(押すと「ノートが見つかりません」と出る ── 既存の `entry:` の断り)。
 *
 * ## 旧ビルドが読んだら
 *
 * 綴り `stack` を知らないので **text fallback** ── 押せるリンクの箇条書きとして普通に開ける
 * (`flavor/index.ts` の規約)。schema は 1 バイトも変えていない。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import { type FlavorSpec } from './flavor-spec';
import { extractSchedule } from '@features/schedule/schedule-keys';
import { formatEntryLink } from '@features/entry-ref/entry-ref-format';
import { bodyLinkTargets } from '@features/entry-ref/body-links';

/** 綴り。⚠ `archetype-label.ts` / `icons.ts` / `plain-markdown.ts` もこの綴りで登記する。 */
export const STACK_ARCHETYPE = 'stack';

export const stackFlavor: FlavorSpec = {
  archetype: STACK_ARCHETYPE,
  /** 期日と状態は他のフレーバーと同じく写す(`smart-flavor.ts` の 2026-08-27 の理由)。 */
  extract: (body) => ({ ...extractSchedule(body), archived: false }),
  /** PKC2 に対応する archetype は無い ── 恒等で通す。 */
  fromPkc2: (body) => body,
  /**
   * ⚠ 作る道は帯の「保存…」だけ(空のスタックを作る道は要らない ── 作る種類には出さない)。
   *   `body` を渡さずに作られた保険として、何をする入れ物かを 1 行だけ置く。
   */
  seed: () => '(スタックの「保存…」から作ります)\n',
};

/**
 * スタックの本文を組む ── **上から順に 1 行 1 リンク**。
 *
 * ⚠ 題名は保存時点の字で焼き込まれる(`entry:` の lid で飛ぶので、改名しても壊れない。
 *   マニュアルの「参照をコピー」と同じ性質)。
 */
export function stackBody(items: readonly { readonly title: string; readonly lid: string }[]): string {
  return items.map((it) => `- ${formatEntryLink(it.title, it.lid)}`).join('\n') + (items.length > 0 ? '\n' : '');
}

/**
 * スタックの本文から lid を**上から順に**読む。
 * 🔑 読む規則は `bodyLinkTargets` そのもの(重複を畳み、出てきた順)── ここで書き直さない。
 */
export function stackLids(body: string): readonly string[] {
  return bodyLinkTargets(body);
}
