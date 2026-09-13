/**
 * ランチャーの面(P7b 段⑩)。
 *
 * > user 指示 2026-08-03「**ランチャーも使いやすければ、なんでもいいよ**」
 *
 * 🔑 **PKC3 の流儀に寄せる** ── 上のサイドバーと同じ「絞り込みで探して、押す」。
 *
 * ⚠ **2026-09-12 に訂正**(#857 段①)。ここには
 * 「PKC2 のグループ折り畳み / drag & drop 並べ替えは持ち込まない」と書いてあったが、
 * 🔴 **user 指示で並べ替えは戻した**(掴んで落とす + 右クリックの「上へ / 下へ」)。
 * 🔑 持ち込まなかった理由は「見えない状態の解消が先」という**段取り**であって、
 *   要らないという判断ではなかった ── 段取りが済んだので戻す向きが正しい
 *   (CLAUDE.md「PKC2 は機能の袋ではない。動線で読む」)。
 * ⚠ **折り畳みも戻した**(#857 段④、2026-09-13)── 見出しを押すと畳める。
 *
 * ⚠ 起動そのものはここでやらない。`data-pkc-action="open-tile"` を置くだけで、
 * blob の貸し出しと `window.open` は adapter の service が持つ ──
 * renderer は DOM を描くだけ、という規約。
 */
import type { AppState } from '@adapter/state/app-state';
import type { LauncherTile } from '@features/launcher/tiles';
import { isMovableTile } from '@features/launcher/tile-order';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';
import { allFolded, encodeFolded, isFolded } from '@features/launcher/group-fold';
import { appGroupIconOf } from '@features/launcher/app-group-spec';
import type { IconValue } from '@features/icon/icon-value';
import { appGroupFold, type GroupFoldStore } from './group-fold';
import { setIcon } from './icons';

export class LauncherRenderer {
  private lastTiles: LauncherTile[] | null | undefined = undefined;
  private lastQuery: string | null = null;
  private lastSelected: string | null | undefined = undefined;
  /** ⚠ **1 回目の押しの印**(#857 段①b)── 指紋に入れないと印が出ない。 */
  private lastPick: string | null | undefined = undefined;
  /** ⚠ **並べ替えモード**(#857 段①b-2)── 入れないと「上へ / 下へ」が出ない。 */
  private lastReorder: boolean | undefined = undefined;

  /** ⚠ **畳みは端末ごと**なので state ではなく保存から読む(`group-fold.ts`)。 */
  private lastFolded: string | undefined = undefined;

  /** ⚠ **目印も指紋に要る**(#857 段②)── 入れないと選んでも画面が動かない。 */
  private lastIcons: string | undefined = undefined;

  constructor(
    private readonly region: HTMLElement,
    /** ⚠ test は自分で `new GroupFoldStore(null)` して渡す(`appEditorMode` と同じ作法)。 */
    private readonly folds: GroupFoldStore = appGroupFold,
  ) {}

  /**
   * 🔴 **器は 1 度だけ組む**(#401 ①)。
   *
   * ⚠ `render` は一覧を毎回捨てて組み直すので、足す欄をそこに置くと
   *   **打ちかけのアドレスが消える**(タイルの読み直しが走った瞬間に)。
   * 🔑 置換の帯・関係を作る帯と同じ作法 ── **打ちかけを守る器は別にする**。
   *
   * @returns 一覧を入れる器(こちらは毎回捨ててよい)
   */
  private ensureFrame(): HTMLElement {
    const found = this.region.querySelector<HTMLElement>('[data-pkc-field="launcher-list"]');
    if (found) return found;

    /**
     * 🔴 **よく開くサイトをアプリ一覧に足す**(#401 ①)。
     *
     * ⚠ PKC3 は URL タイルを**表示も起動もできる**のに(`tiles.ts` が
     *   `attachment.launcher_url` を読む)、**作る口が 1 つも無かった** ──
     *   PKC2 では既定 ON で届いていた導線である。
     * ⚠ 起動の扱いは既存のタイルと**同じ門**を通る(ここで別経路を作らない)。
     */
    const add = document.createElement('div');
    add.setAttribute('data-pkc-region', 'launcher-add');
    const name = document.createElement('input');
    name.type = 'text';
    name.setAttribute('data-pkc-field', 'launcher-add-name');
    name.placeholder = '名前';
    name.setAttribute('aria-label', 'リンクの名前');
    const url = document.createElement('input');
    url.type = 'text';
    url.setAttribute('data-pkc-field', 'launcher-add-url');
    url.placeholder = 'https://…';
    url.setAttribute('aria-label', 'リンクのアドレス');
    const go = document.createElement('button');
    go.type = 'button';
    go.setAttribute('data-pkc-action', 'add-url-tile');
    go.setAttribute('data-pkc-field', 'launcher-add-go');
    // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
    go.title = 'この一覧にリンクを 1 つ足します(足したリンクは別のウィンドウで開きます)';
    go.textContent = 'リンクを足す';
    add.append(name, url, go);

    const list = document.createElement('div');
    list.setAttribute('data-pkc-field', 'launcher-list');
    this.region.append(add, list);
    return list;
  }

  render(state: AppState): void {
    /**
     * ⚠ **畳みも指紋に入れる**(#857 段④)── 入れないと、畳んでも画面が動かない。
     * 🔑 保存は state の外に在るので、**読んだ値を字にして**比べる(参照では比べられない)。
     */
    const folded = this.folds.get();
    const foldKey = encodeFolded(folded);
    /**
     * ⚠ **指紋に入れる**(#857 段②)── 入れ忘れると「目印を選んだのに
     *   見出しが変わらない」になる(段④ の畳みで 1 度踏んだ罠)。
     */
    const iconKey = JSON.stringify(state.appGroupIcons);
    // ⚠ 選択も指紋に入れる ── 押した印が出ないと、いま何を触ったのか残らない
    if (
      state.launcherTiles === this.lastTiles &&
      state.filterQuery === this.lastQuery &&
      state.selectedLid === this.lastSelected &&
      state.launcherPick === this.lastPick &&
      state.launcherReorder === this.lastReorder &&
      foldKey === this.lastFolded &&
      iconKey === this.lastIcons
    )
      return;
    this.lastTiles = state.launcherTiles;
    this.lastQuery = state.filterQuery;
    this.lastSelected = state.selectedLid;
    this.lastPick = state.launcherPick;
    this.lastReorder = state.launcherReorder;
    this.lastFolded = foldKey;
    this.lastIcons = iconKey;
    const list = this.ensureFrame();
    list.textContent = '';

    if (state.launcherTiles === null) {
      const loading = document.createElement('p');
      loading.setAttribute('data-pkc-field', 'launcher-loading');
      loading.textContent = '読み込んでいます…';
      list.append(loading);
      return;
    }

    // ⚠ サイドバーと**同じ絞り込み**を効かせる(探し方を 2 通り覚えさせない)。
    // 規則は `title-filter.ts` の 1 本 ── 面ごとに書くと必ずずれる(review M-1/M-3)
    const q = normalizeQuery(state.filterQuery);
    const tiles = state.launcherTiles.filter((t) => matchesTitle(t.title, q));
    /**
     * 🔴 **絞り込んでいる間は掴ませない**(#857 段①、動線レビュー D3)。
     *
     * ⚠ 画面に出ているのは絞った後のタイルだが、並び順の正本は**全件**である ──
     *   隠れたタイルをまたぐ移動になるので、「上へ」を 1 回押しても**画面が
     *   1 ドットも動かない**(隣の隠れた 1 枚と入れ替わっただけ)。落とすほうも、
     *   線を引いた所と**違う場所に着く**。
     * 🔑 **掴めなくすれば、線も右クリックのメニューも出ない**(どちらも
     *   `[draggable="true"]` を鍵にしている)── 断られる前に、勧めない。
     * ⚠ 門は reducer にも在る(2 枚目)── あちらは理由を声に出す。
     */
    const canReorder = q === '';
    /**
     * 🔴 **並べ替えモード**(#857 段①b-2。user 裁定 2026-09-13「長押しで並べ替えモード」)。
     *
     * ⚠ **絞り込みとの兼ね合いはここで見ない** ── `SET_ENTRY_FILTER` が絞り込みを
     *   受けた時点で `launcherReorder` を落とすので、判定は**この 1 つ**で足りる
     *   (描く側と押す側が別々に判定すると、片方だけずれる ── CLAUDE.md §7)。
     */
    const reordering = state.launcherReorder;

    if (tiles.length === 0) {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'launcher-empty');
      // ⚠ **理由を分ける** ── 「1 つも無い」と「絞り込みで消えた」は別の話で、
      // 一緒にすると user は「取り込めていないのか」と誤解する
      empty.textContent =
        state.launcherTiles.length === 0
          ? // 🔴 **行き止まりにしない**(P8 段⑭)。かつては「PKC2 で登録したものが
            //    出ます」とだけ書いていた ── PKC3 だけの user には**実行できない
            //    指示**で、しかも当時は実際に登録する導線が無かった
            // ⚠ **行き止まりにしない**(P8 段⑭)── いまは道が 2 本ある
            'アプリがありません。HTML ファイルを添付すると、その添付の画面に「アプリとして登録」のチェックが出ます。よく開くサイトなら、上の欄に名前とアドレスを入れて「リンクを足す」を押してください'
          : '絞り込みに一致するものがありません';
      list.append(empty);
      return;
    }

    /**
     * 🔴 **押す前に「別の窓で開く」と分かるようにする**(#300 段③ の直し、2026-08-22)。
     *
     * ⚠ 直す前、タイルを押すと**画面は 1 ドットも動かなかった**(窓が背面に出る /
     *   別の画面に出る / 塞がれる、のどれでも)── user から見ると「壊れている」で
     *   あり、実際にもう一度押す。動線レビュー §4/§8。
     * 🔑 1 行だけ、**一覧の頭に**置く ── 行ごとに `↗` を足すと、この一覧では
     *   **全部のタイルが窓を開く**ので印が印にならない(`↗` は URL タイルの
     *   「**外部サイト**へ出る」という別の主張に取ってある)。
     */
    const lead = document.createElement('p');
    lead.setAttribute('data-pkc-field', 'launcher-lead');
    /**
     * ⚠ **2 回押すことを、押す前に言う**(#857 段①b)── 1 回目で印が付くだけだと、
     *   知らない人には「押したのに開かない」に見える。
     */
    lead.textContent = reordering
      ? // ⚠ モード中は**開かない**ので、開く話を出したままにしない(嘘になる)
        '並べ替え中です。「上へ」「下へ」で動かします(押しても開きません)'
      : 'アプリは 2 回押すと別のウィンドウで開きます';
    list.append(lead);
    /**
     * 🔴 **出口を必ず画面に置く**(#857 段①b-2)。
     * ⚠ 入口は長押しと右クリックの 2 つあるが、**出口が右クリックだけ**だと
     *   指の端末は入ったきり出られない(片道の操作を作らない ── CLAUDE.md 2026-08-23)。
     */
    if (reordering) {
      const done = document.createElement('button');
      done.type = 'button';
      done.setAttribute('data-pkc-action', 'end-tile-reorder');
      done.setAttribute('data-pkc-field', 'launcher-reorder-done');
      /**
       * ⚠ 字は**右クリックのメニューと同じ**にする(着地前の動線レビュー 改善、
       *   2026-09-13)── 同じことをする 2 つの押し所で呼び名が違うと、user は
       *   別の操作だと思う(「上へ」「下へ」は既に揃えてある)。
       * ⚠ 「やめる」にしない ── **直した並びが元へ戻ると読める**(戻らない。
       *   動かしたぶんは既に保存されている)。「終える」はモードの出口だけを言う。
       */
      done.title = '並べ替えを終えます(タイルは 2 回押すと開くように戻ります)';
      done.textContent = '並べ替えを終える';
      list.append(done);
    }

    /**
     * 🔴 **畳んだ群は、見出しだけ出す**(#857 段④)。
     * ⚠ **絞り込み中は畳みを無視する** ── 絞った結果が畳んだ群の中に在ると、
     *   打ったのに何も出ないように見える(「無い」と「畳んである」の区別が付かない)。
     */
    const countOf = (name: string): number => tiles.filter((t) => t.group === name).length;
    const filtering = q !== '';

    /**
     * 🔴 **「すべて畳む / すべて開く」**(#857 段④)── 20 個あるグループを
     * 1 つずつ押させないため。
     *
     * 🔑 **押し所は 1 つ**で、いまの状態で字が裏返る ── 2 つ並べると
     *   **いつも片方が空振り**する(全部開いている画面に「すべて開く」が在る)。
     * ⚠ **名前の付いた群が 1 つも無ければ出さない** ── 名前の無いまとまりは
     *   畳めないので、出すと押しても何も起きない押し所になる。
     * ⚠ **絞り込み中も出さない** ── 見出しと同じ理由(絞り込み中は畳みを無視するので、
     *   押しても画面が変わらない)。
     */
    const named: string[] = [];
    for (const t of tiles) if (t.group !== '' && !named.includes(t.group)) named.push(t.group);
    if (!filtering && named.length > 0) {
      const all = document.createElement('button');
      all.type = 'button';
      all.setAttribute('data-pkc-action', 'toggle-all-app-groups');
      all.setAttribute('data-pkc-field', 'launcher-fold-all');
      const opens = allFolded(folded, named);
      all.title = opens
        ? '畳んであるグループを全部開きます'
        : 'グループを全部畳みます(中のアプリが隠れます)';
      all.textContent = opens ? 'すべて開く' : 'すべて畳む';
      list.append(all);
    }

    let group: string | null = null;
    let grid: HTMLElement | null = null;
    for (const tile of tiles) {
      if (tile.group !== group) {
        group = tile.group;
        grid = document.createElement('div');
        grid.setAttribute('data-pkc-region', 'launcher-grid');
        /**
         * 🔴 **その群が落とし先になるか**(#857 段①)。
         *
         * 🔑 印を付ける条件は「**動かせるタイルが 1 枚でも居るか**」── 群の名前で
         *   判定しない(`BUILTIN_GROUP` を書くと、user が同じ名前を付けた日にずれる)。
         * ⚠ 組み込みだけの群を落とし先にすると、user のタイルに
         *   `app_group: 組み込みアプリ` が書かれ、**最初から在る物の中へ紛れる**。
         * ⚠ **群の末尾へ落とす**のはこの器が受ける(タイルとタイルの間は
         *   タイル自身が受ける)── 器が無いと、いちばん下へは落とせない。
         */
        if (canReorder && tiles.some((t) => t.group === group && isMovableTile(t)))
          grid.setAttribute('data-pkc-tile-group', group);
        // 🔴 **既定グループは見出しを出さない**(P8 段⑭)。かつては「よく使う」と
        //    書いていたが、画面はそんな情報(頻度)を持っていない ── 名乗った
        //    ぶんだけ嘘になる。名前の付いた群だけが見出しを持つ
        if (group === '') {
          list.append(grid);
        } else {
          /**
           * 🔴 **見出しを押すと畳める**(#857 段④)。
           *
           * ⚠ **名前の無い群には出さない** ── 見出しが無いので、畳んだら
           *   **開く口が画面から消える**(片道の操作を作らない)。
           * ⚠ 印は `::before` が描く ── 器の字に混ぜると、見出しの字を読む
           *   側(test / 読み上げ / 写し)が静かに外れる(CLAUDE.md §10)。
           * 🔑 件数は**畳んだときだけ**出す ── 開いていれば数えなくても見える。
           */
          const head = document.createElement('h3');
          head.setAttribute('data-pkc-field', 'launcher-group');
          const off = isFolded(folded, group, filtering);
          /**
           * 🔴 **見出しの目印**(#857 段②)。正本は**グループ用のノート**の
           * frontmatter(`app-group-spec.ts`)。
           *
           * ⚠ **器の字を 1 文字も変えない** ── 絵文字を子の `textContent` に入れると
           *   `h3.textContent` が `🧮資料` に化け、**字を読む側**(test / 読み上げ /
           *   写し)が静かに外れる(#770 段① で smoke 5 本が落ちた型)。
           * 🔑 だから**属性だけ**で描く ── 図案は `data-pkc-symbol`、絵文字は
           *   `data-pkc-icon-text` を CSS の `::before` が出す。
           */
          const mark = appGroupIconOf(state.appGroupIcons, group);
          if (filtering) {
            /**
             * 🔴 **絞り込み中は、見出しを押し所にしない**(#857 段④ の仕上げ)。
             *
             * ⚠ 絞り込み中は畳みを**無視して出す**ので、ここで押せると
             *   **押しても画面が 1 ドットも変わらない**(この repo がいちばん嫌う
             *   無言の dead click)。しかも欄を空にした瞬間に畳まれるので、
             *   **忘れた頃に効く**という、いちばん結び付けにくい形になる。
             * 🔑 探している間は畳みの話を画面から消す ── 字は出す(どの群かは要る)。
             */
            head.textContent = group;
            if (mark !== undefined) head.prepend(groupMark(mark));
          } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-pkc-action', 'toggle-app-group');
            btn.setAttribute('data-pkc-group', group);
            btn.setAttribute('aria-expanded', off ? 'false' : 'true');
            btn.title = off
              ? `${group} を開きます(いまは畳んであります)`
              : `${group} を畳みます(中のアプリが隠れます)`;
            btn.textContent = off ? `${group}(${countOf(group)})` : group;
            // ⚠ `textContent` を入れた**後**に足す(先に足すと代入で消える)
            if (mark !== undefined) btn.prepend(groupMark(mark));
            head.append(btn);
          }
          list.append(head);
          // ⚠ 畳んだ群は器ごと出さない ── 落とし先も消える(掴んで入れるには先に開く)
          if (!off) list.append(grid);
          else grid = null;
        }
      }
      grid?.append(this.row(tile, state.selectedLid, canReorder, state.launcherPick, reordering));
    }
  }

  /**
   * 🔴 **1 行を組む**(#857 段①b-2)── ふだんは**タイルそのもの**、
   * 並べ替えモードでは**タイル + 「上へ」「下へ」**。
   *
   * ## ⚠ なぜモードのときだけ器を増やすのか
   *
   * タイルは `<button>` なので、その**中**にボタンは置けない(入れ子の button は
   * 不正で、ブラウザが勝手に外へ出す)。🔑 だから**外側に器を 1 枚**足す。
   * ⚠ ただし**ふだんは足さない** ── 器が増えると `launcher-grid > button` を
   * 前提にした読み手(CSS・test・smoke)が静かに外れる(CLAUDE.md §10
   * 「器を替えると読み取れる値が変わる」)。モードのときだけなら、**既定の DOM は
   * 1 バイトも変わらない**。
   *
   * ⚠ 組み込みのタイルには出さない ── 動かせないものに押し所を置くと、
   *   押して「並べ替えられません」と断られる(勧めてから断らない)。
   */
  private row(
    tile: LauncherTile,
    selectedLid: string | null,
    canReorder: boolean,
    pick: string | null,
    reordering: boolean,
  ): HTMLElement {
    const btn = this.tile(tile, selectedLid, canReorder, pick);
    if (!reordering || !isMovableTile(tile)) return btn;

    const row = document.createElement('div');
    row.setAttribute('data-pkc-field', 'tile-row');
    row.append(btn);
    /**
     * ⚠ 字は**右クリックのメニューと同じ**にする(「上へ」「下へ」)── 同じことを
     *   する 2 つの口で呼び名を変えると、user は別の操作だと思う。
     * ⚠ **図案だけのボタンにしない**(`icons.ts` の戒め)── 意味は字が持つ。
     * 🔑 身元(`data-pkc-tile`)は**このボタン自身**に写す ── 受け手(`moveTile`)は
     *   押された物からしか辿らない(右クリックのメニューと同じ作法)。
     */
    for (const [action, label, hint] of [
      ['move-tile-up', '上へ', '1 つ上へ動かします'],
      ['move-tile-down', '下へ', '1 つ下へ動かします'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', action);
      b.setAttribute('data-pkc-tile', tile.lid);
      b.setAttribute('data-pkc-field', 'tile-move');
      b.title = `${tile.title} を${hint}`;
      b.textContent = label;
      row.append(b);
    }
    return row;
  }

  /**
   * 1 タイル = **1 行**(P8 段⑭)。
   *
   * 🔴 直す前の実測: 高さが 26px と 34px の 2 種類あり(URL タイルだけ 2 行)、
   * 題名は枠を最大 151px 突き抜けてサイドバーに横スクロールが生え、
   * **地と同じ色の枠が 36 本**引かれて全部太字だった ── 装飾は足りていて
   * 階層が無い、という状態。一覧と同じ流儀(1 行・共有 1px 線・普通の太さ・
   * はみ出しは畳む)へ寄せる。
   */
  private tile(
    tile: LauncherTile,
    selectedLid: string | null,
    canReorder: boolean,
    pick: string | null,
  ): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'open-tile');
    btn.setAttribute('data-pkc-tile', tile.lid);
    btn.setAttribute('data-pkc-tile-kind', tile.kind);
    /**
     * 🔴 **掴んで並べ替えられる**(#857 段①)。
     * ⚠ 組み込みは **entry を持たない**(並び順を書く先が無い)ので掴ませない ──
     *   掴めるのに落とせないと「壊れている」に見える。
     */
    if (canReorder && isMovableTile(tile)) btn.setAttribute('draggable', 'true');
    /**
     * ⚠ 押した対象は**選択状態にもなる**(main.ts)── その印をここで出す。
     * 🔴 **`launcherPick` も見る**(#857 段①b)── 組み込みのタイルは entry を
     *   持たないので `selectedLid` は 1 ミリも動かない。見ないと
     *   **1 回目の押しが無反応に見える**。
     */
    if (tile.lid === selectedLid || tile.lid === pick) btn.setAttribute('data-pkc-selected', '');

    // 🔑 目印(取込は写していたのに、出す側が無かった)。⚠ 無いときも**幅は取る**
    //    ── 有無で題名の左端がずれると、縦に並べたときに読みにくい。
    // ⚠ **無いときは空にする** ── 意味を持たない図案(□ 等)を既定で置くと、
    //    「押せる箱」に見えるうえ、情報を増やさずに画面を混ませる
    //    (地は無彩色・色は情報にだけ、と同じ向きの判断)。
    //    `↗` だけは情報である ── **外へ出る**ことを押す前に伝える
    const icon = document.createElement('span');
    icon.setAttribute('data-pkc-field', 'tile-icon');
    icon.setAttribute('aria-hidden', 'true');
    /**
     * 🔴 **図案で置いた目印は、書体が描く**(#770 段②)。
     * ⚠ **字を器に入れない** ── 入れるとボタン丸ごとの `textContent` に
     *   目に見えない 1 文字が混ざり、文言を読む側が静かに外れる
     *   (2026-09-11 に全量 smoke が 5 本落ちて学んだ形。CLAUDE.md §10)。
     *   絵を出すのは CSS の `::before` である。
     */
    if (tile.symbol !== undefined) {
      icon.setAttribute('data-pkc-icon', '');
      setIcon(icon, tile.symbol);
    } else {
      icon.textContent = tile.icon ?? (tile.kind === 'url' ? '↗' : '');
    }
    btn.append(icon);

    const name = document.createElement('span');
    name.setAttribute('data-pkc-field', 'title');
    name.textContent = tile.title;
    btn.append(name);

    if (tile.kind === 'url' && tile.url !== undefined) {
      // ⚠ 飛び先を**見せる** ── 押す前にどこへ行くか分からないのは怖い。
      //    ただし**同じ行の右端**に置く(2 行にすると行の律動が崩れる)
      const where = document.createElement('span');
      where.setAttribute('data-pkc-field', 'tile-url');
      where.textContent = hostOf(tile.url);
      btn.append(where);
      btn.title = tile.url;
    }
    return btn;
  }
}

/** 飛び先の見せ方(host だけ)。⚠ 長い URL をそのまま出すとタイルが壊れる。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 🔴 **見出しの目印を 1 つ描く**(#857 段②)。
 *
 * ⚠ **字を 1 文字も持たせない** ── 図案は `data-pkc-symbol`、絵文字は
 *   `data-pkc-icon-text` で、どちらも**出すのは CSS の `::before`** である。
 * 🔑 こうすると、この span を足しても `h3.textContent` / `button.textContent` が
 *   **1 バイトも変わらない**(#770 段① の「器を替えると読み取れる値が変わる」を
 *   起こさない置き方)。
 */
function groupMark(v: IconValue): HTMLElement {
  const el = document.createElement('span');
  el.setAttribute('data-pkc-field', 'group-icon');
  if (v.symbol !== undefined) {
    el.setAttribute('data-pkc-icon', '');
    setIcon(el, v.symbol);
  } else if (v.icon !== undefined) {
    el.setAttribute('data-pkc-icon-text', v.icon);
  }
  return el;
}
