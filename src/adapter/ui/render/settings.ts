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
import { THEMES } from './theme';
import { PAGE_FORMATS } from '@features/page-format';
import { currentPageFormat } from './page-format';
import { EDITOR_MODES } from '@features/editor-mode';
import { appEditorMode, EditorModeStore } from './editor-mode';
import { EXTERNAL_IMAGE_MODES } from '@features/markdown/external-images';
import { appExternalImages, ExternalImagePolicy } from './external-images';
import { appJobMonitor, type JobMonitor } from '@adapter/platform/job-monitor';
import { appNoticeStore, type NoticeStore } from '@adapter/platform/notice-store';
import { ScrollMemory } from './scroll-memory';
import { buildOfficePackPanel, type OfficePackPanel } from './office-pack-panel';
import { buildSettingsCommands } from './commands';

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
  /** Office 一式の節(#88 / O6-a)。⚠ 器と同じ寿命 ── 自分で変化を購読する。 */
  private officePack: OfficePackPanel | null = null;

  constructor(
    private readonly region: HTMLElement,
    private readonly monitor: JobMonitor = appJobMonitor,
    /** 外部画像の設定(2026-08-06)。⚠ test は自分で `new` して渡す。 */
    private readonly externalImages: ExternalImagePolicy = appExternalImages,
    /**
     * お知らせを出すか(P11 段⑤)。⚠ **戻し道はここ 1 か所**である ──
     * 帯の「今後は出さない」を押した user が復帰できる唯一の場所なので、
     * `tests/adapter/announce.test.ts` がこの往復を守る。
     */
    private readonly notices: NoticeStore = appNoticeStore,
    /** 編集の仕方(#104 第 2 弾)。⚠ test は自分で `new` して渡す。 */
    private readonly editorMode: EditorModeStore = appEditorMode,
  ) {}

  render(state: AppState): void {
    if (this.built) {
      // 配色は user 操作でしか変わらない ── 毎 state で組み直さない
      this.syncTheme();
      this.syncPageFormat();
      this.syncEditorMode();
      this.syncExternalImages();
      this.syncNotices();
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
     * 📄 **紙面**(2026-08-08、user 裁定「読み幅は A4 と A3、フル HD と 4:3 の
     * 縦横を選べるようにし、デフォは A4 縦」)。
     *
     * ⚠ **flag ではない**(正規設定)── 恒久の user 設定で、畳む予定が無い。
     * ⚠ ここ「表示」に置く ── **見た目の好み**であって、外へ何が伝わるかの
     *   判断(外部の画像)とは別の節である。
     */
    const pt = document.createElement('dt');
    pt.textContent = '紙面';
    const pd = document.createElement('dd');
    const pselect = document.createElement('select');
    pselect.setAttribute('data-pkc-action', 'set-page-format');
    pselect.setAttribute('data-pkc-field', 'page-format-select');
    pselect.setAttribute('aria-label', '紙面');
    for (const f of PAGE_FORMATS) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.label;
      pselect.append(opt);
    }
    pd.append(pselect);
    const pnote = document.createElement('p');
    pnote.setAttribute('data-pkc-field', 'settings-note');
    // ⚠ **何が変わるのか**を書く ── 「紙面」だけでは、画面の話か紙の話か分からない
    pnote.textContent =
      '本文の読み幅と、印刷したときの紙の大きさが決まります。既定は A4 縦です。' +
      'フル HD を選ぶと読み幅の上限が外れ、画面の幅いっぱいまで広がります。' +
      '表・図・コードはどの紙面でも幅いっぱいのままです。' +
      '書き出した HTML には、書き出したときの紙面が焼かれます。';
    pd.append(pnote);
    dl.append(pt, pd);

    /**
     * ✏️ **編集の仕方**(#104 第 2 弾。user 裁定 2026-08-08「既定でONかつ
     * 設定で2ペイン編集はできるようにする」)。
     * ⚠ **flag ではない**(正規設定)── flag `editor.live` はここへ昇格して退役した。
     * ⚠ ここ「表示」に置く ── 見た目と書き方の好みで、外へ何が伝わるかの判断ではない。
     */
    const et = document.createElement('dt');
    et.textContent = '編集の仕方';
    const ed = document.createElement('dd');
    const eselect = document.createElement('select');
    eselect.setAttribute('data-pkc-action', 'set-editor-mode');
    eselect.setAttribute('data-pkc-field', 'editor-mode-select');
    eselect.setAttribute('aria-label', '編集の仕方');
    for (const m of EDITOR_MODES) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      eselect.append(opt);
    }
    ed.append(eselect);
    const enote = document.createElement('p');
    enote.setAttribute('data-pkc-field', 'settings-note');
    // ⚠ **いつ効くか**を書く ── 書かないと「押したのに変わらない」に見える
    enote.textContent =
      '押した行だけが原文になる 1 面の編集(ライブ)が最初の設定です。' +
      '2 ペインは左に原文、右にプレビューが並びます。' +
      '切り替えは、次に編集を開いたときから効きます。';
    ed.append(enote);
    dl.append(et, ed);

    /**
     * 📣 **お知らせを出すか**(P11 段⑤)。
     *
     * 🔑 **ここが「今後は出さない」の戻し道である。** 帯にしか導線が無いと、
     * 一度消した user は二度と戻せない ── 「戻せない導線は作らない」。
     * ⚠ **flag ではない**(正規設定)。開放先は user で、畳む予定も無い。
     */
    const nt = document.createElement('dt');
    nt.textContent = 'お知らせ';
    const nd = document.createElement('dd');
    const nlabel = document.createElement('label');
    const ncheck = document.createElement('input');
    ncheck.type = 'checkbox';
    ncheck.setAttribute('data-pkc-action', 'set-notices-enabled');
    ncheck.setAttribute('data-pkc-field', 'notices-enabled');
    nlabel.append(ncheck, document.createTextNode(' 起動したときに新しいお知らせを出す'));
    nd.append(nlabel);
    const nnote = document.createElement('p');
    nnote.setAttribute('data-pkc-field', 'settings-note');
    nnote.textContent = '出さなくても、過去のお知らせはヘルプからいつでも読めます。';
    nd.append(nnote);
    dl.append(nt, nd);

    /**
     * 🔴 **版はヘルプへ移した**(P11)。
     *
     * P10 では上下の帯の撤去先としてここに置いたが、設定は「**あなたが選ぶもの**」の
     * 場所であり、版は選べない ── ヘルプ(困ったときに見る場所)の持ち物である。
     * ⚠ **2 か所に出さない**。同じ値を 2 経路で描くと、片方だけ直して食い違う
     *   (CLAUDE.md「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」)。
     * ⚠ 版の組み立ては `help.ts` の `versionText()` **1 か所**にある。
     */

    userSection.append(dl);
    body.append(userSection);
    body.append(buildSettingsCommands());
    body.append(this.buildExternalImages());
    /**
     * 🔴 **Office 一式**(#88 / O6-a)。⚠ 「表示」の節に混ぜない ── 見た目の
     * 好みではなく、**この端末に 77MB を置くかどうか**という別の判断である。
     * ⚠ 器は 1 度だけ組む。状態の変化は panel 自身が購読して字だけ差し替える。
     */
    this.officePack = buildOfficePackPanel();
    body.append(this.officePack.root);
    body.append(this.buildJobs());
    this.region.append(body);
    this.syncTheme();
    this.syncPageFormat();
    this.syncEditorMode();
    this.syncExternalImages();
    this.syncNotices();
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

  /**
   * ⚠ 画面の値を**いまの編集の仕方に合わせる**(器は 1 度しか組まない ──
   * 映さないと古い値が見える。CLAUDE.md §7「設定画面の値の同期」)。
   */
  private syncEditorMode(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="editor-mode-select"]',
    );
    const cur = this.editorMode.getMode();
    if (select && select.value !== cur) select.value = cur;
  }

  /**
   * ⚠ 画面の値を**いまのお知らせ設定に合わせる**(P11)。
   * 🔴 帯の「今後は出さない」は**この画面を開かずに**設定を変える ── 映さないと、
   * 次に設定を開いたとき「出す」のまま見える(CLAUDE.md「設定画面の値の同期」)。
   */
  private syncNotices(): void {
    const box = this.region.querySelector<HTMLInputElement>('[data-pkc-field="notices-enabled"]');
    if (box) box.checked = this.notices.enabled();
  }

  /**
   * ⚠ 画面の値を**いまの紙面に合わせる**(2026-08-08)。
   * 🔴 **器は 1 度しか組まない**ので、映さないと**古い値が見える** ──
   * 起動時に保存から復元した値も、ここが呼ばれなければ選択欄は A4 縦のまま
   * (「設定したのに戻っている」と読まれる)。⚠ だから
   * `render()` の**組み立て直後と、組み済みの分岐の両方**から呼ぶ。
   */
  private syncPageFormat(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="page-format-select"]',
    );
    // ⚠ 正本は DOM(`applyPageFormat` が当てた属性)── 保存を読み直さない
    const cur = currentPageFormat(document.documentElement);
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
