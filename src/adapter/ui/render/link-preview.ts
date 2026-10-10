/**
 * Internal Link Hover Preview Card.
 *
 * ノート本文中の内部リンク（`entry:<lid>` など）にマウスを合わせた際、
 * 移動することなくその場でリンク先ノートの概要（タイトル、種別、更新日、本文冒頭）を
 * プレビューカード形式で表示する。
 */
import type { Dispatcher } from '../../state/dispatcher';
import type { BinderServices } from '../actions/binder';
import { parseLinkTarget } from '../../../features/entry-ref/link-target';
import { parseFrontmatter } from '../../../features/markdown/frontmatter';

export const LINK_PREVIEW_REGION = 'link-preview';
export const HOVER_DELAY_MS = 300;
export const CLOSE_DELAY_MS = 150;
export const BODY_PREVIEW_MAX_CHARS = 160;

/**
 * 本文 Markdown からプレビュー用のプレーンテキスト冒頭を抽出・成形する。
 */
export function formatBodyPreview(body: string, maxChars = BODY_PREVIEW_MAX_CHARS): string {
  if (!body) return '';
  // frontmatter を除去
  const content = parseFrontmatter(body).body;
  // コードブロック除去
  const noCode = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ');
  // 行ごとに見出し記号・リスト記号・引用記号・HTMLタグ等を除去
  const lines = noCode.split(/\r?\n/);
  const cleanedLines: string[] = [];

  for (const line of lines) {
    let l = line.trim();
    if (!l) continue;
    // 見出し記号 #
    l = l.replace(/^#{1,6}\s+/, '');
    // リスト記号 - * + 1.
    l = l.replace(/^([-*+]|\d+[.)])\s+/, '');
    // 引用記号 >
    l = l.replace(/^>\s*/, '');
    // 画像記法 ![alt](url) -> [画像: alt] (リンク記法より先に置換する)
    l = l.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_m, alt) => (alt ? `[画像: ${alt}]` : '[画像]'));
    // リンク記法 [text](url) -> text
    l = l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // HTML タグ除去
    l = l.replace(/<[^>]+>/g, '');
    l = l.trim();
    if (l) cleanedLines.push(l);
  }

  const combined = cleanedLines.join(' ');
  if (!combined) return '';
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars)}…`;
}

export interface PreviewCardOptions {
  kind: 'entry' | 'not-found' | 'foreign' | 'external';
  lid?: string;
  title?: string;
  archetype?: string;
  date?: string | null;
  bodyChars?: number | null;
  bodyPreview?: string | null;
  loading?: boolean;
  externalUrl?: string;
  externalDomain?: string;
}

function archetypeLabel(archetype?: string): string {
  switch (archetype) {
    case 'text':
      return 'ノート';
    case 'textlog':
      return 'ログ';
    case 'canvas':
      return 'キャンバス';
    default:
      return archetype || 'ノート';
  }
}

/**
 * プレビューカード要素を構築する。
 */
export function renderPreviewCard(doc: Document, opts: PreviewCardOptions): HTMLElement {
  const card = doc.createElement('div');
  card.className = 'pkc-link-preview-card';
  card.setAttribute('data-pkc-region', LINK_PREVIEW_REGION);
  card.setAttribute('role', 'tooltip');
  card.setAttribute('aria-live', 'polite');

  if (opts.kind === 'external') {
    card.classList.add('pkc-link-preview-external');

    // Header: 外部リンクバッジ + ドメイン名
    const header = doc.createElement('div');
    header.className = 'pkc-link-preview-header';

    const badge = doc.createElement('span');
    badge.className = 'pkc-link-preview-archetype';
    badge.setAttribute('data-pkc-archetype', 'external');
    badge.textContent = '外部リンク ↗';
    header.append(badge);

    if (opts.externalDomain) {
      const domainSpan = doc.createElement('span');
      domainSpan.className = 'pkc-link-preview-domain';
      domainSpan.textContent = opts.externalDomain;
      header.append(domainSpan);
    }
    card.append(header);

    // Title (if any, e.g. anchor text or custom title)
    if (opts.title) {
      const title = doc.createElement('div');
      title.className = 'pkc-link-preview-title';
      title.textContent = opts.title;
      card.append(title);
    }

    // URL display
    if (opts.externalUrl) {
      const urlDiv = doc.createElement('div');
      urlDiv.className = 'pkc-link-preview-url';
      urlDiv.textContent = opts.externalUrl;
      card.append(urlDiv);
    }

    // Safety hint footer
    const hint = doc.createElement('div');
    hint.className = 'pkc-link-preview-safe-hint';
    hint.textContent = '新しいタブで開きます';
    card.append(hint);

    return card;
  }

  if (opts.kind === 'not-found') {
    card.classList.add('pkc-link-preview-empty');
    const msg = doc.createElement('div');
    msg.className = 'pkc-link-preview-not-found';
    msg.textContent = 'このノートは存在しません';
    card.append(msg);
    return card;
  }

  if (opts.kind === 'foreign') {
    card.classList.add('pkc-link-preview-foreign');
    const msg = doc.createElement('div');
    msg.className = 'pkc-link-preview-foreign-desc';
    msg.textContent = '別の PKC3 のノート（外部参照）';
    card.append(msg);
    return card;
  }

  // Header: Archetype, Date, Chars
  const header = doc.createElement('div');
  header.className = 'pkc-link-preview-header';

  const badge = doc.createElement('span');
  badge.className = 'pkc-link-preview-archetype';
  badge.setAttribute('data-pkc-archetype', opts.archetype ?? 'text');
  badge.textContent = archetypeLabel(opts.archetype);
  header.append(badge);

  if (opts.date) {
    const dateSpan = doc.createElement('span');
    dateSpan.className = 'pkc-link-preview-date';
    dateSpan.textContent = opts.date.slice(0, 10);
    header.append(dateSpan);
  }

  if (typeof opts.bodyChars === 'number') {
    const charsSpan = doc.createElement('span');
    charsSpan.className = 'pkc-link-preview-chars';
    charsSpan.textContent = `${opts.bodyChars} 文字`;
    header.append(charsSpan);
  }

  card.append(header);

  // Title
  const title = doc.createElement('div');
  title.className = 'pkc-link-preview-title';
  title.textContent = opts.title?.trim() || '（無題のノート）';
  card.append(title);

  // Body preview
  const bodyEl = doc.createElement('div');
  bodyEl.className = 'pkc-link-preview-body';

  if (opts.loading) {
    const loadingSpan = doc.createElement('span');
    loadingSpan.className = 'pkc-link-preview-loading';
    loadingSpan.textContent = '本文を読み込み中…';
    bodyEl.append(loadingSpan);
  } else if (opts.bodyPreview) {
    bodyEl.textContent = opts.bodyPreview;
  } else {
    const emptySpan = doc.createElement('span');
    emptySpan.className = 'pkc-link-preview-empty-hint';
    emptySpan.textContent = '（本文はありません）';
    bodyEl.append(emptySpan);
  }
  card.append(bodyEl);

  return card;
}

/**
 * プレビューカードを画面端ではみ出さないよう反転・クランプして配置する。
 */
export function positionPreviewCard(
  card: HTMLElement,
  anchor: HTMLElement,
  root: HTMLElement,
): void {
  const view = root.ownerDocument.defaultView;
  const vw = view?.innerWidth ?? 0;
  const vh = view?.innerHeight ?? 0;

  const rect = anchor.getBoundingClientRect();
  const box = card.getBoundingClientRect();

  const MARGIN = 8;
  const GAP = 6;

  // 基本は下側中央
  let top = rect.bottom + GAP;
  let left = rect.left + rect.width / 2 - box.width / 2;

  // 下側にはみ出る場合、上側に反転可能であれば上側へ反転
  if (vh > 0 && top + box.height > vh - MARGIN) {
    const topAlternative = rect.top - box.height - GAP;
    if (topAlternative >= MARGIN) {
      top = topAlternative;
    }
  }

  // 左右のクランプ
  if (vw > 0) {
    left = Math.max(MARGIN, Math.min(left, vw - box.width - MARGIN));
  }

  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

/**
 * 出ているプレビューカード。
 * 🔴 **root の直下だけを見る**(#1467)── カードは必ず `root.append(card)` で置く(この file の 4 か所)。
 * ⚠ `root.querySelector` だと、スクロールのたびに(`onScroll` → `close`)文書全体を探していた
 *   (20,000 行のノートで約 3 万要素 ── スクロールの間に約 0.4 秒)。
 */
function previewCardOf(root: HTMLElement): Element | null {
  for (const child of root.children) {
    if (child.getAttribute('data-pkc-region') === LINK_PREVIEW_REGION) return child;
  }
  return null;
}

/** 表示中のプレビューカードを閉じる */
export function closeLinkPreview(root: HTMLElement): void {
  previewCardOf(root)?.remove();
}

/** プレビューカードが表示中かどうか */
export function linkPreviewOpen(root: HTMLElement): boolean {
  return previewCardOf(root) !== null;
}

/**
 * 内部リンクのホバープレビューをセットアップする。
 * 返り値としてアンバインド（クリーンアップ）関数を返す。
 */
export function setupLinkPreview(
  root: HTMLElement,
  dispatcher: Dispatcher,
  services: BinderServices = {},
): () => void {
  const doc = root.ownerDocument;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAnchor: HTMLElement | null = null;
  let activeLid: string | null = null;

  const clearTimers = (): void => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const close = (): void => {
    clearTimers();
    activeAnchor = null;
    activeLid = null;
    closeLinkPreview(root);
  };

  const scheduleClose = (): void => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      close();
    }, CLOSE_DELAY_MS);
  };

  const findAnchor = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    // プレビューカード内の要素は除外
    if (target.closest(`[data-pkc-region="${LINK_PREVIEW_REGION}"]`)) return null;
    // 🔴 `@[card](…)` は `<span data-pkc-action="navigate-card-ref">` で焼かれる(`a` ではない)。
    //   選択子に `a` を付けると card には**一度も当たらない**(#1189)── 要素名を留めない。
    //   ⚠ 外部リンク(`href`)は `a` のまま(`a` 以外の `href` 持ちを拾わない)。
    return target.closest<HTMLElement>(
      'a[data-pkc-entry-ref], a[data-pkc-action="navigate-entry-ref"], [data-pkc-action="navigate-card-ref"], a[href^="http://"], a[href^="https://"]',
    );
  };

  const isInsideCard = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target.closest(`[data-pkc-region="${LINK_PREVIEW_REGION}"]`) !== null;
  };

  const showPreview = (anchor: HTMLElement): void => {
    if (!anchor.isConnected) return;
    const raw =
      anchor.getAttribute('data-pkc-entry-ref') ??
      anchor.getAttribute('data-pkc-card-target') ??
      anchor.getAttribute('href') ??
      '';

    // 外部リンク（http:// または https://）
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      closeLinkPreview(root);
      let domain = '';
      try {
        const u = new URL(raw);
        domain = u.hostname;
      } catch {
        // invalid URL
      }
      const anchorTitle = anchor.getAttribute('title')?.trim() || anchor.textContent?.trim() || '';
      const card = renderPreviewCard(doc, {
        kind: 'external',
        externalUrl: raw,
        externalDomain: domain,
        title: anchorTitle && anchorTitle !== raw ? anchorTitle : undefined,
      });
      root.append(card);
      positionPreviewCard(card, anchor, root);
      activeAnchor = anchor;
      activeLid = null;
      return;
    }

    // 🔴 自分の PKC の id を渡す(#1187)── 渡さないと `foreign` の下見カードが出ない。
    const target = parseLinkTarget(raw, dispatcher.getState().cid ?? '');

    if (target.kind === 'invalid') return;

    closeLinkPreview(root);

    if (target.foreign) {
      const card = renderPreviewCard(doc, { kind: 'foreign' });
      root.append(card);
      positionPreviewCard(card, anchor, root);
      activeAnchor = anchor;
      activeLid = null;
      return;
    }

    const st = dispatcher.getState();
    const meta = st.entryMetas.get(target.lid) ?? null;

    if (!meta) {
      const card = renderPreviewCard(doc, { kind: 'not-found' });
      root.append(card);
      positionPreviewCard(card, anchor, root);
      activeAnchor = anchor;
      activeLid = target.lid;
      return;
    }

    // 本文プレビューの判定:
    // 1. もし現在開いているノート自身なら openBody から即座に抽出
    // 2. それ以外なら readBodies で非同期取得（取得までは loading）
    let initialBodyPreview: string | null = null;
    let loading = false;

    if (st.openBody?.lid === target.lid) {
      initialBodyPreview = formatBodyPreview(st.openBody.body);
    } else if (services.readBodies) {
      loading = true;
    }

    const card = renderPreviewCard(doc, {
      kind: 'entry',
      lid: target.lid,
      title: meta.title,
      archetype: meta.archetype,
      date: meta.updatedAt ?? meta.date,
      bodyChars: meta.bodyChars,
      bodyPreview: initialBodyPreview,
      loading,
    });

    root.append(card);
    positionPreviewCard(card, anchor, root);
    activeAnchor = anchor;
    activeLid = target.lid;

    // 非同期で本文を取得して更新
    if (loading && services.readBodies) {
      const requestedLid = target.lid;
      void services.readBodies([requestedLid]).then((bodies) => {
        // カードが閉じられたか、別のノートに切り替わっていれば反映しない
        if (activeLid !== requestedLid || !activeAnchor?.isConnected) return;
        const currentCard = root.querySelector<HTMLElement>(
          `[data-pkc-region="${LINK_PREVIEW_REGION}"]`,
        );
        if (!currentCard) return;

        const bodyText = bodies.get(requestedLid);
        const bodyPreview = bodyText ? formatBodyPreview(bodyText) : null;

        const bodyEl = currentCard.querySelector('.pkc-link-preview-body');
        if (bodyEl) {
          bodyEl.textContent = '';
          if (bodyPreview) {
            bodyEl.textContent = bodyPreview;
          } else {
            const emptySpan = doc.createElement('span');
            emptySpan.className = 'pkc-link-preview-empty-hint';
            emptySpan.textContent = '（本文はありません）';
            bodyEl.append(emptySpan);
          }
          // 本文が入って高さが変わる可能性があるので位置を再調整
          positionPreviewCard(currentCard, activeAnchor, root);
        }
      });
    }
  };

  const onMouseOver = (ev: MouseEvent): void => {
    if (isInsideCard(ev.target)) {
      // カード内にマウスが入った場合はクローズをキャンセル
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      return;
    }

    const anchor = findAnchor(ev.target);
    if (!anchor) return;

    if (anchor === activeAnchor && linkPreviewOpen(root)) {
      // 同一アンカー上であればクローズをキャンセル
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      return;
    }

    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
    }

    hoverTimer = setTimeout(() => {
      showPreview(anchor);
    }, HOVER_DELAY_MS);
  };

  const onMouseOut = (ev: MouseEvent): void => {
    // 関連ターゲットがアンカーまたはカード内であれば閉じない
    const related = ev.relatedTarget;
    if (isInsideCard(related)) return;
    const relAnchor = findAnchor(related);
    if (relAnchor && relAnchor === activeAnchor) return;

    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }

    if (linkPreviewOpen(root)) {
      scheduleClose();
    }
  };

  const onClick = (): void => {
    close();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      close();
    }
  };

  const onScroll = (): void => {
    close();
  };

  root.addEventListener('mouseover', onMouseOver, true);
  root.addEventListener('mouseout', onMouseOut, true);
  root.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return () => {
    clearTimers();
    closeLinkPreview(root);
    root.removeEventListener('mouseover', onMouseOver, true);
    root.removeEventListener('mouseout', onMouseOut, true);
    root.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    root.removeEventListener('scroll', onScroll, { capture: true });
  };
}
