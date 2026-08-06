/**
 * 設定の画面(P8 段④)。
 *
 * > user 指示 2026-08-03「**テーマは設定系の画面にしまってください。
 * > 普段から必要ではない**」
 *
 * 🔑 **画面**であって、かぶせる窓ではない ── 「同じものが常に同じ場所にある」
 * という業務画面の作法に従い、ほかの面と同じ場所(中央)に出す。
 *
 * ⚠ ここは**めったに来ない場所**。だから常時見える帯からは外したが、
 * 押す導線そのものは畳まない(操作の帯に「設定」を置く)。
 */
import type { AppState } from '@adapter/state/app-state';
import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
import { THEMES } from './theme';
import { EXTERNAL_IMAGE_MODES } from '@features/markdown/external-images';
import { appExternalImages, ExternalImagePolicy } from './external-images';
import { appJobMonitor, type JobMonitor } from '@adapter/platform/job-monitor';
import { ScrollMemory } from './scroll-memory';

/** 画面の書き換えを間引く間隔。⚠ **可視化がジャンクの原因になっては本末転倒**。 */
const REFRESH_MS = 400;

export class SettingsRenderer {
  private built = false;
  private jobsBody: HTMLElement | null = null;
  private logBody: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = false;
  /**
   * まだ描いていない変化がある(2026-08-05)。
   * 通知が来た時点で立ち、実際に描けたときだけ降りる。
   */
  private dirty = false;
  /** ログは 400ms ごとに描き直す ── 読んでいる位置を殺さない(P8 段⑫)。 */
  private logScroll: ScrollMemory | null = null;

  constructor(
    private readonly region: HTMLElement,
    private readonly monitor: JobMonitor = appJobMonitor,
    /** 外部画像の設定(2026-08-06)。⚠ test は自分で `new` して渡す。 */
    private readonly externalImages: ExternalImagePolicy = appExternalImages,
  ) {}

  render(state: AppState): void {
    if (this.built) {
      // 配色は user 操作でしか変わらない ── 毎 state で組み直さない
      this.syncTheme();
      this.syncExternalImages();
      // 🔴 **隠れている間に来た変化をここで拾う**(2026-08-05、user 報告)。
      //    `refresh()` は面が hidden の間は捨てるので(下の説明)、再表示のときに
      //    誰かが呼び直さないと**表とログは初回ビルドの姿で凍る**。仕事は必ず
      //    detail 面で起きる = 設定が隠れている間に起きるので、user が自然にやる
      //    順序(設定を覗く → ノートを書く → もう一度設定)では
      //    「まだ動いていません」と 2px の空ログのまま**永久に固定**され、
      //    2 件走った後も画面が嘘をつく。復旧手段はリロードだけだった。
      if (this.dirty) this.refresh();
      return;
    }
    this.built = true;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = '設定';
    this.region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'settings-body');

    /**
     * 🔑 **user 向けの設定と、開発者向けの計器を分ける**(P9 段③)。
     *
     * 前は「配色 1 つ + ワーカーの表 + ジョブのログ」が地続きに並んでいて、
     * 設定を開くと**画面のほとんどが計器**だった(実測: user が変えられるのは 1 つ)。
     * ⚠ **畳まない**(user 指示「主要な導線を畳まない」)── 見出しで区切るだけにする。
     * ⚠ 設定は**節ごとに分ける**(2026-08-06 に「外部の画像」が入って 2 つになった)。
     *   ここ「表示」は**見た目の好み**だけ ── 外へ何が伝わるかの判断は別の節に置く
     *   (同じ場所に混ぜると、配色を選ぶ気分で押される)。
     */
    const userSection = document.createElement('section');
    userSection.setAttribute('data-pkc-region', 'settings-user');
    const userHead = document.createElement('h3');
    userHead.textContent = '表示';
    userSection.append(userHead);

    const dl = document.createElement('dl');
    const dt = document.createElement('dt');
    dt.textContent = '配色';
    const dd = document.createElement('dd');
    const select = document.createElement('select');
    select.setAttribute('data-pkc-action', 'set-theme');
    select.setAttribute('data-pkc-field', 'theme-select');
    select.setAttribute('aria-label', '配色');
    for (const t of THEMES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      select.append(opt);
    }
    dd.append(select);
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      '最初は OS の設定に従います。一度選ぶと、この端末ではそちらを覚えています。';
    dd.append(note);
    dl.append(dt, dd);

    /**
     * 🔑 **版はここ**(P10)。上下の帯を撤去したので、常設で出していた
     * 「pkc3 v3.0.0」の行き先を作った ── 不具合を伝えるときに要る情報である。
     * ⚠ 開発者語(`opfs-sahpool`)は出さない ── user は「エラーか」と読む。
     *   ホバー(`title`)に残す作法は撤去前と同じ。
     */
    const vt = document.createElement('dt');
    vt.textContent = 'この版';
    const vd = document.createElement('dd');
    vd.setAttribute('data-pkc-field', 'app-version');
    vd.textContent = `${APP_ID} v${APP_VERSION}`;
    vd.title = `${APP_ID} v${APP_VERSION} (${BUILD_KIND})`;
    dl.append(vt, vd);

    userSection.append(dl);
    body.append(userSection);
    body.append(this.buildExternalImages());
    body.append(this.buildJobs());
    this.region.append(body);
    this.syncTheme();
    this.syncExternalImages();
    this.refresh();
    void state;
  }

  /**
   * 🔑 **外部の画像**(2026-08-06、user 裁定「設定で常にオン / 常に確認 /
   * 常にオフをとりましょう」)。
   *
   * ⚠ **「表示」には入れない** ── これは見た目の好みではなく、**外へ何が伝わるか**の
   *   判断である。同じ場所に混ぜると、配色を選ぶ気分で押される。
   * ⚠ 何が起きるのかを書く ── 「外部画像を許可」だけでは判断できない。
   */
  private buildExternalImages(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-external-images');
    const h = document.createElement('h3');
    h.textContent = '外部の画像';
    wrap.append(h);

    const dl = document.createElement('dl');
    const dt = document.createElement('dt');
    dt.textContent = '読み込む';
    const dd = document.createElement('dd');
    const select = document.createElement('select');
    select.setAttribute('data-pkc-action', 'set-external-images');
    select.setAttribute('data-pkc-field', 'external-images-select');
    select.setAttribute('aria-label', '外部の画像を読み込む');
    for (const m of EXTERNAL_IMAGE_MODES) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      select.append(opt);
    }
    dd.append(select);
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      '本文に書かれた外部の画像(https:// で始まるもの)と、HTML ブロックの中の画像です。' +
      '読み込むと、相手のサーバーに「この端末がいまこれを開いた」ことが伝わります。' +
      '「常に確認」ではノートごとに聞き、答えはタブを閉じるまで覚えます。' +
      '書き出した HTML に画像が入るのは「常にオン」のときだけです。';
    dd.append(note);
    dl.append(dt, dd);
    wrap.append(dl);
    return wrap;
  }

  /**
   * 🔑 **ジョブの可視化**(P8 段⑩。user 指示 2026-08-03「ジョブスケジューラーは
   * 可視化機構とセットでお願いします / ログもみたい」)。
   *
   * 見えるもの: どのワーカーが生きているか / 待ちと実行中の件数 /
   * 起動と使い捨ての回数 / 1 件あたりの中央値と最大 / 直近のログ。
   * ⚠ 本文の中身はログに出さない(**文字数だけ**)── ノートが漏れる。
   */
  private buildJobs(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'jobs');

    const h = document.createElement('h3');
    // ⚠ 見出しで「これは設定ではない」と分かるようにする(P9 段③)。
    //    ここは**読むだけの計器**で、user が変える物は 1 つも無い
    h.textContent = '処理(ワーカー)── 開発者向け';
    wrap.append(h);

    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      '重い処理は別スレッド(ワーカー)で動きます。しばらく使われないと自動で終了し、次に必要になったら作り直します。';
    wrap.append(note);

    const table = document.createElement('table');
    table.setAttribute('data-pkc-field', 'job-lanes');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['名前', '状態', '待ち', '実行中', '完了', '失敗', '起動', '中央値', '最大']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.append(th);
    }
    thead.append(hr);
    this.jobsBody = document.createElement('tbody');
    table.append(thead, this.jobsBody);
    wrap.append(table);

    const lh = document.createElement('h4');
    lh.textContent = 'ログ';
    wrap.append(lh);
    this.logBody = document.createElement('ol');
    this.logBody.setAttribute('data-pkc-field', 'job-log');
    this.logScroll = new ScrollMemory(this.logBody);
    wrap.append(this.logBody);

    // ⚠ 通知は来るたびに描かない(**間引く**)── 可視化が重さの原因になる
    this.unsubscribe?.();
    this.unsubscribe = this.monitor.subscribe(() => {
      // 🔴 **届いたことは即座に覚える**(2026-08-05)。`refresh()` の中で立てると、
      //    400ms の間引きが走る前に user が戻ってきたときに取りこぼす ──
      //    「まだ描いていない変化がある」は**通知の時点**の事実であって、
      //    間引きの都合とは別物である
      this.dirty = true;
      if (this.pending) return;
      this.pending = true;
      setTimeout(() => {
        this.pending = false;
        this.refresh();
      }, REFRESH_MS);
    });
    return wrap;
  }

  /**
   * 表とログを描き直す。⚠ 設定画面が**表示されていない**ときは何もしない。
   *
   * 🔴 `isConnected` では足りない(P8 段⑰。レビュー)── 面の切替は
   * `hidden` の付け外しだけで、DOM には**繋がったまま**である。つまり
   * かつてのガードは常に真で、**設定を一度開いたら以後ずっと 400ms ごとに
   * 隠れた面を作り直して**いた。
   */
  private refresh(): void {
    if (!this.jobsBody || !this.logBody || !this.jobsBody.isConnected) return;
    // ⚠ `offsetParent` は happy-dom で常に null なので使わない ── 面の切替が
    //    実際に触っている `hidden` を見る(`CenterRouter` の pane に付く)
    // ⚠ 隠れているなら描かない。`dirty` は**降ろさない** ── 再表示のときに
    //    `render()` が拾って追いつく(降ろすと、それが凍結の正体になる)
    if (this.region.closest('[data-pkc-view-pane][hidden]') !== null) return;
    this.dirty = false;
    const lanes = this.monitor.stats();
    this.jobsBody.textContent = '';
    if (lanes.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.setAttribute('data-pkc-field', 'jobs-empty');
      td.textContent = 'まだ動いていません';
      tr.append(td);
      this.jobsBody.append(tr);
    }
    for (const l of lanes) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-lane', l.lane);
      const cells = [
        l.lane,
        l.alive ? '動作中' : '停止中',
        String(l.queued),
        String(l.running),
        String(l.done),
        String(l.failed),
        `${l.spawns} 回(終了 ${l.kills})`,
        l.medianMs === null ? '—' : `${l.medianMs}ms`,
        l.maxMs === null ? '—' : `${l.maxMs}ms`,
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      this.jobsBody.append(tr);
    }

    // ⚠ **書き換える前に**退避 → 入れ終わってから戻す(順番が本体)
    this.logScroll?.park();
    this.logBody.textContent = '';
    const recent = this.monitor.recent(50);
    // 🔴 0 件のときに何も入れないと、器は**上下の border だけの 2px の線**になる
    //    (実測)── 「壊れている」と読まれる。表側には `jobs-empty` が在るのに
    //    ログ側だけ無かった。空状態は**言葉で**出す(min-height を足すのではなく)
    if (recent.length === 0) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-field', 'job-log-empty');
      li.textContent = 'まだ記録がありません';
      this.logBody.append(li);
    }
    for (const e of recent) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-phase', e.phase);
      const t = new Date(e.at);
      const hhmmss = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      const parts = [hhmmss, e.lane, PHASE_LABEL[e.phase]];
      if (e.id !== undefined) parts.push(`#${e.id}`);
      if (e.ms !== undefined) parts.push(`${e.ms}ms`);
      if (e.note) parts.push(e.note);
      li.textContent = parts.join(' ');
      this.logBody.append(li);
    }
    this.logScroll?.use('log');
  }

  /**
   * ⚠ **`dispose()` は置かない**(2026-08-06。user 報告 minor
   * 「`dispose()` に呼び出し元が無い」)。
   *
   * かつてここに「面を畳むときに購読を切る」`dispose()` が在ったが、**呼び出し元が
   * 1 つも無かった** ── 中央の面の切替は `hidden` の付け外しだけで、この器は
   * 作り直されないので「畳む」瞬間が存在しない。購読は
   * ① 組み立てのときに `unsubscribe?.()` で張り直す(増えない)
   * ② 間引いた `refresh()` が**隠れている間は何もしない**
   * の 2 つで足りている。**呼ばれないのに purpose を主張するメソッド**は、
   * 次に読む人に「畳めば止まる」と誤解させるので消した。
   */

  /**
   * ⚠ 画面の値を**いまの設定に合わせる**(2026-08-06)。合わせないと、
   * 設定を変えた後に別の面へ行って戻ってきたとき、選択肢が**古い値のまま**見える
   * ── そして user は「変えたのに戻っている」と読む(`syncTheme` と同じ理由)。
   */
  private syncExternalImages(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="external-images-select"]',
    );
    const cur = this.externalImages.getMode();
    if (select && select.value !== cur) select.value = cur;
  }

  /** ⚠ 画面の値を**いまの配色に合わせる**(合わせないと画面が嘘をつく)。 */
  private syncTheme(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="theme-select"]',
    );
    const cur = document.documentElement.getAttribute('data-pkc-theme');
    if (select && cur !== null && select.value !== cur) select.value = cur;
  }
}

/** ⚠ 画面に出る語は**そのまま pin される**(`tests/docs-parity.test.ts`)。 */
const PHASE_LABEL: Record<string, string> = {
  spawn: '起動',
  enqueue: '受付',
  dispatch: '送出',
  done: '完了',
  fail: '失敗',
  kill: '終了(未使用)',
  dispose: '破棄',
};
