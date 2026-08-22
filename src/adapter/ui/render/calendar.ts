/**
 * calendar の描画(P3-6)。月グリッド + 日付セル内の todo リスト。
 * 指紋: (entryMetas, calendarMonth, showArchived, selectedLid)。月の再構築は
 * O(表示分)(セル数 + 当月 todo 数)なので、変化時はグリッドごと作り直す
 * (kanban / sidebar のような常時 patch 対象ではない)。body は読まない。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import {
  groupEntriesByDate,
  getMonthGrid,
  dateKey,
} from '@features/calendar/calendar-data';
import { matchesEntry, normalizeQuery } from '@features/filter/title-filter';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;

export class CalendarRenderer {
  private readonly region: HTMLElement;
  private readonly now: () => Date;
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastMonth: AppState['calendarMonth'] = null;
  private lastShowArchived: boolean | null = null;
  private lastSelected: string | null = null;
  /** ⚠ 絞り込みも指紋の一部(review M-3)。 */
  private lastFilter: string | null = null;

  /** now は test 注入用(既定は実時刻)。 */
  constructor(region: HTMLElement, now: () => Date = () => new Date()) {
    this.region = region;
    this.now = now;
  }

  render(state: AppState): void {
    if (
      state.entryMetas === this.lastMetas &&
      state.calendarMonth === this.lastMonth &&
      state.showArchived === this.lastShowArchived &&
      state.filterQuery === this.lastFilter &&
      state.selectedLid === this.lastSelected
    )
      return;
    this.lastMetas = state.entryMetas;
    this.lastMonth = state.calendarMonth;
    this.lastShowArchived = state.showArchived;
    this.lastFilter = state.filterQuery;
    this.lastSelected = state.selectedLid;

    const today = this.now();
    const year = state.calendarMonth?.year ?? today.getFullYear();
    const month = state.calendarMonth?.month ?? today.getMonth() + 1;
    /**
     * ⚠ **今日の鍵はセルと同じ関数で作る**(`dateKey`)── 別の組み立て方をすると
     *   桁の詰め方が食い違い、月末や 1 桁の月で**印が付かない日**ができる。
     */
    const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());

    // kanban と同じく state.order 順で組む(Map 挿入順に依存しない ── review #8)。
    // ⚠ 絞り込みは**全部の面**に同じ規則で効かせる(review M-3)
    const q = normalizeQuery(state.filterQuery);
    const metas: EntryMeta[] = [];
    for (const lid of state.order) {
      const m = state.entryMetas.get(lid);
      if (m && matchesEntry(m.lid, m.title, q, state.searchHits)) metas.push(m);
    }
    const byDate = groupEntriesByDate(metas, state.showArchived);

    /**
     * 🔴 **器のスクロール位置を返す**(#303、着地前レビュー B-1)。
     *
     * この面は指紋が変わると**格子ごと作り直す**(`textContent = ''`)。⚠ 指紋には
     * `selectedLid` が入っているので、**予定を 1 つ押しただけで**全部作り直される。
     * 予定を器(`day-events`)に入れて中でスクロールさせるようにした以上、
     * ここで控えておかないと **押した瞬間に器が先頭へ戻り、押した予定が視界から
     * 消える**(押した手応えが画面から失われる)。
     *
     * 🔑 これは「置き換えの作法」の③**後始末**である(CLAUDE.md §10)── 直す前は
     *   器そのものが無かったので、**この直しで新しく落ちた性質**にあたる。
     * ⚠ 鍵は**日付**にする(node ではなく)── node は作り直されて別物になる。
     */
    const scrolls = new Map<string, number>();
    for (const box of this.region.querySelectorAll<HTMLElement>('[data-pkc-field="day-events"]')) {
      const key = box.closest('[data-pkc-date]')?.getAttribute('data-pkc-date');
      if (key !== null && key !== undefined && box.scrollTop > 0) scrolls.set(key, box.scrollTop);
    }

    this.region.textContent = '';

    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'calendar-toolbar');
    // 遷移先は描画時に焼き込む ── binder に「今表示している月」の別ソース
    // (実時刻)を持たせない(reducer が 0 / 13 を正規化する)
    const navButton = (label: string, toMonth: number): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'calendar-nav');
      b.setAttribute('data-pkc-nav-year', String(year));
      b.setAttribute('data-pkc-nav-month', String(toMonth));
      b.textContent = label;
      return b;
    };
    const prev = navButton('‹', month - 1);
    const label = document.createElement('span');
    label.setAttribute('data-pkc-field', 'calendar-month');
    label.setAttribute('data-pkc-month', `${year}-${String(month).padStart(2, '0')}`);
    label.textContent = `${year}年${month}月`;
    const next = navButton('›', month + 1);
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.setAttribute('data-pkc-action', 'calendar-today');
    todayBtn.textContent = '今月';
    const archivedLabel = document.createElement('label');
    const archived = document.createElement('input');
    archived.type = 'checkbox';
    archived.checked = state.showArchived;
    archived.setAttribute('data-pkc-action', 'toggle-show-archived');
    archivedLabel.append(archived, document.createTextNode(' 片付けたものも表示'));
    /**
     * 🔴 **「どのノートに日付が付くか」を画面に出す**(2026-08-20)。
     *
     * ⚠ この面は「ノートを先に選んでから日を押す」設計なのに、**何が選ばれて
     *   いるかがどこにも出ていなかった** ── 押して初めて
     *   「日付を付けるノートを先に選んでください」と断られる(押す前に分からない)。
     * 🔑 形はフォルダ面の帯(`render/filer.ts` の `renderMoveBar`)と同じ ──
     *   選んでいれば題名、選んでいなければ**何をすればよいか**を書く。
     * ⚠ **新しい正本を作らない** ── ここは `state.selectedLid` を映すだけである
     *   (選び直す `<select>` を置くと「いま選ばれているのは何か」に答える口が
     *   2 つになる。CLAUDE.md §7)。
     */
    const target = document.createElement('span');
    target.setAttribute('data-pkc-field', 'calendar-target');
    const selected = state.selectedLid === null ? null : state.entryMetas.get(state.selectedLid);
    target.textContent =
      selected === undefined || selected === null
        ? '日を押す前に、左の一覧からノートを選んでください'
        : `「${selected.title}」に日付を付けます`;
    if (selected) target.setAttribute('data-pkc-entry', selected.lid);
    bar.append(prev, label, next, todayBtn, archivedLabel, target);
    this.region.append(bar);

    const table = document.createElement('table');
    table.setAttribute('data-pkc-region', 'calendar-grid');
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    WEEKDAYS.forEach((wd, i) => {
      const th = document.createElement('th');
      /**
       * ⚠ **見出しにも土日の印を付ける**(2026-08-20、着地前の unit が捕まえた)。
       *   本体だけに付けて CSS を `th` にも書いていたので、**誰も出さない規則**が
       *   1 本出荷されるところだった(縞が 1 段ずれて見える)。
       */
      if (i === 0 || i === 6) th.setAttribute('data-pkc-weekend', '');
      th.textContent = wd;
      hrow.append(th);
    });
    thead.append(hrow);
    const tbody = document.createElement('tbody');
    for (const week of getMonthGrid(year, month)) {
      const tr = document.createElement('tr');
      week.forEach((day, wd) => {
        const td = document.createElement('td');
        /**
         * ⚠ **土日は列そのものに印を付ける**(セルが空でも分かるように)。
         * 🔑 曜日は格子の位置で決まる ── 表の列番号がそのまま曜日である。
         */
        if (wd === 0 || wd === 6) td.setAttribute('data-pkc-weekend', '');
        if (day === null) {
          /**
           * ⚠ **月外のセルは「押せない」と分かる形にする** ── 直す前は素の空 td で、
           *   見た目が月内と同じなのに押しても何も起きなかった(無言の dead click)。
           */
          td.setAttribute('data-pkc-outside', '');
        } else {
          const key = dateKey(year, month, day);
          td.setAttribute('data-pkc-date', key);
          /**
           * 🔴 **今日に印を付ける**(2026-08-20)── カレンダーで最初に探すものが
           * 画面に無かった。⚠ 判定は**表示している月**の日と今日を突き合わせる
           * (別の月を見ているときに印が出てはいけない)。
           */
          if (key === todayKey) td.setAttribute('data-pkc-today', '');
          /**
           * 🔴 **読むだけにしない**(#276 の 4)── 選んでいるノートがあるとき、
           * その日を押すと frontmatter に `date` が入る。
           * ⚠ 何も選んでいないときは**理由を出す**(無言の dead click を作らない)。
           */
          td.setAttribute('data-pkc-action', 'calendar-set-date');
          const num = document.createElement('div');
          num.setAttribute('data-pkc-field', 'day-number');
          num.textContent = String(day);
          td.append(num);
          const items = byDate[key] ?? [];
          /**
           * 🔴 **その日に何件あるかを、畳まれない所に出す**(#303)。
           *
           * ⚠ **理由づけを直した**(着地前レビュー B-6)── 1 稿目は
           *   「入り切らない分の手がかり」とだけ書いていたが、閾値は
           *   「2 件以上」であって「溢れているとき」ではない。1440×900 では
           *   3 件まで器に収まるので、**全部見えている日にも数字が出る**
           *   ── 理由と実装が食い違っていた。
           * 🔑 出しているのは「**その日に何件あるか**」である(業務画面の密度)。
           *   溢れている日では、それがそのまま「畳まれた分が在る」手がかりになる。
           * ⚠ 1 件のときは出さない ── 見えている 1 つに「1」と添えるのは飾りである。
           * ⚠ **溢れているかで出し分けない** ── 描画のたびに実寸を読むことになり、
           *   「放っておいても変わる観測点」を製品コードに持ち込む(CLAUDE.md §4)。
           */
          if (items.length >= 2) {
            const count = document.createElement('div');
            count.setAttribute('data-pkc-field', 'day-count');
            count.textContent = String(items.length);
            td.append(count);
          }
          /**
           * 🔴 **予定は器に入れる**(#303)。器は絶対配置なので、
           * **何件入れてもセルの内在高が変わらない**。
           * ⚠ 直す前は `td` の直下に積んでいたため、予定 1 件で下の週が
           *   最大 **53.2px** 押し下がった(1440×900 実測)── 同じ座標の
           *   2 打目が「同じ曜日の別の週」に当たっていた。
           * ⚠ 器は**予定が 0 件でも作る** ── 1 件目で DOM の形が変わると、
           *   そこでまた行が動く(ゼロ件の次元を作らない)。
           */
          const events = document.createElement('div');
          events.setAttribute('data-pkc-field', 'day-events');
          td.append(events);
          // ⚠ 位置を戻すのは**中身を入れた後**(空の器に代入しても 0 に丸められる)
          const keep = scrolls.get(key);
          for (const meta of items) {
            const item = document.createElement('div');
            item.setAttribute('data-pkc-entry', meta.lid);
            item.setAttribute('data-pkc-action', 'select-entry');
            // ⚠ 状態は**書いてあるときだけ**出す(#276)── 既定値を作らない
            //   (`status` を書いていないノートまで「未完了」に見える)
            if (meta.status !== null) item.setAttribute('data-pkc-status', meta.status);
            if (meta.archived) item.setAttribute('data-pkc-archived', '');
            if (meta.lid === state.selectedLid)
              item.setAttribute('data-pkc-selected', '');
            item.textContent = meta.title;
            events.append(item);
          }
          if (keep !== undefined) events.scrollTop = keep;
        }
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    this.region.append(table);
  }
}
