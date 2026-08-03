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

/** SQLite の UTC 文字列を「日付だけ」に落とす。⚠ 生の値を user に見せない。 */
function shortDate(value: string | null): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : value;
}

export class InspectorRenderer {
  private lastMeta: EntryMeta | undefined | null = undefined;
  private lastPhase: string | null = null;
  /** 同じノートに戻ったら同じ位置へ(P8 段⑫。溢れるのは題名が長いときだけ)。 */
  private readonly scroll: ScrollMemory;

  constructor(private readonly region: HTMLElement) {
    this.scroll = new ScrollMemory(region);
  }

  render(state: AppState): void {
    const meta = state.selectedLid ? state.entryMetas.get(state.selectedLid) : undefined;
    // 断面指紋 ── meta の参照と phase が同じなら DOM に触れない
    if (meta === this.lastMeta && state.phase === this.lastPhase) return;
    // ⚠ **書き換える前に**退避(後だと縮んで丸められた値を保存する)
    this.scroll.park();
    this.lastMeta = meta;
    this.lastPhase = state.phase;
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
    row('作成', shortDate(meta.createdAt), 'inspector-created');
    row('更新', shortDate(meta.updatedAt), 'inspector-updated');
    this.region.append(dl);

    // ⚠ **操作は対象の隣**(P8)。共通ツールバーに集約しない
    const actions = document.createElement('div');
    actions.setAttribute('data-pkc-field', 'inspector-actions');
    const btn = (action: string, label: string, title: string): void => {
      const b = iconButton(action, label);
      b.setAttribute('data-pkc-entry', meta.lid);
      b.title = title;
      actions.append(b);
    };
    btn('export-entry', '書き出す', 'このノートだけを Markdown で保存します');
    btn('show-history', '履歴', '過去の版を一覧します');
    btn('delete-entry', '削除', 'ゴミ箱へ移します(フォルダ画面から戻せます)');
    this.region.append(actions);
    // ⚠ **中身を入れ終わってから**戻す(空の器に書いても丸められる)
    this.scroll.use(meta.lid);
  }
}
