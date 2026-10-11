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
import { canTrimCapture, trimUnavailableText } from '@features/capture/capture-trim-gate';
import { trimMarkText, trimNoteFirst } from '@features/audio/trim-text';
import { humanBytes } from '@features/human-bytes';
import type { AssetLender } from './detail';
import { appVoiceBoostRouter } from './voice-boost';
import { ASR_TRANSCRIBE_LABEL, ASR_TRANSCRIBING_LABEL } from '@features/asr/asr-text';
import { msToFrac, peakCountFor } from '@features/audio/waveform';
import { appWaveSource, type WaveProvider } from '@adapter/platform/audio/wave-source';
import { placeRange } from '../actions/wave-drag';
import { bakeWavePng } from './wave-bake';

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

/**
 * 🔴 **焼いた波形 1 枚**(#1232)。⚠ **同時に 1 つだけ**(鳴らしている行のぶん)。
 * `url` は ObjectURL ── 行が替わる / 面を閉じるときに revoke する(`dropWave`)。
 */
interface WaveBake {
  readonly lid: string;
  readonly url: string;
  readonly durationMs: number;
  /** 焼いたときの文字色。⚠ いまの色と違えば(テーマが変わった)焼き直す。 */
  readonly color: string;
}

/** 波形の場所に出す字(場所は最初から 40px 取ってあるので、絵が届いても高さは動かない)。 */
/** 説明文に足す案内(波形が出ていて、範囲がまだ無いとき)。 */
export const WAVE_TRIM_HINT = '波形をなぞっても選べます。';
const WAVE_LOADING_TEXT = '波形を作っています…';
const waveFailedText = (trimmable: boolean): string =>
  trimmable ? 'この音は波形を出せません(ボタンでは切り出せます)' : 'この音は波形を出せません';

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
   * 🔴 **切り出しの印**(#683 段②a)。⚠ **state の写し**で、ここでは決めない
   *   ── 面は 2 つ生きうるので、判定を描画器に置くと片方だけ印が付く(§7)。
   */
  private trim: AppState['captureTrim'] = null;
  /** ⚠ いま画面に出ている行(印の帯だけを差し替えるときに引く)。 */
  private shown: readonly CaptureItem[] = [];
  /** ⚠ 切り出している最中か(#683 段②a)。**state の写し**。 */
  private trimBusy = false;
  /** 🔴 文字にしている録音の lid(#772 段②)。**state の写し**(`null` = 走っていない)。 */
  private transcribeLid: string | null = null;
  /**
   * ⚠ **借りの世代**。押してから bytes が届くまでの間に別の行を押されたら、
   *   届いた側は**借りた瞬間に返す**(古い音が後から鳴らない)。
   */
  private token = 0;
  /** 🔴 焼いた波形(鳴らしている行のぶんだけ。#1232)。 */
  private wave: WaveBake | null = null;
  /** ⚠ 波形の仕事を追っている行の lid(作成中 / 焼けた / 失敗のどれか。`null` = 追っていない)。 */
  private waveLid: string | null = null;
  private waveState: 'loading' | 'ready' | 'failed' = 'loading';
  /** 🔑 仕事の世代。進めると、飛んでいる仕事の結果は全部捨てられる(A → B → A でも古い A が載らない)。 */
  private waveGen = 0;
  /** ⚠ state が「いま鳴らす」と言っている lid(古い結果を捨てる目印)。 */
  private waveWant: string | null = null;
  private readonly waveSource: WaveProvider | null;

  /**
   * @param onReady 借り終えたことを外へ知らせる口。⚠ **渡さないと器が出ない**
   *   ── 借りは非同期なので、届いた時点で誰かが `render` を呼び直す必要がある。
   */
  constructor(
    host: HTMLElement,
    assets: AssetLender | null = null,
    onReady: () => void = () => {},
    waveSource: WaveProvider | null = appWaveSource,
  ) {
    this.waveSource = waveSource;
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
    this.dropWave();
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
    // ⚠ 描く直前に写す(`row` は state を受け取らない)
    this.trim = state.captureTrim;
    this.trimBusy = state.captureTrimBusy;
    this.waveWant = state.capturePlayingLid;
    this.transcribeLid = state.captureTranscribeLid;
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
      /**
       * 🔴 **印は指紋に入れない**(#683 段②a、着地前の実ブラウザ smoke で判明)。
       *
       * ⚠ 入れると「ここから」を押すたびに**一覧を組み直す**ことになり、
       *   その中の `<audio>` も作り直される ── **聞いている音が止まって頭へ戻る**。
       *   🔴 印を付けるのは**聞きながら**する操作なので、これは動線ごと壊す
       *   (「補助的な物が主の作業を奪う」#300 と同じ形)。
       * 🔑 だから印と「切り出しています…」は、**その場所だけ差し替える**
       *   (下の `syncTrimBar`)。
       */
      shown.map((i) => `${i.lid}|${i.name}|${String(i.size ?? -1)}`).join(''),
    ].join('');
    this.shown = shown;
    if (print === this.last) {
      // ⚠ 組み直さない回でも**印は追う**(state だけ動いて画面が変わらない、を作らない)
      this.syncTrimBar();
      this.syncTranscribe();
      this.syncWave();
      return;
    }
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
    this.syncTranscribe();
    this.syncWave();
  }

  /**
   * 波形の仕事を全部畳む(焼いた ObjectURL を返す)。⚠ 別の行を鳴らす / 面を閉じる / やめる / 配色が変わる
   *   ときに必ず通る。世代を進めるので、飛んでいる仕事の結果はここ以後すべて捨てられる。
   */
  private dropWave(): void {
    if (this.wave !== null) URL.revokeObjectURL(this.wave.url);
    this.wave = null;
    this.waveLid = null;
    this.waveState = 'loading';
    this.waveGen += 1;
  }

  /** この行の波形が焼けているか(説明文の案内を出すかの判定。⚠ 失敗・作成中は false)。 */
  private waveReady(lid: string): boolean {
    return this.waveLid === lid && this.waveState === 'ready' && this.wave !== null;
  }

  /**
   * 🔴 **波形の帯を、いまの state に合わせる**(#1232)。
   *
   * ⚠ **指紋に入れない**(`syncTrimBar` と同じ理由 ── 組み直すと `<audio>` が作り直されて音が止まる)。
   * 🔑 作るのは**鳴らしている音の行 1 件だけ**。⚠ 一覧の全部を作ると、押していない録音の bytes を
   *   全部借りて復号することになる(この面の冒頭の「bytes は押したときだけ」に反する)。
   * 🔑 範囲の重ね描きは **state の印**(`captureTrim`)から置く ── ボタンで打った印もドラッグの印も同じ帯に映る。
   * 🔑 **失敗した行は、行が替わるまで作り直さない**(`waveState === 'failed'`)── 読めない音を描くたびに復号し直さない。
   * 🔑 **配色が変わったら焼き直す**(焼いたときの文字色を覚えておき、いまと違えば畳んで作り直す。
   *   画像は色を焼き込んでいるので、テーマを替えても古い色のまま残る)。
   */
  private syncWave(): void {
    const lid = this.waveWant;
    const item = lid === null ? undefined : this.shown.find((i) => i.lid === lid);
    const key = item?.kind === 'audio' ? item.assetKey : null;
    if (item === undefined || key === null || key === undefined || this.assets === null || this.waveSource === null) {
      this.dropWave();
      return;
    }
    if (this.waveLid !== null && this.waveLid !== lid) this.dropWave();
    if (this.waveState === 'ready' && this.wave !== null && this.wave.color !== this.waveColor()) this.dropWave();
    if (this.waveLid === null) this.loadWave(item, key);
    const wave = this.waveReady(item.lid) ? this.wave : null;
    for (const strip of this.host.querySelectorAll<HTMLElement>('[data-pkc-region="capture-wave"]')) {
      if (strip.getAttribute('data-pkc-capture-wave') !== lid) continue;
      // 🔑 場所は最初から取ってある(40px)── 作っている間・失敗したときは字を出し、絵が届いても高さが動かない
      const status = strip.querySelector<HTMLElement>('[data-pkc-field="capture-wave-status"]');
      if (wave === null) {
        strip.removeAttribute('data-pkc-duration-ms');
        strip.removeAttribute('data-pkc-ticks');
        // 🔑 前の絵(URL はもう返してある)・範囲・目盛りを残さない ── 壊れた画像が見えてしまう
        for (const el of [...strip.children]) if (el !== status) el.remove();
        if (status) {
          status.hidden = false;
          status.textContent =
            this.waveState === 'failed' ? waveFailedText(strip.getAttribute('data-pkc-trimmable') === '1') : WAVE_LOADING_TEXT;
        }
        continue;
      }
      if (status) status.hidden = true;
      strip.setAttribute('data-pkc-duration-ms', String(wave.durationMs));
      if (strip.querySelector('img') === null) {
        const img = document.createElement('img');
        img.setAttribute('data-pkc-field', 'capture-wave-img');
        img.alt = '';
        img.draggable = false;
        img.src = wave.url;
        strip.prepend(img);
        const range = document.createElement('div');
        range.setAttribute('data-pkc-field', 'capture-wave-range');
        range.hidden = true;
        strip.append(range);
        const label = document.createElement('span');
        label.setAttribute('data-pkc-field', 'capture-wave-label');
        label.hidden = true;
        strip.append(label);
      }
      // 文字起こしの目盛り(本文の時刻の行ごとに 1 本)。⚠ 数が同じなら触らない
      const times = item.transcriptMs ?? [];
      if (strip.getAttribute('data-pkc-ticks') !== String(times.length)) {
        for (const old of strip.querySelectorAll('[data-pkc-field="capture-wave-tick"]')) old.remove();
        for (const ms of times) {
          if (ms > wave.durationMs) continue;
          const t = document.createElement('i');
          t.setAttribute('data-pkc-field', 'capture-wave-tick');
          t.style.left = `${(msToFrac(ms, wave.durationMs) * 100).toFixed(3)}%`;
          strip.append(t);
        }
        strip.setAttribute('data-pkc-ticks', String(times.length));
      }
      const mark = this.trim !== null && this.trim.lid === lid ? this.trim : null;
      placeRange(strip, mark?.startMs ?? null, mark?.endMs ?? null, wave.durationMs);
    }
  }

  /** 焼くときの色(文字色)。⚠ テーマが変わるとこの値が変わる ── 焼いた画像の色と突き合わせる。 */
  private waveColor(): string {
    return getComputedStyle(this.host).color || '#666';
  }

  private loadWave(item: CaptureItem, assetKey: string): void {
    const lid = item.lid;
    this.waveLid = lid;
    this.waveState = 'loading';
    this.waveGen += 1;
    const gen = this.waveGen;
    /** 🔑 世代で見る(行の名前では見ない)── A → B → A と戻っても、最初の A の結果は捨てる。 */
    const live = (): boolean => gen === this.waveGen;
    const strip = [...this.host.querySelectorAll<HTMLElement>('[data-pkc-region="capture-wave"]')].find(
      (e) => e.getAttribute('data-pkc-capture-wave') === lid,
    );
    const points = peakCountFor(strip?.clientWidth || this.host.clientWidth);
    const fail = (): void => {
      if (!live()) return;
      this.waveState = 'failed';
      this.syncWave();
      this.syncWaveHint();
    };
    void (async () => {
      let url: string | null = null;
      try {
        const blob = await this.assets!.getBlob(assetKey);
        if (!live()) return;
        if (blob === null) return fail();
        const r = await this.waveSource!.load(assetKey, blob, points);
        if (!live()) return;
        if (r === null) return fail();
        const color = this.waveColor();
        url = await bakeWavePng(r.peaks, color);
        // ⚠ 焼いている間に世代が進んだら、焼いた物はその場で捨てる(URL を残さない)
        if (!live()) return;
        if (url === null) return fail();
        // 🔑 前の URL が残っていれば、置き換える前に返す(1 行につき生きている URL は常に 1 つ)
        if (this.wave !== null) URL.revokeObjectURL(this.wave.url);
        this.wave = { lid, url, durationMs: r.durationMs, color };
        url = null;
        this.waveState = 'ready';
        this.syncWave();
        // 説明文の「波形をなぞっても選べます」を出す(字だけ差し替える)
        this.syncWaveHint();
      } catch {
        // 波形は添え物 ── 出せなくても聞く・切り出すは止めない
        fail();
      } finally {
        if (url !== null) URL.revokeObjectURL(url);
      }
    })();
  }

  /**
   * 🔴 **「文字にする」の字と押せるかだけを差し替える**(#772 段②)。
   *
   * ⚠ **指紋に入れない** ── 入れると、押した瞬間(と終わった瞬間)に一覧ごと組み直され、
   *   中の `<audio>` が作り直されて**聞いている音が止まって頭へ戻る**
   *   (`syncTrimBar` と同じ理由。文字にするのは**聞きながら**でも押される)。
   * 🔑 走っている行だけ「文字にしています…」にし、**ほかの行は押せなくする**
   *   (2 本同時に走らせない ── 1.65〜3.6GB を重ねない)。
   */
  private syncTranscribe(): void {
    for (const b of this.host.querySelectorAll<HTMLButtonElement>('[data-pkc-field="capture-transcribe"]')) {
      const lid = b.getAttribute('data-pkc-entry');
      const mine = this.transcribeLid !== null && lid === this.transcribeLid;
      b.textContent = mine ? ASR_TRANSCRIBING_LABEL : ASR_TRANSCRIBE_LABEL;
      b.disabled = this.transcribeLid !== null;
      b.title = mine
        ? 'いま文字にしています。終わるまでお待ちください。'
        : this.transcribeLid !== null
          ? 'いま別の録音を文字にしています。終わってから押してください。'
          : '録った音を、この端末の中だけで文字にして、このノートの末尾に足します。';
    }
  }

  /**
   * ⚠ **「まだ」と「駄目だった」を区別する**(`contacts.ts` と同じ理由)──
   *   区別しないと「集めています…」で**永久に止まって見える**。
   */
  private noteText(state: AppState, shown: number): string {
    if (state.captureScanFailed)
      return '音と動画を集められませんでした(開き直すと試し直します)';
    if (state.captureItems === null) return '音と動画を集めています…';
    if (state.captureItems.length === 0)
      return '音と動画はまだありません。左下の「録音」か「画面録画」で録ると、ここに並びます。';
    if (shown === 0) return '絞り込みに一致するものがありません';
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

  /**
   * 🔴 **前後を削る口**(#683 段②a。user 裁定 2026-09-14)。
   *
   * 聞きながら「ここから」「ここまで」を押す → 「切り出す」で**新しい録音が 1 件増える**。
   * ⚠ **元は残る**(裁定)。
   *
   * ## ⚠ 出す / 出さないの決まり
   *
   * | | |
   * |---|---|
   * | 切り出せない形 | **口を出さず、理由を 1 行**(押しても断るだけの口を作らない) |
   * | 印が片方だけ | 「切り出す」を**出さない** ── 押しても範囲が決まらない |
   * | 動画 | 音と同じ(映像が VP8 の webm だけ。他は理由を 1 行) |
   */
  /**
   * 🔴 **印の帯だけを差し替える**(#683 段②a)。
   *
   * ⚠ 一覧ごと組み直すと `<audio>` が作り直され、**聞いている音が止まる** ──
   *   印は「聞きながら」押すものなので、それでは動線が成り立たない。
   * 🔑 だから**その 1 か所の中身だけ**を捨てて組み直す(器は触らない)。
   */
  private syncTrimBar(): void {
    const lid = this.playing?.lid ?? null;
    for (const bar of this.host.querySelectorAll<HTMLElement>('[data-pkc-region="capture-trim-bar"]')) {
      const row = bar.closest('[data-pkc-capture]');
      const rowLid = row?.getAttribute('data-pkc-capture') ?? null;
      if (rowLid === null) continue;
      const item = this.shown.find((i) => i.lid === rowLid);
      bar.textContent = '';
      // ⚠ 鳴らしていない行には 1 つも出さない(押しても時刻が無い)
      if (item === undefined || rowLid !== lid) continue;
      this.fillTrimBar(bar, item);
    }
  }

  private trimControls(li: HTMLLIElement, item: CaptureItem): void {
    if (!canTrimCapture(item)) {
      const why = trimUnavailableText(item);
      if (why === null) return;
      const note = document.createElement('span');
      note.setAttribute('data-pkc-field', 'capture-trim-note');
      note.textContent = why;
      li.append(note);
      return;
    }
    /**
     * 🔑 **帯を 1 つの器にまとめる** ── 印が動いたら**この中だけ**を捨てて組み直す
     *   (`syncTrimBar`)。⚠ 一覧ごと組み直すと `<audio>` が作り直され、
     *   **聞いている音が止まって頭へ戻る**。
     */
    const bar = document.createElement('span');
    bar.setAttribute('data-pkc-region', 'capture-trim-bar');
    this.fillTrimBar(bar, item);
    li.append(bar);
  }

  /** 説明文の字。⚠ 波形の案内は帯を組み直さず字だけ差し替える(`syncWaveHint`)── 押そうとしている部品を作り替えない。 */
  private trimAboutText(item: CaptureItem, startMs: number | null, endMs: number | null): string {
    return (
      trimMarkText(startMs, endMs, item.kind) +
      (item.kind === 'audio' && startMs === null && endMs === null && this.waveReady(item.lid) ? WAVE_TRIM_HINT : '')
    );
  }

  /**
   * 🔴 波形が焼けた / 作れなかったとき、説明文の**字だけ**を差し替える(帯は組み直さない)。
   * ⚠ 組み直すと「ここを始まりにする」などの部品が作り替わり、押そうとした瞬間に別物になる(実ブラウザ smoke が拾った)。
   */
  private syncWaveHint(): void {
    const lid = this.playing?.lid ?? null;
    if (lid === null) return;
    const item = this.shown.find((i) => i.lid === lid);
    if (item === undefined) return;
    for (const about of this.host.querySelectorAll<HTMLElement>('[data-pkc-capture] [data-pkc-field="capture-trim"]')) {
      if (about.closest('[data-pkc-capture]')?.getAttribute('data-pkc-capture') !== lid) continue;
      about.textContent = this.trimAboutText(item, this.trim?.startMs ?? null, this.trim?.endMs ?? null);
    }
  }

  /** 帯の中身(印の 2 つ・切り出す・印を消す・いまの印の字)。 */
  private fillTrimBar(bar: HTMLElement, item: CaptureItem): void {
    if (!canTrimCapture(item)) return;
    const startMs = this.trim?.startMs ?? null;
    const endMs = this.trim?.endMs ?? null;
    /**
     * 🔴 **説明文の位置**(#683 の裁定 C)。目印が 1 つも無いときは**前**(最初に読む物)、
     *   付けたら**ボタンの後ろ**(作業が始まったら操作が前)。
     * 🔑 帯は印が動くたびに `syncTrimBar` が**中身ごと組み直す**ので、位置もここで決まれば
     *   印を外して 0 に戻ったとき、また前へ来る(双方向)。
     */
    const about = document.createElement('span');
    about.setAttribute('data-pkc-field', 'capture-trim');
    /**
     * 🔑 波形が出ていて、まだ範囲が無いときだけ「なぞっても選べます」を足す(出せなかったときは言わない ──
     *   無い物を指す案内にしない)。帯は `syncTrimBar` が組み直すので、波形が焼けた / 失敗したときに追って変わる。
     */
    about.textContent = this.trimAboutText(item, startMs, endMs);
    if (trimNoteFirst(startMs, endMs)) bar.append(about);
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.setAttribute('data-pkc-action', 'capture-trim-start');
    mark.setAttribute('data-pkc-field', 'capture-trim-start');
    mark.textContent = 'ここを始まりにする';
    /**
     * ⚠ **走っている間は印も打たせない**(着地前レビュー 2-C)── 打てても、
     *   走っている物が終わった瞬間に `CLEAR_CAPTURE_TRIM` で**打ち直した印ごと消える**。
     */
    mark.disabled = this.trimBusy;
    mark.title =
      item.kind === 'video' ? 'いま見ている所を、切り出しの始まりにします。' : 'いま鳴っている所を、切り出しの始まりにします。';
    bar.append(mark);

    const until = document.createElement('button');
    until.type = 'button';
    until.setAttribute('data-pkc-action', 'capture-trim-end');
    until.setAttribute('data-pkc-field', 'capture-trim-end');
    until.textContent = 'ここを終わりにする';
    until.disabled = this.trimBusy;
    until.title =
      item.kind === 'video' ? 'いま見ている所を、切り出しの終わりにします。' : 'いま鳴っている所を、切り出しの終わりにします。';
    bar.append(until);

    if (startMs !== null && endMs !== null) {
      /**
       * 🔴 **走っている間は、押した所で分かるようにする**(着地前の動線レビュー 欠陥 3)。
       * ⚠ 長い録音は数秒かかる ── ボタンが何も言わないと「効かなかった」と読まれ、
       *   もう一度押される。⚠ `disabled` にする(見た目だけ変えて押せるままにしない)。
       */
      const run = document.createElement('button');
      run.type = 'button';
      run.setAttribute('data-pkc-action', 'capture-trim-run');
      run.setAttribute('data-pkc-field', 'capture-trim-run');
      run.textContent = this.trimBusy ? 'この範囲を切り出しています…' : 'この範囲で切り出す';
      run.disabled = this.trimBusy;
      run.title = this.trimBusy
        ? 'いま切り出しています。終わるまでお待ちください。'
        : item.kind === 'video'
          ? 'この範囲だけを新しい動画として保存します(元はそのまま残ります)。'
          : 'この範囲だけを新しい録音として保存します(元はそのまま残ります)。';
      bar.append(run);

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.setAttribute('data-pkc-action', 'capture-trim-clear');
      clear.setAttribute('data-pkc-field', 'capture-trim-clear');
      clear.textContent = '選んだ範囲を消す';
      // ⚠ 走っている間は印を消させない ── 消しても走っている物は止まらないので、
      //   「消したのに増えた」という読めない結果になる
      clear.disabled = this.trimBusy;
      clear.title = '「ここを始まりにする」「ここを終わりにする」で選んだ範囲を消します。';
      bar.append(clear);
    }

    if (!trimNoteFirst(startMs, endMs)) bar.append(about);
  }

  /**
   * 🔴 **波形の帯の器**(#1232)。中身(画像・範囲・目盛り)は波形が焼けたら `syncWave` が入れる ──
   * 焼けるまで(読めない音は最後まで)は `hidden` で、場所を取らない。
   * ⚠ ドラッグの受け手は `wave-drag.ts`(ここは `data-pkc-*` を置くだけ)。
   */
  private waveStrip(item: CaptureItem): HTMLElement {
    const strip = document.createElement('div');
    strip.setAttribute('data-pkc-region', 'capture-wave');
    strip.setAttribute('data-pkc-capture-wave', item.lid);
    strip.setAttribute('data-pkc-trimmable', canTrimCapture(item) ? '1' : '0');
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', '波形');
    strip.title =
      (canTrimCapture(item)
        ? '波形です。ドラッグすると切り出す範囲を選べます。押すとその位置から再生します。'
        : '波形です。押すとその位置から再生します。') +
      ((item.transcriptMs ?? []).length > 0 ? '下の小さい線は文字起こしの時刻です。' : '');
    // 🔑 場所は最初から取る(CSS の高さ 40px)── 作っている間は字、焼けたら絵に替わる
    const status = document.createElement('span');
    status.setAttribute('data-pkc-field', 'capture-wave-status');
    status.textContent = WAVE_LOADING_TEXT;
    strip.append(status);
    return strip;
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
    open.title = 'このノートを開きます(名前の変更と削除は開いた先でできます)。';
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
        /**
         * 🔑 **本文の再生機と同じ扱いにする**(#772 段① B)。
         * 🔴 **ここを落とすと、いちばん聞く所だけ整わない** ── 録ったものを
         *   聞くのは普通この面であって、本文に貼った後ではない。
         */
        appVoiceBoostRouter.watch(media);
        if (item.kind === 'audio' && this.waveSource !== null) li.append(this.waveStrip(item));
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.setAttribute('data-pkc-action', 'capture-stop');
        stop.setAttribute('data-pkc-field', 'capture-stop');
        stop.textContent = '再生をやめる';
        stop.title = '再生をやめて、いま使っているメモリを返します。';
        li.append(stop);
        this.trimControls(li, item);
      } else {
        const play = document.createElement('button');
        play.type = 'button';
        play.setAttribute('data-pkc-action', 'capture-play');
        play.setAttribute('data-pkc-entry', item.lid);
        play.setAttribute('data-pkc-field', 'capture-play');
        play.textContent = item.kind === 'audio' ? '音を聞く' : '動画を見る';
        if (item.kind === 'audio' && this.waveSource !== null)
          play.title = canTrimCapture(item)
            ? '聞くと、下に波形が出ます。波形をなぞると切り出す範囲を選べます。'
            : '聞くと、下に波形が出ます。';
        li.append(play);
      }
    }
    /**
     * 🔴 **文字にする**(#772 段②。裁定 2026-10-01 ② = 「聞く」「切り出す」と同じ並び)。
     * ⚠ **中身が分からない添付には出さない**(`assetKey` が無い行は押しても何も起きない)。
     * ⚠ 部品が無くても**出す** ── 押すと「システム → 保存領域 → 音声認識 で取り込んでください」と
     *   案内する(出さないと、機能があることが分からない)。
     */
    if (item.assetKey !== null) {
      const t = document.createElement('button');
      t.type = 'button';
      t.setAttribute('data-pkc-action', 'capture-transcribe');
      t.setAttribute('data-pkc-entry', item.lid);
      t.setAttribute('data-pkc-field', 'capture-transcribe');
      t.textContent = ASR_TRANSCRIBE_LABEL;
      li.append(t);
    }
    return li;
  }
}
