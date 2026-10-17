/**
 * スマホで端末の「戻る」を押したとき、PKC3 の外ではなく**一覧へ**戻す(#1659 ①、Gemini 裁定
 * 「推薦どおり」= 案 B)。
 *
 * 🔑 仕組みは 1 つ:ノートを読む画面(`note` / `info`)に入るたびに履歴へ**同じ住所の項目を 1 つ**
 *   足し、端末の「戻る」はその 1 つを消費する ── 消費された回に、画面上の「← 一覧へ戻る」と
 *   同じ戻り先へ移す。
 * 🔴 **スマホ用画面のときだけ**。PC の幅・タブレットでは 1 バイトも触らない(約束
 *   「アドレスが変わっても履歴は増えない」は PC で守る)。住所の文字は変えない
 *   (`pushState` に URL を渡さない = 今のアドレスのまま ── `F5` / 栞に影響しない。アドレスは読まない)。
 * ⚠ 履歴の項目に印を付けても、`deep-link.ts` の `replaceState(null, …)` が消す ── だから
 *   「足したか」はこの file の変数(`armed`)で持つ。
 * ⚠ 編集中は戻らない(画面上の「← 一覧へ戻る」と同じ断り)。そのとき消費された項目は
 *   足し直す ── でないと、2 度目の「戻る」で PKC3 の外へ出る。
 */
import type { PhonePage } from '@features/phone-layout';

export interface PhoneBackDeps {
  /** `appPhone.onPageChange` */
  readonly onPageChange: (cb: (page: PhonePage | null) => void) => () => void;
  /** 断る理由(編集中など)。無ければ `null`。 */
  readonly blockReason: () => string | null;
  /** 断ったときの知らせ(前置きは `blockReason` の字)。 */
  readonly notifyBlocked: (message: string) => void;
  /** 情報ページ → ノートへ。 */
  readonly showNote: () => void;
  /** ノート → 一覧へ(画面上の「← 一覧へ戻る」と同じ口)。 */
  readonly showList: () => void;
  /** 差し替え口(unit)。既定は本物。 */
  readonly win?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout'>;
  readonly hist?: Pick<History, 'pushState' | 'back'>;
}

/** 断り文の結び。⚠ 画面上のボタンの断り(`phone-page`)と同じ字。 */
export const PHONE_BACK_BLOCKED_TAIL = '戻ってください';

/** @returns 外す関数 */
export function installPhoneBack(d: PhoneBackDeps): () => void {
  const win = d.win ?? window;
  const hist = d.hist ?? history;
  /** 履歴に足した項目が、まだ消費されずに残っているか。 */
  let armed = false;
  /** 自分で `back()` した直後の popstate は無視する。 */
  let ignoreNext = false;
  let page: PhonePage | null = null;

  const want = (p: PhonePage | null): boolean => p === 'note' || p === 'info';
  const arm = (): void => {
    hist.pushState({ pkcPhoneBack: 1 }, '');
    armed = true;
  };

  const offPage = d.onPageChange((p) => {
    page = p;
    if (want(p) && !armed) arm();
    else if (!want(p) && armed) {
      // 画面上のボタンなどで一覧へ出た ── 足した項目を畳む(積み上げない)
      armed = false;
      ignoreNext = true;
      // 戻る操作が届かなかった場合に、次の本物の「戻る」を食わない
      win.setTimeout(() => {
        ignoreNext = false;
      }, 1000);
      hist.back();
    }
  });

  const onPop = (): void => {
    if (ignoreNext) {
      ignoreNext = false;
      return;
    }
    if (!armed) return;
    // 項目は消費された
    armed = false;
    const reason = d.blockReason();
    if (reason !== null) {
      d.notifyBlocked(`${reason}${PHONE_BACK_BLOCKED_TAIL}`);
      arm();
      return;
    }
    if (page === 'info') {
      d.showNote();
      // 本文ページに残るので、次の「戻る」のために足し直す(onPageChange が arm する)
      return;
    }
    d.showList();
  };
  win.addEventListener('popstate', onPop);
  return () => {
    offPage();
    win.removeEventListener('popstate', onPop);
  };
}
