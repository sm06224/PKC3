/**
 * 見出しのアンカーリンク（章・見出し参照リンク）ワンクリックコピー (Issue #1124).
 *
 * 各見出し（h1〜h6）に控えめなアンカーボタン（#）を添え、
 * クリック時にその見出しへの内部リンク記法（[見出し名](entry:<lid>#<slug>)）を
 * クリップボードにコピーする。
 */
import { copyPlainText } from '@adapter/platform/clipboard';
import { flashCopied } from '../actions/copy-md-block';
import { slugifyHeading } from '@features/markdown/markdown-toc';

export const HEADING_ANCHOR_FIELD = 'heading-anchor';

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
 * 例: `[概要](entry:abc123#summary)`
 */
export function buildHeadingLink(lid: string, slug: string, text: string): string {
  const label = text || slug;
  return `[${label}](entry:${lid}#${slug})`;
}

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
    const slug = heading.getAttribute('id') || slugifyHeading(text);
    if (!slug) continue;

    const btn = heading.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'pkc-heading-anchor';
    btn.setAttribute('data-pkc-field', HEADING_ANCHOR_FIELD);
    btn.setAttribute('aria-label', `「${text}」への参照リンクをコピー`);
    btn.setAttribute('title', '見出しの参照リンクをコピー');

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const link = buildHeadingLink(lid, slug, text);
      void copyPlainText(link).then((ok) => {
        if (!ok) return;
        flashCopied(btn);
        btn.classList.add('pkc-copied');
        btn.setAttribute('title', 'リンクをコピーしました！');
        setTimeout(() => {
          btn.classList.remove('pkc-copied');
          btn.setAttribute('title', '見出しの参照リンクをコピー');
        }, 1500);
      });
    });

    heading.append(btn);
  }
}
