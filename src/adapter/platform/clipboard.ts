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
 *
 * ## 🔴 履歴へ積むのは**ここ**である(#678、2026-09-09)
 *
 * コピーの口はこの 2 つだけで、そこに**13 か所**が集まっている。
 * ⚠ 呼び側を 1 つずつ拾う形にすると、**次に増えた 1 か所を必ず数え漏らす**
 * (CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ壊しても届かない」)。
 * 🔑 だから口の中で積む ── 呼び側は 1 行も変えない。
 *
 * ⚠ **二重に積まない。** `copyMarkdownAndHtml` は失敗すると
 * `copyPlainText` へ落ちるので、**落ちた先で積む**(rich が通った回だけ、
 * こちらが html つきで積む)。
 * ⚠ **成功した回だけ積む** ── 写せていない物を履歴に出すと、押しても
 * 貼れない行が並ぶ。
 */

import { appCopyHistory } from './copy-history-store';
import type { CopiedItem } from '@features/clipboard/history';

/**
 * 履歴へ積む口。⚠ **既定で本物へ繋いである** ── 差し替え式にして main で配線すると、
 * 落とした日に **tsc も test も黙る**(症状は「コピーしたのに履歴に無い」)。
 * test だけが `setCopyRecorder` で差し替える。
 */
let record: (item: CopiedItem) => void = (item) => {
  appCopyHistory.push(item);
};

/** ⚠ **test 専用**。製品では呼ばない(呼ぶ場所が増えたら、それは配線の分岐である)。 */
export function setCopyRecorder(fn: (item: CopiedItem) => void): () => void {
  const prev = record;
  record = fn;
  return () => {
    record = prev;
  };
}

export async function copyPlainText(text: string): Promise<boolean> {
  const ok = await writePlain(text);
  // ⚠ 成功した回だけ積む(写せていない物を一覧に出さない)
  if (ok) record({ at: Date.now(), text, html: '' });
  return ok;
}

async function writePlain(text: string): Promise<boolean> {
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
      record({ at: Date.now(), text: markdown, html });
      return true;
    } catch {
      // fall through to plain text
    }
  }
  // ⚠ 落ちた先が積む(ここで積むと二重になる)
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
