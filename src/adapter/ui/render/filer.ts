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
  getStructuralChildren,
  getRootEntries,
  getAncestorFolders,
  resolveCanonicalParents,
  resolveFilerScope,
  listMoveTargets,
  listSiblings,
} from '@features/relation/tree';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';
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
  private lastRelations: readonly Relation[] | null = null;
  private lastSelected: string | null = null;
  private lastScopeLid: string | null = null;
  /** ⚠ 絞り込みも指紋の一部(review M-3 ── 絞り込み中にファイラだけ全件出ていた)。 */
  private lastFilter: string | null = null;
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
  private renderMoveBar(state: AppState, scope: EntryMeta | null): void {
    const host = this.moveBar;
    if (!host) return;
    host.textContent = '';

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

  render(state: AppState): void {
    const listChanged =
      state.entryMetas !== this.lastMetas ||
      state.relations !== this.lastRelations ||
      state.filterQuery !== this.lastFilter;
    const selectionChanged = state.selectedLid !== this.lastSelected;
    const trashChanged = state.trashPanel !== this.lastTrash;
    if (!listChanged && !selectionChanged && !trashChanged) return;

    const scope = resolveFilerScope(state.selectedLid, state.entryMetas, state.relations);
    const scopeLid = scope?.lid ?? null;

    if (!listChanged && !trashChanged && scopeLid === this.lastScopeLid) {
      // 選択だけの変化(scope 不変)── 属性 patch のみで済ませる
      if (this.lastSelected) {
        this.rows.get(this.lastSelected)?.removeAttribute('data-pkc-selected');
      }
      if (state.selectedLid) {
        this.rows.get(state.selectedLid)?.setAttribute('data-pkc-selected', '');
      }
      this.lastSelected = state.selectedLid;
      // 🔴 **居場所の帯は選択に追従する**(2026-08-05)。ここを忘れると、
      //    行を選び直しても帯は**前に選んでいたものを指したまま**になり、
      //    「移動」を押すと**別のノートが動く**(見えない取り違え)
      this.renderMoveBar(state, scope);
      return;
    }

    this.lastMetas = state.entryMetas;
    this.lastRelations = state.relations;
    this.lastSelected = state.selectedLid;
    this.lastScopeLid = scopeLid;
    this.lastTrash = state.trashPanel;
    this.lastFilter = state.filterQuery;

    // ⚠ 絞り込みは**全部の面**に同じ規則で効かせる(review M-3)。
    // scope(どのフォルダを見ているか)は動かさない ── 絞るのは**中身**だけ
    const q = normalizeQuery(state.filterQuery);
    const list = (
      scope
        ? getStructuralChildren(scope.lid, state.entryMetas, state.relations)
        : getRootEntries(state.entryMetas, state.relations)
    ).filter((m) => matchesTitle(m.title, q));

    this.region.textContent = '';
    this.rows.clear();

    // breadcrumb: root / …祖先… / scope
    const crumb = document.createElement('nav');
    crumb.setAttribute('data-pkc-region', 'filer-breadcrumb');
    const rootSeg = document.createElement('button');
    rootSeg.type = 'button';
    rootSeg.setAttribute('data-pkc-action', 'filer-root');
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
        btn.setAttribute('data-pkc-action', 'select-entry');
        btn.textContent = seg.title;
        crumb.append(btn);
      }
    }
    this.region.append(crumb);
    this.moveBar = document.createElement('div');
    this.moveBar.setAttribute('data-pkc-region', 'filer-move');
    this.region.append(this.moveBar);
    this.renderMoveBar(state, scope);

    const table = document.createElement('table');
    table.setAttribute('data-pkc-region', 'filer-table');
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
      if (m.lid === state.selectedLid) tr.setAttribute('data-pkc-selected', '');
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
  }
}
