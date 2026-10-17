/**
 * 見出しのアンカーリンク（章・見出し参照リンク）ワンクリックコピー (Issue #1124).
 *
 * 各見出し（h1〜h6）に控えめなアンカーボタン（#）を添え、
 * クリック時にその見出しへの内部リンク記法（[見出し名](entry:<lid>#h/<見出しの id>)）を
 * クリップボードにコピーする。
 *
 * ⚠ 書く形は右クリックの「章の参照をコピー」(`copy-section-ref`)と同じ `formatSectionLink` 1 本。
 *   以前は `entry:<lid>#<slug>` を書いていたが、読む側(`parseEntryRef`)が受けるのは `#h/<id>` で、
 *   日本語の見出しは「解けないリンク」になっていた。
 * ⚠ 描画が id を刻むのは h1〜h3 だけ(`markdown-render.ts` の heading_open)── id の無い見出しには
 *   ボタンを付けない(貼っても飛べないリンクを渡さない。右クリックの章の参照も同じ理由で出さない)。
 */
import { copyPlainText } from '@adapter/platform/clipboard';
import { flashCopied } from '../actions/copy-md-block';
import { formatSectionLink } from '@features/entry-ref/entry-ref-format';

export const HEADING_ANCHOR_FIELD = 'heading-anchor';
/** コピーに失敗したとき、ボタンから上へ伝える合図(binder が画面下に言う。`inline-code-copy.ts` と同じ作り)。 */
export const HEADING_ANCHOR_COPY_FAILED_EVENT = 'pkc-heading-anchor-copy-failed';
const ANCHOR_TITLE = '見出しの参照をコピー(本文に貼ります)';

/**
 * 見出し要素から純粋なテキストを抽出する。
 * （内部に含まれる折りたたみボタンやアンカーボタン等の記号文字を除外）
 */
export function extractHeadingText(heading: Element): string {
  const clone = heading.cloneNode(true) as Element;
  for (const btn of clone.querySelectorAll('button')) {
    btn.remove();
  }
  return clone.textContent?.trim() || '';
}

/**
 * 見出しのアンカーリンク記法を生成する。
 * 例: `[概要](entry:abc123#h/概要)`(ラベルの `]` などは escape される)
 */
export function buildHeadingLink(lid: string, id: string, text: string): string {
  return formatSectionLink(text || id, lid, id);
}

/**
 * 🔴 **主でない面(横に留めた枠)の本文の器に焼く、`id` の接頭辞**(#1087 A7)。
 * ⚠ 見出しの `id` には接頭辞が付いている(同じ document で重ならないように)が、**コピーするリンクには
 *   付けない**(リンクの受け手は接頭辞を持たない `id` で探す)。付ける / 外すを 1 か所で揃える。
 */
export const ID_PREFIX_ATTR = 'data-pkc-id-prefix';

/**
 * 本文内の見出し（h1〜h6）にアンカーコピーボタンを付与する。
 */
export function applyHeadingAnchors(root: Element, lid: string | null): void {
  if (!lid) return;

  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const heading of headings) {
    // 既存のボタンがあればスキップ（冪等性）
    if (heading.querySelector(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`)) continue;

    const text = extractHeadingText(heading);
    // 描画が刻んだ id をそのまま使う(計算し直さない。同名見出しの連番がずれる)。無ければ付けない
    const rawSlug = heading.getAttribute('id');
    if (!rawSlug) continue;
    const prefix = root.getAttribute(ID_PREFIX_ATTR) ?? '';
    const slug = prefix !== '' && rawSlug.startsWith(prefix) ? rawSlug.slice(prefix.length) : rawSlug;

    const btn = heading.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'pkc-heading-anchor';
    btn.setAttribute('data-pkc-field', HEADING_ANCHOR_FIELD);
    btn.setAttribute('aria-label', `「${text}」への参照をコピー`);
    btn.setAttribute('title', ANCHOR_TITLE);

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const link = buildHeadingLink(lid, slug, text);
      void copyPlainText(link).then((ok) => {
        if (!ok) {
          btn.dispatchEvent(new CustomEvent(HEADING_ANCHOR_COPY_FAILED_EVENT, { bubbles: true }));
          return;
        }
        flashCopied(btn);
        btn.classList.add('pkc-copied');
        btn.setAttribute('title', '参照をコピーしました');
        setTimeout(() => {
          btn.classList.remove('pkc-copied');
          btn.setAttribute('title', ANCHOR_TITLE);
        }, 1500);
      });
    });

    heading.append(btn);
  }
}
