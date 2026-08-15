/**
 * **集計の面**(#184 / 台帳 #180 の A-4)── frontmatter の 1 つの key で束ねて表にする。
 *
 * ## PKC2 の轍を踏まないための約束(実地調査 2026-08-15 より)
 *
 * PKC2 の Inventory は「Bases 風」を名乗って着地したが、次の形で失敗した ──
 * ここはその**逆**を明示的に選ぶ:
 *
 * | PKC2 | ここ |
 * |---|---|
 * | クエリ処理 169 行を 12,523 行の描画 file に**直書き**(features 層に 0 行)→ unit test 0 件 | 束ね方は `features/query/group-by.ts` の**純関数**。13 件の unit test が守る |
 * | **毎描画**で全子 entry の本文を parse(索引なし・メモ化なし) | **開いたときだけ** worker が舐める。描画は state を読むだけ |
 * | 列・行・グループに**上限が無い** DOM 生成 | 上限を置き、**捨てた数を画面に出す**(`QUERY_LIMITS`) |
 * | クエリ変更が**シェル全体の再構築**に落ちる | 面の中で閉じる(器を捨てず、指紋で早期 return) |
 * | 入口が 3 段深く、自動では 1 度も出ない | 面の切替に**1 つのボタン**として出る |
 * | 列名が英語のまま(自分たちの UX 評価で指摘 → 2 ヶ月放置) | 見出しは日本語 |
 *
 * ## 何を出すか
 *
 * - **束ね方**(key)を選ぶ `<select>` ── 目録は worker が数えたものだけ出す
 *   (「書いていない key」を選ばせない)
 * - 束ねた組を **件数の多い順**に。組を開くとノートが並ぶ
 * - ⚠ 行を押すと**選択が動くだけ**(面はここに留まる)── かんばん / カレンダーと
 *   同じ規約。本文は右の情報ペインと、面の切替 1 回で見られる
 */
import type { AppState } from '@adapter/state/app-state';
import { QUERY_LIMITS, UNSET } from '@features/query/group-by';

/** 未設定の組の表示名。⚠ features は字を持たない(層規約)ので adapter が決める。 */
const UNSET_LABEL = '(未設定)';

export class QueryRenderer {
  private readonly region: HTMLElement;
  private frame: {
    picker: HTMLSelectElement;
    note: HTMLElement;
    table: HTMLElement;
  } | null = null;
  /**
   * 断面指紋。⚠ **参照**で見る(kanban と同じ)── 集計の結果は
   * 差し替えでしか変わらないので、内容の指紋を作る必要が無い。
   */
  private lastKeys: AppState['queryKeys'] = null;
  private lastGroups: AppState['queryGroups'] = null;
  private lastKey: string | null = null;
  private lastSelected: string | null = null;
  private lastMetas: AppState['entryMetas'] | null = null;
  private lastFailed = false;
  /**
   * 🔑 **選択は Map で付け替える**(サイドバー / ファイラ / かんばんと同じ作法)。
   * ⚠ 1 稿目は属性セレクタで引いていたが、この repo で**そこだけ**セレクタを組む形に
   * なるうえ、想定外の lid(改行を含む等)で `querySelectorAll` が投げる ──
   * 既存の作法へ寄せた(判定を 2 種類に増やさない)。
   * ⚠ **1 件が複数の組に出る**(タグ)ので値は配列である。
   */
  private readonly rows = new Map<string, HTMLElement[]>();
  /**
   * 🔴 **user が畳んだ組を覚える**(レビュー B-4)。⚠ 1 稿目のコメントは
   * 「畳んだまま残る」と書いていたが**嘘だった** ── 表を作り直すたびに
   * `open = true` を代入していたので、数え直すと全部開いた(PKC2 と同じ)。
   */
  private readonly collapsed = new Set<string>();

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    const sameData =
      state.queryKeys === this.lastKeys &&
      state.queryGroups === this.lastGroups &&
      state.queryKey === this.lastKey &&
      state.entryMetas === this.lastMetas &&
      state.queryFailed === this.lastFailed;
    if (sameData && state.selectedLid === this.lastSelected) return;
    const selectionOnly = sameData;
    this.lastKeys = state.queryKeys;
    this.lastGroups = state.queryGroups;
    this.lastKey = state.queryKey;
    this.lastMetas = state.entryMetas;
    this.lastFailed = state.queryFailed;
    const prevSelected = this.lastSelected;
    this.lastSelected = state.selectedLid;

    const frame = this.ensureFrame();
    /**
     * 🔑 **選択が動いただけなら属性を付け替えるだけ**(サイドバー / かんばんと同じ)。
     * ⚠ 表を作り直すと、押した瞬間にその行が消えて別の行が下に来る。
     */
    if (selectionOnly && frame.table.childElementCount > 0) {
      if (prevSelected !== null)
        for (const el of this.rows.get(prevSelected) ?? []) el.removeAttribute('data-pkc-selected');
      if (state.selectedLid !== null)
        for (const el of this.rows.get(state.selectedLid) ?? [])
          el.setAttribute('data-pkc-selected', '');
      return;
    }

    this.renderPicker(frame.picker, state);
    this.renderNote(frame.note, state);
    this.renderTable(frame.table, state);
  }

  /** 器は 1 度だけ作る(押す寸前のボタンを捨てない)。 */
  private ensureFrame(): NonNullable<QueryRenderer['frame']> {
    if (this.frame) return this.frame;
    const head = document.createElement('div');
    head.setAttribute('data-pkc-region', 'query-bar');
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = '集計';
    const label = document.createElement('label');
    label.textContent = '束ね方';
    const picker = document.createElement('select');
    picker.setAttribute('data-pkc-field', 'query-key');
    picker.setAttribute('data-pkc-action', 'set-query-key');
    picker.setAttribute('aria-label', '束ねる項目');
    picker.title = 'frontmatter に書いた項目で束ねます';
    label.append(picker);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.setAttribute('data-pkc-action', 'refresh-query');
    refresh.textContent = '数え直す';
    refresh.title = '書き換えた後の中身で数え直します';
    head.append(title, label, refresh);

    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'query-note');
    const table = document.createElement('div');
    table.setAttribute('data-pkc-region', 'query-table');
    this.region.append(head, note, table);
    this.frame = { picker, note, table };
    return this.frame;
  }

  private renderPicker(picker: HTMLSelectElement, state: AppState): void {
    const keys = state.queryKeys?.keys ?? [];
    const wanted = [
      { value: '', label: keys.length === 0 ? '(束ねられる項目がありません)' : '(選んでください)' },
      ...keys.map((k) => ({ value: k.key, label: `${k.key}(${k.count} 件)` })),
    ];
    // ⚠ 中身が同じなら作り直さない(開いている最中に選択肢が飛ぶのを避ける)
    const same =
      picker.options.length === wanted.length &&
      wanted.every((w, i) => picker.options[i]!.value === w.value &&
        picker.options[i]!.textContent === w.label);
    if (!same) {
      picker.textContent = '';
      for (const w of wanted) {
        const opt = document.createElement('option');
        opt.value = w.value;
        opt.textContent = w.label;
        picker.append(opt);
      }
    }
    picker.value = state.queryKey ?? '';
    picker.disabled = keys.length === 0;
  }

  /** 🔴 **切ったことを必ず言う**(PKC2 は黙って切って「無い」と読ませた)。 */
  private renderNote(note: HTMLElement, state: AppState): void {
    const keys = state.queryKeys;
    const groups = state.queryGroups;
    const parts: string[] = [];
    /**
     * 🔴 **「まだ」と「駄目だった」を分ける**(レビュー B-5)── 分けないと、
     * 数えられない環境で「数えています…」が**永久に出続ける**。
     */
    if (state.queryFailed) {
      note.textContent = 'この版では集計を数えられませんでした(読み込み直すと直ることがあります)';
      return;
    }
    if (keys === null) parts.push('数えています…');
    else if (keys.scanned === 0) parts.push('ノートがまだありません');
    else parts.push(`${keys.scanned} 件のノートを見ました`);
    if (keys !== null && keys.omittedKeys > 0)
      parts.push(`項目は多い順に ${QUERY_LIMITS.keys} 個まで(あと ${keys.omittedKeys} 個)`);
    if (groups !== null && groups.omittedGroups > 0)
      parts.push(`組は多い順に ${QUERY_LIMITS.groups} 組まで(あと ${groups.omittedGroups} 組)`);
    note.textContent = parts.join(' / ');
  }

  private renderTable(table: HTMLElement, state: AppState): void {
    table.textContent = '';
    this.rows.clear();
    if (state.queryFailed) {
      const failed = document.createElement('p');
      failed.setAttribute('data-pkc-field', 'query-empty');
      failed.textContent = '数えられませんでした';
      table.append(failed);
      return;
    }
    if (state.queryKey === null) {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'query-empty');
      empty.textContent =
        (state.queryKeys?.keys.length ?? 0) === 0
          ? '本文の先頭に「---」で囲んだ項目(例: author: 佐藤)を書くと、ここで束ねられます'
          : '上の「束ね方」で項目を選ぶと、その項目の値ごとに束ねます';
      table.append(empty);
      return;
    }
    const groups = state.queryGroups;
    if (groups === null) {
      const wait = document.createElement('p');
      wait.setAttribute('data-pkc-field', 'query-empty');
      wait.textContent = '数えています…';
      table.append(wait);
      return;
    }
    for (const group of groups.groups) {
      const box = document.createElement('details');
      box.setAttribute('data-pkc-region', 'query-group');
      box.setAttribute('data-pkc-group', group.value);
      /**
       * 🔴 **既定は開く。ただし user が畳んだ組は畳んだまま**(レビュー B-4)。
       * ⚠ 1 稿目は毎回 `open = true` を代入していたので、「数え直す」を押すだけで
       * 畳んだ組が全部開いた ── PKC2 の `detail.open = true` と**同じ形**だった
       * (コメントには「畳んだまま残る」と書いてあり、実態と食い違っていた)。
       */
      box.open = !this.collapsed.has(group.value);
      box.addEventListener('toggle', () => {
        if (box.open) this.collapsed.delete(group.value);
        else this.collapsed.add(group.value);
      });
      const summary = document.createElement('summary');
      const name = document.createElement('span');
      name.setAttribute('data-pkc-field', 'query-group-name');
      name.textContent = group.value === UNSET ? UNSET_LABEL : group.value;
      const count = document.createElement('span');
      count.setAttribute('data-pkc-field', 'query-group-count');
      // 🔴 **N 件中 M 件**(切ったことを組ごとにも言う)
      count.textContent =
        group.lids.length < group.total
          ? `${group.total} 件(先頭 ${group.lids.length} 件)`
          : `${group.total} 件`;
      summary.append(name, count);
      box.append(summary);

      const list = document.createElement('ul');
      list.setAttribute('data-pkc-region', 'query-rows');
      for (const lid of group.lids) {
        const meta = state.entryMetas.get(lid);
        // ⚠ 消えたノートは出さない(集計は非同期なので、返る前に消えうる)
        if (meta === undefined) continue;
        const li = document.createElement('li');
        // 🔑 既存の規約に**揃える** ── 行は `data-pkc-entry` + `select-entry`
        li.setAttribute('data-pkc-entry', lid);
        li.setAttribute('data-pkc-action', 'select-entry');
        li.tabIndex = 0;
        if (lid === state.selectedLid) li.setAttribute('data-pkc-selected', '');
        // ⚠ 1 件が複数の組に出る(タグ)ので、行は**溜める**
        const bucket = this.rows.get(lid);
        if (bucket) bucket.push(li);
        else this.rows.set(lid, [li]);
        const t = document.createElement('span');
        t.setAttribute('data-pkc-field', 'title');
        t.textContent = meta.title || '(題名なし)';
        li.append(t);
        list.append(li);
      }
      box.append(list);
      table.append(box);
    }
    if (groups.groups.length === 0) {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'query-empty');
      empty.textContent = 'この項目を書いたノートがありません';
      table.append(empty);
    }
  }
}
