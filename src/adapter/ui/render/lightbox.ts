/**
 * In-place Image Lightbox Modal.
 *
 * ノート本文中の画像や図をクリックした際、別ウィンドウへ飛ばずに
 * その場で暗転オーバーレイ（モーダル拡大）を表示する。
 * Esc キー、背景クリック、右上の「✕」ボタンで即座に閉じる。
 * 必要に応じて別ウィンドウへ切り出せる「別窓で開く（⧉）」ボタンも備える。
 */
import type { BinderServices } from '../actions/binder';

export const LIGHTBOX_REGION = 'lightbox';

export interface LightboxOptions {
  src: string;
  alt?: string;
  diagram?: { kind: 'mermaid' | 'chart'; source: string };
  defaultView?: Window;
}

/**
 * ライトボックスオーバーレイ要素を生成する。
 */
export function renderLightboxOverlay(
  doc: Document,
  opts: LightboxOptions,
  services?: BinderServices,
  onClose?: () => void,
): HTMLElement {
  const overlay = doc.createElement('div');
  overlay.className = 'pkc-lightbox-overlay';
  overlay.setAttribute('data-pkc-region', LIGHTBOX_REGION);
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', opts.alt || '画像拡大プレビュー');

  const backdrop = doc.createElement('div');
  backdrop.className = 'pkc-lightbox-backdrop';
  backdrop.setAttribute('data-pkc-action', 'close-lightbox');
  overlay.append(backdrop);

  const container = doc.createElement('div');
  container.className = 'pkc-lightbox-container';

  // Toolbar
  const toolbar = doc.createElement('div');
  toolbar.className = 'pkc-lightbox-toolbar';

  const titleSpan = doc.createElement('span');
  titleSpan.className = 'pkc-lightbox-title';
  titleSpan.textContent = opts.alt || '図';
  toolbar.append(titleSpan);

  const actions = doc.createElement('div');
  actions.className = 'pkc-lightbox-actions';

  if (services?.viewBig) {
    const openWinBtn = doc.createElement('button');
    openWinBtn.className = 'pkc-lightbox-btn pkc-lightbox-open-win-btn';
    openWinBtn.type = 'button';
    openWinBtn.title = '別ウィンドウで開く';
    openWinBtn.setAttribute('aria-label', '別ウィンドウで開く');
    openWinBtn.textContent = '⧉';
    openWinBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      services.viewBig?.(opts.src, opts.alt || '図', opts.diagram, opts.defaultView);
    });
    actions.append(openWinBtn);
  }

  const closeBtn = doc.createElement('button');
  closeBtn.className = 'pkc-lightbox-btn pkc-lightbox-close-btn';
  closeBtn.type = 'button';
  closeBtn.setAttribute('data-pkc-action', 'close-lightbox');
  closeBtn.title = '閉じる (Esc)';
  closeBtn.setAttribute('aria-label', '閉じる');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClose?.();
  });
  actions.append(closeBtn);

  toolbar.append(actions);
  container.append(toolbar);

  // Content
  const content = doc.createElement('div');
  content.className = 'pkc-lightbox-content';

  const img = doc.createElement('img');
  img.className = 'pkc-lightbox-img';
  img.src = opts.src;
  img.alt = opts.alt || '図';
  content.append(img);

  container.append(content);
  overlay.append(container);

  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClose?.();
  });

  return overlay;
}

/** ライトボックスを開く */
export function openLightbox(
  root: HTMLElement,
  opts: LightboxOptions,
  services?: BinderServices,
): void {
  closeLightbox(root);

  const doc = root.ownerDocument;
  const overlay = renderLightboxOverlay(doc, opts, services, () => {
    closeLightbox(root);
  });

  root.append(overlay);
}

/** ライトボックスを閉じる */
export function closeLightbox(root: HTMLElement): void {
  root.querySelector(`[data-pkc-region="${LIGHTBOX_REGION}"]`)?.remove();
}

/** ライトボックスが表示中か */
export function lightboxOpen(root: HTMLElement): boolean {
  return root.querySelector(`[data-pkc-region="${LIGHTBOX_REGION}"]`) !== null;
}

/**
 * ライトボックス用のイベント監視をセットアップする。
 * Esc キーによるクローズおよび画像クリック時のライトボックス起動を処理する。
 */
export function setupLightbox(
  root: HTMLElement,
): () => void {
  const doc = root.ownerDocument;

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && lightboxOpen(root)) {
      ev.stopPropagation();
      closeLightbox(root);
    }
  };

  doc.addEventListener('keydown', onKeyDown, true);

  return () => {
    closeLightbox(root);
    doc.removeEventListener('keydown', onKeyDown, true);
  };
}
