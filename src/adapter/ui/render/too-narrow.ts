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
 * | **OK を押した** | もう出ない(**次に開いても**) | user が「分かった」と言った |
 * | **幅が足りるようになった** | 畳む(押していなければ、また狭めれば出る) | 🔴 **画面に嘘を出さない** |
 *
 * ## 🔴 OK は端末に憶える(user 裁定 2026-09-04、#687 E-1)
 *
 * ⚠ 直す前は閉包変数だった ── **読み込み直すたびに同じ字が出て、同じ OK を
 *   押させていた**。「分かった」と言った人に毎回言い直すのは、押す口が無いのと
 *   体験が変わらない。🔑 だから `pkc3.too-narrow-ok` に憶える
 *   (`pkc3.alarm` と同じ作法 ── container には入れない。**その端末の画面幅を見て
 *   押した事実**なので、設定 file でも運ばない:`settings-file.ts` の `SKIPPED_KEYS`)。
 * 🔑 **戻す道は設定に置く**(「狭い画面のときに断り書きを出す」)── 戻せない導線は
 *   作らない(お知らせの「今後は出さない」と同じ形)。⚠ 戻したら**その場で**効かせる
 *   (`setNoticesEnabled` が「戻す側もその場で効かせる」と直された型と同じ)──
 *   store の変化を購読して塗り直す。
 *
 * ⚠ 2 つ目は #671 の本文に「幅を広げても**自動では消さない**」と書いていたが、
 *   **そのとおりにすると 1440px の画面で「この画面の幅では表示が崩れる」と
 *   出したままになる** ── それは事実に反する。🔑 user の裁定は
 *   「**OK でも消せるようにする**」であって「幅で消すのをやめる」ではない、と
 *   読んだ(押さずに直した人にまで断り書きを残す理由が無い)。
 *   ⚠ **この読みが違っていたときの戻し方**(2026-09-04 に書き直した ── 直す前は
 *   `dismissedOnly` という**存在しない名前**を指していた):下の `paint` の
 *   `const show = narrow && store.enabled();` を
 *   `const show = store.enabled() && (narrow || shown);` にして、`shown` を
 *   「1 度でも出したか」で持つ ── 幅では畳まなくなる。
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
/**
 * 🔴 **ポップアップの窓(小窓 / アプリの窓)向けの字**(#690 ③、2026-09-04)。
 *
 * ⚠ 小窓は 420px で出るので、掴んで細くすると上の字が出る ── ところが
 *   **窓に「横向き」は無い**。読んだ user にできる一手が書いていない
 *   (上の字が直す前の「対応していません」と同じ顔になる)。
 * 🔑 窓なら**いまできる一手は「広げる」**なので、そう書く。前半は同じ字にする
 *   (何が起きるかは同じ ── 変えるのは一手の側だけ)。
 * ⚠ 字の正本はこの 2 つで、選ぶのは下の `paint` 1 か所である。
 */
export const TOO_NARROW_TEXT_WINDOW =
  'この画面の幅では表示が崩れることがあります。ウィンドウを広げると直ります';
/** 消す口の字。⚠ user の言葉(「OK 押したらで」)。 */
export const TOO_NARROW_OK = 'OK';

/** 押した事実を憶える鍵。値は `'1'` = OK を押した(出さない)。 */
const KEY = 'pkc3.too-narrow-ok';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 🔴 **断り書きを出すか**(#687 E-1)。既定は**出す**。OK で切れ、設定で戻せる。
 *
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── **この起動の間は控えが効く**
 *   (OK を押したのに次の狭めでまた出る、を作らない)。
 */
export class TooNarrowOkStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = true;
  private subs: Array<() => void> = [];

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * ⚠ **読むたびに保存を見る**(書き手が複数 ── 帯の OK と設定画面)。
   * ⚠ 何も書かれていなければ控えを返す ── `setItem` だけ落ちる環境で、
   *   押した直後の狭めに「出す」へ戻らないため。
   */
  enabled(): boolean {
    try {
      const raw = this.storage?.getItem(KEY) ?? null;
      return raw === null ? this.fallback : raw !== '1';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    try {
      this.storage?.setItem(KEY, on ? '0' : '1');
    } catch {
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
    for (const fn of [...this.subs]) fn();
  }

  /** 変わったら知らせる。⚠ 戻り値で外す(test が state を持ち越さない)。 */
  onChange(fn: () => void): () => void {
    this.subs.push(fn);
    return () => {
      this.subs = this.subs.filter((f) => f !== fn);
    };
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appTooNarrowOk = new TooNarrowOkStore();

export interface TooNarrowDeps {
  /** 器(`shell.ts` が 1 度だけ組む)。⚠ 中身は作り直さない ── 押している最中に消える。 */
  readonly band: HTMLElement;
  /** 字を置く所。⚠ **器ではなくここに書く**(下の `paint` の理由)。 */
  readonly text: HTMLElement;
  /** 押す口。 */
  readonly ok: HTMLElement;
  /**
   * 🔴 **この窓は PKC 自身が開いたポップアップか**(#690 ③)── 真なら
   *   「ウィンドウを広げると直ります」、偽なら「横向きにすると直ります」。
   * ⚠ 判断は持ち込まない(`deep-link.ts` の `noteOpenedByUs` が正本)── ここは聞くだけ。
   * ⚠ **出すたびに聞く**(起動時に 1 度だけ読まない)── 配線の順番に依らせない。
   * ⚠ optional にしない ── 落とすと、小窓で「横向きにすると直ります」に黙って戻る。
   */
  readonly popup: () => boolean;
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
 * @param store 押した事実の置き場(#687 E-1)。⚠ test は自分で `new` して渡す。
 * @returns 配線を解く関数(⚠ test が state を持ち越さないため)
 */
export function installTooNarrow(
  deps: TooNarrowDeps,
  store: TooNarrowOkStore = appTooNarrowOk,
): () => void {
  let narrow = false;
  const paint = (): void => {
    // ⚠ 読むたびに store を見る ── 設定画面が書き換えても、次の塗りで追従する
    const show = narrow && store.enabled();
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
    // 🔑 一手は窓の種類で決まる(#690 ③)── 窓に「横向き」は無い
    deps.text.textContent = show ? (deps.popup() ? TOO_NARROW_TEXT_WINDOW : TOO_NARROW_TEXT) : '';
    deps.ok.textContent = show ? TOO_NARROW_OK : '';
    deps.onChange();
  };
  /**
   * 🔴 OK = **憶える**(#687 E-1)。塗り直しは store の購読(下)が受ける ──
   *   ここで `paint()` を呼ばない(呼ぶと「憶えずに畳むだけ」の変異が生き延びる)。
   */
  const onOk = (): void => {
    store.setEnabled(false);
  };
  deps.ok.addEventListener('click', onOk);
  // ⚠ 設定で戻した / OK を押した、のどちらも**その場で**塗り直す
  const offStore = store.onChange(paint);
  const off = appPhone.onTooNarrow((now) => {
    narrow = now;
    paint();
  });
  return () => {
    deps.ok.removeEventListener('click', onOk);
    offStore();
    off();
  };
}
