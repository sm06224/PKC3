/**
 * 🔴 **読む面を横に並べる**(#505 段②。user 指示 2026-08-28)。
 *
 * > 「ウルトラワイドモニター用に閲覧時にセンターペインを任意分割して、
 * > **複数ドキュメントを開いたり**…」
 *
 * ## 何が画面に出るか
 *
 * ```
 * [ いま見ているノート ][ 留めたノート ][ 留めたノート ]
 *        主の枠            × 外す         × 外す
 * ```
 *
 * - **主の枠**は今までどおり ── 一覧を押すたびに中身が変わる
 * - **留めた枠**は user が留めた 1 件を出し続ける。⚠ 一覧を押しても**動かない**
 *   (動くと「横に並べて突き合わせる」が成立しない)
 * - **枠ごとに送る** ── 片方を読み進めても、もう片方は動かない
 *
 * ## ⚠ 既定は 1 枠。何も留めなければ、画面は 1 バイトも変わらない
 *
 * 留めたものが 0 件のときは**器も作らない**(`row` を置かない)── 置くと
 * 何もしていない user の DOM が 1 段深くなり、CSS と scroll の当たりが変わる。
 *
 * ## 🔴 なぜ枠ごとに `DetailRenderer` を立てるのか
 *
 * ⚠ PKC2 は「**同じ markdown を 5 面が別経路で描き**、canonical と異なる経路で
 * 常に Gap が生まれる構造的問題」を自己診断している(PKC3 の CLAUDE.md)。
 * 🔑 だから**描き方を 2 つ作らない** ── 図の焼き直し・画像の貸し借り・見出しの畳み・
 * 自由配置の板は、全部 `DetailRenderer` が 1 か所で持っている。
 * ⚠ 代わりに `DetailRenderer` へ「留めた枠として描く」門を足した(`pinnedLid`)──
 * そちらは**帯も履歴も出さず**、`data-pkc-field` を `split-*` に変える。
 */
import type { AppState } from '@adapter/state/app-state';
import type { DetailRenderer } from './detail';
import { fittingSplitFrames, knownSplitLids } from '@features/split-frames';
import { READ_COLUMN_BASE_FONT_PX } from '@features/read-columns';
import { sayFolded } from './fold-notify';

/** 枠 1 つを作る口。⚠ `DetailRenderer` を直に `new` しない(依存を配線側が持つ)。 */
export type MakeFrameRenderer = (host: HTMLElement, pinnedLid: string) => DetailRenderer;

interface Frame {
  readonly host: HTMLElement;
  readonly renderer: DetailRenderer;
}

/** 面の幅と本文の大きさ。⚠ 測れない環境(test)では `null` ── そのとき畳まない。 */
function measure(row: HTMLElement): { width: number; fontPx: number } | null {
  const width = row.getBoundingClientRect().width;
  if (!Number.isFinite(width) || width <= 0) return null;
  const view = row.ownerDocument.defaultView;
  const px = view === null ? Number.NaN : Number.parseFloat(view.getComputedStyle(row).fontSize);
  // ⚠ 採寸できない環境では**標準の大きさ**へ落ちる(0 や NaN を渡さない)
  return { width, fontPx: Number.isFinite(px) && px > 0 ? px : READ_COLUMN_BASE_FONT_PX };
}

export class SplitView {
  /**
   * 🔴 **器は最初から作る**(2026-08-29、test が捕まえた)。
   *
   * ⚠ 1 稿目は「留めたときに器を作り、主の枠の子をそこへ移す」形だった ──
   * **主の `DetailRenderer` は器(`pane`)を握ったままなので、次に描いた瞬間
   * `textContent = ''` で枠ごと消していた**。器の同一性は renderer の前提であり、
   * 後から差し替えられない。
   * 🔑 だから**主の器は最初に 1 つ作って動かさない**。並べているかどうかは
   * **印(`data-pkc-split` / `data-pkc-region`)だけ**で表す ──
   * ⚠ 何も留めていない間は印が付かないので、CSS も `scroller` も**今までどおり**。
   */
  private readonly row: HTMLElement;
  private readonly mainHost: HTMLElement;
  readonly main: DetailRenderer;
  private readonly frames = new Map<string, Frame>();
  /** 直前に出した並び。⚠ 変わったときだけ器を触る(毎回作り直さない)。 */
  private shown: readonly string[] = [];
  /** 直前に「入らないので減らしました」と言った件数。⚠ 同じ事を繰り返し言わない。 */
  private lastDropped = 0;

  constructor(
    private readonly pane: HTMLElement,
    makeMain: (host: HTMLElement) => DetailRenderer,
    private readonly makeFrame: MakeFrameRenderer,
  ) {
    const doc = pane.ownerDocument;
    this.row = doc.createElement('div');
    this.row.setAttribute('data-pkc-region', 'split-row');
    this.mainHost = doc.createElement('div');
    this.mainHost.setAttribute('data-pkc-split-main', '');
    this.row.append(this.mainHost);
    pane.append(this.row);
    this.main = makeMain(this.mainHost);
  }

  /**
   * 留めた枠を state に合わせて並べ替え、全部の枠を描く。
   *
   * ⚠ **主の枠は必ず描く** ── 留めたものが 0 件でも、ここが唯一の描き口である。
   */
  render(state: AppState): void {
    const want = knownSplitLids(state.splitLids, state.entryMetas);
    const fit = this.fitCount(want.length + 1);
    // ⚠ 減らすのは**後ろから**(先に留めた物が残る ── `split-frames.ts` の規約)
    const show = want.slice(0, Math.max(fit - 1, 0));
    this.sayIfDropped(want.length, show.length);
    this.sync(show);
    this.main.render(state);
    for (const lid of show) this.frames.get(lid)?.renderer.render(state);
  }

  /** 器に何枠置けるか。⚠ 測れないときは**減らさない**(test で全部消えない)。 */
  private fitCount(wanted: number): number {
    if (wanted <= 1) return 1;
    const m = measure(this.row);
    if (m === null) return wanted;
    return fittingSplitFrames(m.width, wanted, m.fontPx);
  }

  private sayIfDropped(wanted: number, shown: number): void {
    const dropped = wanted - shown;
    if (dropped === this.lastDropped) return;
    this.lastDropped = dropped;
    /**
     * 🔴 **口は共有の 1 つ**(#606)── 直す前はコンストラクタ引数で受けており、
     *   `main.ts` が渡していなかったので**製品では 1 度も出ていなかった**
     *   (test だけが自分で渡していた = CLAUDE.md §7)。
     */
    if (dropped > 0) sayFolded(`幅が足りないので、横に並べる枠を ${dropped} 枚畳みました`);
  }

  /** 器を並びへ合わせる。⚠ **同じなら 1 バイトも触らない**(scroll と図が生き残る)。 */
  private sync(lids: readonly string[]): void {
    if (lids.length === this.shown.length && lids.every((l, i) => l === this.shown[i])) return;
    this.shown = [...lids];
    // ⚠ 居なくなった枠を先に片づける(器を使い回さない ── 別のノートの図が残る)
    for (const [lid, frame] of [...this.frames]) {
      if (lids.includes(lid)) continue;
      frame.host.remove();
      this.frames.delete(lid);
    }
    for (const lid of lids) {
      if (this.frames.has(lid)) continue;
      const host = this.frameHost(lid);
      const inner = host.ownerDocument.createElement('div');
      host.append(inner);
      this.frames.set(lid, { host, renderer: this.makeFrame(inner, lid) });
    }
    // 並び順を state に合わせる(留めた順に左から)
    for (const lid of lids) {
      const f = this.frames.get(lid);
      if (f !== undefined) this.row.append(f.host);
    }
    this.mark(lids.length > 0);
  }

  /**
   * 🔴 **並べている間だけ印を立てる**(#505 段②)。
   *
   * ⚠ **器は消さない**(消せない ── 主の renderer が握っている)。代わりに印を外す。
   * ⚠ `data-pkc-region="split-frame"` を主の器にも付けるのは**並べている間だけ** ──
   * 常に付けると `DetailRenderer` の `scroller` がこの器を掴み、
   * **並べていないのに送りの持ち主が変わる**(既存の位置戻しが黙って壊れる)。
   */
  private mark(on: boolean): void {
    if (on) {
      this.pane.setAttribute('data-pkc-split', 'on');
      this.mainHost.setAttribute('data-pkc-region', 'split-frame');
      return;
    }
    this.pane.removeAttribute('data-pkc-split');
    this.mainHost.removeAttribute('data-pkc-region');
  }

  private frameHost(lid: string): HTMLElement {
    const doc = this.pane.ownerDocument;
    const host = doc.createElement('div');
    host.setAttribute('data-pkc-region', 'split-frame');
    host.setAttribute('data-pkc-split-lid', lid);
    const bar = doc.createElement('div');
    bar.setAttribute('data-pkc-region', 'split-frame-bar');
    const off = doc.createElement('button');
    off.type = 'button';
    off.setAttribute('data-pkc-action', 'unsplit-entry');
    off.setAttribute('data-pkc-lid', lid);
    // ⚠ 記号だけにしない ── 何が外れるのか読めない
    off.textContent = '× 外す';
    off.title = '横に並べるのをやめる(ノートは消えません)';
    bar.append(off);
    host.append(bar);
    this.row.append(host);
    return host;
  }
}
