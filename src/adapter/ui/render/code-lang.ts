/**
 * Code Block Language Badge (Issue #1128).
 *
 * フェンス付きコードブロック（<pre><code class="language-xxx">）に
 * 指定されたプログラミング言語・データ形式のラベルバッジを表示する。
 */

/**
 * 除外する汎用・擬似言語名。
 * これらはプログラミング言語・形式としての意味が薄いためバッジを表示しない。
 */
const IGNORED_LANGS = new Set([
  '',
  'none',
  'text',
  'plain',
  'plaintext',
  'raw',
]);

/**
 * プレビュー内のコードブロック要素に言語名バッジを付与する。
 * 冪等性: 既に .pkc-code-lang が付いているブロックには重複追加しない。
 */
export function applyCodeLangBadges(host: HTMLElement): void {
  const blocks = host.querySelectorAll<HTMLElement>('.pkc-md-block[data-pkc-md-block-kind="code"]');
  for (const block of blocks) {
    if (block.querySelector('.pkc-code-lang')) continue;

    const codeEl = block.querySelector<HTMLElement>('pre > code[class*="language-"]');
    if (!codeEl) continue;

    // 🔴 ```3d は器の中の原文(language-json)ではなく、囲みの言語(3d)を出す ── 3D ビューアの上段と二重見出しにしない(V-6)
    const lang = block.getAttribute('data-pkc-render-lang') === '3d' ? '3D' : extractLanguageName(codeEl.className);
    if (!lang || IGNORED_LANGS.has(lang.toLowerCase())) continue;

    const badge = block.ownerDocument.createElement('span');
    badge.className = 'pkc-code-lang';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = lang;

    block.prepend(badge);
  }
}

/**
 * class 文字列（例: "language-typescript", "hljs language-json" 等）から
 * 言語名を取り出す。
 */
export function extractLanguageName(className: string): string | null {
  const match = /(?:^|\s)language-([\w#+.-]+)(?:\s|$)/.exec(className);
  return match && match[1] ? match[1].trim() : null;
}
