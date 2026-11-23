/**
 * 🔴 **左端の縦のバー**(#1982 ③-a-1。user 裁定 2026-11-22「縦のバー(40px)常設」)。
 *
 * ## user から見て何が変わるか
 *
 * 左のペインの上に詰めていた「探し方」のタブ(フォルダ / アプリ / 予定 / …)と、下にあった
 * アプリ全体の操作(取り込む / バックアップ / 操作を探す / 集計 / システム / フラグ / ヘルプ)を、
 * 画面の左端の 40px の縦のバーへ**図案で**並べる。左のペインを畳んでもバーは残る
 * (以前の「畳んだ縁」`collapsed-edge.ts` はこのバーに一本化した)。
 *
 * ## 🔴 登記簿を 2 つにしない(ボタンを 2 組作らない)
 *
 * バーの中身は**新しく組まない** ── `shell.ts` が左のペインの中に建てた 2 つの器
 * (`browse-tabs` / `collection-bar`)を、**同じ DOM の物のまま**バーへ移す。スマホ用画面では
 * 左のペインの元の場所へ戻す。だから同じ `data-pkc-action` のボタンが DOM に 2 組居ることは無い
 * (受け手・検査が「最初の 1 件」を引く前提を守る)。
 *
 * ## 作り
 *
 * - 呼び手は `applyPaneVisibility` の 1 か所(版面の入れ替えも畳みの適用も、必ずここを通る)。
 * - **何度呼んでも同じ結果**で、既に正しい場所に居れば動かさない(動かすと押しているボタンの焦点が飛ぶ)。
 * - 上の群(タブ)は高さが足りなければ**群の中だけ**縦に送る。下の群は常に全部見えて押せる(CSS)。
 */
import { syncNeonPhone } from './neon-glow';

const RAIL = 'rail';
const CREATE_BAR = 'create-bar';
const MESSAGE_ENTRY = '[data-pkc-field="message-entry"]';
const TABS = 'browse-tabs';
const BAR = 'collection-bar';
/** バーの中のタブ群の読み上げ名。 */
export const RAIL_TABS_LABEL = '探し方';
/** バーの中の操作群の読み上げ名(旧い畳んだ縁と同じ字)。 */
export const RAIL_BAR_LABEL = 'アプリ全体の操作';

/** shell の**直下**の子から引く(`:scope` の対応は環境で揺れるので、子を直に見る)。 */
function childOf(parent: Element, region: string): HTMLElement | null {
  for (const el of Array.from(parent.children)) if (el.getAttribute('data-pkc-region') === region) return el as HTMLElement;
  return null;
}

/** shell の中のどこかに居る器(バーか左のペイン)。 */
function find(shell: HTMLElement, region: string): HTMLElement | null {
  return shell.querySelector<HTMLElement>(`[data-pkc-region="${region}"]`);
}

/**
 * 図案だけで並ぶ間も**名前を持たせる**(`aria-label` + `title`)。⚠ `title` は組み立て側
 * (`collectionBarButton` の説明 + 鍵の綴り、`applyShortcutHints`)が持っていればそちらを残す。
 */
function nameButtons(group: HTMLElement): void {
  for (const btn of group.querySelectorAll<HTMLElement>('button')) {
    const label = btn.querySelector('[data-pkc-field="label"], [data-pkc-field="cmd-label"]')?.textContent?.trim() ?? '';
    if (label === '') continue;
    if (!btn.hasAttribute('aria-label')) btn.setAttribute('aria-label', label);
    if (btn.title === '') btn.title = label;
  }
}

/**
 * 🔴 **メッセージの入口をスマホ幅では「作る」の行へ移す**(2026-11-23)。
 *
 * ⚠ 左のペインの下の操作の列(`collection-bar`)は、スマホ幅で**8 個が 1 行**に収まる幅しか無い(44px のタイル)── 9 個目の入口を
 *   足すと、いちばん後ろから「⋯」の下へ畳まれて**システムが 1 段奥へ行く**。そこで**同じボタンを**一覧のページの「作る」の行の末尾へ
 *   移す(新しく作らない ── 登記は `collectionBarItems()` の 1 件のまま)。PC の幅では元の場所(バーの下の群の最後)へ戻す。
 * ⚠ 本文のページは上のバー(`phone-bar`)の入口がある。一覧のページ・本文のページのどちらからも届く。
 */
function placeMessageEntry(shell: HTMLElement, phone: boolean): void {
  const entry = shell.querySelector<HTMLElement>(`[data-pkc-region="collection-bar"] ${MESSAGE_ENTRY}, [data-pkc-region="${CREATE_BAR}"] ${MESSAGE_ENTRY}`);
  const bar = find(shell, BAR);
  const create = find(shell, CREATE_BAR);
  if (entry === null || bar === null || create === null) return;
  if (phone) {
    if (entry.parentElement !== create) create.append(entry);
    return;
  }
  const group = bar.querySelector<HTMLElement>('[data-pkc-field="collection-app-group"]');
  if (group !== null && entry.parentElement !== group) group.append(entry);
}

/**
 * バーへ載せる / 左のペインへ戻す。
 *
 * @param phone スマホ用画面か(バーを出さず、元の場所へ戻す)
 * @returns バー(スマホ用画面では `null`)
 */
export function paintRail(shell: HTMLElement, phone: boolean): HTMLElement | null {
  const rail = childOf(shell, RAIL);
  const sidebar = childOf(shell, 'sidebar');
  if (rail === null || sidebar === null) return null;
  const tabs = find(shell, TABS);
  const bar = find(shell, BAR);
  // 🔴 輪郭の近接発光(B2。左のバーのボタン・ログ・情報ペイン共通)の付け外しも版面の入れ替えと同じ 1 か所で(スマホ用画面では付けない)
  syncNeonPhone(phone);
  placeMessageEntry(shell, phone);
  if (phone) {
    rail.hidden = true;
    // 🔑 元の場所: タブは「探す欄」の前、操作は左のペインの最後(`shell.ts` の建て順)
    if (tabs !== null && tabs.parentElement !== sidebar) {
      const anchor = childOf(sidebar, 'find-bar');
      if (anchor !== null) anchor.before(tabs);
      else sidebar.prepend(tabs);
      tabs.removeAttribute('aria-orientation');
    }
    if (bar !== null && bar.parentElement !== sidebar) {
      sidebar.append(bar);
      bar.removeAttribute('role');
      bar.removeAttribute('aria-orientation');
      bar.removeAttribute('aria-label');
    }
    return null;
  }
  rail.hidden = false;
  if (tabs !== null && tabs.parentElement !== rail) {
    rail.prepend(tabs);
    tabs.setAttribute('aria-orientation', 'vertical');
    if (!tabs.hasAttribute('aria-label')) tabs.setAttribute('aria-label', RAIL_TABS_LABEL);
    nameButtons(tabs);
  }
  if (bar !== null && bar.parentElement !== rail) {
    rail.append(bar);
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-orientation', 'vertical');
    bar.setAttribute('aria-label', RAIL_BAR_LABEL);
    nameButtons(bar);
  }
  return rail;
}

/** ボタンがバーの中に居るか(バーの中だけの振る舞い ── 現在地をもう一度押すと左のペインを畳む ── の判定)。 */
export function inRail(el: Element): boolean {
  return el.closest(`[data-pkc-region="${RAIL}"]`) !== null;
}
