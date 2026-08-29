/**
 * sidebar の差分描画(P3 設計メモ §2)。
 *
 * - **断面指紋**: entryMetas / order は reducer が変更時のみ新しい参照を作るので、
 *   参照同一性が指紋になる。指紋一致なら DOM に一切触れない
 *   (PKC2「編集の開始・確定でサイドバー全行再構築」= 体感の主因、の構造対策)
 * - **行は lid キーで再利用**: 一覧が変わっても既存行ノードを patch して使い回す。
 *   再生成は新規 lid のみ
 * - **選択変更は属性 patch のみ**(2 行の data-pkc-selected を付け替える)
 */
import { archetypeLabel } from '@features/flavor/archetype-label';
import type { EntryMeta } from '@core/model/entry-meta';
import { canNavBack, canNavForward, type AppState } from '@adapter/state/app-state';
import { entryFilterOf, matchesEntry } from '@features/filter/title-filter';
import { sortOrder } from '@features/filter/entry-sort';
import { ARCHETYPE_ICONS, iconSpan, setIcon, type IconName } from './icons';
import { formatListDate, formatStoredDate } from '@features/datetime/stored-date';

export class SidebarRenderer {
  private readonly list: HTMLElement;
  /**
   * lid → 行ノード。**絞り込みで外した行もここに残す**(review M-4)。
   *
   * 🔴 初版は絞り込みで外れた行を `rows` から削除していたので、絞り込みを
   * 緩める / 消すたびに `createRow` で作り直していた。15,000 件で実測すると
   * 打鍵ごとに 0.2〜0.75 秒メインスレッドが止まる ── CLAUDE.md が PKC2 の
   * 体感悪化の主因として名指しした「5000 行のサイドバーを作り直す」と同型である。
   * ⚠ `wanted` から外れた行は **DOM からは外す**(`hidden` で残さない ──
   * 行数を数える test や「見えている中で n 番目」が静かにずれる)。
   * ⚠ 一覧から**消えた** entry はここからも消す(でないと際限なく溜まる)。
   */
  private readonly rows = new Map<string, HTMLLIElement>();
  /** 行ごとの描画済み meta 参照 ── 1 件の meta 変更で 15k 行を patch 歩行しない
   *  (patch は querySelector を伴うので、参照一致で丸ごと skip する)。 */
  private readonly rowMeta = new Map<string, EntryMeta>();
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastOrder: readonly string[] | null = null;
  private lastSelected: string | null = null;
  /** ⚠ 絞り込みも**指紋の一部** ── 入れないと、絞っても行が減らない。 */
  private lastHits: ReadonlySet<string> | null = null;
  private lastSort = 'manual';
  /** ⚠ 向きも指紋(入れないと ▲▼ を反転しても並びが変わらない)。 */
  private lastSortDesc = false;
  private lastFilter: string | null = null;

  /** 戻る・進む(#190)。⚠ **押せないときは殺す** ── dead click を作らない。 */
  private readonly navBack: HTMLButtonElement | null;
  private readonly navForward: HTMLButtonElement | null;
  private lastHistory: AppState['selectionHistory'] | null = null;
  /** 0 件のときの字と戻り道。⚠ 器の外に置く(行の数え方を壊さない)。 */
  private emptyNote: HTMLElement | null = null;
  /** 種類の札(#411)。⚠ **器だけ** shell が持ち、中身はここが描く。 */
  private lastKinds: ReadonlySet<string> | null = null;
  /** 前回描いた札の姿。⚠ **数まで含めて**比べる(数だけ変わる回がある)。 */

  constructor(sidebarRegion: HTMLElement) {
    const list = sidebarRegion.querySelector<HTMLElement>(
      '[data-pkc-region="entry-list"]',
    );
    if (!list) throw new Error('sidebar shell missing entry-list region');
    this.list = list;
    this.navBack = sidebarRegion.querySelector<HTMLButtonElement>(
      '[data-pkc-action="nav-back"]',
    );
    this.navForward = sidebarRegion.querySelector<HTMLButtonElement>(
      '[data-pkc-action="nav-forward"]',
    );
  }

  render(state: AppState): void {
    // ⚠ 絞り込みを指紋に入れる。当初は metas / order だけを見ており、
    // **絞り込みを変えても `reconcileRows` が走らなかった**(smoke で実際に踏んだ)
    const listChanged =
      state.entryMetas !== this.lastMetas ||
      state.order !== this.lastOrder ||
      state.filterQuery !== this.lastFilter ||
      // 🔴 **種類の絞りも指紋**(#411)── 入れないと**札を押しても行が減らない**
      //    (上の 2 つとまったく同じ罠。ここで 3 度目なので、足す軸は必ずここへ書く)
      state.kindFilter !== this.lastKinds ||
      // 🔴 **本文の当たりも指紋の一部**(#181)。入れないと、SQL が返っても
      //    画面が変わらない ── state だけ正しくて**行が増えない**
      //    (絞り込みを指紋に入れ忘れた 2026-08 の再演。今回は test が捕まえた)
      state.searchHits !== this.lastHits ||
      // ⚠ 並び順も指紋(入れないと選んでも並びが変わらない ── #181 で踏んだのと同型)
      state.entrySort !== this.lastSort ||
      state.entrySortDesc !== this.lastSortDesc;
    const selectionChanged = state.selectedLid !== this.lastSelected;
    /**
     * ⚠ **履歴も指紋の一部**(#190)。選択と連動して動くことが多いが、
     * 掃除(`pruneHistory`)だけが動く回もあるので**別に見る** ── 入れないと
     * 「戻れないのにボタンが生きている」状態が残る(dead click の作り方そのもの)。
     */
    const historyChanged = state.selectionHistory !== this.lastHistory;
    if (!listChanged && !selectionChanged && !historyChanged) return; // 指紋一致 ── DOM に触れない

    /**
     * 🔴 **欄の同期は、ここではなく `browse.ts` が持つ**(2026-08-29、#536 ② で判明)。
     *
     * ⚠ この renderer は**一覧の面を開いているときしか走らない**
     *   (`browse.ts` が `mode === 'list'` のときだけ呼ぶ)── ところが
     *   **探す欄は面の外**にあって、どの面でも見えている。
     *   だから**フォルダ / 連絡先 / 予定のタブで絞りが変わると、欄だけ古い字が残る**
     *   (タグの札を押した直後がその形だった)。
     * 🔑 #478 の「**札の帯は面に関係なく描く**」と同じ理由である。
     */

    if (listChanged) this.reconcileRows(state);
    if (listChanged || selectionChanged) this.patchSelection(state.selectedLid);
    if (historyChanged) {
      if (this.navBack) this.navBack.disabled = !canNavBack(state);
      if (this.navForward) this.navForward.disabled = !canNavForward(state);
    }

    this.lastHistory = state.selectionHistory;
    this.lastMetas = state.entryMetas;
    this.lastHits = state.searchHits;
    this.lastSort = state.entrySort;
    this.lastSortDesc = state.entrySortDesc;
    this.lastOrder = state.order;
    this.lastFilter = state.filterQuery;
    this.lastKinds = state.kindFilter;
    this.lastSelected = state.selectedLid;
  }

  private reconcileRows(state: AppState): void {
    // 削除を**先に**行う ── stale ノードが cursor に残ると、それ以降の全行が
    // insertBefore(move)になる(review A-2: 先頭 1 行削除で 14,999 move の実測)
    /**
     * 🔑 絞り込み(P7b 段⑨c、user 指示「導線を再考」)。**常駐 meta の題名だけ**を
     * 見る ── 本文は常駐していないので、全文検索をここでやると全 body の読込が要る
     * (それは別の段で、SQL 側に持たせる)。
     *
     * ⚠ 隠すのではなく**外す** ── `hidden` で残すと、行数を数える test や
     * 「見えている中で n 番目」の操作が静かにずれる。
     * ⚠ 判定は**この 1 パスだけ**でやる。当初は下の cursor ループの中で
     * 消していて、**先に取った `cursor` が消えたノードを指す**ため以降の
     * 挿入位置が壊れた(絞り込んでも行が減らない ── smoke で実際に踏んだ)。
     */
    const filter = entryFilterOf(state.filterQuery, state.searchHits, state.kindFilter);
    const visible: string[] = [];
    const wanted = new Set<string>();
    // 一覧に**存在する** lid(絞り込み前)── 行キャッシュの掃除はこちらで判定する
    const alive = new Set<string>();
    // 🔴 並び順(#183)── 規則は `sortOrder` 1 か所。既定は手動の順
    for (const lid of sortOrder(state.order, (l) => state.entryMetas.get(l), state.entrySort, state.entrySortDesc)) {
      const meta = state.entryMetas.get(lid);
      if (!meta) continue;
      alive.add(lid);
      if (!matchesEntry(meta, filter)) continue;
      wanted.add(lid);
      visible.push(lid);
    }
    for (const [lid, row] of this.rows) {
      // 絞り込みで外れただけの行は **DOM から外すが、ノードは取っておく**
      // (次の打鍵で戻ってくる ── 作り直しが M-4 の停止の正体だった)
      if (!wanted.has(lid)) row.remove();
      if (!alive.has(lid)) {
        this.rows.delete(lid);
        this.rowMeta.delete(lid);
      }
    }

    /**
     * 🔴 **0 件のときに、そう言って戻り道を出す**(2026-08-29 の動線レビュー)。
     *
     * ⚠ フォルダ・アプリ・連絡先の面には 0 件の字が出るのに、**既定の一覧タブだけ
     *   何も出なかった** ── 行が全部消えたように見え、しかも
     *   **自分が打っていない語**(タグの札を押した直後)が探す欄に入っているので、
     *   戻し方が画面から読み取れない。
     * 🔑 形は連絡先(#536 ②)と**同じ**にする ── 「絞りを外す」で、その場で戻れる。
     * ⚠ 本当にノートが 0 件のときは出さない(外す物が無い ── dead click を作らない)。
     */
    this.emptyNote?.remove();
    this.emptyNote = null;
    if (visible.length === 0 && alive.size > 0) {
      const box = document.createElement('div');
      box.setAttribute('data-pkc-field', 'entry-list-empty');
      const p = document.createElement('p');
      p.textContent =
        state.filterQuery === ''
          ? '絞り込みに一致するものがありません'
          : `「${state.filterQuery}」に一致するものがありません`;
      box.append(p);
      if (state.filterQuery !== '' || state.kindFilter.size > 0) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.setAttribute('data-pkc-action', 'clear-entry-filter');
        clear.setAttribute('data-pkc-field', 'entry-list-clear-filter');
        clear.textContent = '絞りを外す';
        clear.title = '絞り込みを空にして、ノートを全部出します。';
        box.append(clear);
      }
      this.list.after(box);
      this.emptyNote = box;
    }

    let cursor: ChildNode | null = this.list.firstChild;
    for (const lid of visible) {
      const meta = state.entryMetas.get(lid);
      if (!meta) continue;
      let row = this.rows.get(lid);
      if (!row) {
        row = this.createRow(meta);
        this.rows.set(lid, row);
        this.rowMeta.set(lid, meta);
      } else if (this.rowMeta.get(lid) !== meta) {
        this.patchRow(row, meta);
        this.rowMeta.set(lid, meta);
      }
      // 既に正位置ならノードを動かさない(move も DOM 操作なので避ける)。
      // ⚠ 既知の限界: 「先頭行を末尾へ move」型の並べ替えは O(n) move になる
      // (LIS なし cursor 方式の本質)。reorder UI が入る P3-6/7 で計測して判断
      if (cursor === row) {
        cursor = row.nextSibling;
      } else {
        this.list.insertBefore(row, cursor);
      }
    }
  }

  private createRow(meta: EntryMeta): HTMLLIElement {
    const row = document.createElement('li');
    row.setAttribute('data-pkc-entry', meta.lid);
    row.setAttribute('data-pkc-action', 'select-entry');
    // 🔑 種別は**チップ**で出す(P8)。⚠ 以前は CSS の `::before` で
    // 「文 」「了 」のような単漢字を行の頭に生やしていたが、日本語として
    // 存在しない書き方であるうえ、`::before` が `<tr>` に当たると**匿名セルが
    // でき、ファイラの表が 1 列ずれて全ヘッダが嘘になっていた**(実測)。
    const chip = iconSpan(chipIcon(meta.archetype));
    chip.setAttribute('data-pkc-chip', meta.archetype);
    chip.title = archetypeLabel(meta.archetype);
    const title = document.createElement('span');
    title.setAttribute('data-pkc-field', 'title');
    title.textContent = meta.title;
    /**
     * 🔑 **行は走査できること**(P9 段②。業務画面の作法)。
     *
     * 題名だけの行は目で追えない ── 15 件でも「どれが最近か」が分からず、
     * 500 件では一覧が機能しない。⚠ **行の高さは増やさない**(密度を落とさない)
     * ので、題名の右端に細字で置く。
     * ⚠ 出すのは**更新**(探すときに見るのはこちら)。無ければ作成で代替する。
     */
    const when = document.createElement('span');
    when.setAttribute('data-pkc-field', 'when');
    this.paintWhen(when, meta);
    row.append(chip, title, when);
    row.setAttribute('data-pkc-archetype', meta.archetype);
    return row;
  }

  /** 更新(無ければ作成)を細字で。⚠ 生の値は `title` 属性に置く。 */
  private paintWhen(el: HTMLElement, meta: EntryMeta): void {
    const raw = meta.updatedAt ?? meta.createdAt;
    el.textContent = formatListDate(raw, new Date().getFullYear());
    // 年まで見たいときは hover で分かるようにする(行の幅は食わない)
    const full = formatStoredDate(raw, '');
    if (full) el.title = meta.updatedAt ? `更新 ${full}` : `作成 ${full}`;
    else el.removeAttribute('title');
  }

  private patchRow(row: HTMLLIElement, meta: EntryMeta): void {
    const title = row.querySelector('[data-pkc-field="title"]');
    if (title && title.textContent !== meta.title) title.textContent = meta.title;
    // ⚠ **更新側にも書く** ── ここを忘れると、保存で時刻が動いても行は古いまま
    //    (作成側だけ直して「出た」と誤認する型の事故)
    const when = row.querySelector<HTMLElement>('[data-pkc-field="when"]');
    if (when) this.paintWhen(when, meta);
    if (row.getAttribute('data-pkc-archetype') !== meta.archetype) {
      row.setAttribute('data-pkc-archetype', meta.archetype);
      const chip = row.querySelector('[data-pkc-chip]');
      if (chip) {
        chip.setAttribute('data-pkc-chip', meta.archetype);
        // 🔴 **`textContent` で書かない** ── 中身が要素になったので、代入すると
        //    SVG ごと消えてチップが空になる(`setIcon` は replaceChildren で入れ替える)
        setIcon(chip, chipIcon(meta.archetype));
        (chip as HTMLElement).title = archetypeLabel(meta.archetype);
      }
    }
  }

  private patchSelection(selected: string | null): void {
    if (this.lastSelected && this.lastSelected !== selected) {
      this.rows.get(this.lastSelected)?.removeAttribute('data-pkc-selected');
    }
    if (selected) this.rows.get(selected)?.setAttribute('data-pkc-selected', '');
  }
}

/**
 * 種別の**名前**(user に見せる語)。
 *
 * 🔑 **実体は `features/flavor/archetype-label.ts` へ移した**(#421 段②)──
 *   スマートフォルダの条件(「種類が〇〇」)が同じ一覧を要るが、条件は
 *   pure module が読むので adapter を import できない(層の規約)。
 * ⚠ ここは**再輸出だけ**(呼び側の import は変えない ── 一覧を 2 つ作らない §7)。
 */
export { archetypeLabel };

/**
 * チップに入れる図案(user 指示 2026-08-03「アイコンや絵文字を使ってください」)。
 * ⚠ **チップの中でだけ**使う ── 地の文の前に裸で置くと
 * 「文 会議メモ」のような日本語に無い書き方になる(P8 で全廃した形)。
 * ⚠ 未知の種別は `dot`(空にしない ── 空だと行の頭が揃わない)。
 */
function chipIcon(archetype: string): IconName {
  return ARCHETYPE_ICONS[archetype] ?? 'dot';
}
