/**
 * ノートの名前を変えたとき、ほかのノートの本文にある**リンクの字**も新しい題名へ書き換える
 * (#1163 依頼 177、#1648。Gemini の裁定:確認なしで書き換え、終わってから 1 行知らせる)。
 *
 * 🔑 **書き換えるのは「字が旧い題名と同じリンク」だけ**。自分で付けた別の字は残す(動線を減らさない)。
 * 🔑 リンクの読み方は `scanLinks` の 1 本(コードの中は読まない)。字下げのコードも外す
 *   (`bodyLinkTargets` と同じ範囲)。
 * ⚠ 書き換えるのはラベルの 1 区間だけ。そのほかの byte(宛先 `#章` ・題の引用・改行コード)は動かさない。
 * ⚠ pure module。書込は worker の `renameLinkTexts`(走査と書込を 1 tx に閉じ込める)が持つ。
 */
import { escapeLinkLabel } from '../markdown/link-format';
import { indentedCodeRanges, scanLinks } from '../markdown/link-scan';
import { isWritableLinkTitle, scanTitleLinks } from '../markdown/title-link';

const LID_CHARS = 'A-Za-z0-9_\\-';

/** その宛先が `lid` を指すか(`entry:<lid>` / `entry:<lid>#章` / 同じ入れ物の `pkc://<cid>/entry/<lid>`)。 */
function destTargets(dest: string, lid: string, cid: string | null): boolean {
  const d = dest.trim();
  const m = new RegExp(`^entry:([${LID_CHARS}]+)(?:#.*)?$`, 'i').exec(d);
  if (m) return m[1] === lid;
  if (cid !== null && /^[A-Za-z0-9_-]+$/.test(cid)) {
    const p = new RegExp(`^pkc://${cid}/entry/([${LID_CHARS}]+)(?:#.*)?$`).exec(d);
    if (p) return p[1] === lid;
  }
  return false;
}

export interface LinkTextRename {
  body: string;
  /** 書き換えたリンクの数(0 なら `body` は入力のまま)。 */
  count: number;
}

/**
 * 本文の中で `lid` を指すリンクのうち、字が `oldTitle` と同じものを `newTitle` へ書き換える。
 * 字の比べ方:`escapeLinkLabel(oldTitle)`(画面が書く綴り)か、`oldTitle` そのもの(手で書いた綴り)と byte 一致。
 */
export function renameLinkTexts(
  body: string,
  lid: string,
  cid: string | null,
  oldTitle: string,
  newTitle: string,
): LinkTextRename {
  if (oldTitle === '' || newTitle === '' || oldTitle === newTitle) return { body, count: 0 };
  if (!body.includes(lid)) return { body, count: 0 };
  const sites = scanLinks(body).sites;
  const indented = body.includes('    ') || body.includes('\t') ? indentedCodeRanges(body) : [];
  const accepted = new Set([escapeLinkLabel(oldTitle), oldTitle]);
  const next = escapeLinkLabel(newTitle);
  const edits: Array<[number, number]> = [];
  for (const site of sites) {
    if (site.kind !== 'inline' || site.image || site.labelStart < 0) continue;
    if (!destTargets(site.dest, lid, cid)) continue;
    if (indented.some(([a, b]) => site.start >= a && site.start < b)) continue;
    const from = site.labelStart + 1;
    if (!accepted.has(body.slice(from, site.start))) continue;
    edits.push([from, site.start]);
  }
  if (edits.length === 0) return { body, count: 0 };
  let out = '';
  let cursor = 0;
  for (const [a, b] of edits) {
    out += body.slice(cursor, a) + next;
    cursor = b;
  }
  return { body: out + body.slice(cursor), count: edits.length };
}

export { isWritableLinkTitle } from '../markdown/title-link';

/**
 * 🔴 **改名のとき、`[[旧い題名]]` / `[[旧い題名|表示]]` も新しい題名へ**(#1174 段②)。
 *
 * `[[題名]]` は番号ではなく**題名で**指すので、改名すると指す先が無くなる。番号リンク(`entry:`)の字と同じく、
 * 改名に合わせて書き換える。書き換えるのは題名の 1 区間だけ(`|表示` と前後の空白・ほかの byte は動かさない)。
 * 🔑 **どれがリンクか**は描画と同じ正本(`markdown/title-link.ts` の `scanTitleLinks`)── 画面でリンクになっていない
 *   `[[ ]]`(コード・数式・リンクの字・エスケープ・表のセルをまたぐ物)は書き換えない。
 * ⚠ 新しい題名が `[[…]]` に書けない字(`[` `]` `|` `\` 改行・`ruby:` / `em:` 始まり)なら書き換えない
 *   (書くと別の記法に化ける / リンクでなくなる)。
 */
export function renameTitleLinks(body: string, oldTitle: string, newTitle: string): LinkTextRename {
  if (oldTitle === '' || newTitle === '' || oldTitle === newTitle) return { body, count: 0 };
  if (!isWritableLinkTitle(newTitle) || !body.includes(oldTitle.trim())) return { body, count: 0 };
  const old = oldTitle.trim();
  let out = '';
  let cursor = 0;
  let count = 0;
  for (const site of scanTitleLinks(body)) {
    if (site.title !== old) continue;
    out += body.slice(cursor, site.titleFrom) + newTitle.trim();
    cursor = site.titleFrom + old.length;
    count += 1;
  }
  if (count === 0) return { body, count: 0 };
  return { body: out + body.slice(cursor), count };
}
