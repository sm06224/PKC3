/**
 * 🔴 **方言記法を落として、素の CommonMark を取り出す**(#396)。
 *
 * > user 明示要望(PKC2 に記録):「**方言記法されたエントリからベーシックな
 * > マークダウンだけを取り出す機能**」
 *
 * ## ⚠ PKC2 では「在ったが届いていなかった」
 *
 * PKC2 の `strip-dialect.ts` を呼んでいたのは **1 か所だけ**
 * (`render-for-extension.ts:140`、拡張の render RPC の `opts.strip_dialect`)──
 * つまり**押せる口はどこにも無かった**。
 * 🔑 移植の判定は 2 段(CLAUDE.md):①届いていたか → **届いていない**
 * ②しかし **user の要望として記録されている**ので、価値の側は正しい。
 * だから PKC3 では**本物の動線**(書き出しの一覧)として出す。
 *
 * ## 🔴 PKC2 より落とさない ── 等価があるものは記号へ戻す
 *
 * PKC2 は `:strong:[X]` も `:emphasis:[X]` も**素の文字**へ潰していた。
 * ⚠ しかし CommonMark には `**X**` / `*X*` が在る ── 潰す理由が無い。
 * 🔑 **等価が在るものは記号へ、無いものだけ素の文字へ**落とす
 * (「取り出す」の目的は**読める markdown を得ること**であって、
 *  装飾を捨てることではない)。
 *
 * ## ⚠ fence の中は 1 バイトも触らない
 *
 * ```` ```js ```` の中に `==` や `:::` が在っても、それは**コード**である。
 *
 * 🔑 **pure module**。DOM も窓も知らない。
 */
import { parseBlockDirectiveOpen, isBlockDirectiveClose } from './block-directive-attrs';

/**
 * CommonMark に**等価が在る** inline role → その記号。
 * ⚠ ここに無い役(`sup` / `sub` / `span`)は素の文字へ落とす(等価が無い)。
 */
const ROLE_TO_MARK: ReadonlyMap<string, string> = new Map([
  ['strong', '**'],
  ['emphasis', '*'],
  ['code', '`'],
  ['strike', '~~'],
]);

/** 等価が無い役(記号ごと落として中身だけ残す)。 */
const ROLE_BARE: ReadonlySet<string> = new Set(['sup', 'sub', 'span', 'text', 'role']);

/** fence の外の 1 行から inline の方言を落とす。 */
function stripInline(line: string): string {
  return (
    line
      // `:role:[X]{attrs}` ── 等価が在れば記号へ、無ければ中身だけ
      .replace(
        /:([a-z]+):\[([^\]]*)\](?:\{[^}]*\})?/g,
        (whole: string, role: string, inner: string): string => {
          const mark = ROLE_TO_MARK.get(role);
          if (mark !== undefined) return `${mark}${inner}${mark}`;
          if (ROLE_BARE.has(role)) return inner;
          // ⚠ **知らない役は触らない**(黙って壊さない)── 落とすのは
          //    「方言だと分かっているもの」だけである
          return whole;
        },
      )
      // `==X==` / `==[color]X==` 強調 ── CommonMark に等価が無い
      .replace(/==(?:\[[a-zA-Z-]+\])?([^=]+?)==/g, '$1')
      // `^^X^^` 圏点 ── 等価が無い
      .replace(/\^\^([^^]+?)\^\^/g, '$1')
      // `[[ruby:base|よみ]]` → base(読みは落ちる ── 等価が無い)
      .replace(/\[\[ruby:([^|\]]+)\|[^\]]*\]\]/g, '$1')
      // `[[em:X]]`(圏点の旧形)
      .replace(/\[\[em:([^\]]+)\]\]/g, '$1')
      // `%%X%%` 行内コメント ── 消す
      .replace(/%%[^\n]*?%%/g, '')
  );
}

/**
 * 方言を落として CommonMark にする。
 *
 * ⚠ 落とした行は**空行に置き換える**(消して詰めない)── 詰めると
 *   前後の段落がくっつく。最後に 3 行以上の空行を 2 行へ畳む。
 */
export function stripDialect(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  /** fence の記号(`` ` `` か `~`)。空 = fence の外。 */
  let fence = '';
  let inComment = false;
  /** `:::comment` / `:::toc` ── **中身ごと**落とす。 */
  let dropping = false;

  for (const line of lines) {
    const fenceM = /^\s*([`~]{3,})/.exec(line);

    // ── fence の中は 1 バイトも触らない ──
    if (fence !== '') {
      out.push(line);
      if (fenceM && fenceM[1]![0] === fence && /^\s*[`~]{3,}\s*$/.test(line)) fence = '';
      continue;
    }
    if (fenceM) {
      fence = fenceM[1]![0]!;
      out.push(line);
      continue;
    }

    // ── `%%%` の塊コメント ── 中身ごと落とす ──
    if (/^\s*%%%\s*$/.test(line)) {
      inComment = !inComment;
      out.push('');
      continue;
    }
    if (inComment) {
      out.push('');
      continue;
    }

    // ── `:::comment` / `:::toc` ── 中身ごと落とす ──
    if (dropping) {
      if (isBlockDirectiveClose(line)) dropping = false;
      out.push('');
      continue;
    }
    const open = parseBlockDirectiveOpen(line);
    if (open !== null && (open.name === 'comment' || open.name === 'toc')) {
      dropping = true;
      out.push('');
      continue;
    }
    // ── その他の `:::` ── **枠だけ**落として中身は残す ──
    if (open !== null || isBlockDirectiveClose(line)) {
      out.push('');
      continue;
    }

    // ── `+++` 改頁 → CommonMark の区切り線 ──
    if (/^\+\+\+\s*(?:\{[^}]*\})?\s*$/.test(line)) {
      out.push('---');
      continue;
    }
    // ── `_` / `_3` 空行マーカー → 空行 ──
    if (/^\s*_\d*\s*$/.test(line)) {
      out.push('');
      continue;
    }

    // ── 行頭の寄せ / 字下げ ── 記号だけ落とす ──
    let work = line.replace(/^(\s*)(?:\|\||\|>|<\||\|<|>\|)\s?/, '$1');
    if (work === line) {
      // ⚠ `__bold__` を字下げと読まない ── 行頭の `__` の**後ろに `__` が無い**ときだけ
      if (/^\s*(?:__|＿)(?!.*__)/.test(work)) work = work.replace(/^(\s*)(?:__|＿)\s?/, '$1');
    }
    out.push(stripInline(work));
  }

  // ⚠ 空行が増えるのは当然(枠を空行にしたので)── 3 行以上を 2 行へ畳む
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
