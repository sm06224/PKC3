/**
 * 右の付随情報ペイン(P8)。
 *
 * 🔑 **1 画面で完結**(user 指示 2026-08-03。業務画面の作法)── いま選んでいる
 * ものの**素性**と、それに**対する操作**を、本文の隣に常時置く。
 * 以前は素性を見る面が無く、操作は本文の上のツールバーに集約されていて、
 * **編集に入ると両方消えて** textarea 1 枚になっていた。
 *
 * ⚠ ここは**読むだけ**ではない ── 「操作は対象の隣」に従い、その entry に
 * 対する操作(書き出す・履歴・削除)はここが持つ。
 * ⚠ frontmatter を直に編集させる面(user 指示「基本は UI 導線ありき」)は
 * 次の段。この段では**素性を見せて、操作を隣に戻す**ところまで。
 */
import type { AppState } from '@adapter/state/app-state';
import { ScrollMemory } from './scroll-memory';
import type { EntryMeta } from '@core/model/entry-meta';
import { archetypeLabel } from './sidebar';
import { iconButton } from './icons';
// ⚠ 日付の切り方は `features/datetime/stored-date` が正本(一覧の行と共有)。
//    ここで独自に parse していた頃は、一覧に日付を出すときに規則が 2 つに増えた
import { formatStoredDate } from '@features/datetime/stored-date';


export class InspectorRenderer {
  private lastMeta: EntryMeta | undefined | null = undefined;
  private lastPhase: string | null = null;
  /** 元ファイルの紐づけも指紋の一部 ── 忘れると「書き戻す」が出ない(2026-08-05)。 */
  private lastLink: string | null = null;
  /** 同じノートに戻ったら同じ位置へ(P8 段⑫。溢れるのは題名が長いときだけ)。 */
  private readonly scroll: ScrollMemory;

  constructor(private readonly region: HTMLElement) {
    this.scroll = new ScrollMemory(region);
  }

  render(state: AppState): void {
    const meta = state.selectedLid ? state.entryMetas.get(state.selectedLid) : undefined;
    // 🔴 紐づけは**取込の後**に届く(`FILE_LINKED`)── meta と phase だけを指紋に
    //    すると、開いた直後は「書き戻す」が出ないままになる
    const link = (state.selectedLid && state.linkedFiles.get(state.selectedLid)) || null;
    // 断面指紋 ── meta の参照と phase が同じなら DOM に触れない
    if (meta === this.lastMeta && state.phase === this.lastPhase && link === this.lastLink) return;
    // ⚠ **書き換える前に**退避(後だと縮んで丸められた値を保存する)
    this.scroll.park();
    this.lastMeta = meta;
    this.lastPhase = state.phase;
    this.lastLink = link;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = '情報';
    this.region.append(head);

    if (!meta) {
      this.scroll.use('');
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'inspector-empty');
      empty.textContent = '左の一覧から選ぶと、ここに情報が出ます。';
      this.region.append(empty);
      return;
    }

    const dl = document.createElement('dl');
    const row = (label: string, value: string, field?: string): void => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      if (field) dd.setAttribute('data-pkc-field', field);
      dl.append(dt, dd);
    };
    row('題名', meta.title, 'inspector-title');
    row('種類', archetypeLabel(meta.archetype), 'inspector-kind');
    row('作成', formatStoredDate(meta.createdAt), 'inspector-created');
    row('更新', formatStoredDate(meta.updatedAt), 'inspector-updated');
    // 🔴 **どのファイルから来たか**を出す(2026-08-05)── 出さないと、書き戻しが
    //    「どこへ」書くのか分からない操作になる。⚠ この行の有無が導線の有無と一致する
    if (link !== null) row('元ファイル', link, 'inspector-linked-file');
    this.region.append(dl);

    // ⚠ **操作は対象の隣**(P8)。共通ツールバーに集約しない
    const actions = document.createElement('div');
    actions.setAttribute('data-pkc-field', 'inspector-actions');
    /**
     * 🔴 **編集中は押せなくする**(P8 段⑲)。
     *
     * 直す前は 3 つとも押せる見た目のまま出ていたが、実際には
     * `DELETE_ENTRY` / `SHOW_HISTORY` が `phase !== 'ready'` で**黙って何もしない**
     * ── 押しても画面が 1 ドットも変わらず、user には「壊れている」としか見えない。
     * ⚠ **消さずに、押せなくする**(業務画面の作法「同じものが常に同じ場所にある」)。
     * ⚠ 理由を `title` に書く ── 押せない理由が分からないほうが困る。
     */
    const editing = state.phase !== 'ready';
    const btn = (action: string, label: string, title: string): void => {
      const b = iconButton(action, label);
      b.setAttribute('data-pkc-entry', meta.lid);
      if (editing) {
        b.disabled = true;
        b.title = `${title}(編集中は使えません ── 確定するか取り消してください)`;
      } else {
        b.title = title;
      }
      actions.append(b);
    };
    // ⚠ 文言は**実際に落ちるもの**に合わせる(P8 段⑱)── ここは可逆な
    //    アーカイブで、Markdown ではない(マニュアル §5 の表と同じ材料)
    btn(
      'export-entry',
      '書き出す',
      'このノートだけをバックアップ形式(.pkc3.zip)で保存します。取り込み直せます',
    );
    if (link !== null) {
      btn(
        'write-back-file',
        '書き戻す',
        `開いた元のファイル(${link})を、このノートの内容で上書きします`,
      );
    }
    btn('show-history', '履歴', '過去の版を一覧します');
    btn('delete-entry', '削除', 'ゴミ箱へ移します(フォルダ画面から戻せます)');
    this.region.append(actions);
    // ⚠ **中身を入れ終わってから**戻す(空の器に書いても丸められる)
    this.scroll.use(meta.lid);
  }
}
