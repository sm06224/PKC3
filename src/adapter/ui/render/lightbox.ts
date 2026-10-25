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
  diagram?: { kind: 'mermaid' | 'chart' | 'plotly'; source: string };
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
    openWinBtn.title = '別のウィンドウで開く';
    openWinBtn.setAttribute('aria-label', '別のウィンドウで開く');
    openWinBtn.textContent = '⧉';
    openWinBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const opened = services.viewBig?.(opts.src, opts.alt || '図', opts.diagram, opts.defaultView);
      /**
       * 🔴 **別のウィンドウが開けたときだけ、この拡大を閉じる**(台帳 #1852 束 T1、依頼 99-2 C)。直す前は ⧉ を押した後も
       *   暗い拡大が本文を覆ったままだった(別のウィンドウは「本文を書きながら見る」ための物)。
       *   開けなかったとき(ポップアップが止められた等)は閉じない ── 理由の知らせ(`OP_FAILED`)を読め、拡大のまま使える。
       * ⚠ 開く側は非同期(図は描き起こす)なので、結果は `Promise<boolean>`。返さない呼び手(`void`)は閉じない側へ倒す。
       *   ⚠ 待っている間に user が閉じた / 別の拡大を開いたなら触らない(`isConnected`)。
       */
      void Promise.resolve(opened).then((ok) => {
        if (ok === true && overlay.isConnected) onClose?.();
      });
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

  // 🔴 開く前の焦点を控え、✕ へ移す(#1087)。閉じるとき {@link closeLightbox} が返す
  const doc2 = root.ownerDocument;
  const prev = doc2.activeElement;
  root.append(overlay);
  restoreBase.set(root, prev instanceof HTMLElement ? prev : null);
  overlay.querySelector<HTMLElement>('.pkc-lightbox-close-btn')?.focus();
  // ⚠ aria-modal の約束 ── Tab は中だけを巡る。
  // 🔴 overlay ではなく **document の capture** に置く ── 焦点が <body> に落ちている
  //    (外を押した直後など)と keydown は overlay を通らず、Tab が外へ抜ける。Escape と同じ置き方。
  const onTab = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Tab' || !overlay.isConnected) return;
    const btns = [...overlay.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    if (btns.length === 0) return;
    const first = btns[0]!;
    const last = btns[btns.length - 1]!;
    const act = doc2.activeElement;
    if (ev.shiftKey && (act === first || !overlay.contains(act))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (act === last || !overlay.contains(act))) {
      ev.preventDefault();
      first.focus();
    }
  };
  doc2.addEventListener('keydown', onTab, true);
  tabTrapOff.set(root, () => doc2.removeEventListener('keydown', onTab, true));
}

/** 開いている間だけ張る Tab の見張りの外し方(閉じるとき必ず呼ぶ)。 */
const tabTrapOff = new WeakMap<HTMLElement, () => void>();

const restoreBase = new WeakMap<HTMLElement, HTMLElement | null>();

/** ライトボックスを閉じる */
export function closeLightbox(root: HTMLElement): void {
  tabTrapOff.get(root)?.();
  tabTrapOff.delete(root);
  const el = root.querySelector(`[data-pkc-region="${LIGHTBOX_REGION}"]`);
  if (el === null) return;
  const doc = root.ownerDocument;
  const active = doc.activeElement;
  // 焦点が中か <body> のときだけ返す(別の所へ移していたら奪わない)
  const mine = active === null || active === doc.body || el.contains(active);
  const back = restoreBase.get(root) ?? null;
  restoreBase.delete(root);
  el.remove();
  if (mine && back !== null && back.isConnected) back.focus();
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
