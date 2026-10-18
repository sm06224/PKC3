/**
 * 🔴 **リンク先のノートが無い内部リンクを、押す前に見分けられるようにする**(#1174 段①)。
 *
 * ## 何をするか
 * - 本文の読む面で、`[題名](entry:<lid>)` / `pkc://<自分>/entry/<lid>` /
 *   `@[card](entry:<lid>)` のうち、**指す lid が `entryMetas` に無い**ものへ
 *   `data-pkc-link-missing` と `title`(「このノートは見つかりません…」)を付ける。
 *   見た目は点線の下線だけ(字の色は変えない ── CSS は `app.css` の 1 規則)。
 * - 無い理由は 3 通り:ゴミ箱へ移した / 取り込みで落ちた / 別の PKC から貼った。
 *   どれも押すと「リンク先のノートが見つかりません」になる(`navigateToLink`)ので、
 *   **その答えを押す前に出す**のがこの面の仕事である。
 * - 別の PKC を指す携帯参照(`foreign`)は**触らない** ── あれは「無い」ではなく
 *   「別の PKC にある」で、押したときの答えも違う。
 *
 * ## 🔑 なぜ描画後の DOM 走査か
 * markdown は worker で描かれ、`entryMetas` を持っていない(`applyExternalLinks` と
 * 同じ事情)。だから描いた後に host へ当てる。⚠ 冪等 ── 塊が差し替わると属性が
 * 消えるので、描画のたびに呼ぶ。
 *
 * ## 🔑 戻したら消える
 * 本文の指紋は `entryMetas` を含まないので、ゴミ箱から戻しても本文は描き直されない。
 * だから `has` が真になったものは**属性ごと外す**(`detail.ts` が `entryMetas` の参照が
 * 変わったときに、描き直さずにもう一度これだけを当てる)。
 *
 * ## ⚠ 当てない面(わざと)
 * 中央の読む面だけ(`↗` と同じ)。**プレビュー / 章の別窓 / 書き出した HTML は当てない** ──
 * 書き出した HTML は `entryMetas` を持たず、**1 バイトも変えない**と決めてある
 * (書き出しの file には触れていない)。別窓は本体と `entryMetas` を共有しない。
 *
 * ⚠ **title は user が付けたものを潰さない** ── 空のときだけ書き、消すのも自分の字のときだけ。
 */
import { parseLinkTarget } from '@features/entry-ref/link-target';

/** 押す前に出す言葉(`ui-terms` の使わない語を含まない)。 */
export const MISSING_LINK_TITLE = 'このノートは見つかりません(ゴミ箱にあれば戻せます。ゴミ箱は左のペインの「フォルダ」の中です)';

export const MISSING_ATTR = 'data-pkc-link-missing';

/** 内部リンクの 2 つの焼かれ方(`entry:` / `pkc://` は `data-pkc-entry-ref`、card は `data-pkc-card-target`)。 */
const SELECTOR = 'a[data-pkc-entry-ref], [data-pkc-card-target]';

/**
 * @param has その lid のノートが在るか(`state.entryMetas.has`)
 * @param selfContainerId 自分のコンテナ id。⚠ 渡さないと `pkc://<外>/…` を外と見なせない
 */
export function applyMissingLinks(
  host: ParentNode,
  has: (lid: string) => boolean,
  selfContainerId = '',
): void {
  for (const el of host.querySelectorAll<HTMLElement>(SELECTOR)) {
    const raw =
      el.getAttribute('data-pkc-entry-ref') ?? el.getAttribute('data-pkc-card-target') ?? '';
    const t = parseLinkTarget(raw, selfContainerId);
    // 読めない形 / 別の PKC は「無い」と言えない ── 触らない(付いていたら外す)
    const missing = t.kind === 'entry' && !t.foreign && !has(t.lid);
    if (missing) {
      if (!el.hasAttribute(MISSING_ATTR)) el.setAttribute(MISSING_ATTR, '');
      const cur = el.getAttribute('title');
      if (cur === null || cur.trim() === '') el.setAttribute('title', MISSING_LINK_TITLE);
    } else if (el.hasAttribute(MISSING_ATTR)) {
      el.removeAttribute(MISSING_ATTR);
      if (el.getAttribute('title') === MISSING_LINK_TITLE) el.removeAttribute('title');
    }
  }
}

/**
 * 🔴 **`@[card](entry:…)` の枠の字を、指したノートの題名にする**(台帳 #1852 束 R1、依頼 94-1 A)。
 *
 * 以前は「@card」と書いた点線の灰色の枠で、どのノートかは押すかマウスを載せるまで分からなかった
 * (ふつうのリンクは題名が出る)。枠の見た目は今のまま、中の字だけを題名にする。
 * ⚠ ノートが無い / 別の PKC を指す / 添付を指す枠は、元の字のまま(無いノートは `applyMissingLinks` の点線の下線で見分ける)。
 * 🔑 markdown は worker で描かれ `entryMetas` を持たないので、描いた後に host へ当てる(`applyMissingLinks` と同じ事情)。
 *    冪等 ── 字が同じなら触らない。
 */
export function applyCardTitles(
  host: ParentNode,
  titleOf: (lid: string) => string | undefined,
  selfContainerId = '',
): void {
  for (const el of host.querySelectorAll<HTMLElement>('.pkc-card-placeholder[data-pkc-card-target]')) {
    const t = parseLinkTarget(el.getAttribute('data-pkc-card-target') ?? '', selfContainerId);
    if (t.kind !== 'entry' || t.foreign) continue;
    const title = titleOf(t.lid);
    if (title === undefined || title.trim() === '') continue;
    if (el.textContent !== title) el.textContent = title;
  }
}

/** 付けた印をすべて外す(設定を切ったとき)。 */
export function clearMissingLinks(host: ParentNode): void {
  applyMissingLinks(host, () => true);
}
