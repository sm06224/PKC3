/**
 * フラグの面(P11。user 指示 2026-08-07)。
 *
 * > 「**設定画面から、設定とフラグは別々で見えるようにしてよ!**
 * > **設定はユーザーに開放されたもの、フラグは開発者とパワーユーザーに開放された
 * > もので予算は 15 個まで、それ以上は設定値で正式リリースさせる**」
 *
 * 🔑 **設定とは別の面**にする(裁定 Q3)。同じ画面の節にすると、user が
 * 配色を選ぶ気分で開発用の切替を押してしまう ── 「開放先が違うものは、
 * 場所を分ける」。設定画面が「表示 / 外部の画像」と「計器」を見出しで
 * 分けた判断(P9 段③)の、1 段強い版である。
 *
 * ⚠ **かぶせる窓にはしない。** この repo にモーダルは 1 件も無く、面はすべて
 * 「同じ場所に出る」作法(`settings.ts:7-11`)。ここもそれに従う。
 * ⚠ **畳まない**(`<details>` を使わない)── user 指示「主要な導線を畳まない」で、
 * `tests/docs-parity.test.ts` が機械的に落とす。
 *
 * ⚠ 器は**1 度だけ組む**(`settings.ts` と同じ)。面の切替は `hidden` の
 * 付け外しなので、器を捨てると押される寸前のボタンが消える(2026-08-07 に
 * 本文の面で実際に踏んだ)。
 */
import { FlagStore, registeredFlags } from '@adapter/platform/flag-store';
import { FLAG_BUDGET, findFlag } from '@features/flags';

export class FlagsRenderer {
  private built = false;
  private readonly rows = new Map<string, HTMLInputElement>();
  private summary: HTMLElement | null = null;

  constructor(
    private readonly region: HTMLElement,
    /** ⚠ test は自分で `new` して渡す(URL を差し替えるため)。 */
    private readonly store: FlagStore = new FlagStore(),
    /** ⚠ 再読込は注入する ── test で実際に遷移させない。 */
    private readonly reload: (url: string) => void = (url) => {
      location.replace(url);
    },
    private readonly href: () => string = () => location.href,
  ) {}

  /**
   * ⚠ **state を受け取らない。** フラグは container のデータではなく、
   * その端末の切替である(保存は localStorage)── state を引数に取ると
   * 「state に入っている」と誤読される。面の切替は `center.ts` が hidden でやる。
   */
  render(): void {
    if (this.built) {
      this.sync();
      return;
    }
    this.built = true;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = 'フラグ';
    this.region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'flags-body');

    const note = document.createElement('p');
    note.className = 'settings-note';
    note.setAttribute('data-pkc-field', 'flags-note');
    /**
     * 🔑 **ここが「設定と何が違うか」を user に伝える唯一の場所**である。
     * ⚠ 「開発者向け」とだけ書くと、パワーユーザーが自分は対象外だと思う ──
     *   user 指示は「開発者**と**パワーユーザーに開放」。
     */
    note.textContent =
      'ここは開発中の切替です。設定と違って、いつか畳まれます(畳む条件を各行に書いています)。' +
      'うまく動かなくなったら「すべて既定へ戻す」を押してください。';
    body.append(note);

    const sum = document.createElement('p');
    sum.className = 'settings-note';
    sum.setAttribute('data-pkc-field', 'flags-summary');
    this.summary = sum;
    body.append(sum);

    const flags = registeredFlags();
    if (flags.length === 0) {
      /**
       * ⚠ **空でも器は出す。** 「まだ 1 つも無い」ことは情報である ──
       * 面ごと消すと、user は「フラグ機能が壊れている」と読む。
       */
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'flags-empty');
      empty.className = 'settings-note';
      empty.textContent = 'いま切り替えられるものはありません。';
      body.append(empty);
    } else {
      body.append(this.buildList(flags));
      body.append(this.buildReset());
    }

    this.region.append(body);
    this.sync();
  }

  private buildList(flags: readonly ReturnType<typeof registeredFlags>[number][]): HTMLElement {
    const dl = document.createElement('dl');
    dl.setAttribute('data-pkc-field', 'flag-list');
    for (const f of flags) {
      const dt = document.createElement('dt');
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('data-pkc-action', 'set-flag');
      input.setAttribute('data-pkc-flag', f.name);
      this.rows.set(f.name, input);
      label.append(input, document.createTextNode(` ${f.name}`));
      dt.append(label);

      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-field', 'flag-detail');
      const what = document.createElement('div');
      what.textContent = f.summary;
      dd.append(what);
      /**
       * 🔴 **起動前に要るものは、そう書く**(user 指示 2026-08-07)。
       * ⚠ 書かないと「押したのに何も変わらない」に見える ── 実際には
       *   次の起動から効くので、**再起動が要ることを先に伝える**。
       */
      if (f.needsRestart === true) {
        const r = document.createElement('div');
        r.className = 'settings-note';
        r.setAttribute('data-pkc-field', 'flag-restart');
        r.textContent = '切り替えると読み込み直します(起動時に決まるため)';
        dd.append(r);
      }
      /** ⚠ **畳む条件を画面に出す** ── 「いつ消えるか」を隠さないのが flag の約束。 */
      const fold = document.createElement('div');
      fold.className = 'settings-note';
      fold.setAttribute('data-pkc-field', 'flag-fold');
      fold.textContent = `畳む条件: ${f.foldWhen}`;
      dd.append(fold);
      dl.append(dt, dd);
    }
    return dl;
  }

  private buildReset(): HTMLElement {
    const p = document.createElement('p');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'reset-flags');
    btn.textContent = 'すべて既定へ戻す';
    p.append(btn);
    return p;
  }

  /**
   * 値を映す。⚠ **器は組み直さない**ので、ここで映さないと古い値が見える
   * (CLAUDE.md「設定画面の値の同期 ── 器は 1 度しか組まないので、映さないと古い値が見える」)。
   */
  private sync(): void {
    const values = this.store.values();
    for (const [name, input] of this.rows) {
      input.checked = values[name] ?? false;
      /**
       * 🔴 **URL で上書き中は触らせない。** 触れると「押したのに変わらない」に
       * なる ── 無言の操作拒否を作らないので、理由を `title` に出す。
       */
      /**
       * 🔴 **ロックしない**(user 指摘 2026-08-08)。
       *
       * > 「**フラグ適用順と再起動を促す順序があるんだから、本質的にロック不要**」
       *
       * 適用順(URL > 保存 > 既定)と再起動の仕組みが在る以上、URL で上書き中でも
       * **保存して、効かせるために読み込み直せばよい**。押せなくする理由が無い。
       * ⚠ 直す前は `disabled` にしていたので、起動前フラグを ON にすると
       *   **アプリが自分で付けた URL を理由に、二度と OFF にできない**袋小路になっていた。
       * ⚠ 上書き中であることは**知らせる**(押せない理由ではなく、状態の説明)。
       */
      const url = this.store.isFromUrl(name);
      input.title = url ? 'いまは URL の指定が優先されています(切り替えると読み込み直します)' : '';
    }
    if (this.summary) {
      const n = registeredFlags().length;
      const changed = this.store.changedCount();
      this.summary.textContent =
        `${n} / ${FLAG_BUDGET} 枠を使用中` +
        (changed > 0 ? ` ── うち ${changed} 個が既定と違います` : '');
    }
  }

  /**
   * 切り替える(binder から呼ばれる)。
   *
   * 🔴 **起動前に要る flag は、パラメータ付きで読み込み直す**
   * (user 指示 2026-08-07)。⚠ 保存だけして黙っていると、user には
   * 「押したのに何も起きない」に見える ── しかも次の起動で急に挙動が変わる。
   */
  setFlag(name: string, on: boolean): void {
    const overridden = this.store.isFromUrl(name);
    this.store.set(name, on);
    this.sync();
    /**
     * 🔴 **切り替えが「いま効かない」ときだけ読み込み直す。**
     * ① 起動前に読まれる flag ② URL が優先されていて保存値が隠れている flag。
     * ⚠ ②を落とすと「押したのに変わらない」= 無言の操作拒否になる ──
     *   ロックの代わりに**効かせる**のがこの設計の要点(user 指摘 2026-08-08)。
     * ⚠ 再起動の URL は**保存値から**組み直されるので、手で打った指定はそこで落ちる。
     */
    if (findFlag(name)?.needsRestart === true || overridden) this.restart();
  }

  /** ⚠ test は差し替えられるよう、再読込は 1 か所に閉じる。 */
  private restart(): void {
    this.reload(this.store.restartUrl(this.href()));
  }

  resetFlags(): void {
    const hadRestart = registeredFlags().some(
      (f) => f.needsRestart === true && this.store.values()[f.name] !== f.default,
    );
    // ⚠ **URL に残った flag も落とす** ── 落とさないと「既定へ戻す」を押しても
    //   URL が生き続け、戻らない(2026-08-08 に踏んだ袋小路の片割れ)
    const hadUrl = this.store.hasUrlFlags();
    this.store.reset();
    this.sync();
    if (hadRestart || hadUrl) this.restart();
  }
}
