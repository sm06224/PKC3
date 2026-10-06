/**
 * 🔴 **左の列のタブ「PC」の中身**(#215 段①②。🟣 Gemini 裁定 2026-10-01:
 * 別のタブに並べ、押すと取り込んで開く)。
 *
 * ## 画面で何が起きるか
 *
 * 1. 「フォルダを選ぶ…」を押す → OS のフォルダ選択が出る
 * 2. 選ぶと、**そのフォルダの直下**が名前順に並ぶ(名前 / 種類。大きさ・更新日は「—」── 一覧では file を読まない、#1271)。
 *    200 件で切れて「さらに表示」
 * 3. ファイルの行を押すと、**PKC に取り込んで中央に開く**(このタブは開いたまま)
 * 4. 「更新」で同じフォルダの一覧を読み直す / 「別のフォルダ…」で選び直す(切らずに済む。#1264 §2)
 * 5. 「切る」で繋ぎを外す(次に開いたときは繋がっていない)
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
import {
  FOLDER_PAGE,
  PC_CONTACT_NOTE,
  PC_DIRECTORY_NOTE,
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
  private readonly host: HTMLElement;
  private readonly folder: LocalFolder;
  /** 直前に描いた版。⚠ 同じなら触らない(押している最中に作り直さない)。 */
  private last = -1;

  constructor(host: HTMLElement, folder: LocalFolder) {
    this.host = host;
    this.folder = folder;
  }

  render(): void {
    const view = this.folder.view();
    if (view.version === this.last) return;
    this.last = view.version;
    this.host.textContent = '';
    switch (view.phase) {
      case 'unsupported':
        // ⚠ タブは出したまま、使えない理由と行き先を言う(押せないボタンは置かない)
        this.host.append(para('pc-note', 'このブラウザでは使えません(Chrome / Edge で開いてください)'));
        return;
      case 'none':
        this.host.append(
          para('pc-note', 'パソコンのフォルダを選ぶと、中のファイルが並びます。押すと PKC に取り込んで開きます。'),
          this.pickButton(),
        );
        return;
      case 'lost':
        this.host.append(para('pc-note', '許可が切れました。もう一度フォルダを選んでください'), this.pickButton());
        return;
      case 'failed':
        this.host.append(para('pc-note', view.message ?? 'フォルダを開けませんでした'), this.pickButton());
        return;
      case 'listing':
        this.host.append(this.band(view), para('pc-note', `読み込んでいます… ${view.counted} 件`));
        return;
      case 'listed':
        this.renderListed(view);
    }
  }

  private pickButton(): HTMLButtonElement {
    return button(
      'pc-pick-folder',
      'pc-pick',
      'フォルダを選ぶ…',
      'パソコンのフォルダを選びます。中のファイルを読むだけで、消したり書き換えたりはしません',
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
    band.append(name);
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
    band.append(
      button(
        'pc-cut-folder',
        'pc-cut',
        'フォルダを外す',
        'このフォルダとの接続を外します(取り込んだノートはそのまま残ります。パソコンのファイルには何もしません)',
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
      // ⚠ フォルダは押せない(直下だけ ── 中へは入らない)。押せる見た目にしない
      // 🔴 ただし押されても**無言にしない**(#1264 §1)── ホバーと、押した後の状態の行に同じ字
      li.setAttribute('data-pkc-action', 'pc-dir-note');
      li.title = PC_DIRECTORY_NOTE;
      const about = document.createElement('span');
      field(about, 'pc-meta');
      about.textContent = row.label;
      li.append(head(row), about);
      return li;
    }
    const open = button(
      'pc-open-file',
      'pc-open',
      '',
      row.writeBack
        ? '取り込んで開きます。直して保存したあと、情報ペインの「元ファイルへ書き戻す」でパソコンのファイルも書き換えられます'
        : '取り込んで開きます(PKC の添付や連絡先になります)。元のファイルへは書き戻せません',
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
