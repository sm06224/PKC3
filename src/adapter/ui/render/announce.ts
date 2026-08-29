/**
 * 🔴 **起動したときのお知らせ**(P11 段⑤。user 指示 2026-08-07)。
 *
 * > 「**PKC3 にも PKC2 のようにお知らせポップアップをつけてください**」
 *
 * ## かぶせる窓にはしない ── **専用の行**に出す
 *
 * この repo にモーダルは 1 件も無く、面はすべて「同じものが常に同じ場所にある」
 * 作法(user 指示 2026-08-03「目指す姿は業務画面」)。PKC2 の起動時お知らせも
 * 実体は**カード**であって、操作を塞ぐ窓ではない ── そこを継ぐ。
 *
 * ⚠ **`notices` / `update` の行に相乗りしない**(裁定 Q5)。
 *  - `notices` は取込・書出しのたびに**中身が作り替わる** ── 相乗りすると、
 *    user が読む前に次の取込で黙って消える(`shell.ts:36-41` が同じ理由で
 *    `update` を分けている)
 *  - `update` は「新しい版があります」── **両方出たときに重なる**
 *
 * ## 出す条件
 *
 * ① 恒久オフでない ② **未読が 1 件以上**。
 * ⚠ 既読は **id の集合**(`notice-store.ts`)── 「最後に閉じた 1 件」で持つと、
 *   user が旧ビルドを手元に残す単一 HTML 製品では往復のたび巻き戻る。
 */
import type { Notice } from '@features/notice/notice-log';
import { noticeDate, unreadNotices } from '@features/notice/notice-log';
import type { NoticeStore } from '@adapter/platform/notice-store';

export interface Announce {
  /** 未読が在れば出す。⚠ **無ければ行の高さを 0 に保つ**(空の枠を残さない)。 */
  present(): void;
  /**
   * 🔴 **いま出ている 1 件を読んだことにして、次を出す**(#475、2026-08-27)。
   * ⚠ `dismiss` と分ける ── **帯は畳まない**。畳むのは残り 0 件になったときだけ。
   */
  next(): void;
  /** 残っている未読をまとめて読んだことにして、帯を畳む。 */
  dismiss(): void;
  /** 今後出さない(設定から戻せる)。⚠ **戻せない導線は作らない**。 */
  mute(): void;
  /**
   * 帯を**しまうだけ**(既読にしない)。設定から「出さない」に切り替えたとき用。
   * ⚠ `dismiss` と分ける ── 設定を切っただけの user は**読んでいない**ので、
   *   既読にすると、戻したときに「見ていないお知らせ」が消えたままになる。
   */
  hide(): void;
}

export function createAnnounce(
  region: HTMLElement,
  store: NoticeStore,
  all: readonly Notice[],
): Announce {
  /** ⚠ **出した時点の未読を覚える**。閉じるまでに登記表が動いても、
   *  user が実際に見たものだけを既読にする。 */
  let shown: readonly Notice[] = [];

  const clear = (): void => {
    region.textContent = '';
    region.hidden = true;
    shown = [];
  };

  /**
   * 🔴 **出すのは 1 件だけ**(#475、2026-08-27 の実機検証レポート #16)。
   *
   * > 「230px の箱の中に **10 件が縦に積まれ、中でスクロール**します。1 件読むのに
   * > 箱の中を繰る形で、**箱が大きいのに一度に 1 件しか読めません**。畳むだけでは
   * > 「読ませたい」目的も果たせていない状態です」
   *
   * ⚠ 初回起動の user は**未読が登記表の全数**(最大 10 件)なので、
   *   積むと必ず 30vh の上限に当たる ── **大きいのに読めない**という、
   *   場所と目的を同時に損なう形だった。
   * 🔑 だから**新しい 1 件だけ**を出し、「次へ」で送る。
   *   残りは見出しの件数で分かり、**まとめて読む道はヘルプに在る**
   *   (帯の案内文がその場に書いてある)。
   */
  const paint = (): void => {
    if (!store.enabled()) return clear();
    const unread = unreadNotices(all, store.seenIds());
    if (unread.length === 0) return clear();
    /** ⚠ **既読にする対象は「出した時点の未読の集合」のまま** ── 「閉じる」と
     *  「今後は出さない」は *残り全部* を読んだことにする出口なので、
     *  画面に出ている 1 件だけでは足りない。送る(`next`)ときだけ先頭を使う。 */
    shown = unread;
    const current = unread[0]!;
    region.textContent = '';
    region.hidden = false;

    /**
     * 🔴 **閉じるは見出しの行に置く**(#151、2026-08-14 の実機報告)。
     *
     * ⚠ 以前は本文・案内文のあとに置いていたが、面は `max-height: 30vh` で
     * **中を流す**ので、お知らせが 2 件も在れば**箱の中で見切れて**いた ──
     * user からは「閉じ方が分からない帯が画面の 1/3 を占領している」に見える。
     * 🔑 高さを切ってよいのは**読むもの**だけで、**閉じる導線を切ってはいけない**
     * (`app.css` の「幅が足りないなら場所を変えるのであって、操作を無くして
     * よい理由にはならない」と同じ。あれの縦版である)。
     * ⚠ 「今後は出さない」は末尾のままでよい ── 常に見えている必要があるのは
     * **その場を畳む手**だけである。
     */
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'announce-title');
    const label = document.createElement('span');
    /** ⚠ **残りの件数を出す**(1 件ずつ出す以上、これが唯一の手掛かりである)。 */
    label.textContent = unread.length === 1 ? 'お知らせ' : `お知らせ(残り ${unread.length} 件)`;

    /**
     * 🔴 **「次へ」は 2 件以上のときだけ**。⚠ 1 件しか無いのに出すと、
     *   押しても何も起きない(= 無言の dead click)。
     * 🔑 **「閉じる」の意味を変えない** ── 今日までと同じく *帯が消える* である。
     *   読み進める手を「閉じる」に兼ねさせると、押しても消えない帯になる。
     */
    if (unread.length > 1) {
      const next = document.createElement('button');
      next.type = 'button';
      next.setAttribute('data-pkc-action', 'next-announce');
      next.textContent = '次へ';
      next.title = 'この 1 件を読んだことにして、次のお知らせを出します';
      head.append(label, next);
    } else {
      head.append(label);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('data-pkc-action', 'dismiss-announce');
    close.textContent = '閉じる';
    /** ⚠ **押す前に結果が分かるようにする** ── 残りごと既読になることを書く。 */
    close.title =
      unread.length === 1
        ? '読んだことにして閉じます'
        : `残り ${unread.length} 件を読んだことにして閉じます(ヘルプからいつでも読めます)`;
    head.append(close);
    region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'announce-body');
    const sec = document.createElement('section');
    sec.setAttribute('data-pkc-announce', current.id);
    const t = document.createElement('h3');
    // ⚠ 日付は id から引く(field を二重に持たない)
    t.textContent = `${noticeDate(current.id)} ${current.title}`;
    const ul = document.createElement('ul');
    for (const line of current.items) {
      const li = document.createElement('li');
      // ⚠ **素のテキスト**(記法は書かない決まり ── test が守る)
      li.textContent = line;
      ul.append(li);
    }
    sec.append(t, ul);
    body.append(sec);
    region.append(body);

    /**
     * 🔴 **案内文と「今後は出さない」を 1 行に畳む**(#475、2026-08-27)。
     *
     * ⚠ どちらも**読むものではなく、在り処を示すもの**なのに、縦に 2 行 +
     *   余白を取っていた(実測 16px + 26px + 余白 ≒ 帯の 1/5)。
     * 🔑 **読むもの(お知らせ本文)に縦を譲る** ── 場所を取ってよいのは
     *   読ませたい物だけである。
     * ⚠ **どちらも消さない** ── 「あとから読める」を書かないと
     *   「閉じたら二度と読めない」と思わせ、「今後は出さない」を帯から外すと
     *   止める手が設定の中だけになる(動線を 1 つ失う)。
     */
    const foot = document.createElement('div');
    foot.setAttribute('data-pkc-field', 'announce-foot');

    const where = document.createElement('p');
    where.setAttribute('data-pkc-field', 'announce-where');
    where.textContent = '過去のお知らせは、左の列の「ヘルプ」からいつでも読めます。';

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.setAttribute('data-pkc-action', 'mute-announce');
    mute.textContent = '今後は出さない';
    /** ⚠ **戻し道をその場に書く**(押した後に探させない)。 */
    mute.title = '設定の「表示」からいつでも戻せます';

    foot.append(where, mute);
    region.append(foot);
  };

  return {
    present: paint,

    /**
     * 🔴 **焦点を返す**(CLAUDE.md §10「置き換えの作法」)。
     *
     * ⚠ 送るたびに帯を描き直すので、**押したボタンごと消える** ── 何もしないと
     *   焦点が `<body>` へ落ち、鍵で読み進めている user は **2 件目で止まる**。
     * 🔑 描き直した後に、同じ場所のボタンへ焦点を戻す ── 最後の 1 件では
     *   「次へ」が消えるので、そのときは「閉じる」が受ける
     *   (`querySelector` の選択子リストは**文書順で最初**を返すので、
     *   「次へ」が在る限りそちらに当たる)。
     */
    next() {
      const current = shown[0];
      if (!current) return;
      const had = region.contains(document.activeElement);
      // ⚠ **出す側の登記表を渡す**(#605 の 2 巡目レビュー)── 既読の席を守る側が
      //   module 直輸入の `NOTICES` を見ていると、2 つの登記表が食い違いうる(§7)
      store.markSeen([current.id], all);
      paint();
      if (!had) return;
      const back = region.querySelector(
        '[data-pkc-action="next-announce"], [data-pkc-action="dismiss-announce"]',
      );
      if (back instanceof HTMLElement) back.focus();
    },

    dismiss() {
      store.markSeen(
        shown.map((x) => x.id),
        all,
      );
      clear();
    },

    hide() {
      clear();
    },

    mute() {
      // ⚠ **既読にもする** ── 戻したときに、もう読んだ物が出直さない
      store.markSeen(
        shown.map((x) => x.id),
        all,
      );
      store.setEnabled(false);
      clear();
    },
  };
}

/**
 * 🔴 **お知らせの配線を `main.ts` から取り出す**(2026-08-08、変異試験の指摘)。
 *
 * ⚠ `main.ts` は**どの test からも実行されていない**(読んでいるのは原文だけ)。
 * 配線をそこへ直書きしていたので、変異試験で次のどれをやっても**全 2358 tests が
 * 緑**だった:
 *  - 設定を切ったときに `hide` ではなく `dismiss` を呼ぶ(= **読んでいない物を
 *    既読にする**。この段の設計の要そのもの)
 *  - 設定の切替を保存しない
 *  - `dismissAnnounce` を `hide` にすり替える(閉じても既読にならない)
 *
 * 🔑 **取り出せば test できる**(`update-card.ts` が同じ理由で取り出されている)。
 */
export interface AnnounceServices {
  dismissAnnounce(): void;
  /** 🔴 いま出ている 1 件を読んだことにして、次を出す(#475)。 */
  nextAnnounce(): void;
  muteAnnounce(): void;
  setNoticesEnabled(on: boolean): void;
}

export function announceServices(
  announce: Announce,
  store: NoticeStore,
  /** 設定画面などを映し直す。⚠ 帯から切ると**画面の外で設定が変わる**ので要る。 */
  onChanged: () => void = () => {},
): AnnounceServices {
  return {
    // ⚠ 閉じたのは**読んだから** ── 既読にする
    dismissAnnounce: () => announce.dismiss(),
    /** ⚠ **畳まない** ── 送るだけ(残りが 0 件になったら `present` が畳む)。 */
    nextAnnounce: () => announce.next(),
    muteAnnounce: () => {
      announce.mute();
      onChanged();
    },
    setNoticesEnabled: (on) => {
      store.setEnabled(on);
      /**
       * ⚠ **既読にしない**(`dismiss` ではなく `hide`)── 設定を切っただけの
       * user は読んでいないので、戻したときに出直す。
       *
       * 🔴 **戻す側もその場で効かせる**(2026-08-08、レビュー指摘)。
       * ⚠ 直す前は `if (!on)` だけで、**切る側は即座に効き、戻す側は次の起動まで
       *   効かなかった** ── 片側だけ実装した対称の反対側である。
       *   未読が無ければ `present()` は何も出さないので、余計な帯は立たない。
       */
      if (on) announce.present();
      else announce.hide();
    },
  };
}
