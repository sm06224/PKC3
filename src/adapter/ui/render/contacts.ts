/**
 * 🔴 **連絡先の面**(#278 段①。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ…、**連絡先**、
 * タイマー、アラートは組み込みアプリでリリースしたい」)。
 *
 * ## どこに在るか ── **左の列のタブ**と、**別ウィンドウの面**の 2 か所
 *
 * `features/launcher/tiles.ts` が #292 段⑤ で確立した見分け方:
 * **「それを閉じたとき user が失うものは何か」**。⚠ 連絡先を閉じても
 * **失う物は無い**(連絡先は**ノート**である)── つまり道具ではなく
 * **ノートの見方**なので、`browse.ts` の表どおり**左**である
 * (中央の本文を退かす理由が無い ── #300 の user 指摘)。
 * 🔴 **#278 段③(user 裁定 2026-09-04「予定表も連絡先も別窓」)で、同じ面を
 * 組み込みアプリの別ウィンドウ**(`ViewMode` の `contacts`、`center.ts`)**でも
 * 開けるようにした** ── 左のタブは残したまま、2 つ目の入口である。
 * ⚠ だから**この描画器は同じ document に 2 つ生きうる**(左のタブ + 中央の面)。
 *   器の印は器の側(`data-pkc-browse-pane` / `data-pkc-view-pane`)が持つので、
 *   ここでは `data-pkc-region` を焼かない ── 焼くと同じ名前の region が 2 つ並び、
 *   `querySelector` で引く人が**先に描かれた左の面**を掴む(読む人が居なかった
 *   のを確かめて外した)。
 *
 * ## 何ができるか ── **見るだけの面にしない**
 *
 * | 操作 | 何が起きるか |
 * |---|---|
 * | 名前を押す | そのノートを中央に開く(面はそのまま) |
 * | 電話を押す | 端末の電話に渡す(`tel:`) |
 * | メールを押す | メールの下書きが開く(`mailto:`) |
 * | 上の欄で **足す** | 名前を題名にしたノートを 1 件作る(先頭の囲みは取込と同じ形 ── #278 段③) |
 *
 * ⚠ **押せない宛先はボタンにしない** ── 数字が 1 桁も無い電話、`@` の無い
 *   メールは**字のまま**出す(押しても何も起きない口を作らない)。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  contactLine,
  displayWays,
  mailHref,
  telHref,
  visibleContacts,
  type ContactCard,
} from '@features/contact/contact-card';

export class ContactsRenderer {
  private readonly host: HTMLElement;
  /** 直前に描いた指紋。⚠ 同じなら触らない(押している最中に作り直さない)。 */
  private last = ' ';
  /**
   * 🔴 **一覧を描き直す器**(#278 段③)── 足す欄とは**別**にする。
   * ⚠ 一覧は指紋が変わるたびに丸ごと作り直す(下の `textContent = ''`)。欄を同じ器に
   *   置くと、走査が届いた瞬間に**打ちかけの字が消える**。だから欄は作り直さない親
   *   (`host`)に 1 度だけ組み、一覧はこの `body` に描く
   *   (`schedule.ts` の `ensureFrame` と同じ作法)。
   */
  private body: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /**
   * 🔴 **その場で 1 件足す欄**(#278 段③。user 裁定 2026-09-04)。
   *
   * > user の物語: 連絡先タブを眺めている。名刺をもらった人を足したい。
   * > いまは足す口が無い ── ノートを作る → 先頭に `---` / `tel:` … と手で書く → 戻る。
   *
   * 🔑 **正本は本文のまま**(user 指示 2026-08-23「面は映すだけにしない ── 双方向」)。
   *   押した先(`binder.ts` の `contacts-quick-add`)は取込と**同じ 1 本**(`vcfNoteOf`)で
   *   frontmatter を組む ── 鍵の綴りを 2 か所に書かない。
   * ⚠ 必須は名前だけ。電話・メールの書き方は**ここでも binder でも検めない** ──
   *   押せない宛先を字のまま出す規則は下の `way()` が既に持っている(2 か所で判定しない)。
   * ⚠ 1 度だけ組む ── 一覧の描き直し(下)で欄を作り直さない(打ちかけを失わせない)。
   */
  private ensureFrame(): HTMLElement {
    if (this.body !== null) return this.body;
    const quick = document.createElement('div');
    quick.setAttribute('data-pkc-field', 'contacts-quick');
    const input = (
      field: string,
      placeholder: string,
      label: string,
      type: 'text' | 'tel' | 'email' = 'text',
    ): HTMLInputElement => {
      const el = document.createElement('input');
      // ⚠ `tel` / `email` は端末の鍵盤を選ぶためだけ ── `<form>` の外なので検証は走らない
      el.type = type;
      el.setAttribute('data-pkc-field', `contacts-quick-${field}`);
      el.placeholder = placeholder;
      el.setAttribute('aria-label', label);
      return el;
    };
    const add = document.createElement('button');
    add.type = 'button';
    add.setAttribute('data-pkc-action', 'contacts-quick-add');
    add.textContent = '足す';
    // ⚠ **どこへ書くか**と**いつ並ぶか**を両方言う ── 「足したのに出てこない」を作らない
    add.title =
      '名前を題名にしたノートを作り、先頭の囲みに tel: / email: / org: を書きます(取り込みと同じ形)。電話かメールが 1 つ以上あると、ここに並びます';
    quick.append(
      input('name', '名前', '足す連絡先の名前(必須)'),
      input('tel', '電話', '電話番号', 'tel'),
      input('email', 'メール', 'メールアドレス', 'email'),
      input('org', '所属', '所属'),
      add,
    );
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'contacts-body');
    this.host.append(quick, body);
    this.body = body;
    return body;
  }

  render(state: AppState): void {
    // ⚠ 欄は指紋より先に組む ── 「まだ集めていない」回でも足す口は出ている
    const body = this.ensureFrame();
    const scan = state.contactScan;
    const query = state.filterQuery;
    // 🔑 書き出し(binder の `export-vcards`)と**同じ 1 つ**の規則(§7)
    const cards = scan === null ? [] : visibleContacts(scan.cards, query);
    /**
     * ⚠ **指紋に「集めていない」も入れる** ── 入れないと、集め終わった瞬間に
     *   `0 件` の指紋と一致してしまい、**一覧が出ないまま**になる。
     */
    const print = [
      /**
       * 🔴 **失敗を先に見る**(2 巡目の着地前レビュー 2026-08-28)。
       *
       * ⚠ 1 稿目は `scan === null` を先に見ていたので、**初回の走査が失敗した回**
       *   (`CONTACT_SCAN_FAILED` は `contactScan` を触らないので `null` のまま)が
       *   「まだ集めていない」と**同じ指紋**になり、下の早期 return で
       *   **DOM が 1 バイトも書き換わらなかった** ── つまり
       *   `noteText` が持っている「集められませんでした」は**一度も画面に出ない**。
       *   user から見ると「集めています…」で**永久に止まる**。
       * ⚠ 予定の面(`schedule.ts`)は `failed` を独立の項として持っており、
       *   **そちらだけ正しかった**(= 設計判断ではなく取りこぼし)。
       */
      state.contactScanFailed ? 'failed' : scan === null ? 'pending' : 'ok',
      scan?.truncated === true ? 't' : '',
      query,
      cards
        .map((c) => `${c.lid}|${c.name}|${c.org}|${c.tels.join(',')}|${c.emails.join(',')}`)
        .join(''),
    ].join('');
    if (print === this.last) return;
    this.last = print;

    body.textContent = '';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'contacts-note');
    note.textContent = this.noteText(state, cards.length);
    body.append(note);
    if (cards.length === 0) {
      /**
       * 🔴 **行き止まりを作らない**(#536 ②)。
       *
       * ⚠ 一覧タブで「会議」と打ったまま連絡先タブへ来ると、当たりが 0 件になり
       *   **「vCard で書き出す」ボタンごと画面から消えていた** ── user は
       *   「書き出しはどこへ行った」と探すことになる。
       * 🔑 **押せないボタンを置くのではなく、進める道を出す** ── 行き止まりに
       *   説明を貼るだけだと、user は**自分で一覧タブへ戻って絞りを消す**必要がある
       *   (CLAUDE.md「片道の操作を作らない」「置かれ方が問題なら、置き直す」)。
       * ⚠ 絞り込みが**無い**ときは出さない ── そのときは本当に連絡先が 0 件で、
       *   外す物が無い(押しても何も起きないボタン = dead click を作らない)。
       */
      if (query !== '') {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.setAttribute('data-pkc-action', 'clear-entry-filter');
        clear.setAttribute('data-pkc-field', 'contacts-clear-filter');
        clear.textContent = '絞りを外す';
        clear.title = '一覧の絞り込みを空にして、連絡先を全部出します。';
        body.append(clear);
      }
      return;
    }

    const list = document.createElement('ul');
    list.setAttribute('data-pkc-field', 'contacts-list');
    for (const card of cards) list.append(this.row(card));
    body.append(list);

    /**
     * 🔴 **vCard の書き出し**(#278 段③)── 押した 1 回だけ、**見えている分**を
     * .vcf 1 つに書く。⚠ 個人情報なので**明示の 1 押し**でしか出ない(自動で
     * どこかへ含めない ── issue の「既定は含めない側」)。文言に件数を出す ──
     * 絞り込み中に「全部出た」と誤読させない。
     */
    const exp = document.createElement('button');
    exp.type = 'button';
    exp.setAttribute('data-pkc-action', 'export-vcards');
    exp.setAttribute('data-pkc-field', 'contacts-export');
    /**
     * ⚠ **途中までしか集めていないなら、ボタンの字でも言う**(#536 ①)──
     *   件数だけ見せると「全部」と読まれる。
     */
    exp.textContent =
      scan?.truncated === true
        ? `vCard で書き出す(途中まで集めた ${cards.length} 件)`
        : `vCard で書き出す(${cards.length} 件)`;
    exp.title =
      'いま見えている連絡先を .vcf ファイル 1 つに書き出します(絞り込み中は絞った分だけ)。' +
      '出るのは名前・所属・電話・メール・誕生日です。' +
      '住所やメモなど、本文に書いた残りは出ません。';
    body.append(exp);
  }

  /**
   * ⚠ **「まだ」と「駄目だった」を区別する**(予定の `taskScanFailed` と同じ理由)
   * ── 区別しないと、面が「集めています…」を出したまま**永久に止まって見える**。
   * ⚠ **切ったことは必ず言う**(「無い」と読ませない)。
   */
  private noteText(state: AppState, shown: number): string {
    if (state.contactScanFailed) return '連絡先を集められませんでした(開き直すと試し直します)';
    const scan = state.contactScan;
    if (scan === null) return '集めています…';
    if (scan.cards.length === 0)
      return '連絡先はまだありません。ノートの先頭に tel: か email: を書くと、ここに並びます。';
    if (shown === 0) return '絞り込みに当たる連絡先がありません';
    const cut = scan.truncated ? '(多いので途中まで集めました)' : '';
    return `${shown} 件${cut}`;
  }

  private row(card: ContactCard): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-contact', card.lid);

    // 🔑 名前は**そのノートを開く** ── 既存の `select-entry` を通す(開く口を増やさない)
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('data-pkc-action', 'select-entry');
    open.setAttribute('data-pkc-entry', card.lid);
    open.setAttribute('data-pkc-field', 'contact-name');
    open.textContent = contactLine(card);
    li.append(open);

    /**
     * ⚠ **丸めるのはここだけ**(`displayWays`)。`ContactCard` は原値を持つ ──
     *   書き出し(`buildVcf`)に画面の丸めが流れ込むと、**壊れた宛先を
     *   在るものとして相手の端末が保存する**(CLAUDE.md §7)。
     * ⚠ **切ったことは必ず言う** ── 黙って落とすと
     *   「9 本目の電話は無い」と読まれる(`truncated` と同じ向き)。
     */
    const ways = document.createElement('span');
    ways.setAttribute('data-pkc-field', 'contact-ways');
    const tels = displayWays(card.tels);
    const mails = displayWays(card.emails);
    // 🔴 **字は丸めた物、押し先は原値**(`DisplayWay` の注記 ── 2 巡目のレビュー)
    for (const t of tels.shown) ways.append(this.way(t.text, telHref(t.raw), 'contact-tel'));
    for (const m of mails.shown) ways.append(this.way(m.text, mailHref(m.raw), 'contact-mail'));
    const hidden = tels.hidden + mails.hidden;
    if (hidden > 0) {
      const more = document.createElement('span');
      more.setAttribute('data-pkc-field', 'contact-ways-more');
      more.textContent = `ほか ${hidden} 件(ノートを開くと全部あります)`;
      ways.append(more);
    }
    li.append(ways);
    return li;
  }

  /**
   * 1 つの宛先。⚠ **押せないものはボタンにしない**(字のまま出す)──
   *   押しても何も起きない口は、user から見て「壊れている」と同じである。
   */
  private way(text: string, href: string | null, field: string): HTMLElement {
    if (href === null) {
      const span = document.createElement('span');
      span.setAttribute('data-pkc-field', `${field}-plain`);
      span.textContent = text;
      return span;
    }
    const a = document.createElement('a');
    a.setAttribute('data-pkc-field', field);
    a.href = href;
    a.textContent = text;
    return a;
  }
}
