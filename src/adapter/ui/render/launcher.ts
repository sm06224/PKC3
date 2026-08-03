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

  constructor(private readonly region: HTMLElement) {}

  render(state: AppState): void {
    if (state.launcherTiles === this.lastTiles && state.filterQuery === this.lastQuery) return;
    this.lastTiles = state.launcherTiles;
    this.lastQuery = state.filterQuery;
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
          ? 'ランチャーに出す添付がありません(PKC2 で「アプリとして登録」したものが出ます)'
          : '絞り込みに一致するものがありません';
      this.region.append(empty);
      return;
    }

    let group: string | null = null;
    let grid: HTMLElement | null = null;
    for (const tile of tiles) {
      if (tile.group !== group) {
        group = tile.group;
        const head = document.createElement('h3');
        head.setAttribute('data-pkc-field', 'launcher-group');
        // 既定グループは名前を持たない ── 見出しの文言で埋める
        head.textContent = group === '' ? 'よく使う' : group;
        grid = document.createElement('div');
        grid.setAttribute('data-pkc-region', 'launcher-grid');
        this.region.append(head, grid);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', 'open-tile');
      btn.setAttribute('data-pkc-tile', tile.lid);
      btn.setAttribute('data-pkc-tile-kind', tile.kind);
      const name = document.createElement('span');
      name.setAttribute('data-pkc-field', 'title');
      name.textContent = tile.title;
      btn.append(name);
      if (tile.kind === 'url' && tile.url !== undefined) {
        // ⚠ 飛び先を**見せる** ── 押す前にどこへ行くか分からないのは怖い
        const where = document.createElement('span');
        where.setAttribute('data-pkc-field', 'tile-url');
        where.textContent = hostOf(tile.url);
        btn.append(where);
        btn.title = tile.url;
      }
      grid?.append(btn);
    }
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
