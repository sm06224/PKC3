/**
 * 🔴 **左の列のタブ「パソコン」の中身**(#215 段①②。🟣 Gemini 裁定 2026-10-01:
 * 別のタブに並べ、押すと取り込んで開く)。
 *
 * ## 画面で何が起きるか
 *
 * 1. 「フォルダを選ぶ…」を押す → OS のフォルダ選択が出る
 * 2. 選ぶと、**そのフォルダの直下**が名前順に並ぶ(名前 / 種類 / 大きさ / 更新日)。
 *    200 件で切れて「さらに表示」
 * 3. ファイルの行を押すと、**PKC に取り込んで中央に開く**(このタブは開いたまま)
 * 4. 「切る」で繋ぎを外す(次に開いたときは繋がっていない)
 *
 * 🔴 **消す口・改名・移動は置かない**(裁定)── パソコンのファイルは取り消せない。
 * ⚠ **書き戻せない種類**(画像・PDF・Office…)の行には「書き戻せません」を出す
 *   (Markdown だけが、取り込んだあと元のファイルへ書き戻せる)。
 *
 * ⚠ **描画器は handle を持たない** ── `LocalFolder`(`platform/local-folder.ts`)の
 *   `view()` を映すだけで、押された先は `data-pkc-action` を通って binder が呼ぶ
 *   (描画器は state を読まず、DOM から状態を引かない)。
 */
import type { LocalFolder, LocalFolderRow, LocalFolderView } from '@adapter/platform/local-folder';
import { FOLDER_PAGE, folderModifiedText, folderSizeText } from '@features/local-folder/folder-entries';

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
        this.host.append(para('pc-note', '許可が切れました ── もう一度フォルダを選んでください'), this.pickButton());
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

  /** 選んでいるフォルダの名前と「切る」。 */
  private band(view: LocalFolderView): HTMLElement {
    const band = document.createElement('div');
    field(band, 'pc-band');
    const name = document.createElement('span');
    field(name, 'pc-folder-name');
    name.textContent = view.folderName ?? '';
    name.title = view.folderName ?? '';
    band.append(
      name,
      button('pc-cut-folder', 'pc-cut', '切る', '繋ぎを外します(パソコンのファイルには何もしません)'),
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
    const meta = [row.label, folderSizeText(row.size), folderModifiedText(row.modified)].join(' · ');
    if (row.kind === 'directory') {
      // ⚠ フォルダは押せない(直下だけ ── 中へは入らない)。押せる見た目にしない
      const name = document.createElement('span');
      field(name, 'pc-name');
      name.textContent = row.name;
      const about = document.createElement('span');
      field(about, 'pc-meta');
      about.textContent = row.label;
      li.append(name, about);
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
    const name = document.createElement('span');
    field(name, 'pc-name');
    name.textContent = row.name;
    const about = document.createElement('span');
    field(about, 'pc-meta');
    about.textContent = meta;
    open.append(name, about);
    if (!row.writeBack) {
      const note = document.createElement('span');
      field(note, 'pc-readonly');
      note.textContent = '書き戻せません';
      open.append(note);
    }
    li.append(open);
    return li;
  }
}
