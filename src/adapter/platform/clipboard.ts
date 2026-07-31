/**
 * Clipboard helpers(PKC2 adapter/ui/clipboard.ts の移植。dep-zero)。
 *
 * - `copyPlainText(text)` — text/plain のみ
 * - `copyMarkdownAndHtml(markdown, html)` — text/plain(ソース)+ text/html
 *   (rendered)を 1 回の write で。貼り付け先が表現を選ぶ(editor → plain、
 *   Word / Slack 等 rich → html)
 *
 * fallback 連鎖: clipboard.write(ClipboardItem) → clipboard.writeText →
 * 隠し textarea + execCommand('copy')。**never throw、boolean を resolve**
 * (caller は成功時だけ flash を出す)。
 */

export async function copyPlainText(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand
    }
  }
  return legacyCopy(text);
}

export async function copyMarkdownAndHtml(
  markdown: string,
  html: string,
): Promise<boolean> {
  const ClipboardItemCtor: typeof ClipboardItem | undefined =
    typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined;

  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === 'function' &&
    ClipboardItemCtor &&
    typeof Blob !== 'undefined'
  ) {
    try {
      const item = new ClipboardItemCtor({
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      // fall through to plain text
    }
  }
  return copyPlainText(markdown);
}

/**
 * legacy fallback。happy-dom は execCommand('copy') を実装しないが throw も
 * しない(undefined が返る)── true 以外は失敗として扱う。
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  let ok: boolean;
  try {
    ta.select();
    ok = document.execCommand?.('copy') === true;
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}
