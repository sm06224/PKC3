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
  /** 読んだことにして閉じる。 */
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

  return {
    present() {
      if (!store.enabled()) return clear();
      const unread = unreadNotices(all, store.seenIds());
      if (unread.length === 0) return clear();
      shown = unread;
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
      label.textContent = unread.length === 1 ? 'お知らせ' : `お知らせ(${unread.length} 件)`;
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('data-pkc-action', 'dismiss-announce');
      close.textContent = '閉じる';
      head.append(label, close);
      region.append(head);

      const body = document.createElement('div');
      body.setAttribute('data-pkc-field', 'announce-body');
      for (const nt of unread) {
        const sec = document.createElement('section');
        sec.setAttribute('data-pkc-announce', nt.id);
        const t = document.createElement('h3');
        // ⚠ 日付は id から引く(field を二重に持たない)
        t.textContent = `${noticeDate(nt.id)} ${nt.title}`;
        const ul = document.createElement('ul');
        for (const line of nt.items) {
          const li = document.createElement('li');
          // ⚠ **素のテキスト**(記法は書かない決まり ── test が守る)
          li.textContent = line;
          ul.append(li);
        }
        sec.append(t, ul);
        body.append(sec);
      }
      region.append(body);

      /**
       * ⚠ **あとから読める**ことをその場に書く ── 「閉じたら二度と読めない」と
       * 思わせない(実際はヘルプに残る)。
       */
      const where = document.createElement('p');
      where.setAttribute('data-pkc-field', 'announce-where');
      where.textContent = '過去のお知らせは、左の列の「ヘルプ」からいつでも読めます。';
      region.append(where);

      const acts = document.createElement('p');
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.setAttribute('data-pkc-action', 'mute-announce');
      mute.textContent = '今後は出さない';
      /** ⚠ **戻し道をその場に書く**(押した後に探させない)。 */
      mute.title = '設定の「表示」からいつでも戻せます';
      acts.append(mute);
      region.append(acts);
    },

    dismiss() {
      store.markSeen(shown.map((x) => x.id));
      clear();
    },

    hide() {
      clear();
    },

    mute() {
      // ⚠ **既読にもする** ── 戻したときに、もう読んだ物が出直さない
      store.markSeen(shown.map((x) => x.id));
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
