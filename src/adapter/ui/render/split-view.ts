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
import {
  fittingSplitFrames,
  knownSplitLids,
  SPLIT_PINNED_MAX,
} from '@features/split-frames';
import { READ_COLUMN_BASE_FONT_PX } from '@features/read-columns';
import { sayFolded } from './fold-notify';

/** 枠 1 つを作る口。⚠ `DetailRenderer` を直に `new` しない(依存を配線側が持つ)。 */
export type MakeFrameRenderer = (host: HTMLElement, pinnedLid: string) => DetailRenderer;

interface Frame {
  readonly host: HTMLElement;
  readonly renderer: DetailRenderer;
}

/** CSS の長さを px にする。⚠ 読めない値は 0(採寸を NaN で汚さない)。 */
function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * 面の**中身の幅**と本文の大きさ。⚠ 測れない環境(test)では `null` ── そのとき畳まない。
 *
 * 🔴 **測るのは器(`split-row`)ではなく面(`pane`)である**(#608)。
 *
 * ⚠ 1 稿目は `row` を測っていたが、**何も並べていない間の `row` は
 * `display: contents`**(`app.css:5193-5197`)なので
 * `getBoundingClientRect().width` が **0** を返す ── そこから
 * 「測れないなら減らさない」へ落ちて `wanted` をそのまま通していた。
 * 🔑 結果、**畳んだ次の描画は 0 と読んで全部戻し、その次は 676 と読んで全部畳む** ──
 * 狭い窓で一覧を押すたびに **0 枚 ⇄ 3 枚**で入れ替わっていた(#608 の実測)。
 *
 * ⚠ **「row が 0 なら pane を測る」にはしない** ── 同じ問いに答える口が 2 つになる
 * (CLAUDE.md §7)。面は**どちらの状態でも実寸を持つ**ので、口は 1 つで足りる。
 * 🔑 面の中身の幅 = 器が占める幅である(面は縦の flex で、器は `flex: 1 1 auto` =
 * 交差軸いっぱいに伸びる)。⚠ だから `padding` と `border` を**引く**
 * (`box-sizing: border-box` なので外寸には含まれている)。
 */
function measure(pane: HTMLElement): { width: number; fontPx: number } | null {
  const box = pane.getBoundingClientRect().width;
  if (!Number.isFinite(box) || box <= 0) return null;
  const view = pane.ownerDocument.defaultView;
  const cs = view === null ? null : view.getComputedStyle(pane);
  const width =
    box -
    px(cs?.paddingLeft) -
    px(cs?.paddingRight) -
    px(cs?.borderLeftWidth) -
    px(cs?.borderRightWidth);
  if (!Number.isFinite(width) || width <= 0) return null;
  const font = Number.parseFloat(cs?.fontSize ?? '');
  // ⚠ 採寸できない環境では**標準の大きさ**へ落ちる(0 や NaN を渡さない)
  return { width, fontPx: Number.isFinite(font) && font > 0 ? font : READ_COLUMN_BASE_FONT_PX };
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
  /**
   * 直前に描いた state。⚠ 窓の大きさが変わったときに**描き直す**ために持つ
   * (#608)── `render` は state を要るので、持たないと resize から呼べない。
   */
  private lastState: AppState | null = null;
  /** 直前に置けると判定した枠数。⚠ **変わったときだけ**描き直す(振動させない)。 */
  private lastFit = 0;
  /**
   * 🔴 **スタックの帯**(#633 段①。user 裁定 2026-09-02 ②)── 本文の**上**に 1 行。
   *
   * ⚠ **何も載せていなければ DOM に置かない**(既存の「既定は 1 枠」と同じ作法)──
   *   置くと、何もしていない user の版面が 1 行ぶん縮む。
   * ⚠ 置き場は**面(`pane`)の兄ではなく、面の先頭** ── 面の中に置くと
   *   `read-columns` が面の高さを段の高さに使い、段が溢れる(設計 doc §7 のリスク)。
   *   🔑 だから `row` の**前**に入れて、面の高さは帯 + 器で分け合う。
   */
  private band: HTMLElement | null = null;
  /** 直前に帯へ描いた並びと印。⚠ 同じなら 1 バイトも触らない(押し所が飛ばない)。 */
  private bandKey = '';
  /** 見張りを外す口。⚠ 面と同じ寿命なので普段は呼ばないが、test が使う。 */
  private stopWatch: (() => void) | null = null;

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
    this.watch();
  }

  /**
   * 🔴 **窓の大きさが変わったら測り直す**(#608)。
   *
   * ⚠ 直す前は `SplitView.render` を呼ぶのが `center.ts` の 1 か所だけで、
   * **`ResizeObserver` が付いていなかった** ── 900px まで狭めても
   * **1 枠 448px の下限を無視して 203px の枠が 3 枚**残っていた。
   * ⚠ 🟢 段組みのほうには最初から付いている(`read-columns.ts` の
   * `installColumnFit`)── **同じ「幅で畳む」機構が、片方だけ見ていなかった**。
   *
   * 🔑 `installColumnFit` と同じ作法を写す:
   * ①**面 1 枚だけ**を見る(document を見張らない = 常駐を足さない)
   * ②🔴 **答えが変わったときだけ触る** ── `fitCount` が前と同じなら
   * **1 バイトも書かない**(毎フレーム描き直すと、送りも図も作り直しになる)。
   *
   * ⚠ `ResizeObserver` が無い環境(happy-dom)では**何もしない** ──
   * そこでは `measure` も `null` を返すので、畳みの判定自体が走らない。
   */
  private watch(): void {
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO === undefined) return;
    const ro = new RO(() => this.refit());
    ro.observe(this.pane);
    this.stopWatch = () => ro.disconnect();
  }

  /** 見張りを外す(test 用)。⚠ 二度呼んでも安全。 */
  stop(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  /**
   * 幅が変わったので測り直す。⚠ **答えが変わったときだけ**描き直す。
   *
   * 🔴 **これは「安さ」の門であって、輪を止めているのではない**(2026-08-30、
   * 変異試験で判明)。⚠ 1 稿目のコメントは「これが無いと、描き直しが面の高さを
   * 変え、それがまた `ResizeObserver` を鳴らす**輪**になる」と書いていたが、
   * **外しても test は 1 件も落ちなかった**(N4 / N5 が SURVIVED)── 描き直しても
   * `sync` の枠ごとの門(`frames.has(lid)` / `lids.includes(lid)`)が節点を
   * 作り直さず、`DetailRenderer` も指紋が同じなら早く返るので、**観測できる
   * 違いが 1 つも無い**。
   * ⚠ CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る。
   * 見ないなら書かない」── 見たので、書き直した。
   *
   * 🔑 **残す理由は 1 つだけ**:resize は連射で来るので、鳴るたびに枠 N 枚分の
   * renderer を歩くのは**無駄**である(`installColumnFit` が同じ理由で
   * 「同じ値なら書かない」を持っている)。⚠ 消しても壊れないので、
   * **消す日は「安さが要らなくなった」を理由にすること** ──
   * 「効いていないから」ではない。
   */
  private refit(): void {
    const state = this.lastState;
    if (state === null) return;
    const want = knownSplitLids(state.splitLids, state.entryMetas);
    const fit = this.fitCount(want.length + 1);
    if (fit === this.lastFit) return;
    this.render(state);
  }

  /**
   * 留めた枠を state に合わせて並べ替え、全部の枠を描く。
   *
   * ⚠ **主の枠は必ず描く** ── 留めたものが 0 件でも、ここが唯一の描き口である。
   */
  render(state: AppState): void {
    this.lastState = state;
    const want = knownSplitLids(state.splitLids, state.entryMetas);
    const fit = this.fitCount(want.length + 1);
    this.lastFit = fit;
    // ⚠ 減らすのは**後ろから**(先に留めた物が残る ── `split-frames.ts` の規約)
    /**
     * ⚠ **減らすのは後ろから** ── 先頭が一番上なので、**後に載せた物が残る**
     *   (#633 裁定②「新しく載せた物が本文のすぐ隣」)。
     * ⚠ 直す前のコメントは「先に留めた物が残る」だった ── 並びの向きを裏返したので
     *   **同じ 1 行の意味が反転している**(字を直さないと、次に読む人が逆に読む)。
     */
    const show = want.slice(0, Math.max(fit - 1, 0));
    this.sayIfDropped(want.length, show.length);
    this.sync(show);
    this.renderBand(want, show, state);
    this.main.render(state);
    for (const lid of show) this.frames.get(lid)?.renderer.render(state);
  }

  /** 器に何枠置けるか。⚠ 測れないときは**減らさない**(test で全部消えない)。 */
  private fitCount(wanted: number): number {
    if (wanted <= 1) return 1;
    const m = measure(this.pane);
    if (m === null) return wanted;
    return fittingSplitFrames(m.width, wanted, m.fontPx);
  }

  /**
   * 🔴 **数えるのは「幅で減ったぶん」だけ**(#633 段①)。
   *
   * ⚠ スタックは 20 件まで積めるが、**横に出るのはもともと 3 枠まで**である。
   *   載せた総数から引くと「17 枚畳みました」と毎回言うことになる ──
   *   それは**幅の話ではない**(帯に札で出ているので、user は失っていない)。
   * 🔑 だから**表示上限(`SPLIT_PINNED_MAX`)を上限として数える**。
   */
  private sayIfDropped(wanted: number, shown: number): void {
    const dropped = Math.min(wanted, SPLIT_PINNED_MAX) - shown;
    if (dropped === this.lastDropped) return;
    this.lastDropped = dropped;
    /**
     * 🔴 **口は共有の 1 つ**(#606)── 直す前はコンストラクタ引数で受けており、
     *   `main.ts` が渡していなかったので**製品では 1 度も出ていなかった**
     *   (test だけが自分で渡していた = CLAUDE.md §7)。
     */
    if (dropped > 0) sayFolded(`幅が足りないので、横に並べる枠を ${dropped} 枚畳みました`);
  }

  /**
   * 🔴 **スタックの帯を描く**(#633 段①。user 裁定 2026-09-02)。
   *
   * ```
   * [ 議事録 × ][ 資料 B × ][ 去年の稟議 × ]        (載せた順に左から = 上から)
   *   ↑ 横に出ている物には印(data-pkc-shown)
   * ```
   *
   * - **札を押すと一番上へ上がる**(= 本文のすぐ隣に来る)── 裁定④
   * - **× で降ろす** ── 🔴 **枠が幅で畳まれていても降ろせる**(#584 が閉じるのはここ)。
   *   ⚠ 直す前は「× 外す」が**枠の中にしか無かった**ので、狭い窓で畳まれると
   *   **外す口が画面から消えて**いた(しかも PR #649 で並びが憶えられるように
   *   なったので、開き直しても同じ行き止まりから始まる状態だった)
   * - ⚠ **何も載せていなければ器ごと置かない**(版面を 1 行も食わない)
   */
  private renderBand(
    want: readonly string[],
    show: readonly string[],
    state: AppState,
  ): void {
    if (want.length === 0) {
      this.band?.remove();
      this.band = null;
      this.bandKey = '';
      return;
    }
    const doc = this.pane.ownerDocument;
    /**
     * ⚠ **指紋で早く返る** ── 題名まで含める(改名に追随する)。
     * 🔑 含めないと、載せたノートの名前を変えても帯が古い字のまま残る。
     */
    const key = want
      .map((lid) => `${lid}\u0001${state.entryMetas.get(lid)?.title ?? ''}\u0001${show.includes(lid) ? '1' : '0'}`)
      .join('\u0002');
    if (this.band !== null && key === this.bandKey) return;
    this.bandKey = key;
    if (this.band === null) {
      const el = doc.createElement('div');
      el.setAttribute('data-pkc-region', 'stack-bar');
      // ⚠ **面の先頭へ**(器 `row` の前)── 本文の上に 1 行、が裁定②である
      this.pane.insertBefore(el, this.row);
      this.band = el;
    }
    const band = this.band;
    band.textContent = '';
    for (const lid of want) {
      const card = doc.createElement('span');
      card.setAttribute('data-pkc-field', 'stack-card');
      card.setAttribute('data-pkc-lid', lid);
      // 🔑 **いま横に出ている物には印** ── 押しても画面が変わらない札との差が読める
      if (show.includes(lid)) card.setAttribute('data-pkc-shown', '');
      const up = doc.createElement('button');
      up.type = 'button';
      up.setAttribute('data-pkc-action', 'pin-split');
      /** ⚠ 名前は `entryMetas` から引く ── 改名に追随する(保存した字を貼らない)。 */
      up.textContent = state.entryMetas.get(lid)?.title ?? '(消えたノート)';
      up.title = '一番上へ上げる(本文のすぐ隣に出ます)';
      const off = doc.createElement('button');
      off.type = 'button';
      off.setAttribute('data-pkc-action', 'unsplit-entry');
      off.textContent = '×';
      off.title = 'スタックから降ろす(ノートは消えません)';
      card.append(up, off);
      band.append(card);
    }
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
    // 🔑 字は「降ろす」へ(#633 裁定③ ── 載せる / 降ろす で対にする)
    off.textContent = '× 降ろす';
    off.title = 'スタックから降ろす(ノートは消えません)';
    /**
     * 🔴 **この枠を主で開く**(#633 段①)。
     *
     * ⚠ 直す前は、留めた枠から**その物を主で開く道が無かった** ── 一覧へ戻って
     *   同じノートを探し直すしかなく、⚠ 一覧を畳んでいる人には道が 1 本も無い。
     * 🔑 `select-entry` は身元を**自分の属性**(`data-pkc-entry`)で持つので、
     *   一覧の行と**同じ受け手**が使える(2 本目を書かない ── §7)。
     */
    const open = doc.createElement('button');
    open.type = 'button';
    open.setAttribute('data-pkc-action', 'select-entry');
    open.setAttribute('data-pkc-entry', lid);
    open.textContent = '← 左で開く';
    open.title = 'このノートを主の枠(左)で開く';
    bar.append(open, off);
    host.append(bar);
    this.row.append(host);
    return host;
  }
}
