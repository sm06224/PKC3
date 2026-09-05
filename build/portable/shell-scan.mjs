/**
 * 🔴 **畳んだ HTML の「器」だけを見る**(#400 段①②③)。
 *
 * ## なぜ取り出したか(2026-08-25、同じ罠を 2 度踏んでから)
 *
 * 畳んだ HTML の大半は**アプリ本体の JS**で、その中には
 * `` `src="${e}"` `` のような**組み立て**も、書き出し用 HTML の
 * `</head>` も**実在する**。だから HTML 全体を字面で走査する検査は、
 * ⚠ **無関係な散文に満たされる**(CLAUDE.md §1)。
 *
 * 1 度目 ── 「外部参照が 0 件」を全体で見て、**必ず落ちた**。
 * 2 度目 ── 「印を `</head>` の前に差す」を畳んだ後にやって、
 *   **JS の途中に差し込まれ**、アプリが `SyntaxError` で真っ白になった。
 *
 * 🔑 **同じ規則を script と test の 2 か所に書かない**(CLAUDE.md §7)ために
 * ここへ寄せた。⚠ test はこの関数を**実際に走らせて**見る ── 原文 pin では
 * 上の 2 つの壊れ方を 1 つも捕まえられない(字面は両方とも「在る」ので)。
 */

/**
 * `<script>` / `<style>` の**中身だけ**を抜いた器を返す。
 *
 * 🔑 **開始タグは残す** ── 抜くと属性ごと消えるので、
 * ⚠ `<script src="...">` という**いちばん見たい外部参照**が検査から消える
 * (3 稿目で気づいた)。
 */
export function shellOf(html) {
  return html
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/g, '$1</style>');
}

/** 器に残っている外部参照(`data:` と `#` は外部ではない)。 */
export function externalRefs(shell) {
  return [...shell.matchAll(/(?:src|href)="(?!data:|#)[^"]+"/g)].map((m) => m[0]);
}

/** 器に在る可搬バンドルの印の数。⚠ **1 件でなければならない**。 */
export function bundleTagCount(shell) {
  return [...shell.matchAll(/data-pkc-bundle/g)].length;
}

/**
 * 🔴 **印は「頭」に置く**(#400 段④)。
 *
 * 書き出し側(`src/features/export/portable-bundle.ts`)は、雛形の**先頭
 * この長さぶん**だけを見て印を差し替える ── ⚠ 全体を見ると、畳んだ JS の中の
 * **同じ綴り**(書き出しのコードが持っている文字列)に当たる。
 * 🔑 だから `fold.mjs` は `<head>` の**直後**に置き、ここに収まることを確かめる。
 * ⚠ 2 つの値が食い違わないことは `tests/build/portable-fold.test.ts` が
 *   **両方を import して等値で**見る(片方だけ変えられない)。
 */
export const PORTABLE_HEAD_SCAN = 4096;

/**
 * 🔴 **マニュアルの page を 1 枚へ焼き込む封筒**(#648 段③)。
 *
 * ⚠ HTML 全文(`manual.html`)には `</script>` も `</body>` も**必ず在る** ── 素のまま
 *   `<script>` に入れると最初の `</script>` で切れ、`</body>` は書き出し側の
 *   `lastIndexOf('</body>')`(`portable-bundle.ts`)を**JS の中へ**当ててしまう。
 * 🔑 だから JSON 文字列にして `<` を `\u003c` に逃がす ── 中身に `<` が 1 つも残らない
 *   ので、どちらの罠にも当たらない。読む側(`adapter/platform/portable-manual.ts`)は
 *   `JSON.parse` するだけ。⚠ 属性名は読む側の selector と同じ綴り ── 突き合わせは
 *   `tests/adapter/portable-manual.test.ts`(封筒を組む実物 → 読む実物、で往復する)。
 */
export const MANUAL_PAGE_ATTR = 'data-pkc-manual-page';

export function manualPageTag(html) {
  return (
    `<script type="application/json" ${MANUAL_PAGE_ATTR}>` +
    JSON.stringify(html).replace(/</g, '\\u003c') +
    `</script>`
  );
}

/** 器に在るマニュアルの page の印の数。⚠ **1 件でなければならない**(`bundleTagCount` と同じ作法)。 */
export function manualPageTagCount(shell) {
  return [...shell.matchAll(new RegExp(MANUAL_PAGE_ATTR, 'g'))].length;
}
