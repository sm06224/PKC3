/**
 * 🔴 **狭すぎる端末への断り書き**(user 裁定 2026-09-04、#671 の裁定 2・3)。
 *
 * ## 字は user が決めた
 *
 * > 「**この画面の幅では表示が崩れることがあります。横向きにすると直ります**」
 *
 * ⚠ **前の字は「別の端末を使え」としか読めなかった**(「この幅には対応して
 *   いません ── 360px 以上でお使いください」)── スマホに窓は無いので、
 *   読んだ user にできることが 1 つも無い。🔑 新しい字は**いまできる一手**を
 *   名指しする ── 320px の端末でも横なら 568px になるので、実際に直る。
 *
 * ## 消え方も user が決めた
 *
 * > 「**OK 押したらで**」
 *
 * ⚠ だから**押せる口が要る** ── 直す前は状態の行に字が出るだけで、
 *   押す所が 1 つも無かった(読んだ user は消し方を知りようがない)。
 *
 * 🔴 **消える条件は 2 つある。分けて持つ**:
 *
 * | 何が起きたか | どうなるか | なぜ |
 * |---|---|---|
 * | **OK を押した** | もう出ない(この起動の間) | user が「分かった」と言った |
 * | **幅が足りるようになった** | 畳む(押していなければ、また狭めれば出る) | 🔴 **画面に嘘を出さない** |
 *
 * ⚠ 2 つ目は #671 の本文に「幅を広げても**自動では消さない**」と書いていたが、
 *   **そのとおりにすると 1440px の画面で「この画面の幅では表示が崩れる」と
 *   出したままになる** ── それは事実に反する。🔑 user の裁定は
 *   「**OK でも消せるようにする**」であって「幅で消すのをやめる」ではない、と
 *   読んだ(押さずに直した人にまで断り書きを残す理由が無い)。
 *   ⚠ **この読みが違っていたときの戻し方**(2026-09-04 に書き直した ── 直す前は
 *   `dismissedOnly` という**存在しない名前**を指していた):下の `paint` の
 *   `const show = narrow && !dismissed;` を `const show = !dismissed && (narrow || shown);`
 *   にして、`shown` を「1 度でも出したか」で持つ ── 幅では畳まなくなる。
 *
 * ## ⚠ なぜ `fold-notify` から出したか
 *
 * `fold-notify.ts` は **「幅が足りないので畳んだ」を言う口 1 つ**である
 * (#606 が「口が 2 つあると片方の配線を忘れる」を直した所)。⚠ そこは
 * **字を流すだけの口**で、押しボタンを持てない ── 裁定 3 が要求するのは
 * **押せる物**なので、器から違う。🔑 代わりに**配線が落ちたら鳴る検査**を
 * 別に置く(`tests/smoke/phone.smoke.spec.ts` の 340px の腕)。
 */
import { appPhone } from './phone-layout';

/** 🔴 **user 裁定の言葉そのまま。**⚠ 足さない(前回、足した 1 語で帯からはみ出した)。 */
export const TOO_NARROW_TEXT =
  'この画面の幅では表示が崩れることがあります。横向きにすると直ります';
/** 消す口の字。⚠ user の言葉(「OK 押したらで」)。 */
export const TOO_NARROW_OK = 'OK';

export interface TooNarrowDeps {
  /** 器(`shell.ts` が 1 度だけ組む)。⚠ 中身は作り直さない ── 押している最中に消える。 */
  readonly band: HTMLElement;
  /** 字を置く所。⚠ **器ではなくここに書く**(下の `paint` の理由)。 */
  readonly text: HTMLElement;
  /** 押す口。 */
  readonly ok: HTMLElement;
  /**
   * 出し入れが変わったら呼ぶ。
   * ⚠ 状態の行を畳むかどうかは `main.ts` の `paint` **1 か所**が決める ──
   *   ここで `status.hidden` を触ると、判定が 2 か所になる(CLAUDE.md §7)。
   */
  readonly onChange: () => void;
}

/**
 * 断り書きを配線する。
 *
 * @returns 配線を解く関数(⚠ test が state を持ち越さないため)
 */
export function installTooNarrow(deps: TooNarrowDeps): () => void {
  let dismissed = false;
  let narrow = false;
  const paint = (): void => {
    const show = narrow && !dismissed;
    if (deps.band.hidden === !show) return;
    deps.band.hidden = !show;
    /**
     * 🔴 **畳むときは字も消す。**
     *
     * ⚠ `hidden` は**見た目にしか効かない** ── `textContent` は隠れた子も含むので、
     *   字を置きっぱなしにすると「**状態の行に何が出ているか**」を見る検査が
     *   **この字に満たされて常に真**になる(CLAUDE.md §1「別の面の文字に満たされる」)。
     *   実際、対応している幅で「断り書きが出ていない」を見る smoke が
     *   **隠れたままの字を拾って落ちた**(2026-09-04 に踏んだ)。
     * ⚠ **器は作り直さない**(字を入れ替えるだけ)── 作り直すと、押そうとした
     *   OK が指の下から消える。
     */
    deps.text.textContent = show ? TOO_NARROW_TEXT : '';
    deps.ok.textContent = show ? TOO_NARROW_OK : '';
    deps.onChange();
  };
  const onOk = (): void => {
    dismissed = true;
    paint();
  };
  deps.ok.addEventListener('click', onOk);
  const off = appPhone.onTooNarrow((now) => {
    narrow = now;
    paint();
  });
  return () => {
    deps.ok.removeEventListener('click', onOk);
    off();
  };
}
