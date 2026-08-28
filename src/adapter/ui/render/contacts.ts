/**
 * 🔴 **連絡先の面**(#278 段①。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ…、**連絡先**、
 * タイマー、アラートは組み込みアプリでリリースしたい」)。
 *
 * ## どこに在るか ── **左の列のタブ**(中央の面にしない)
 *
 * `features/launcher/tiles.ts` が #292 段⑤ で確立した見分け方:
 * **「それを閉じたとき user が失うものは何か」**。⚠ 連絡先を閉じても
 * **失う物は無い**(連絡先は**ノート**である)── つまり道具ではなく
 * **ノートの見方**なので、`browse.ts` の表どおり**左**である
 * (中央の本文を退かす理由が無い ── #300 の user 指摘)。
 *
 * ## 何ができるか ── **見るだけの面にしない**
 *
 * | 操作 | 何が起きるか |
 * |---|---|
 * | 名前を押す | そのノートを中央に開く(面はそのまま) |
 * | 電話を押す | 端末の電話に渡す(`tel:`) |
 * | メールを押す | メールの下書きが開く(`mailto:`) |
 *
 * ⚠ **押せない宛先はボタンにしない** ── 数字が 1 桁も無い電話、`@` の無い
 *   メールは**字のまま**出す(押しても何も起きない口を作らない)。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  contactLine,
  mailHref,
  telHref,
  visibleContacts,
  type ContactCard,
} from '@features/contact/contact-card';

export class ContactsRenderer {
  private readonly host: HTMLElement;
  /** 直前に描いた指紋。⚠ 同じなら触らない(押している最中に作り直さない)。 */
  private last = ' ';

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.setAttribute('data-pkc-region', 'contacts');
  }

  render(state: AppState): void {
    const scan = state.contactScan;
    const query = state.filterQuery;
    // 🔑 書き出し(binder の `export-vcards`)と**同じ 1 つ**の規則(§7)
    const cards = scan === null ? [] : visibleContacts(scan.cards, query);
    /**
     * ⚠ **指紋に「集めていない」も入れる** ── 入れないと、集め終わった瞬間に
     *   `0 件` の指紋と一致してしまい、**一覧が出ないまま**になる。
     */
    const print = [
      scan === null ? 'pending' : state.contactScanFailed ? 'failed' : 'ok',
      scan?.truncated === true ? 't' : '',
      query,
      cards
        .map((c) => `${c.lid}|${c.name}|${c.org}|${c.tels.join(',')}|${c.emails.join(',')}`)
        .join(''),
    ].join('');
    if (print === this.last) return;
    this.last = print;

    this.host.textContent = '';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'contacts-note');
    note.textContent = this.noteText(state, cards.length);
    this.host.append(note);
    if (cards.length === 0) return;

    const list = document.createElement('ul');
    list.setAttribute('data-pkc-field', 'contacts-list');
    for (const card of cards) list.append(this.row(card));
    this.host.append(list);

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
    exp.textContent = `vCard で書き出す(${cards.length} 件)`;
    exp.title = 'いま見えている連絡先を .vcf ファイル 1 つに書き出します(絞り込み中は絞った分だけ)';
    this.host.append(exp);
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

    const ways = document.createElement('span');
    ways.setAttribute('data-pkc-field', 'contact-ways');
    for (const tel of card.tels) ways.append(this.way(tel, telHref(tel), 'contact-tel'));
    for (const mail of card.emails) ways.append(this.way(mail, mailHref(mail), 'contact-mail'));
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
