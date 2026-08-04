/**
 * ランチャーの面(P7b 段⑩)。
 *
 * > user 指示 2026-08-03「**ランチャーも使いやすければ、なんでもいいよ**」
 *
 * 🔑 **PKC3 の流儀に寄せる** ── 上のサイドバーと同じ「絞り込みで探して、押す」。
 * PKC2 のグループ折り畳み / drag & drop 並べ替えは持ち込まない
 * (「見えない状態の解消」が先で、足りなければ次の段で足せる)。
 *
 * ⚠ 起動そのものはここでやらない。`data-pkc-action="open-tile"` を置くだけで、
 * blob の貸し出しと `window.open` は adapter の service が持つ ──
 * renderer は DOM を描くだけ、という規約。
 */
import type { AppState } from '@adapter/state/app-state';
import type { LauncherTile } from '@features/launcher/tiles';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';

export class LauncherRenderer {
  private lastTiles: LauncherTile[] | null | undefined = undefined;
  private lastQuery: string | null = null;
  private lastSelected: string | null | undefined = undefined;

  constructor(private readonly region: HTMLElement) {}

  render(state: AppState): void {
    // ⚠ 選択も指紋に入れる ── 押した印が出ないと、いま何を触ったのか残らない
    if (
      state.launcherTiles === this.lastTiles &&
      state.filterQuery === this.lastQuery &&
      state.selectedLid === this.lastSelected
    )
      return;
    this.lastTiles = state.launcherTiles;
    this.lastQuery = state.filterQuery;
    this.lastSelected = state.selectedLid;
    this.region.textContent = '';

    if (state.launcherTiles === null) {
      const loading = document.createElement('p');
      loading.setAttribute('data-pkc-field', 'launcher-loading');
      loading.textContent = '読み込んでいます…';
      this.region.append(loading);
      return;
    }

    // ⚠ サイドバーと**同じ絞り込み**を効かせる(探し方を 2 通り覚えさせない)。
    // 規則は `title-filter.ts` の 1 本 ── 面ごとに書くと必ずずれる(review M-1/M-3)
    const q = normalizeQuery(state.filterQuery);
    const tiles = state.launcherTiles.filter((t) => matchesTitle(t.title, q));

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
            'アプリがありません。HTML のファイルを添付して、その画面の「アプリとして登録」を押すと、ここに並びます'
          : '絞り込みに一致するものがありません';
      this.region.append(empty);
      return;
    }

    let group: string | null = null;
    let grid: HTMLElement | null = null;
    for (const tile of tiles) {
      if (tile.group !== group) {
        group = tile.group;
        grid = document.createElement('div');
        grid.setAttribute('data-pkc-region', 'launcher-grid');
        // 🔴 **既定グループは見出しを出さない**(P8 段⑭)。かつては「よく使う」と
        //    書いていたが、画面はそんな情報(頻度)を持っていない ── 名乗った
        //    ぶんだけ嘘になる。名前の付いた群だけが見出しを持つ
        if (group === '') {
          this.region.append(grid);
        } else {
          const head = document.createElement('h3');
          head.setAttribute('data-pkc-field', 'launcher-group');
          head.textContent = group;
          this.region.append(head, grid);
        }
      }
      grid?.append(this.tile(tile, state.selectedLid));
    }
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
  private tile(tile: LauncherTile, selectedLid: string | null): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'open-tile');
    btn.setAttribute('data-pkc-tile', tile.lid);
    btn.setAttribute('data-pkc-tile-kind', tile.kind);
    // ⚠ 押した対象は**選択状態にもなる**(main.ts)── その印をここで出す
    if (tile.lid === selectedLid) btn.setAttribute('data-pkc-selected', '');

    // 🔑 目印(取込は写していたのに、出す側が無かった)。⚠ 無いときも**幅は取る**
    //    ── 有無で題名の左端がずれると、縦に並べたときに読みにくい。
    // ⚠ **無いときは空にする** ── 意味を持たない図案(□ 等)を既定で置くと、
    //    「押せる箱」に見えるうえ、情報を増やさずに画面を混ませる
    //    (地は無彩色・色は情報にだけ、と同じ向きの判断)。
    //    `↗` だけは情報である ── **外へ出る**ことを押す前に伝える
    const icon = document.createElement('span');
    icon.setAttribute('data-pkc-field', 'tile-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = tile.icon ?? (tile.kind === 'url' ? '↗' : '');
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
