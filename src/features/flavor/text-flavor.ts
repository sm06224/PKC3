/**
 * text フレーバー = fallback。text / folder / generic / opaque はこの経路
 * (registry に個別登録が無い archetype も同様)。
 *
 * PKC2 のこれらの body は素の text / markdown なので変換は恒等。opaque の
 * 「内容を解釈せず保全する」契約も恒等変換がそのまま満たす。
 */
import { NO_EXTRACT, type FlavorSpec } from './flavor-spec';

export const textFlavor: FlavorSpec = {
  archetype: 'text',
  // text 系は抽出列を持たない。frontmatter に status 等が書かれていても列に
  // 写さない ── kanban / calendar は todo だけを引く(PKC2 と同じ意味論)
  extract: () => NO_EXTRACT,
  fromPkc2: (body) => body,
};
