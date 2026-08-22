/**
 * filer view の最小核(P3-7b): breadcrumb + explorer table の read-only ビュー。
 *
 * - scope = 選択が folder ならそれ / 最近傍祖先 folder / root(PKC2 と同じ)
 * - 一覧は scope 直下(root scope なら正準親なし)を entryOrder 順で
 * - folder click = その folder を選択(= scope が移る)、非 folder click = 選択
 *   (SELECT_ENTRY 1 本 ── scope と selection を別 state にしない。PKC2 で
 *   両者を混ぜた結果 lastFilerScopeLid という補助状態が要った教訓は、
 *   「scope は selection の純関数」に振り切ることで回避する)
 * - relation 作成 UI / subset profile(表示レンズ)/ DnD は持ち込まない
 *
 * 差分規律: scope・一覧内容が変わったときだけ table を作り直す。選択だけの
 * 変化(scope 不変)は data-pkc-selected の属性 patch のみ(P3-7b review #2 ──
 * 15k 平置き root で選択 1 クリック = 60,009 createElement の反例を封鎖)。
 * ⚠ 既知の限界: 一覧変化時の rebuild は O(scope 直下)で、平置き container の
 * root scope では「scope 直下 = 全 entry」になる。keyed 行再利用(sidebar 方式)
 * は P6 import で平置き大 container が現実になった時に計測してから入れる。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import {
  getAncestorFolders,
  resolveCanonicalParents,
  listMoveTargets,
  listSiblings,
} from '@features/relation/tree';
import { filerRows } from '@features/relation/filer-list';
import { normalizeQuery } from '@features/filter/title-filter';
// 🔑 種別の呼び名は **1 本**(P8 段⑲)── かつてここだけ独自表を持ち、
//    同じノートがフォルダ画面では「シート」、他の全画面では「表」と出ていた
import { archetypeLabel } from './sidebar';
// ⚠ 日付の切り方は `features/datetime/stored-date` が正本(情報列・一覧の行と共有)。
//    ここに 3 つ目の parse を置いていたので寄せた(規則は 1 つ ── CLAUDE.md)
import { formatListDate, formatStoredDate } from '@features/datetime/stored-date';
import { ARCHETYPE_ICONS, iconButton, iconSpan } from './icons';



export class FilerRenderer {
  private readonly region: HTMLElement;
  private readonly rows = new Map<string, HTMLTableRowElement>();
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  /**
   * 画面に出る材料の指紋(参照ではなく内容)。⚠ **この面が実際に描くものだけ**を
   * 入れる ── 描かないものを入れると、また「変わっていないのに作り直す」に戻る。
   * ⚠ 逆に**描くものを入れ忘れると古い値が残る** ── 行が出しているのは
   *   `lid` / `title` / `archetype` / 更新日(`MM/DD` に丸めた形)である。
   */
  private lastSignature: string | null = null;
  /** 日付だけの指紋。⚠ 本体の指紋と**別に**持つ(混ぜると建て直しに戻る ── #270)。 */
  private lastDates: string | null = null;
  private lastRelations: readonly Relation[] | null = null;
  private lastSelected: string | null = null;
  private lastScopeLid: string | null = null;
  /** 印(複数選択)の指紋。⚠ 参照ではなく**中身**で見る(配列は毎回作り直される)。 */
  private lastMarks = '';
  /** ⚠ 絞り込みも指紋の一部(review M-3 ── 絞り込み中にファイラだけ全件出ていた)。 */
  private lastFilter: string | null = null;
  /** ⚠ 並び順と本文検索の当たりも指紋(着地前レビュー 3 ── 入れないと死んだ操作子になる)。 */
  private lastSort: AppState['entrySort'] | null = null;
  /** ⚠ 向きも指紋(2 ペイン側で実際に踏んだ ── 同型なのでこちらも入れる)。 */
  private lastSortDesc: boolean | null = null;
  private lastHits: AppState['searchHits'] = null;
  /** ゴミ箱 panel の断面(参照比較 ── P5b で指紋に加わった次元)。 */
  private lastTrash: AppState['trashPanel'] = null;
  /** 居場所を変える帯の器(中身は選択が変わるたびに差し替える)。 */
  private moveBar: HTMLElement | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  /**
   * 🔴 **フォルダ整理の導線**(2026-08-05、user 報告
   * 「フォルダ整理のための導線がない」)。直す前は、フォルダは**作れるのに
   * 中身を入れる手段が画面のどこにも無く**、永久に空だった。
   *
   * 形は **1 本の帯**にする(行ごとにボタンを生やさない):
   *   - 行ごとに置くと、平置き 15k 件の root で 15k 個の `<select>` を作ることになる
   *   - フォルダ自身を選ぶと scope がその中へ移る(= 行が一覧から消える)ので、
   *     行に付けた操作では**フォルダ自身を動かせない**
   * 「いま選んでいるものの居場所」を**いつも同じ場所**に出す
   * (user 指示 2026-08-03「同じものが常に同じ場所にある」)。
   */
  /**
   * 印(複数選択)だけを塗り直す(#240 段②)。
   * ⚠ 表を組み直さない**速い経路**でも呼ぶ ── 呼ばないと `Ctrl` クリックで
   * state だけ動いて画面が追いつかない。
   */
  private paintMarks(state: AppState): void {
    const marked = new Set(state.selection);
    for (const [lid, tr] of this.rows) {
      if (marked.has(lid)) tr.setAttribute('data-pkc-marked', '');
      else tr.removeAttribute('data-pkc-marked');
    }
    this.lastMarks = state.selection.join(' ');
  }

  private renderMoveBar(state: AppState, scope: EntryMeta | null): void {
    const host = this.moveBar;
    if (!host) return;
    host.textContent = '';

    /**
     * 🔴 **まとめて操作する帯**(#240 段③。user 指示 2026-08-17「まとめて消せない」)。
     *
     * ⚠ **2 件以上のときだけ**出す ── 1 件のときは下の「居場所」の帯と役割が重なる。
     * ⚠ 出すのは**ゴミ箱へ**だけ(完全削除は一括で撃たせない。戻せない操作を
     *   まとめて撃てるようにするのが、いちばん事故が大きい)。
     */
    /**
     * 🔴 **数えるのは「いま表に出ている印」だけ**(着地前レビュー 2)。
     * ⚠ 印は行が見えなくなっても残る(絞り込みで消えた / 別の場所へ移った)ので、
     *    素で数えると**画面に印が 1 つも無いのに「3 件を選んでいます」**が出て、
     *    押すと画面に無い 3 件がゴミ箱へ入る。
     * ⚠ 消す側(`binder` の `delete-selected`)と**同じ規則**である ── 数と対象が
     *    食い違うと、確認の文言が嘘になる。
     */
    const marks = state.selection.filter((lid) => this.rows.has(lid));
    if (marks.length > 1) {
      const bulk = document.createElement('div');
      bulk.setAttribute('data-pkc-field', 'filer-bulk');
      const count = document.createElement('span');
      count.setAttribute('data-pkc-field', 'filer-bulk-count');
      count.textContent = `${marks.length} 件を選んでいます`;
      const del = iconButton('delete-selected', 'まとめてゴミ箱へ');
      del.title = `選んでいる ${marks.length} 件をゴミ箱へ入れます(フォルダ画面から戻せます)`;
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.setAttribute('data-pkc-action', 'clear-selection');
      clear.textContent = '選択を解除';
      bulk.append(count, del, clear);
      host.append(bulk);
    }

    const moving = state.selectedLid ? (state.entryMetas.get(state.selectedLid) ?? null) : null;
    if (!moving) {
      const hint = document.createElement('p');
      hint.setAttribute('data-pkc-field', 'filer-move-empty');
      // ⚠ 「操作が無い」ではなく「**何をすれば出るか**」を書く
      hint.textContent = '動かしたいものを選ぶと、ここで居場所を変えられます';
      host.append(hint);
    } else {
      const label = document.createElement('label');
      const cap = document.createElement('span');
      cap.setAttribute('data-pkc-field', 'move-caption');
      cap.textContent = `「${moving.title}」の居場所`;
      const sel = document.createElement('select');
      sel.setAttribute('data-pkc-field', 'move-target');
      // 🔑 選んだ瞬間に効く(binder の change 経路)── 「選ぶ」と「押す」に
      //    割らない。割ると選んだだけで満足して押し忘れる
      sel.setAttribute('data-pkc-action', 'move-entry');
      // ⚠ **動かす当人の lid は帯自身が持つ** ── `selectedLid` を binder 側で
      //    読み直すと、押した瞬間に選択が変わっていた場合に別のものが動く
      sel.setAttribute('data-pkc-entry', moving.lid);
      sel.title = 'このノートを入れるフォルダを選びます';
      const root = document.createElement('option');
      root.value = '';
      root.textContent = 'ルート(いちばん上)';
      sel.append(root);
      for (const f of listMoveTargets(moving.lid, state.entryMetas, state.relations)) {
        const opt = document.createElement('option');
        opt.value = f.lid;
        // ⚠ 字下げは**見た目だけ**。同名フォルダの取り違えは hover の道が防ぐ
        opt.textContent = `${'　'.repeat(f.depth)}${f.title}`;
        opt.title = f.path;
        sel.append(opt);
      }
      // ⚠ いまの親を選んでおく(「どこに居るか」が読める)。候補に無い親
      //    (取り込んだデータに輪がある等)なら空 = ルート表示に落ちる
      sel.value = resolveCanonicalParents(state.entryMetas, state.relations).get(moving.lid) ?? '';
      label.append(cap, sel);
      host.append(label);

      /**
       * 🔴 **並べ替え**(2026-08-06。user 報告 2-10「並べ替えの手段が無い」)。
       *
       * ⚠ **居場所の帯と同じ場所**に置く(行ごとに生やさない ── 平置き 15k 件で
       *   30k 個のボタンになるし、フォルダ自身は選ぶと一覧から消えるので
       *   行のボタンでは動かせない。帯に置いた理由と同じ)。
       * ⚠ 端では**押せなくする**(押して黙って断られるのは「無言の操作拒否」)。
       */
      const siblings = listSiblings(moving.lid, state.entryMetas, state.relations);
      const at = siblings.findIndex((m) => m.lid === moving.lid);
      const nudge = document.createElement('div');
      nudge.setAttribute('data-pkc-field', 'order-nudge');
      for (const [dir, text] of [
        ['up', '上へ'],
        ['down', '下へ'],
      ] as const) {
        // 図案は `ACTION_ICONS['move-order-…']` が持つ(表は 1 つ)
        const b = iconButton(`move-order-${dir}`, text);
        b.setAttribute('data-pkc-entry', moving.lid);
        b.disabled = at < 0 || (dir === 'up' ? at === 0 : at === siblings.length - 1);
        // ⚠ なぜ押せないかを言う(端に居ることは見た目から分からない)
        if (b.disabled) b.title = dir === 'up' ? 'すでに先頭です' : 'すでに末尾です';
        nudge.append(b);
      }
      host.append(nudge);
    }

    if (scope) {
      // 🔑 **作る先を先に見せる**(押してから探させない)── 新規作成は
      //    「いま見ているフォルダ」に入る(binder `create-entry`)
      const where = document.createElement('p');
      where.setAttribute('data-pkc-field', 'filer-create-target');
      where.textContent = `新しく作るものは「${scope.title}」に入ります`;
      host.append(where);
    }
  }

  /**
   * 行の**並びと中身**の指紋。⚠ 日付は**入れない**(下の `dateSignature` が持つ)。
   *
   * 🔴 **日付を混ぜると、日付が入っただけで表を丸ごと建て直す**(#270 の真因)。
   * `CREATE_ENTRY` は `updatedAt: null` を置き、実時刻を刻むのは worker なので、
   * ノートを作った直後に **`ENTRY_STAMPED` という非同期の ack** が届いて
   * `''` → `MM/DD` と変わる ── それだけで `region.textContent = ''` が走っていた。
   *
   * ⚠ 実ブラウザで測った実害(`organize` spec 全体 × 30 回。trail を採取):
   *   - **2 回** 押下ごと奪われ、`dragstart` しか出ない(`dragover` も `drop` も来ない)
   *   - **約 3 回** 落とせてはいるが、**狙った行が動いていて**別の所へ入る
   *   どちらも「掴もうとしている手の下で表が作り直される」ことから来る。
   * 🔑 だから**日付だけの変化では建て直さない** ── セルの字を差し替える(`patchDates`)。
   */
  private metaSignature(state: AppState): string {
    // ⚠ 区切りは **NUL のエスケープ**(`\u0000`)── 題名には現れない文字なので
    //    「題名の途中が次の項目に見える」取り違えが起きない。
    //    🔴 生バイトで埋めない(`tests/repo-hygiene.test.ts` が機械的に止める)
    const SEP = '\u0000';
    const parts: string[] = [];
    for (const m of state.entryMetas.values()) {
      // ⚠ **並び順も材料**(2026-08-22)── 直す前は指紋に無く、「並べ替えると
      //    日付も変わる」ことに**間接的に頼って**建て直していた。日付を外した
      //    瞬間に上へ/下へが 1 バイトも描き直さなくなる(回帰 test が捕まえた)
      parts.push([m.lid, m.title, m.archetype, String(m.entryOrder)].join(SEP));
    }
    return parts.join(SEP);
  }

  /**
   * 日付だけの指紋。⚠ **丸めた後**を使う ── 生の `updatedAt` だと、同じ日の保存
   * (秒だけ違う)でも変わってしまい、**字が 1 文字も変わらないのに塗り直す**。
   */
  private dateSignature(state: AppState): string {
    const year = new Date().getFullYear();
    const parts: string[] = [];
    for (const m of state.entryMetas.values()) {
      parts.push(m.lid, formatListDate(m.updatedAt, year));
    }
    return parts.join(String.fromCharCode(0));
  }

  /**
   * 日付のセルだけを差し替える(**行の node は作り直さない**)。
   * ⚠ 並べ替えが「更新」順のときは日付が**並びを変えうる**ので、呼び手が
   *   その場合を除いている(`render` の門)。
   */
  private patchDates(state: AppState): void {
    const year = new Date().getFullYear();
    for (const [lid, tr] of this.rows) {
      const m = state.entryMetas.get(lid);
      const cell = tr.querySelector<HTMLElement>('[data-pkc-field="updated"]');
      if (!m || !cell) continue;
      cell.textContent = formatListDate(m.updatedAt, year);
      const full = formatStoredDate(m.updatedAt, '');
      if (full) cell.title = `更新 ${full}`;
      else cell.removeAttribute('title');
    }
    this.lastDates = this.dateSignature(state);
  }

  render(state: AppState): void {
    /**
     * 🔴 **参照が変わっただけで作り直さない**(2026-08-06)。
     *
     * `entryMetas` は保存 ack の `ENTRY_STAMPED` が**必ず新しい Map** で差し替える。
     * 参照比較だけを指紋にすると、**画面に出る文字が 1 字も変わらないのに**この面を
     * 丸ごと `textContent = ''` して組み直す ── そのとき「ゴミ箱」「移動」「上へ / 下へ」の
     * `<button>` が別の node になり、押そうとしていた target が消える。
     * binder は `root.contains(el)` を通らない target を黙って捨てるので、
     * **無言の dead click** になる(情報ペインで実際に踏んだ形。同 file の
     * `inspector.ts` の冒頭に経緯)。
     * ⚠ この面が出す更新日は `MM/DD`(同日の保存では**同じ文字列**)なので、
     *   「参照が変わった」の大半は**見た目の変化ゼロ**である。
     * 🔑 だから指紋は**画面に出る材料そのもの**にする ── 参照ではなく内容。
     */
    /**
     * 🔴 **並び順と本文検索の当たりも指紋に入れる**(着地前レビュー 3)。
     * ⚠ `filerRows` へ渡しているのに指紋に入れていなかったので、`SET_ENTRY_SORT`
     *    では**1 バイトも描き直さなかった** ── 並べ替えの `<select>` は
     *    `findBar` に在って**フォルダタブでも見えている**ので、段⑤ で既定に
     *    なったこの面に、押しても何も起きない操作子が出ていた。
     * ⚠ 同じ罠は sidebar で既に踏んで直してある(`sidebar.ts` の `lastSort` /
     *    `lastHits`)── **回帰 test がそちらしか import していなかった**ので、
     *    こちらは誰にも守られていなかった(CLAUDE.md「test の import 一覧」)。
     */
    /**
     * 🔴 **日付だけの変化**(#270)。⚠ 「更新」で並べているときは**並びを変えうる**
     * ので、`listChanged` に数えて建て直す ── 字だけ差し替えると**並びが嘘になる**。
     * ⚠ ここで数えないと、この先の「選択だけの変化」の速い経路が**飲み込む**
     *   (日付を指紋から外した瞬間に露見した ── 回帰 test が捕まえた)。
     */
    const datesChanged = this.dateSignature(state) !== this.lastDates;
    const sortedByDate = state.entrySort === 'updated';
    const listChanged =
      (datesChanged && sortedByDate) ||
      state.relations !== this.lastRelations ||
      state.filterQuery !== this.lastFilter ||
      state.entrySort !== this.lastSort ||
      state.entrySortDesc !== this.lastSortDesc ||
      state.searchHits !== this.lastHits ||
      (state.entryMetas !== this.lastMetas && this.metaSignature(state) !== this.lastSignature);
    const selectionChanged = state.selectedLid !== this.lastSelected;
    // ⚠ 現在地は選択と**別に**変わる(#240 段①)── 指紋に入れないと、
    //    フォルダへ入っても表が組み直されない
    const scopeChanged = state.scopeLid !== this.lastScopeLid;
    // ⚠ 印(複数選択)も指紋に入れる(#240 段②)── 入れないと Ctrl クリックしても
    //    行の印が付かない(state だけ動いて画面が嘘をつく)
    const marksChanged = state.selection.join(' ') !== this.lastMarks;
    const trashChanged = state.trashPanel !== this.lastTrash;

    /**
     * 🔴 **日付だけが変わったら、セルの字を差し替えて帰る**(#270)。
     *
     * ⚠ 建て直すと、**掴もうとしている手の下で行が消える / 動く**。実ブラウザで
     *   30 回測って、押下ごと奪われる回と、狙った行が動いて別の所へ落ちる回の
     *   両方を記録した(`metaSignature` の注記)。
     * ⚠ **「更新」で並べているときは除く** ── そのときは日付が**並びを変えうる**ので、
     *   字だけ差し替えると**並びが嘘になる**(建て直すほうが正しい)。
     */
    if (
      datesChanged &&
      !sortedByDate &&
      !listChanged &&
      !selectionChanged &&
      !trashChanged &&
      !scopeChanged &&
      !marksChanged &&
      this.rows.size > 0
    ) {
      this.patchDates(state);
      // ⚠ 参照の控えも進める ── 進めないと次の描画で「一覧が変わった」と読まれる
      this.lastMetas = state.entryMetas;
      return;
    }

    if (
      !listChanged &&
      !selectionChanged &&
      !trashChanged &&
      !scopeChanged &&
      !marksChanged &&
      !datesChanged
    )
      return;

    /**
     * 🔴 **現在地は state が持つ**(#240 段①)。直す前はここが
     * `resolveFilerScope(state.selectedLid, …)` ── **選ぶと入ってしまう**ので、
     * user 指示「ダブルクリックで開く」も、この先の複数選択も成り立たなかった。
     * ⚠ 消えた lid は `removeEntry` が畳むので、ここでは引けなければルート扱い。
     */
    const scopeLid = state.scopeLid;
    const scope = scopeLid === null ? null : (state.entryMetas.get(scopeLid) ?? null);

    if (!listChanged && !trashChanged && scopeLid === this.lastScopeLid) {
      // 選択だけの変化(scope 不変)── 属性 patch のみで済ませる
      if (this.lastSelected) {
        this.rows.get(this.lastSelected)?.removeAttribute('data-pkc-selected');
      }
      if (state.selectedLid) {
        this.rows.get(state.selectedLid)?.setAttribute('data-pkc-selected', '');
      }
      this.lastSelected = state.selectedLid;
      this.paintMarks(state);
      // 🔴 **居場所の帯は選択に追従する**(2026-08-05)。ここを忘れると、
      //    行を選び直しても帯は**前に選んでいたものを指したまま**になり、
      //    「移動」を押すと**別のノートが動く**(見えない取り違え)
      this.renderMoveBar(state, scope);
      return;
    }

    this.lastMetas = state.entryMetas;
    this.lastSignature = this.metaSignature(state);
    this.lastRelations = state.relations;
    this.lastSelected = state.selectedLid;
    this.lastScopeLid = scopeLid;
    this.lastTrash = state.trashPanel;
    this.lastFilter = state.filterQuery;
    this.lastSort = state.entrySort;
    this.lastSortDesc = state.entrySortDesc;
    this.lastHits = state.searchHits;
    this.lastMarks = state.selection.join(' ');
    this.lastDates = this.dateSignature(state);

    /**
     * 🔴 **行を決めるのは `filerRows` 1 か所**(#240 段②)。
     *
     * ⚠ ここで組み直すと、**範囲選択(reducer)と表示(ここ)が別の並びを持つ** ──
     * 目で見た範囲と選ばれる範囲が食い違う、いちばん気づけない形になる
     * (CLAUDE.md §7)。⚠ 絞り込みは全部の面に同じ規則で効かせる(review M-3)。
     * 🔑 **並び順(#183)もここで効く**ようになった ── 直す前、フォルダ面は
     * 並べ替えを 1 度も見ておらず、一覧タブで題名順にしても中は作成順のままだった。
     */
    const q = normalizeQuery(state.filterQuery);
    const list = filerRows(scopeLid, state.entryMetas, state.relations, {
      filterQuery: state.filterQuery,
      searchHits: state.searchHits,
      sort: state.entrySort,
      sortDesc: state.entrySortDesc,
    });

    /**
     * 🔴 **焦点を落とさずに組み直す**(2026-08-18。実ブラウザで実測)。
     *
     * この面は `textContent = ''` で**丸ごと**作り直すので、中に焦点があると
     * `document.activeElement` は **`body` へ落ちる**。⚠ すると
     * `binder` の「フォルダの表の中でだけ効く」門(`closest(...)`)に当たらなくなり、
     * **鍵が 1 手で全部死ぬ**(Enter で入ったあとの Backspace / Delete / Ctrl+A)。
     * ⚠ binder 側で「dispatch のあとに置き直す」形では足りない ── **その後に来る
     * 別の再描画**(本文の読み込み完了など)でまた落ちる。実際、中身のある
     * フォルダへ入る smoke がそれで落ちた(焦点は `body` に在った)。
     * 🔑 **壊す側が直す** ── 組み直す直前に「中に焦点があったか」を採り、
     *   組み直したあとに**同じ行**(無ければ先頭行、無ければ表)へ戻す。
     * ⚠ 外に焦点があるときは**触らない**(絞り込み欄に打っている最中に
     *   奪うと、打鍵が表へ飛ぶ)。
     */
    let focusedBefore: string | null = null;
    const activeNow = this.region.ownerDocument.activeElement;
    if (activeNow instanceof HTMLElement && this.region.contains(activeNow)) {
      focusedBefore = activeNow.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? '';
    }

    this.region.textContent = '';
    this.rows.clear();

    // breadcrumb: root / …祖先… / scope
    const crumb = document.createElement('nav');
    crumb.setAttribute('data-pkc-region', 'filer-breadcrumb');
    const rootSeg = document.createElement('button');
    rootSeg.type = 'button';
    // ⚠ ルートは**現在地だけ**を戻す(#240 段①)── 直す前は `DESELECT_ENTRY` で
    //    選択ごと捨てており、**ルートに戻ると中央のノートまで閉じて**いた
    rootSeg.setAttribute('data-pkc-action', 'enter-folder');
    // ⚠ パンくずは**出す**ための落とし先(#240 段④)── 上の階層へ戻す唯一の D&D 動線
    rootSeg.setAttribute('data-pkc-drop', 'crumb');
    rootSeg.textContent = 'ルート';
    crumb.append(rootSeg);
    if (scope) {
      const chain = [
        ...getAncestorFolders(scope.lid, state.entryMetas, state.relations).reverse(),
        scope,
      ];
      for (const seg of chain) {
        crumb.append(document.createTextNode(' / '));
        // crumb セグメントはそれ自身が entry(folder)を表す要素 ── data-pkc-entry
        // の適用対象(P3-7a 規約が禁じるのは delete / toggle 等の操作ボタン直付け)
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-entry', seg.lid);
        // パンくずの段は「そこへ入る」── 選ぶ操作ではない(#240 段①)
        btn.setAttribute('data-pkc-action', 'enter-folder');
        btn.setAttribute('data-pkc-drop', 'crumb');
        btn.textContent = seg.title;
        crumb.append(btn);
      }
    }
    this.region.append(crumb);
    /**
     * 🔴 **操作の帯は表の「下」に置く**(#240 段①〜③ の実装中に実測で判明)。
     *
     * ⚠ 帯を表の**上**に置くと、**1 回目のクリックで帯が伸びて表が下へずれる** ──
     * 2 回目のクリックは**別の行に落ちる**ので、「2 クリックで開く」も
     * 「素早く 2 回押す」操作も成立しない(実ブラウザで再現。9ms 差の 2 打で
     * `click detail=2` は届いているのに、当たっている要素が違っていた)。
     * 🔑 表を先に置けば、帯が伸び縮みしても**行は動かない**。
     */
    this.moveBar = document.createElement('div');
    this.moveBar.setAttribute('data-pkc-region', 'filer-move');

    const table = document.createElement('table');
    table.setAttribute('data-pkc-region', 'filer-table');
    /**
     * 🔴 **表そのものにも焦点を置けるようにする**(2026-08-18 の着地前レビュー 8)。
     * 空のフォルダには置く先の行が無いので、ここが `filer` 文脈の鍵の受け皿になる。
     * ⚠ **`-1`** ── Tab の巡回には入れない(15,000 件の平置きで巡回に入ると
     *   Tab を数千回押すことになる)。⚠ **binder では書かない** ── 直す前は
     *   `focusFirstRow()` の中で付けていたので、**その関数を 1 度通るまで
     *   表に焦点が入らなかった**(= マウスだけの user は鍵の面へ入れない)。
     */
    /**
     * 🔴 **`0`**(2026-08-18)── お知らせで「**マウスを使わずに行までたどり着けます**」と
     * 配ったのに、直す前は表も行も `-1` で **Tab の巡回に入らず**、焦点は
     * マウスで 1 回押さないと作れなかった(= 配った約束が嘘だった)。
     * ⚠ **行は `-1` のまま** ── 15,000 件の平置きを巡回に入れると Tab を数千回
     *   押すことになる。入口は**表 1 つ**で、そこから ↑↓ で送る。
     */
    table.tabIndex = 0;
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    // 🔴 **種別の列は持たない**(P9 段③)。以前は 3 列作って `display: none` で
    //    2 列を畳んでいた ── 見出しが約束した「種別 / 更新日」が**どちらも
    //    画面に出ていなかった**(実測: 幅 0px)。しかも種別が見えないので、
    //    このタブは「一覧」と同じ題名の並びに見えていた(かぶりの実体)。
    //    種別は**行の頭の図案**が示し(一覧と同じ規則)、列は更新日だけ残す
    for (const h of ['名前', '更新日']) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const m of list) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-entry', m.lid);
      tr.setAttribute('data-pkc-action', 'select-entry');
      tr.setAttribute('data-pkc-archetype', m.archetype);
      /**
       * 🔴 **掴んで動かす**(#240 段④。user 指示 2026-08-17「D&D を導入すること」)。
       * ⚠ 落とし先は**フォルダの行**と**パンくず**の 2 つだけ ── 行と行の隙間
       * (並べ替え)は別の主題なので、この段では作らない(doc §6-3 の裁定)。
       * ⚠ `draggable` は行そのものに置く(セルに置くと掴む場所が読めない)。
       */
      tr.setAttribute('draggable', 'true');
      /**
       * 🔴 **行に焦点を持たせる**(user 裁定 2026-08-18「OS のファイラに似せる」)。
       * ⚠ 焦点が無いと `Enter` / `Delete` を**どこで効かせるか**が決まらない ──
       *   面をまたいで効かせると、#240 の着地前レビューで踏んだ「見えない所で
       *   印が増える」を繰り返す。押した行が焦点を持つのが OS と同じ形である。
       * ⚠ `-1` にする(Tab の巡回には入れない)── 行が何百件も在るので、
       *   Tab で 1 行ずつ辿らせるのは動線として悪い。
       */
      tr.tabIndex = -1;
      if (m.archetype === 'folder') tr.setAttribute('data-pkc-drop', 'folder');
      if (m.lid === state.selectedLid) tr.setAttribute('data-pkc-selected', '');
      // ⚠ **開いている**(`selected`)と**印を付けた**(`marked`)は別の印である
      if (state.selection.includes(m.lid)) tr.setAttribute('data-pkc-marked', '');
      const name = document.createElement('td');
      name.setAttribute('data-pkc-field', 'title');
      // ⚠ 図案は**題名の文字列に混ぜない**(P9 段③)。以前は '📁 ' を題名の頭に
      //    連結していたので、題名の文字列そのものが figure を含んでいた
      //    (絞り込み・突合・読み上げが全部それを題名として扱う)
      // 🔑 **全部の種別に図案を出す**(一覧と同じ規則)── フォルダだけ出していた頃は
      //    他の種別が無印で、種別の列も畳まれていたので**何のノートか分からなかった**
      const chip = iconSpan(ARCHETYPE_ICONS[m.archetype] ?? 'dot');
      chip.setAttribute('data-pkc-chip', m.archetype);
      chip.title = archetypeLabel(m.archetype);
      name.append(chip, document.createTextNode(m.title));
      const updated = document.createElement('td');
      // ⚠ 目印を付ける ── 日付だけの変化はここを差し替えて済ませる(#270)
      updated.setAttribute('data-pkc-field', 'updated');
      // ⚠ 生の SQLite UTC 文字列(`2026-08-03 13:11:39`)を出さない。
      // 🔑 **一覧の行と同じ形**(今年は MM/DD)にする(P9 段③)── `YYYY/MM/DD` だと
      //    狭い列に収まらず `2026/08/` で切れていた(実測)。年まで見たいときは
      //    hover の `title` に出す(一覧の行と同じ作法)
      updated.textContent = formatListDate(m.updatedAt, new Date().getFullYear());
      const full = formatStoredDate(m.updatedAt, '');
      if (full) updated.title = `更新 ${full}`;
      tr.append(name, updated);
      tbody.append(tr);
      this.rows.set(m.lid, tr);
    }
    table.append(thead, tbody);
    this.region.append(table);
    // ⚠ 帯は**表の後**(上の注記)── 選んだ瞬間に行が動かないようにする
    this.region.append(this.moveBar);
    this.renderMoveBar(state, scope);

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'filer-empty');
      // ⚠ 「空」と「絞り込みで消えた」を混ぜない(ランチャーと同じ理由)
      empty.textContent =
        q !== ''
          ? '絞り込みに一致するものがありません'
          : scope
            ? 'このフォルダは空です'
            : 'まだ何もありません';
      this.region.append(empty);
    }

    // ── ゴミ箱(P5b)── filer の常設導線。一覧は明示ロード(SHOW_TRASH)
    const trashBar = document.createElement('div');
    trashBar.setAttribute('data-pkc-region', 'filer-trash');
    if (!state.trashPanel) {
      const open = document.createElement('button');
      open.type = 'button';
      open.setAttribute('data-pkc-action', 'show-trash');
      open.textContent = 'ゴミ箱';
      trashBar.append(open);
    } else {
      const head = document.createElement('div');
      const label = document.createElement('span');
      label.textContent =
        state.trashPanel.items.length === 0
          ? 'ゴミ箱は空です'
          : `ゴミ箱 ${state.trashPanel.items.length} 件`;
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('data-pkc-action', 'hide-trash');
      close.textContent = '閉じる';
      head.append(label, close);
      if (state.trashPanel.items.length > 0) {
        const purge = document.createElement('button');
        purge.type = 'button';
        purge.setAttribute('data-pkc-action', 'purge-trash');
        purge.textContent = '空にする';
        head.append(purge);
      }
      trashBar.append(head);
      const ul = document.createElement('ul');
      for (const t of state.trashPanel.items) {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-trash-entry', t.entryLid);
        const text = document.createElement('span');
        text.textContent = `${t.title ?? '(無題)'}(${
          archetypeLabel(t.archetype ?? '')
        } / ${t.createdAt ?? ''})`;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.setAttribute('data-pkc-action', 'restore-trash');
        restore.setAttribute('data-pkc-rev-id', t.revId);
        restore.setAttribute('data-pkc-trash-lid', t.entryLid);
        restore.textContent = '復元';
        li.append(text, restore);
        ul.append(li);
      }
      trashBar.append(ul);
    }
    this.region.append(trashBar);

    /**
     * 🔴 組み直しで落ちた焦点を戻す(上の `focusedBefore` の注記)。規則は 3 つ:
     *
     * ① **同じ行が在れば、そこへ戻す**(ただの再描画では焦点を動かさない)
     * ② **現在地が変わったなら、1 行目へ**(移った先の先頭 ── OS のファイラ)
     * ③ **それ以外で行が消えたなら、表そのものへ**(鍵は生きるが、
     *    **押していない行に枠を置かない**)
     *
     * ⚠ ①③ を分けずに「無ければ 1 行目」と書いて実機で踏んだ:
     * 印を消すだけの再描画で焦点が**別の行へ移り**、その状態の Enter が
     * 「フォルダを開く」ではなく「**そのノートを開く**」になっていた
     * (焦点の足跡で確認: `TR#folder` → `TR#別のノート` → `DIV@detail`)。
     * 🔑 焦点は**進む操作の対象**なので、勝手に移すと**別のものが開く**。
     */
    if (focusedBefore !== null) {
      const sameRow = focusedBefore === '' ? undefined : this.rows.get(focusedBefore);
      const firstRow = scopeChanged
        ? this.region.querySelector<HTMLElement>('[data-pkc-region="filer-table"] tbody tr')
        : null;
      const back =
        sameRow ??
        firstRow ??
        this.region.querySelector<HTMLElement>('[data-pkc-region="filer-table"]');
      back?.focus();
    }
  }
}
