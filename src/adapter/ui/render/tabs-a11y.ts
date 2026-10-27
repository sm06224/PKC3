/**
 * タブの帯を、**読み上げにもタブとして届ける**(#720。cowork 評価レポート)。
 *
 * 🔴 **この repo にはタブの帯が 2 つある** ── 左の列の「探し方」(`shell.ts` の
 * `browse-tabs`)と、2 ペインの面のタブ(`dual-filer.ts` の `dual-tabs`)。
 * ⚠ 直す前は **2 ペインの側にだけ** `role="tab"` / `aria-selected` が在り、
 *   左の列は素の `<button>` が並んでいるだけだった ── 読み上げで使う人には
 *   「押しボタンが 5 つ」に聞こえ、**いまどれを見ているのかが分からない**。
 *
 * 🔑 だから**同じ関数に寄せる**(CLAUDE.md §7)── 綴りを 2 か所に書くと、
 *   片方だけ直した日に片方だけ黙って古くなる(2 ペイン側で実際にそうなっていた)。
 * ⚠ **`data-pkc-active` は寄せない** ── 印を付ける器が 2 つで違う(左の列は
 *   ボタン自身、2 ペインは包んでいる `<span>`)。ここが持つのは
 *   **読み上げへ渡す名前**だけである。
 */

/** タブの帯そのもの。⚠ 「押しボタンの群れ」ではなく「タブの列」だと名乗る。 */
export function markTablist(host: HTMLElement): void {
  host.setAttribute('role', 'tablist');
}

/**
 * タブ 1 枚。**選んでいるかどうか**を読み上げへ渡す。
 *
 * ⚠ `aria-selected` は**選んでいない側にも書く**(`'false'`)── 属性ごと落とすと
 *   「選べるもの」ではなく「ただの押しボタン」として読まれる。
 */
export function markTab(btn: HTMLElement, selected: boolean): void {
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', selected ? 'true' : 'false');
}

/**
 * 左の列の「探し方」のタブに、**いまどれを見ているか**を書く。
 *
 * 🔴 **見た目の印(`data-pkc-active`)と読み上げの印(`aria-selected`)を、
 * 同じ 1 回で書く**(#720)。⚠ 分けて書くと、片方だけ更新する経路ができた日に
 * **目には正しく、耳には古い**という、いちばん気づけない食い違いが残る。
 *
 * ⚠ 探す範囲は呼び側が渡す(左の列)── `document` 全体で探すと、別の面の
 *   `data-pkc-browse`(アプリのタイルなど)まで巻き込む。
 */
export function markBrowseTabs(host: ParentNode, mode: string): void {
  for (const btn of host.querySelectorAll<HTMLElement>('[data-pkc-browse]')) {
    const on = btn.getAttribute('data-pkc-browse') === mode;
    markTab(btn, on);
    if (on) btn.setAttribute('data-pkc-active', '');
    else btn.removeAttribute('data-pkc-active');
  }
}

/** 「連絡先は 0 件と分かっている」印。⚠ `bar-overflow.ts` の `forced` と `app.css` が読む。 */
export const TAB_EMPTY_ATTR = 'data-pkc-tab-empty';

/**
 * 🔴 **連絡先が 0 件と分かっているか**(#475 項目 5)。
 * ⚠ **「まだ集めていない」と「0 件」は別**(`contactScan === null` は前者 ── 開くまで走らない)。
 *   集めた結果が 0 件で、上限で切っておらず、失敗でもないときだけ空と言う
 *   (切った・失敗したを「無い」と読ませない)。
 */
export function contactsKnownEmpty(state: {
  readonly contactScan: { readonly cards: readonly unknown[]; readonly truncated: boolean } | null;
  readonly contactScanFailed: boolean;
}): boolean {
  const scan = state.contactScan;
  return scan !== null && !state.contactScanFailed && !scan.truncated && scan.cards.length === 0;
}

/**
 * 🔴 **連絡先が空のあいだ、左のタブを「⋯」の下へ回す**(#475 項目 5)。
 *
 * 畳むのではなく**回す**: 「⋯」の中から開ける(入口は消えない ── 片道にしない)。
 * 1 件でも見つかれば印を外し、元の位置に戻る。いま開いているタブは回さない(`bar-overflow.ts`)。
 * 空の面は作り方(`tel:` / `email:`)を教える入口なので、「⋯」から開けば今までどおり出る。
 */
export function markContactsTabEmpty(host: ParentNode, empty: boolean): void {
  const btn = host.querySelector<HTMLElement>('[data-pkc-region="browse-tabs"] [data-pkc-browse="contacts"]');
  if (btn === null) return;
  if (empty === btn.hasAttribute(TAB_EMPTY_ATTR)) return;
  if (empty) btn.setAttribute(TAB_EMPTY_ATTR, '');
  else btn.removeAttribute(TAB_EMPTY_ATTR);
}
