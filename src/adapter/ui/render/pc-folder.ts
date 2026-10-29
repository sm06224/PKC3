/**
 * 🔴 **左の列のタブ「PC」の中身**(#215 段①②。🟣 Gemini 裁定 2026-10-01:
 * 別のタブに並べ、押すと取り込んで開く)。
 *
 * ## 画面で何が起きるか
 *
 * 1. 「フォルダを選ぶ…」を押す → OS のフォルダ選択が出る
 * 2. 選ぶと、**そのフォルダの直下**が名前順に並ぶ(サブフォルダの行を押すと**中へ入り**、上のパンくずで**上の階層へ戻れる**。#215)(名前 / 種類。大きさ・更新日は「—」── 一覧では file を読まない、#1271)。
 *    200 件で切れて「さらに表示」
 * 3. ファイルの行を押すと、**PKC に取り込んで中央に開く**(このタブは開いたまま)
 * 4. 「更新」で同じフォルダの一覧を読み直す / 「別のフォルダ…」で選び直す(切らずに済む。#1264 §2)
 * 5. 「切る」で繋ぎを外す(次に開いたときは繋がっていない)
 * 6. 「Office のファイルを開く…」で、フォルダを繋がずに Office の file を 1 つ選んで開く(#432。保存で元の file へ書き戻す。
 *    書き戻せない環境ではダウンロードに保存する)。Office の行を押したときも同じ
 *
 * 🔴 **消す口・改名・移動は置かない**(裁定)── パソコンのファイルは取り消せない。
 * ⚠ **Markdown の行にだけ**「元ファイルと結びつきます」を出す(取り込んだあと元のファイルへ
 *   書き戻せるのは Markdown だけ)。画像・PDF・Office などの行には**何も添えない**(#1264 §2 改善 1 ──
 *   200 行あれば 200 回「書き戻せません」が出ていた)。
 *
 * ⚠ **描画器は handle を持たない** ── `LocalFolder`(`platform/local-folder.ts`)の
 *   `view()` を映すだけで、押された先は `data-pkc-action` を通って binder が呼ぶ
 *   (描画器は state を読まず、DOM から状態を引かない)。
 */
import type { LocalFolder, LocalFolderRow, LocalFolderView } from '@adapter/platform/local-folder';
import type { FolderSync, FolderSyncView } from '@adapter/platform/folder-sync';
import { SYNC_INTERVAL_MINUTES } from '@features/folder-sync/folder-sync';
import {
  FOLDER_PAGE,
  PC_CONTACT_NOTE,
  PC_ENTER_TITLE,
  PC_LINK_NOTE,
  PC_STATS_NOTE,
  fileKindOf,
  iconFor,
  folderModifiedText,
  folderSizeText,
} from '@features/local-folder/folder-entries';
import { iconSpan } from './icons';

const field = (el: HTMLElement, name: string): void => el.setAttribute('data-pkc-field', name);

function button(action: string, name: string, text: string, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  field(b, name);
  b.textContent = text;
  if (title !== undefined) b.title = title;
  return b;
}

/**
 * 行の 1 行目 ── 種類の絵 + 名前(#1272)。
 * ⚠ 名前の span(`pc-name`)の**外**に絵を置く ── 名前の `textContent` に絵が混ざらない。
 */
function head(row: LocalFolderRow): HTMLSpanElement {
  const h = document.createElement('span');
  field(h, 'pc-head');
  const name = document.createElement('span');
  field(name, 'pc-name');
  name.textContent = row.name;
  h.append(iconSpan(iconFor(row)), name);
  return h;
}

function para(name: string, text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  field(p, name);
  p.textContent = text;
  return p;
}

export class PcFolderRenderer {
  /** フォルダの一覧を描く箱(以下の `renderFolder` 系はここへ描く)。 */
  private readonly host: HTMLElement;
  private readonly folder: LocalFolder;
  private readonly sync: FolderSync | null;
  /** 直前に描いた版。⚠ 同じなら触らない(押している最中に作り直さない)。 */
  private last = -1;
  private lastSync = -1;
  /**
   * 同期の欄。🔴 **間隔の `<select>` は作り直さない**(開いている最中に同期が走って欄を描き直すと、開いた一覧が閉じる)。
   * 欄の外枠と `<select>` は 1 度だけ作り、前後の部分(`dynTop` / `dynBottom`)だけ描き直す。
   */
  private syncSec: HTMLElement | null = null;
  private syncTop: HTMLElement | null = null;
  private syncBottom: HTMLElement | null = null;
  private syncSelect: HTMLSelectElement | null = null;

  constructor(host: HTMLElement, folder: LocalFolder, sync: FolderSync | null = null) {
    // 箱を 2 つに分ける: フォルダの一覧(フォルダの版で描き直す)と、同期の欄(同期の版で描き直す)。
    // ⚠ `display: contents`(CSS)── 箱を挟んでも、並び(縦積み・間隔)は変わらない
    const folderBox = document.createElement('div');
    field(folderBox, 'pc-folder-box');
    host.append(folderBox);
    this.host = folderBox;
    this.outer = host;
    this.folder = folder;
    this.sync = sync;
  }

  private readonly outer: HTMLElement;

  render(): void {
    const view = this.folder.view();
    if (view.version !== this.last) {
      this.last = view.version;
      this.host.textContent = '';
      this.renderFolder(view);
    }
    const syncView = this.sync?.view() ?? null;
    if (syncView !== null && syncView.version !== this.lastSync) {
      this.lastSync = syncView.version;
      this.renderSync(syncView);
    }
  }

  /**
   * 🔴 **フォルダとの同期**(#1455 の後半)── PC タブの下に置く。ノートを選んだフォルダの Markdown と、
   * 一定の間隔で同期する(正本は PKC3)。上の「取り込んで開く」とは別の仕事なので、見出しで分ける。
   * ⚠ 選べないブラウザでは**理由を言う**(押せないボタンを置かない)。⚠ 同期をやめる口を必ず置く(片道にしない)。
   */
  private renderSync(v: FolderSyncView): void {
    if (this.syncSec === null) {
      const sec = document.createElement('section');
      field(sec, 'pc-sync');
      const title = document.createElement('div');
      field(title, 'pc-sync-title');
      title.textContent = 'フォルダと同期';
      const top = document.createElement('div');
      field(top, 'pc-sync-top');
      const sel = document.createElement('select');
      sel.setAttribute('data-pkc-action', 'pc-sync-interval');
      field(sel, 'pc-sync-interval');
      sel.setAttribute('aria-label', '同期の間隔');
      for (const m of SYNC_INTERVAL_MINUTES) {
        const o = document.createElement('option');
        o.value = String(m);
        o.textContent = m === 60 ? '1 時間ごと' : `${m} 分ごと`;
        sel.append(o);
      }
      const bottom = document.createElement('div');
      field(bottom, 'pc-sync-bottom');
      sec.append(title, top, sel, bottom);
      this.outer.append(sec);
      this.syncSec = sec;
      this.syncTop = top;
      this.syncBottom = bottom;
      this.syncSelect = sel;
    }
    const top = this.syncTop!;
    const bottom = this.syncBottom!;
    const sel = this.syncSelect!;
    top.textContent = '';
    bottom.textContent = '';
    const connected = v.phase === 'idle' || v.phase === 'running';
    // 間隔は、つながっている間だけ出す(1 つの要素を出し入れするだけ ── 作り直さない)
    if (sel.hidden === connected) sel.hidden = !connected;
    if (connected && sel.value !== String(v.minutes) && sel.ownerDocument.activeElement !== sel) sel.value = String(v.minutes);

    if (v.phase === 'unsupported') {
      top.append(para('pc-sync-note', v.message ?? ''));
      return;
    }
    if (v.phase === 'none') {
      top.append(
        para(
          'pc-sync-note',
          'ノートを、パソコンのフォルダの Markdown(.md)と定期的に同期します。正本は PKC3 です。フォルダで直した内容は PKC3 に取り込み、PKC3 で直した内容はフォルダに書きます。',
        ),
        button(
          'pc-sync-pick',
          'pc-sync-pick',
          'フォルダを選んで同期…',
          'フォルダを選ぶと、すぐ 1 回同期します。開き直すと同期は止まります(フォルダは保存しません)',
        ),
      );
      return;
    }
    const name = document.createElement('div');
    field(name, 'pc-sync-folder');
    name.textContent = `同期先: ${v.folderName ?? ''}`;
    name.title = v.folderName ?? '';
    top.append(name);
    if (v.phase === 'lost' || v.phase === 'stopped') {
      bottom.append(
        para('pc-sync-note', v.message ?? '同期を止めました'),
        button('pc-sync-pick', 'pc-sync-pick', 'フォルダを選び直す…', '別のフォルダ(または同じフォルダ)を選んで、もう一度同期を始めます'),
        button('pc-sync-stop', 'pc-sync-stop', '同期をやめる', '同期をやめます(フォルダのファイルとノートには何もしません)'),
      );
      return;
    }
    if (v.phase === 'running') {
      bottom.append(para('pc-sync-note', '同期しています…'));
    } else {
      bottom.append(
        button('pc-sync-now', 'pc-sync-now', '今すぐ同期', 'いま 1 回同期します'),
        button('pc-sync-stop', 'pc-sync-stop', '同期をやめる', '同期をやめます(フォルダのファイルとノートには何もしません)'),
      );
    }
    if (v.lastText !== null) bottom.append(para('pc-sync-last', `${v.lastAt ?? ''} ${v.lastText}`.trim()));
    // 🔴 フォルダでファイルが消えたノート: 黙って書き戻さず、行ごとに選んでもらう
    if (v.gone.length > 0) {
      bottom.append(
        para('pc-sync-note', `フォルダで消えたノート ${v.gone.length} 件(どうするか選んでください。選ぶまでは、そのままです)`),
        this.noteList('pc-sync-gone', v.gone, (lid, title) => [
          this.syncRowButton('pc-sync-restore', lid, '書き戻す', `「${title}」をフォルダに書き直します`),
          this.syncRowButton('pc-sync-detach', lid, '同期から外す', `「${title}」をこれ以後の同期の対象から外します(ノートは消えません。あとで「同期に戻す」で戻せます)`),
        ]),
      );
    }
    if (v.detached.length > 0) {
      bottom.append(
        para('pc-sync-note', `同期から外したノート ${v.detached.length} 件`),
        this.noteList('pc-sync-detached', v.detached, (lid, title) => [
          this.syncRowButton('pc-sync-attach', lid, '同期に戻す', `「${title}」を同期の対象に戻します(フォルダには新しいファイルとして書きます)`),
        ]),
      );
    }
  }

  private syncRowButton(action: string, lid: string, text: string, title: string): HTMLButtonElement {
    const b = button(action, action, text, title);
    b.setAttribute('data-pkc-sync-lid', lid);
    return b;
  }

  private noteList(
    name: string,
    rows: readonly { lid: string; title: string }[],
    buttons: (lid: string, title: string) => HTMLButtonElement[],
  ): HTMLUListElement {
    const ul = document.createElement('ul');
    field(ul, name);
    for (const r of rows) {
      const li = document.createElement('li');
      const t = document.createElement('span');
      field(t, 'pc-sync-note-title');
      t.textContent = r.title === '' ? '(無題)' : r.title;
      t.title = r.title;
      li.append(t, ...buttons(r.lid, r.title));
      ul.append(li);
    }
    return ul;
  }

  private renderFolder(view: LocalFolderView): void {
    switch (view.phase) {
      case 'unsupported':
        // ⚠ タブは出したまま、使えない理由と行き先を言う(押せないボタンは置かない)
        this.host.append(para('pc-note', 'このブラウザでは使えません(Chrome / Edge で開いてください)'));
        return;
      case 'none':
        this.host.append(
          para('pc-note', 'パソコンのフォルダを選ぶと、中のファイルが並びます。押すと PKC3 に取り込んで開きます。'),
          this.pickButton(),
          ...this.officeOnly(view),
        );
        return;
      case 'lost':
        this.host.append(
          para('pc-note', '許可が切れました。もう一度フォルダを選んでください'),
          this.pickButton(),
          ...this.officeOnly(view),
        );
        return;
      case 'failed':
        this.host.append(
          ...(view.crumbs.length > 1 ? [this.band(view)] : []),
          para('pc-note', view.message ?? 'フォルダを開けませんでした'),
          ...(view.crumbs.length > 1 ? [] : [this.pickButton()]),
          ...this.officeOnly(view),
        );
        return;
      case 'listing':
        this.host.append(this.band(view), para('pc-note', `読み込んでいます… ${view.counted} 件`));
        return;
      case 'listed':
        this.renderListed(view);
    }
  }

  private officeOnly(view: LocalFolderView): HTMLButtonElement[] {
    return view.canPickFile ? [this.officeButton()] : [];
  }

  /** 🔴 フォルダを繋がずに Office の file を 1 つ選んで開く(#432)。 */
  private officeButton(): HTMLButtonElement {
    return button(
      'pc-open-office-file',
      'pc-office',
      'Office のファイルを開く…',
      'パソコンの Office ファイル(docx / xlsx / pptx など)を選んで Office で開きます。保存すると元のファイルへ書き戻します(書き戻せないときはダウンロードに保存します)',
    );
  }

  private pickButton(): HTMLButtonElement {
    return button(
      'pc-pick-folder',
      'pc-pick',
      'フォルダを選ぶ…',
      'パソコンのフォルダを選びます。選んだだけでは何も書き換えません。取り込んだ Markdown を書き戻すときは、そのつど確認が出ます',
    );
  }

  /**
   * 選んでいるフォルダの名前と「更新」「別のフォルダ…」「切る」(#1264 §2 欠陥 4-a)。
   * ⚠ 読み込み中(`listing`)は「切る」だけ ── 更新・選び直しは**一覧が出た後**の操作
   *   (読んでいる最中に読み直すと、数が巻き戻って見える)。
   */
  private band(view: LocalFolderView): HTMLElement {
    const band = document.createElement('div');
    field(band, 'pc-band');
    const name = document.createElement('span');
    field(name, 'pc-folder-name');
    name.textContent = view.folderName ?? '';
    name.title = view.folderName ?? '';
    // 🔴 パンくず(#215)── 上の階層は押して戻れる。いまの階層(最後)は字だけ
    const crumbs = document.createElement('span');
    field(crumbs, 'pc-crumbs');
    for (const c of view.crumbs.slice(0, -1)) {
      const b = button('pc-crumb', 'pc-crumb', c.name, `「${c.name}」へ戻ります`);
      b.setAttribute('data-pkc-pc-level', String(c.level));
      const sep = document.createElement('span');
      field(sep, 'pc-crumb-sep');
      sep.textContent = '/';
      crumbs.append(b, sep);
    }
    crumbs.append(name);
    band.append(crumbs);
    if (view.phase === 'listed') {
      band.append(
        button(
          'pc-refresh-folder',
          'pc-refresh',
          '更新',
          '同じフォルダの一覧を再読み込みします(ファイルの中身は読みません)',
        ),
        // ⚠ 「フォルダを選ぶ…」と**同じ口**(`pc-pick-folder`)── 選び直しの入り口を 2 つ作らない
        button(
          'pc-pick-folder',
          'pc-repick',
          '別のフォルダ…',
          '別のフォルダを選びます(選ばずに閉じれば、いまのフォルダのままです)',
        ),
      );
    }
    if (view.canPickFile) band.append(this.officeButton());
    band.append(
      button(
        'pc-cut-folder',
        'pc-cut',
        '接続を解除',
        'このフォルダとの接続を解除します(取り込んだノートはそのまま残ります。パソコンのファイルには何もしません)',
      ),
    );
    return band;
  }

  private renderListed(view: LocalFolderView): void {
    this.host.append(this.band(view));
    const shown = view.rows.length;
    this.host.append(
      para(
        'pc-note',
        view.total === 0
          ? 'このフォルダにはファイルがありません'
          : view.more
            ? `${view.total} 件のうち先頭 ${shown} 件を表示しています`
            : `${view.total} 件`,
      ),
    );
    if (view.total === 0) return;
    const list = document.createElement('ul');
    field(list, 'pc-list');
    for (const row of view.rows) list.append(this.row(row));
    this.host.append(list);
    if (view.more) {
      const rest = view.total - shown;
      this.host.append(
        button(
          'pc-more',
          'pc-more',
          `さらに表示(残り ${rest} 件)`,
          `${Math.min(FOLDER_PAGE, rest)} 件ずつ足します`,
        ),
      );
    }
  }

  private row(row: LocalFolderRow): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-pc-row', String(row.index));
    // 🔴 大きさ・更新日は**一覧では読まない**(#1271)── 読むには `getFile()` が要り、クラウド同期の
    // フォルダ(ファイルオンデマンド)では未ダウンロードの実体を一斉に取りに行く。列は残して「—」を出す
    const meta = [row.label, folderSizeText(null), folderModifiedText(null)].join(' · ');
    if (row.kind === 'directory') {
      // 🔴 サブフォルダは押すと**中へ入る**(#215)。上の階層へはパンくずで戻る
      const enter = button('pc-enter-dir', 'pc-enter', '', PC_ENTER_TITLE);
      enter.setAttribute('data-pkc-pc-index', String(row.index));
      const about = document.createElement('span');
      field(about, 'pc-meta');
      about.textContent = row.label;
      enter.append(head(row), about);
      li.append(enter);
      return li;
    }
    const isOffice = fileKindOf(row.name).route === 'office';
    const open = button(
      'pc-open-file',
      'pc-open',
      '',
      isOffice
        ? 'Office で開きます。保存すると元のファイルへ書き戻します(書き込みの許可を求めます。書き戻せないときはダウンロードに保存します)'
        : row.writeBack
          ? '取り込んで開きます。直して保存したあと、情報ペインの「元ファイルへ書き戻す」でパソコンのファイルも書き換えられます'
          : '取り込んで開きます(PKC3 の添付や連絡先になります)。元のファイルへは書き戻せません',
    );
    open.setAttribute('data-pkc-pc-index', String(row.index));
    const about = document.createElement('span');
    field(about, 'pc-meta');
    about.textContent = meta;
    about.title = PC_STATS_NOTE;
    open.append(head(row), about);
    // 🔴 連絡先になることを、ホバーに頼らず見える字で言う(#1264 §1)
    if (fileKindOf(row.name).route === 'contact') {
      const contact = document.createElement('span');
      field(contact, 'pc-contact-note');
      contact.textContent = PC_CONTACT_NOTE;
      open.append(contact);
    }
    // 🔴 結びつく(= 書き戻せる)行にだけ言う。書き戻せない行には何も添えない(#1264 §2 改善 1)
    if (row.writeBack) {
      const note = document.createElement('span');
      field(note, 'pc-link-note');
      note.textContent = PC_LINK_NOTE;
      open.append(note);
    }
    li.append(open);
    return li;
  }
}
