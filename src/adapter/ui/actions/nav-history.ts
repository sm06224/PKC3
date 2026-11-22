/**
 * 🔴 **マウスの戻る・進むボタンと、PC のブラウザの「戻る」を、ノートの戻る・進むへつなぐ**(A1。user 裁定 2026-11-22)。
 *
 * ## 3 つの入口
 * 1. マウスの戻る / 進むボタン(`pointerup` の `button === 3 / 4`)→ `nav-back` / `nav-forward`。
 *    ⚠ ブラウザ自身の戻る(履歴の移動)は `mouseup` の既定動作 ── そこで `preventDefault` して止める。
 * 2. ブラウザの「戻る」(キー・ボタン・止めきれなかったマウスの戻る)→ **番兵**の項目を 1 つ履歴に置き、それが消費されたら
 *    アプリの中で 1 つ戻って、番兵を置き直す(スマホの `phone-back.ts` と同じ考え方。アドレスは変えない = `pushState` に URL を渡さない)。
 *    ⚠ ブラウザの「進む」は対象外(番兵は戻る側にしか置けない ── user 裁定)。
 *    ⚠ アプリの中で戻れないとき(履歴が 1 件以下)は番兵を置かない ── 次の「戻る」は普通にページを離れる(閉じ込めない)。
 * 3. アプリの中の `‹ ›`(PWA のときだけ出す ── CSS と `standalone.ts`)は今までどおり `nav-back` / `nav-forward` の口。
 *
 * ## 🔴 二重発火を防ぐ(user 必須ガード)
 * マウスの戻るボタン 1 回で、①`pointerup` の受け手 と ②ブラウザ自身の戻る(番兵の `popstate`)の両方が走ると **2 回戻る**。
 * ①で戻ったら、その直後(`MOUSE_NAV_SUPPRESS_MS`)に来た番兵の `popstate` は**戻らずに番兵を置き直すだけ**にする。
 *
 * ⚠ スマホの幅では何もしない(履歴は `phone-back.ts` が持つ ── 2 つが同時に番兵を置かない)。
 */

/** マウスの戻るボタンで戻った直後、ブラウザ自身の戻る(番兵の popstate)を無視する時間。 */
export const MOUSE_NAV_SUPPRESS_MS = 800;

/** マウスの「戻る」「進む」ボタンの番号(`PointerEvent.button`)。 */
export const MOUSE_BACK_BUTTON = 3;
export const MOUSE_FORWARD_BUTTON = 4;

export interface NavHistoryDeps {
  back(): void;
  forward(): void;
  /** アプリの中で戻れるか(番兵を置くか)。 */
  canBack(): boolean;
  /** スマホの幅か(そのときは何もしない)。 */
  isPhone(): boolean;
  /** 状態が変わったら呼ぶ口(番兵を置く / 畳む判断をやり直す)。外す関数を返す。 */
  onChange(cb: () => void): () => void;
  readonly win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout'>;
  readonly hist?: Pick<History, 'pushState' | 'back'>;
  readonly now?: () => number;
}

/** @returns 外す関数 */
export function installNavHistory(d: NavHistoryDeps): () => void {
  const win = d.win ?? window;
  const hist = d.hist ?? history;
  const now = d.now ?? (() => Date.now());
  /** 番兵が置かれていて、まだ消費されていないか。 */
  let armed = false;
  /** 自分で畳んだ(`hist.back()`)直後の popstate は無視する。 */
  let ignoreNext = false;
  /** マウスの戻るボタンで戻った時刻(この時刻から `MOUSE_NAV_SUPPRESS_MS` の間の番兵の popstate は戻らない)。 */
  let mouseBackAt = Number.NEGATIVE_INFINITY;

  const arm = (): void => {
    hist.pushState({ pkcNavBack: 1 }, '');
    armed = true;
  };
  const disarm = (): void => {
    armed = false;
    ignoreNext = true;
    // 畳む戻りが届かなかった場合に、次の本物の「戻る」を食わない
    win.setTimeout(() => {
      ignoreNext = false;
    }, 1000);
    hist.back();
  };
  const sync = (): void => {
    const want = !d.isPhone() && d.canBack();
    if (want && !armed) arm();
    else if (!want && armed) disarm();
  };

  const isNavButton = (e: Event): number | null => {
    const b = (e as MouseEvent).button;
    return b === MOUSE_BACK_BUTTON || b === MOUSE_FORWARD_BUTTON ? b : null;
  };
  const onPointerUp = (e: Event): void => {
    const b = isNavButton(e);
    if (b === null || d.isPhone()) return;
    e.preventDefault();
    if (b === MOUSE_BACK_BUTTON) {
      mouseBackAt = now();
      d.back();
    } else d.forward();
  };
  /** ブラウザ自身の戻る・進む(`mouseup` の既定動作)を止める ── 止まらなくても番兵の側で二重には戻らない。 */
  const onMouseUp = (e: Event): void => {
    if (isNavButton(e) !== null && !d.isPhone()) e.preventDefault();
  };
  const onPop = (): void => {
    if (ignoreNext) {
      ignoreNext = false;
      return;
    }
    if (!armed) return;
    armed = false; // 番兵は消費された
    if (now() - mouseBackAt < MOUSE_NAV_SUPPRESS_MS) {
      // 🔴 マウスの戻るボタンで既に戻った ── もう 1 度は戻らない(置き直すだけ)
      mouseBackAt = Number.NEGATIVE_INFINITY;
      sync();
      return;
    }
    d.back();
    sync();
  };

  win.addEventListener('pointerup', onPointerUp);
  win.addEventListener('mouseup', onMouseUp);
  win.addEventListener('popstate', onPop);
  const off = d.onChange(sync);
  sync();
  return () => {
    off();
    win.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('mouseup', onMouseUp);
    win.removeEventListener('popstate', onPop);
  };
}
