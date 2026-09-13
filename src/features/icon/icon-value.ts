/**
 * 🔴 **目印の字を読む ── 1 か所**(#857 段②、2026-09-13)。
 *
 * 目印は **2 通りの書き方**を受ける(#770 段②):
 *
 * | 打った字 | 出る物 |
 * |---|---|
 * | `\u{1F9EE}`(絵文字) | そのまま(**1 ドットも変えない**) |
 * | `calendar`(図案の名前) | 予定表の絵 ── 直す前は **`ca`** と出ていた |
 *
 * ## なぜ切り出したか
 *
 * ⚠ 読む所が **2 つ**になった ── タイル(`attachment.app_icon`)と
 *   グループの見出し(`appgroup.icon`)。
 * 🔑 **同じ問いに答える口を 2 つ作らない**(CLAUDE.md §7)── 片方だけ直した日に、
 *   「タイルでは絵が出るのに見出しでは `ca` と出る」という形で割れる。
 *
 * ⚠ **pure module**。DOM も frontmatter も知らない(読み出しは呼び側の仕事)。
 */
import { isIconName, type IconName } from './symbols';

export interface IconValue {
  /** 絵文字などの**字**。⚠ 図案のときは立てない。 */
  readonly icon?: string;
  /** 図案の名前。⚠ 字のときは立てない。 */
  readonly symbol?: IconName;
}

/**
 * 目印の生の字を読む。
 *
 * ⚠ **2 字までに切るのは字のほうだけ** ── 長い文字列を入れられると行の高さが崩れる。
 *   `[...]` で切る(サロゲートペアを割らない ── 絵文字が壊れる)。
 * ⚠ 図案のときは `icon` を**立てない** ── 2 つ立つと、出す側が「どちらを描くか」の
 *   規則をもう 1 つ持つことになる(§7)。
 */
export function parseIconValue(raw: string | undefined): IconValue {
  const trimmed = raw?.trim();
  const symbol = trimmed !== undefined && isIconName(trimmed) ? trimmed : undefined;
  if (symbol !== undefined) return { symbol };
  if (raw === undefined) return {};
  return { icon: [...raw].slice(0, 2).join('') };
}
