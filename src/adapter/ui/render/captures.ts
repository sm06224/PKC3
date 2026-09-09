/**
 * 🔴 **録ったものの面**(#683 段①。user 要望 2026-09-03
 * 「**時間を測る・画面録画・録音も…組み込みアプリにしたい**」)。
 *
 * ## どこに在るか ── **左の列のタブ**と、**別ウィンドウの面**の 2 か所
 *
 * user 裁定 2026-09-04「**予定表も連絡先も別窓、アプリの基本は別窓**」と、
 * #300 の「**中央(本文)を退かすな**」を両方満たす置き方である
 * (CLAUDE.md「面を 1 つ足すたびに ①左に置き場 ②別窓 ③塞がれたら①へ戻す」)。
 * ⚠ だから**この描画器は同じ document に 2 つ生きうる**(左のタブ + 中央の面)──
 *   `data-pkc-region` を焼かない(器の印は器の側が持つ。`contacts.ts` と同じ)。
 *
 * ## 🔴 bytes は「押したときだけ」借りる
 *
 * ⚠ 一覧を開いただけで全部の中身を借りると、録音 20 本(数百 MB)が
 *   **常駐メモリに載る** ── 不可侵指示 2026-07-27「ゼロコピー・生成と
 *   ライフサイクル後の速やかな破棄」と正面から反する。
 * 🔑 だから **「聞く」を押した 1 件だけ**借り、**次の 1 件を押したら前を返す**。
 *   ⚠ 面を閉じるとき(`dispose`)も返す ── 返し忘れると、タブを切り替えただけで
 *   URL が残る(`mermaid-hydrate.ts` が実測で踏んだ形)。
 *
 * ## ⚠ 「録ったもの」と言い切らない
 *
 * 拾う条件は `attachment.mime` が `audio/` か `video/` なので、**外から取り込んだ
 * 音や動画も並ぶ** ── 出所は区別できない。だから面の字は「音と動画」と書き、
 * 呼び名は `captureItemLabel` が名前から見分ける。
 */
import type { AppState } from '@adapter/state/app-state';
import {
  captureItemLabel,
  visibleCaptures,
  type CaptureItem,
} from '@features/capture/capture-item';
import { humanBytes } from '@features/human-bytes';
import type { AssetLender } from './detail';

/**
 * 借りている 1 件(押した行)。⚠ **同時に 1 つだけ**。
 * 🔑 **どの行を鳴らすかは state が持つ**(`capturePlayingLid`)── ここは
 *   「いま借りている物」だけを持つ。⚠ 2 か所(左のタブ / 別窓)に同じ描画器が
 *   居るので、判定を描画器に持たせると**面ごとに別の答え**になる(§7)。
 */
interface Playing {
  readonly lid: string;
  readonly url: string;
  readonly dispose: () => void;
}

export class CapturesRenderer {
  private readonly host: HTMLElement;
  private readonly assets: AssetLender | null;
  /** 直前に描いた指紋。⚠ 同じなら触らない(押している最中に作り直さない)。 */
  private last = ' ';
  /** いま借りている 1 件。⚠ 借り換え・面を閉じるときに返す。 */
  private playing: Playing | null = null;
  /** ⚠ 借りに行っている最中の lid(同じ行で二重に借りない)。 */
  private borrowing: string | null = null;
  /**
   * ⚠ **借りの世代**。押してから bytes が届くまでの間に別の行を押されたら、
   *   届いた側は**借りた瞬間に返す**(古い音が後から鳴らない)。
   */
  private token = 0;

  /**
   * @param onReady 借り終えたことを外へ知らせる口。⚠ **渡さないと器が出ない**
   *   ── 借りは非同期なので、届いた時点で誰かが `render` を呼び直す必要がある。
   */
  constructor(
    host: HTMLElement,
    assets: AssetLender | null = null,
    onReady: () => void = () => {},
  ) {
    this.host = host;
    this.assets = assets;
    this.onReady = onReady;
  }

  private readonly onReady: () => void;

  /** ⚠ 面を捨てるときに必ず呼ぶ(借りたままにしない)。 */
  dispose(): void {
    this.token += 1;
    this.borrowing = null;
    this.playing?.dispose();
    this.playing = null;
  }

  render(state: AppState): void {
    const items = state.captureItems;
    const query = state.filterQuery;
    const shown = items === null ? [] : visibleCaptures(items, query);
    /**
     * 🔴 **借りるのは render の中**(`detail.ts` の添付と同じ作法)。
     * ⚠ 借り終えると `render` がもう一度呼ばれる(`onReady`)ので、
     *   ここで器を作るのは**届いた後**である。
     */
    this.syncBorrow(state, shown);
    /**
     * ⚠ **指紋に「失敗」を先に入れる**(`contacts.ts` の 2 巡目レビューで判明した形)
     *   ── 入れないと、初回の走査が失敗した回(`captureItems` は `null` のまま)が
     *   「まだ集めていない」と同じ指紋になり、**断り文が一度も画面に出ない**。
     */
    const print = [
      state.captureScanFailed ? 'failed' : items === null ? 'pending' : 'ok',
      query,
      // ⚠ 鳴らしている行も指紋に入れる ── 入れないと、押しても器が作り直されない
      state.capturePlayingLid ?? '',
      // ⚠ **借り終えたか**も入れる ── 借りている間は器を作り直せない(URL がまだ無い)
      this.playing?.url ?? '',
      shown.map((i) => `${i.lid}|${i.name}|${String(i.size ?? -1)}`).join(''),
    ].join('');
    if (print === this.last) return;
    this.last = print;

    this.host.textContent = '';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'captures-note');
    note.textContent = this.noteText(state, shown.length);
    this.host.append(note);
    if (shown.length === 0) {
      /**
       * 🔴 **行き止まりを作らない**(#536 ②、`contacts.ts` と同じ)──
       * 絞り込みのせいで 0 件なら、**絞りを外す道**をここに出す。
       * ⚠ 絞りが無いときは出さない(押しても何も起きない口を作らない)。
       */
      if (query !== '') {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.setAttribute('data-pkc-action', 'clear-entry-filter');
        clear.setAttribute('data-pkc-field', 'captures-clear-filter');
        clear.textContent = '絞りを外す';
        clear.title = '一覧の絞り込みを空にして、音と動画を全部出します。';
        this.host.append(clear);
      }
      return;
    }
    const list = document.createElement('ul');
    list.setAttribute('data-pkc-field', 'captures-list');
    for (const item of shown) list.append(this.row(item));
    this.host.append(list);
  }

  /**
   * ⚠ **「まだ」と「駄目だった」を区別する**(`contacts.ts` と同じ理由)──
   *   区別しないと「集めています…」で**永久に止まって見える**。
   */
  private noteText(state: AppState, shown: number): string {
    if (state.captureScanFailed)
      return '音と動画を集められませんでした(開き直すと試し直します)';
    if (state.captureItems === null) return '集めています…';
    if (state.captureItems.length === 0)
      return '音と動画はまだありません。左下の 録音 か 画面 で録ると、ここに並びます。';
    if (shown === 0) return '絞り込みに当たるものがありません';
    return `${shown} 件`;
  }

  /**
   * 🔴 **state が指す 1 件だけを借りる**(#683 段①)。
   *
   * ⚠ **返してから借りる** ── 逆にすると 2 本ぶんの bytes が重なる。
   * ⚠ **見えている行に居ないなら返す** ── 絞り込みで消えた / ノートが消えた
   *   場合も同じで、鳴りっぱなしにしない。
   * ⚠ 届くまでの間に別の行を押されたら、**借りた瞬間に返す**(世代で見る)──
   *   でないと、後から届いた古い音が鳴る。
   * 🔑 借り終えたら `onReady` で描き直しを頼む ── renderer は dispatch しない
   *   (層規約)ので、**画面を動かす合図は外から渡してもらう**。
   */
  private syncBorrow(state: AppState, shown: readonly CaptureItem[]): void {
    const want = state.capturePlayingLid;
    const item = want === null ? undefined : shown.find((i) => i.lid === want);
    const key = item?.assetKey ?? null;
    if (key === null || this.assets === null) {
      if (this.playing !== null || this.borrowing !== null) this.dispose();
      return;
    }
    if (this.playing?.lid === want || this.borrowing === want) return;
    this.token += 1;
    const mine = this.token;
    this.playing?.dispose();
    this.playing = null;
    this.borrowing = want;
    void this.assets.lend(key).then((lent) => {
      if (lent === null) {
        if (mine === this.token) this.borrowing = null;
        return;
      }
      if (mine !== this.token) {
        lent.dispose();
        return;
      }
      this.borrowing = null;
      this.playing = { lid: want!, url: lent.url, dispose: lent.dispose };
      this.onReady();
    });
  }

  private row(item: CaptureItem): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('data-pkc-capture', item.lid);

    // 🔑 名前は**そのノートを開く** ── 既存の `select-entry` を通す(開く口を増やさない)
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('data-pkc-action', 'select-entry');
    open.setAttribute('data-pkc-entry', item.lid);
    open.setAttribute('data-pkc-field', 'capture-name');
    open.textContent = item.name;
    // ⚠ **名前を直す / 消す はノートの側に在る** ── ここに 2 本目を作らない(§7)
    open.title = 'このノートを開きます(名前を直す・消すは開いた先でできます)。';
    li.append(open);

    const about = document.createElement('span');
    about.setAttribute('data-pkc-field', 'capture-about');
    const size = item.size === null ? '' : ` ${humanBytes(item.size)}`;
    about.textContent = `${captureItemLabel(item)}${size}`;
    li.append(about);

    /**
     * 🔴 **その場で聞く / 見る**。
     * ⚠ **中身が分からない添付には出さない** ── `assetKey` が無い行は
     *   押しても何も起きないので、ボタンにしない(dead click を作らない)。
     */
    if (item.assetKey !== null && this.assets !== null) {
      if (this.playing?.lid === item.lid && this.playing.url !== '') {
        const media = document.createElement(item.kind);
        media.setAttribute('data-pkc-field', 'capture-media');
        media.controls = true;
        media.autoplay = true;
        media.src = this.playing.url;
        li.append(media);
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.setAttribute('data-pkc-action', 'capture-stop');
        stop.setAttribute('data-pkc-field', 'capture-stop');
        stop.textContent = '閉じる';
        stop.title = '再生をやめて、この中身を器から返します。';
        li.append(stop);
      } else {
        const play = document.createElement('button');
        play.type = 'button';
        play.setAttribute('data-pkc-action', 'capture-play');
        play.setAttribute('data-pkc-entry', item.lid);
        play.setAttribute('data-pkc-field', 'capture-play');
        play.textContent = item.kind === 'audio' ? '聞く' : '見る';
        li.append(play);
      }
    }
    return li;
  }
}
