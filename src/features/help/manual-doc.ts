/**
 * 🔴 **マニュアルを「アプリ」として独立した窓へ出すための、組み立ての純粋部**
 * (#645。user 要望 2026-08-31)。
 *
 * > 「**ヘルプの中からマニュアルをアプリとして出してください。
 * > ちっとも改善していません。少しはこちらの要望を尊重してください**」
 *
 * ## なぜ「面を別窓で開く」ではないのか
 *
 * ⚠ 既に在る `platform/view-window.ts` は **PKC をもう 1 枚**開く。それは
 * #292 で user に否定された形である ──「**ユーザーはもう一つ PKC が開いて
 * 混乱すると思う**」。しかも開いた先でもマニュアルは
 * `max-height: 60vh` の箱の中(`app.css` の `[data-pkc-region='help-manual']`)
 * なので、**読みにくさは 1 ミリも変わらない**。
 *
 * 🔑 user が引き合いに出した Office の窓は **PKC 本体ではない独立した document**
 * である(`platform/office/`)。ここもそちらへ揃える ── 窓の中は
 * **マニュアルだけ**。だから:
 *
 * | | ヘルプ面の中 | この窓 |
 * |---|---|---|
 * | 本文の高さ | `60vh` の箱 | **窓いっぱい** |
 * | 幅 | 左の列と右の情報ペインを引いた残り | **窓いっぱい** |
 * | `Ctrl+F` | アプリと取り合う(#636 で譲るようにした) | **素のブラウザの検索** |
 * | `#見出し` へのリンク | 🔴 **使えない**(面が同一 document に常駐し、`#slug` が本文の面に当たる) | **使える**(この窓には本文の面が居ない) |
 * | 目次 | 無い | **見出し 162 本ぶん** |
 *
 * ## 🔴 飛び先の id は**ここで焼く**(2 か所に分けない)
 *
 * ⚠ 描かれた HTML に `id` が付くのは **h1〜h3 だけ**(実測 162 本中 **77 本**。
 * `markdown-render.ts` の heading id injection)。目次は h4〜h6 も出すので、
 * **足りない分を後から DOM で足す**形にすると、
 * 「目次を作る側」と「id を焼く側」が**別々に数える**ことになる ──
 * CLAUDE.md §7 の「A と B が合意していること」は、どちらの test にも書けない。
 *
 * 🔑 だから **1 つの関数が両方を返す**。目次の `href` と本文の `id` は
 * **同じ走査から出る**ので、食い違いようがない。
 *
 * ## 🔴 id は**見出しの字**から作る(2026-09-04、#648 D4)
 *
 * ⚠ 段①②は**通し番号**(`m-12`)だった ── 焼いた page の URL に残る節の印がそれなので、
 *   ブックマークした節が、**見出しが 1 本増えた版では隣の節を指した**(マニュアルに
 *   「ずれることがあります」と注意書きまで置いていた)。
 * 🔑 見出しの字から作る(`4-4-ヘルプ` / `マニュアルだけのウィンドウで読む-アプリとして開く`)
 *   ── 版をまたいでも**その見出しの字が変わらない限り同じ節**を指す。
 * ⚠ 同じ字の見出しが 2 つ在れば 2 つ目から `-2` `-3` を足す(dead click も取り違えも
 *   作らない)。字が記号だけで slug が空になる見出しは、通し番号(`m-N`)へ落とす。
 * ⚠ **`pkc-` で始めない**(CLAUDE.md §9)── goldens の正規化が
 *   「id らしく見える名前」を機械的に潰す。逃げ道の前置きは `m-` にする。
 *
 * 🔑 **pure module**。browser API を使わない(窓を開くのは adapter の仕事)。
 */
import type { ManualSection } from './manual-find';

/**
 * 字から id を作れない見出し(記号だけ等)に付ける、通し番号の前置き。
 * ⚠ 目次の `href` も同じ値から組む(`buildManualDoc` の中で 1 回だけ決める)。
 */
export const MANUAL_HEADING_ID = 'm-';

/**
 * 見出しの字 → id の芯(重複の `-2` は付けない)。
 *
 * 🔑 規則は **1 つ**:記法の印を落とし、小文字にし、空白・記号(`\p{P}` / `\p{S}` =
 *   句読点・括弧・絵文字・`.` `/` `:` …)の連なりを `-` 1 つに畳み、両端の `-` を落とす。
 *   `### 4-4. ヘルプ` → `4-4-ヘルプ` / `#### 🔴 マニュアルだけのウィンドウで読む(アプリとして開く)`
 *   → `マニュアルだけのウィンドウで読む-アプリとして開く`。
 * ⚠ 日本語はそのまま残す(URL では percent-encode されるが、`location.hash` を読む側が
 *   `decodeURIComponent` するので `getElementById` に届く ── `manual-page.ts` の boot script)。
 * ⚠ 空になりうる(字が絵文字だけ等)── 呼び側が通し番号へ落とす。
 */
export function manualHeadingSlug(title: string): string {
  return label(title)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** 目次の 1 行。 */
export interface ManualTocItem {
  /**
   * 飛び先の id(見出しの字から作る ── `4-4-ヘルプ`)。⚠ 本文に**必ず同じ id が在る**(下の不変量)。
   *
   * 🔴 **`href` ではなく id を持つ**(2026-08-31、実ブラウザの probe で判明)。
   * ⚠ `<a href="#m-3">` にしていたら、**押した瞬間に窓がアプリへ飛んだ** ──
   *   実測: 窓の URL が `about:blank` → **`http://…/#m-100`** に変わり、
   *   マニュアルの中身が丸ごと消えた。`about:blank` は**開いた側の base URL を
   *   引き継ぐ**ので、素の断片リンクが「アプリを開き直す」になる
   *   (= 避けたはずの「PKC がもう 1 枚」を、目次を押すたびに起こす)。
   * 🔑 だから目次は `<button>` で出し、押されたら `scrollIntoView` する。
   */
  readonly targetId: string;
  /** 出す字。⚠ 記法は落としてある(`**強調**` の星を見せない)。 */
  readonly label: string;
  /** `#` の数(1〜6)。段付けに使う。 */
  readonly level: number;
}

export interface ManualDoc {
  /** 見出しに id を焼き、押せない操作子を落とした本文の HTML。 */
  readonly html: string;
  /** 目次。⚠ **本文に飛び先が在る分だけ**(dead click を作らない)。 */
  readonly toc: readonly ManualTocItem[];
  /**
   * 本文に在った見出しの数。
   * ⚠ **test の観測点**である ── 節の数と食い違ったら、
   *   源文の走査(`manualSections`)か描画のどちらかが変わった合図。
   */
  readonly headings: number;
}

/** 見出しの開きタグ。⚠ `<h1` 〜 `<h6` だけ(囲みの中の `#` は描画で字になる)。 */
const HEADING_OPEN = /<h([1-6])(\s[^>]*)?>/giu;

/**
 * 🔴 **押しても何も起きない操作子を取り除く**(2026-08-31、着地前の実地調査が拾った)。
 *
 * 描画はアプリと**同じ関数**なので、コード・表・図の頭に付く「コピー」ボタン
 * (`data-pkc-action="copy-md-block"`)がそのまま焼き込まれる ── ⚠ この窓には
 * **binder が居ない**ので、実測 **106 個**が全部**沈黙する飾り**になる。
 * 🔑 閲覧用 HTML(`pkc3-html.ts`)が**同じ理由で同じことをしている** ──
 *   判定も**同じ狭さ**にする(この action 名だけ。属性名で総なめにすると、
 *   将来 action を持つ本文要素まで消える)。
 */
const COPY_BUTTON =
  /<button\b[^>]*\bdata-pkc-action="copy-md-block"[^>]*>[\s\S]*?<\/button>/giu;

/** 目次に出す字。⚠ 記法の印を落とす(`help.ts` の `findRow` と同じ向き)。 */
function label(title: string): string {
  return title.replace(/[*`_]/gu, '').trim();
}

/**
 * 見出しに id を焼き、目次を組む。
 *
 * ⚠ **既に `id` を持つ見出しも上書きする** ── h1〜h3 の描画の slug をそのまま使うと、
 *   h4〜h6 だけ別の付け方になり、**目次の中で 2 つの規則が混ざる**
 *   (CLAUDE.md §7「判定を増やさない」)。ここの規則 1 本に寄せる。
 * 🔴 **だから、マニュアルに文書内リンク(`[…](#slug)`)を書くとこの窓だけ壊れる。**
 *   ⚠ いまは書けない決まりで(`help.ts` 冒頭 ── 面が同一 document に常駐するため)、
 *   `tests/adapter/help-pane.test.ts` が「マニュアルに `](#` が 0 件」を機械で守って
 *   いる。**その pin がこの上書きの安全網も兼ねている** ── 外すときは、
 *   ここも一緒に見直すこと(`tests/features/manual-doc.test.ts` が両者を結んでいる)。
 *
 * ⚠ **数が食い違ったら、少ないほうに合わせる** ── 目次に「本文に無い飛び先」を
 *   出すと、押しても何も起きない行になる(この repo がいちばん嫌う形)。
 *   食い違い自体は `headings` で見えるので、test が鳴る。
 */
export function buildManualDoc(
  bodyHtml: string,
  sections: readonly ManualSection[],
): ManualDoc {
  /**
   * 🔑 **id は 1 か所で決めて、本文と目次の両方へ配る**(`ids[n]`)。
   * ⚠ 本文の n 番目の見出しの字は**源文の同じ番号の節**から取る(描かれた HTML の
   *   中身を読み直さない ── 「160 = 160」の対応は `manual-find.test.ts` が pin している)。
   *   源文に無い番号(数が食い違ったとき)は通し番号へ落とす。
   * ⚠ 重複は**出た順**に `-2` `-3` ── 目次と本文が同じ配列を見るので食い違いようがない。
   */
  const byIndex = new Map<number, ManualSection>();
  for (const s of sections) if (s.index >= 0) byIndex.set(s.index, s);
  const used = new Map<string, number>();
  const ids: string[] = [];
  const idFor = (index: number): string => {
    const s = byIndex.get(index);
    const stem = (s ? manualHeadingSlug(s.title) : '') || `${MANUAL_HEADING_ID}${index}`;
    const seen = used.get(stem) ?? 0;
    used.set(stem, seen + 1);
    return seen === 0 ? stem : `${stem}-${seen + 1}`;
  };
  let n = 0;
  // ⚠ **先に落とす** ── 見出しの番号を数える前に消しても、見出しの数は変わらない
  //    (コピーボタンは `<h1>` の中には入らない)。順番を変えても結果は同じだが、
  //    「数えたものと出すものが同じ」を読みやすくするため、落としてから数える
  const stripped = bodyHtml.replace(COPY_BUTTON, '');
  const html = stripped.replace(HEADING_OPEN, (_m, level: string, attrs: string | undefined) => {
    const rest = (attrs ?? '').replace(/\sid="[^"]*"/giu, '');
    const id = idFor(n);
    ids.push(id);
    const tag = `<h${level} id="${id}"${rest}>`;
    n += 1;
    return tag;
  });
  const toc: ManualTocItem[] = [];
  for (const s of sections) {
    // ⚠ 番号を持たない節(見出しより前の字)は飛び先が無い
    if (s.index < 0 || s.index >= n) continue;
    toc.push({
      targetId: ids[s.index]!,
      label: label(s.title),
      level: s.level,
    });
  }
  return { html, toc, headings: n };
}
