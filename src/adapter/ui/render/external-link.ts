/**
 * 🔴 **Markdown プレビュー内の外部リンク識別と安全なドメイン表示**(#1152)。
 *
 * ## 何をするか
 * - ノートのプレビュー画面内に表示される外部 Web サイトへのリンク（`http://` または `https://`）の末尾に、
 *   控えめな外部リンクインジケータ（`↗`、`.pkc-external-link-icon`）を表示する。
 * - リンク先ドメイン（ホスト名）を抽出してツールチップ（`title="外部サイトを開く: <hostname>"`）を設定し、
 *   意図しない外部タブ展開や不審なリンクの誤クリックを未然に防止する。
 * - 画像のみを含むリンク（テキストを持たない画像バナーリンク等）は視覚ノイズを防ぐため除外する。
 * - 内部ノートリンク（`entry:...`, `[[...]]`）やアンカーリンク（`#...`）は対象外とする。
 */

/**
 * URL 文字列から表示用のホスト名（ドメイン名）を安全に抽出する。
 */
export function extractHostname(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 指定されたリンクが外部リンク装飾の対象かどうかを判定する。
 */
export function isDecoratableExternalLink(anchor: HTMLAnchorElement): boolean {
  const href = anchor.getAttribute('href') ?? '';
  const trimmed = href.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return false;
  }

  // 画像のみを含み、テキストを持たないリンクは除外
  const hasImg = anchor.querySelector('img') !== null;
  const text = anchor.textContent?.trim() ?? '';
  if (hasImg && text === '') {
    return false;
  }

  return true;
}

/**
 * ホスト要素配下の Markdown 外部リンクにアイコンとドメイン情報を付与する。
 * 冪等に動作し、既に付与済みのリンクは二重処理しない。
 */
export function applyExternalLinks(root: ParentNode = document): void {
  const anchors = root.querySelectorAll<HTMLAnchorElement>('.pkc-md-rendered a[href]');
  for (const anchor of anchors) {
    if (anchor.hasAttribute('data-pkc-external-link-ready')) continue;
    anchor.setAttribute('data-pkc-external-link-ready', 'true');

    if (!isDecoratableExternalLink(anchor)) continue;

    const href = anchor.getAttribute('href') ?? '';
    const hostname = extractHostname(href);
    if (!hostname) continue;

    anchor.setAttribute('data-pkc-external-link', 'true');

    // 既存の title が空、または href と同一の場合はドメイン注記付き title を設定
    const currentTitle = anchor.getAttribute('title');
    if (!currentTitle || currentTitle.trim() === '' || currentTitle.trim() === href.trim()) {
      anchor.setAttribute('title', `外部サイトを開く: ${hostname}`);
    }

    const icon = document.createElement('span');
    icon.className = 'pkc-external-link-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '↗';
    anchor.appendChild(icon);
  }
}
