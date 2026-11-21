/**
 * 🔴 **「どのテンプレートから作った記録か」を、記録ノートの先頭の設定欄へ残す**(#2002 段 4)。
 *
 * > user の物語:同じテンプレートから 10 件の記録ノートを作った。あとで 1 つの一覧に並べて、入力欄の値を列で見たい。
 *
 * 🔑 残すのは `template: <テンプレートの題名>` の 1 行だけ(新しい種類も本文の形も作らない)。
 *   集計(`group-by.ts`)でこの key を選ぶと、同じテンプレートから作ったノートが 1 組に集まる。
 * ⚠ 値は題名(読める字)。テンプレートの題名を後で変えると、その後に作る記録は別の組になる ──
 *   先に作った記録の行は書き換えない(複製が独立である裁定 1 と同じ)。
 * ⚠ 本文に既に `template:` がある(テンプレート自身が書いている)ときは、書き換えず残す。
 * pure。
 */
import { isFormInfo } from '../markdown/form-def';
import { parseFrontmatter, spliceFrontmatterKeys } from '../markdown/frontmatter';
import { TEMPLATE_KEY } from '../query/group-by';

/**
 * 本文に入力欄の定義(` ```yaml form `)の囲みがあるか。
 * ⚠ 囲みの入れ子を見る(4 本の囲みの中に書いた ` ```yaml form ` の行は定義ではない)。判定は描画と同じ `isFormInfo`。
 */
export function hasFormFence(body: string): boolean {
  let open: { ch: string; len: number } | null = null;
  for (const line of body.split(/\r?\n/u)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (m === null) continue;
    const ch = m[1]![0]!;
    const len = m[1]!.length;
    if (open === null) {
      // ⚠ バッククォートの囲みの見出しにバッククォートは書けない(CommonMark)
      if (ch === '`' && m[2]!.includes('`')) continue;
      if (isFormInfo(m[2])) return true;
      open = { ch, len };
    } else if (ch === open.ch && len >= open.len && m[2]!.trim() === '') {
      open = null;
    }
  }
  return false;
}

export function stampTemplateOrigin(body: string, templateTitle: string): string {
  const title = templateTitle.trim();
  // ⚠ 入力欄の無いテンプレート(議事録の型など)には書かない ── 記録でないノートの先頭に設定欄を増やさない
  if (title === '' || !hasFormFence(body)) return body;
  const { meta } = parseFrontmatter(body);
  if (TEMPLATE_KEY in meta) return body;
  return spliceFrontmatterKeys(body, { [TEMPLATE_KEY]: title });
}
