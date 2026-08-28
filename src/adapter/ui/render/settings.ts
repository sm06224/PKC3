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
import { SameOriginGrants } from '@adapter/platform/same-origin-grants';
import { ExtensionGrants } from '@adapter/platform/extension-grants';
import type { AppState } from '@adapter/state/app-state';
import type { PersistState } from '@adapter/platform/storage-persist';
import { THEMES } from './theme';
import { PAGE_FORMATS } from '@features/page-format';
import { currentPageFormat } from './page-format';
import { EDITOR_MODES } from '@features/editor-mode';
import { TEXT_SCALES } from '@features/text-scale';
import {
  effectiveColumns,
  minWidthForColumns,
  READ_COLUMN_CHOICES,
  readColumnsSpec,
  type ReadColumns,
} from '@features/read-columns';
import { currentTextScale } from './text-scale';
import { currentReadColumns } from './read-columns';
import { appEditorMode, EditorModeStore } from './editor-mode';
import { appOpenInEdit, OpenInEditStore } from './open-in-edit';
import { appAlarmEnabled, AlarmEnabledStore } from './alarm-enabled';
import { EXTERNAL_IMAGE_MODES } from '@features/markdown/external-images';
import { appExternalImages, ExternalImagePolicy } from './external-images';
import { PASTE_SOURCES } from '@features/markdown/paste-source';
import { appPasteSource, PasteSourceStore } from './paste-source';
import { appJobMonitor, type JobMonitor } from '@adapter/platform/job-monitor';
import { appNoticeStore, type NoticeStore } from '@adapter/platform/notice-store';
import { ScrollMemory } from './scroll-memory';
import { buildOfficePackPanel, type OfficePackPanel } from './office-pack-panel';
import { buildSettingsCommands } from './commands';
import { buildKeymapPanel, type KeymapPanel } from './keymap-panel';

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
  /**
   * ショートカットキーの節(#256)。⚠ 器と同じ寿命 ── 自分で割当の変化を購読する。
   * ⚠ 組み直しは 1 度だけ(`built`)なので、購読も capture も 1 組しか生きない。
   */
  private keymapPanel: KeymapPanel | null = null;

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
    /** 「開く」で編集に入るか(user 裁定 2026-08-18)。⚠ test は自分で `new` して渡す。 */
    private readonly openInEdit: OpenInEditStore = appOpenInEdit,
    /** 素のまま起動の許可(#301)。⚠ test は自分で `new` して渡す。 */
    private readonly sameOriginGrants: SameOriginGrants = new SameOriginGrants(),
    /** 目次を見せる許可(#195 / C-5 段①)。⚠ test は自分で `new` して渡す。 */
    private readonly extensionGrants: ExtensionGrants = new ExtensionGrants(),
    /**
     * 🔴 **貼付で読み取る形**(user 指示 2026-08-25)。
     * ⚠ **末尾に足す** ── 途中に入れると、位置引数で渡している test が
     *   **静かに別の物を受け取る**(1 稿目で実際に 12 件落とした)。
     */
    private readonly pasteSource: PasteSourceStore = appPasteSource,
    /**
     * 🔴 **予定の時刻に知らせるか**(#280)。
     * ⚠ **末尾に足す**(すぐ上の戒めのとおり)── 途中に入れると、位置引数で
     *   渡している test が**静かに別の物を受け取る**。⚠ 1 稿目で実際に
     *   途中へ入れて 2 件落とした(型が違ったので tsc が拾ったが、
     *   **同じ型どうしなら黙って通る**)。
     */
    private readonly alarmEnabled: AlarmEnabledStore = appAlarmEnabled,
  ) {}

  private sameOriginList: HTMLElement | null = null;
  private extensionList: HTMLElement | null = null;

  render(state: AppState): void {
    if (this.built) {
      // 配色は user 操作でしか変わらない ── 毎 state で組み直さない
      this.syncTheme();
      this.syncPageFormat();
      this.syncTextScale();
      this.syncReadColumns();
      this.syncEditorMode();
      this.syncOpenInEdit();
      this.syncAlarmEnabled();
      this.syncExternalImages();
      this.syncPasteSource();
      this.syncSameOrigin(state);
      this.syncExtensions(state);
      this.syncPersist(state);
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
     * 🔴 **文字の大きさ**(#504。user 指示 2026-08-28
     * 「**正直変更はユーザーに委ねて欲しい**」)。
     *
     * ⚠ **flag ではない**(正規設定)── 15 枠は 1 つも使わない。
     * ⚠ ここ「表示」に置く ── 紙面・編集の仕方と同じ「見え方の好み」である。
     * ⚠ **既定は「標準」= 現行そのまま** ── 選ばなければ見え方は変わらない。
     */
    const tt = document.createElement('dt');
    tt.textContent = '文字の大きさ';
    const td = document.createElement('dd');
    const tselect = document.createElement('select');
    tselect.setAttribute('data-pkc-action', 'set-text-scale');
    tselect.setAttribute('data-pkc-field', 'text-scale-select');
    tselect.setAttribute('aria-label', '文字の大きさ');
    for (const t of TEXT_SCALES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.label;
      tselect.append(opt);
    }
    td.append(tselect);

    /**
     * 🔴 **本文の段組み**(#505 段①。user 指示 2026-08-28)。
     *
     * ⚠ ここ「表示」に置く ── 紙面・文字の大きさと同じ「見え方の好み」である。
     * ⚠ **既定は 1 段 = 現行そのまま** ── 選ばなければ見え方は変わらない。
     */
    const ct = document.createElement('dt');
    ct.textContent = '本文の段組み';
    const cd = document.createElement('dd');
    const cselect = document.createElement('select');
    cselect.setAttribute('data-pkc-action', 'set-read-columns');
    cselect.setAttribute('data-pkc-field', 'read-columns-select');
    cselect.setAttribute('aria-label', '本文の段組み');
    for (const c of READ_COLUMN_CHOICES) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      cselect.append(opt);
    }
    cd.append(cselect);
    /**
     * 🔴 **いま実際に何段になっているかを出す**(#526。user 報告 2026-08-28
     * 「**2〜4 のどの数字を選んでもレンダリングは変わらなかった それはバグ?**」)。
     *
     * ⚠ 答えは「バグではない ── **器の幅で頭打ちになる**」で、**実装はそれを
     *   知っていた**(`columnsFit` の注記が「CSS が 2 段へ落とす」と書いている)。
     *   決まっていなかったのは **user に言うこと**だけだった。
     * 🔑 実測すると、器が **928〜1390px のあいだは 2/3/4 が全部 2 段**になる
     *   ── ごく普通の幅である。
     * ⚠ **選択肢は減らさない** ── いま狭くても、広い画面で開けば効く。
     */
    const ceff = document.createElement('p');
    ceff.setAttribute('data-pkc-field', 'read-columns-effective');
    ceff.setAttribute('data-pkc-note', 'effective');
    cd.append(ceff);
    const cnote = document.createElement('p');
    cnote.setAttribute('data-pkc-field', 'settings-note');
    // ⚠ **何が変わって、何に気をつけるか**を書く(押した後に探させない)
    cnote.textContent =
      '横に広い画面で、本文を新聞のように段へ流します。' +
      '送りが横向きになり、マウスホイールはそのまま横へ送れます。' +
      '画面の幅が足りないときは自動で 1 段に戻ります。' +
      '表と図は段の幅まで縮むので、広く見たいときは段を減らしてください。' +
      '編集に入っている間は 1 段に戻ります。';

    const tnote = document.createElement('p');
    tnote.setAttribute('data-pkc-field', 'settings-note');
    // ⚠ **何が動いて、何が動かないか**を書く(押した後に探させない)
    tnote.textContent =
      '本文と画面の字の大きさが変わります。押すとその場で効きます。' +
      '読み幅(1 行の長さ)は動かないので、大きくすると 1 行に入る字が減ります。' +
      'この端末だけの設定で、ノートの中身には入りません。';
    td.append(tnote);
    dl.append(tt, td);
    cd.append(cnote);
    dl.append(ct, cd);

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
     * 🔴 **保存が「消えない扱い」か**(#347、user 裁定 2026-08-23
     * 「**気になるから見るだけで**」)。
     *
     * ⚠ **押せるものは置かない。** ここは**知らせるだけ**である ── 帯にもダイアログにも
     * しないのが裁定で、操作の失敗ではないので user の手を止めない。
     * 🔑 だから `dd` に入るのは説明文 1 つだけ(選択欄もチェックも無い)。
     */
    const st = document.createElement('dt');
    st.textContent = 'このアプリのデータ';
    const sd = document.createElement('dd');
    const snote = document.createElement('p');
    snote.setAttribute('data-pkc-field', 'settings-note');
    snote.setAttribute('data-pkc-field-persist', 'persist-state');
    sd.append(snote);
    dl.append(st, sd);

    /**
     * 🔴 **「開く」で編集に入るか**(user 裁定 2026-08-18
     * 「**Enter は閲覧を開始、インライン編集で常に開くは設定でトグル可能にすること**」)。
     * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い。
     * ⚠ 「編集の仕方」の**すぐ下**に置く ── 同じ「編集の入り方」の話である。
     */
    const ot = document.createElement('dt');
    ot.textContent = '開いたときの状態';
    const od = document.createElement('dd');
    const olabel = document.createElement('label');
    const ocheck = document.createElement('input');
    ocheck.type = 'checkbox';
    ocheck.setAttribute('data-pkc-action', 'set-open-in-edit');
    ocheck.setAttribute('data-pkc-field', 'open-in-edit');
    olabel.append(ocheck, document.createTextNode(' 開いたら、そのまま編集に入る'));
    od.append(olabel);
    const onote = document.createElement('p');
    onote.setAttribute('data-pkc-field', 'settings-note');
    // ⚠ **どの操作に効くか**を書く ── 書かないと「行を押しても編集にならない」と読まれる
    onote.textContent =
      // ⚠ **記法を書かない** ── ここは `textContent` なので `**` がそのまま画面に出る
      //   (PKC2 が同じ失敗をしていて、`notice-log.ts` の冒頭がまさにこれを戒めている)
      '最初の設定では、フォルダの表で Enter を押すと「読む」ところから始まります。' +
      'ここを入れると、開いた時点で編集に入ります。' +
      '行を 1 回押して選んだだけでは編集に入りません(それは「選ぶ」で、「開く」ではありません)。';
    od.append(onote);
    dl.append(ot, od);

    /**
     * 🔴 **予定の時刻に知らせるか**(#280。user 指示 2026-08-19「アラートは
     * 組み込みアプリでリリースしたい」)。
     * ⚠ **既定は切** ── 音は割り込みであり、入にすると起動のたびに予定を数える。
     * ⚠ **できないことを先に書く**(#280 の本文)── 「開いている間だけ」を
     *   曖昧にすると、user は**鳴る前提で予定を任せて失う**。
     */
    const at = document.createElement('dt');
    at.textContent = '予定の知らせ';
    const ad = document.createElement('dd');
    const alabel = document.createElement('label');
    const acheck = document.createElement('input');
    acheck.type = 'checkbox';
    acheck.setAttribute('data-pkc-action', 'set-alarm-enabled');
    acheck.setAttribute('data-pkc-field', 'alarm-enabled');
    alabel.append(acheck, document.createTextNode(' 予定の時刻になったら音で知らせる'));
    ad.append(alabel);
    const anote = document.createElement('p');
    anote.setAttribute('data-pkc-field', 'settings-note');
    anote.textContent =
      '本文の行に時刻まで書いた予定(- [ ] 打ち合わせ @2026-08-27 14:00)が対象です。' +
      '時間になると短い音が鳴り、画面の下に帯が出ます。押すとそのノートを開きます。' +
      'PKC を開いている間だけ鳴ります ── 閉じている間は鳴りません(ブラウザでは' +
      '閉じたページを時刻で起こすことができないためです)。' +
      'ここを入れると、起動したときに予定を数えます(切のままなら数えません)。';
    ad.append(anote);
    dl.append(at, ad);

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
    /**
     * ⌨ **ショートカットキー**(user 指示 2026-08-18)。⚠ 「表示」の節に混ぜない ──
     * 見た目の好みではなく**操作の割当**である。⚠ 一覧は `KEY_COMMANDS` から出す
     * (PKC2 はここを手書きにしてズレた)。
     */
    this.keymapPanel?.dispose();
    this.keymapPanel = buildKeymapPanel();
    body.append(this.keymapPanel.root);
    body.append(this.buildExternalImages());
    body.append(this.buildPasteSource());
    body.append(this.buildSameOrigin());
    body.append(this.buildExtensions());
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
    this.syncTextScale();
    this.syncReadColumns();
    this.syncEditorMode();
    this.syncOpenInEdit();
    this.syncAlarmEnabled();
    this.syncSameOrigin(state);
    this.syncExtensions(state);
    this.syncPersist(state);
    this.syncExternalImages();
    this.syncPasteSource();
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
  /**
   * 🔴 **素のまま起動を許したアプリの一覧**(#301。user 裁定 2026-08-21)。
   *
   * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
   * > (文字通りの永続化、期間とかない)**」
   *
   * ⚠ **期限が無い以上、取り消す場所が要る。** 永続化そのものは user の裁定だが、
   *   「一度許したら二度と外せない」は裁定に含まれていない ── 出口を作る。
   * ⚠ 一覧に**限界も併記する** ── 素のままのアプリはこの一覧自体を書き換えられる。
   *   隠すと「一覧があるから安全」と読まれるので、**実際より安全に見せない**
   *   (`same-origin-grants.ts` 冒頭の判断と同じ向き)。
   * ⚠ 「表示」には入れない ── 見た目の好みではなく**外へ何を渡すか**の判断である。
   */
  private buildSameOrigin(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-same-origin');
    const h = document.createElement('h3');
    h.textContent = '素のまま起動を許したアプリ';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      'ここに載っているアプリは、ノート・添付・設定を全部読み書きできます。' +
      '中身が 1 バイトでも変われば許可は外れ、次に開くときまた聞きます。' +
      '⚠ これらのアプリは、この一覧そのものも書き換えられます' +
      '(同じ場所で動くので、どこに保存しても届きます)。';
    this.sameOriginList = document.createElement('ul');
    this.sameOriginList.setAttribute('data-pkc-field', 'same-origin-list');
    wrap.append(h, note, this.sameOriginList);
    return wrap;
  }

  /**
   * ⚠ **毎回組み直す** ── 許可はこの面の外(添付の起動)で増えるので、
   *   「開いている間に変わらない」という前提が成り立たない(P8 段⑩ と同じ理由で、
   *   隠れている間の変化を取りこぼすと**画面が嘘をつく**)。
   */
  private syncSameOrigin(state: AppState): void {
    const list = this.sameOriginList;
    if (!list) return;
    const keys = this.sameOriginGrants.list();
    list.textContent = '';
    if (keys.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'まだ許可したアプリはありません';
      list.append(li);
      return;
    }
    for (const key of keys) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-asset-key', key);
      const name = document.createElement('span');
      // ⚠ 題名は**いま並んでいるタイル**から引く ── 引けないものは消えた / 登録を
      //    外した添付なので、**鍵の頭だけ**を出す(空欄にすると取り消しようがない)
      const tile = state.launcherTiles?.find((t) => t.assetKey === key);
      name.textContent = tile?.title ?? `(一覧に無いアプリ ${key.slice(4, 12)}…)`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', 'revoke-same-origin');
      btn.setAttribute('data-pkc-asset-key', key);
      btn.textContent = '取り消す';
      li.append(name, btn);
      list.append(li);
    }
  }

  /**
   * 🔴 **目次を見せる許可の一覧**(#195 / C-5 段①)。
   *
   * ⚠ 素のまま起動の隣に、**別の一覧として**置く ── 台帳が別なので、片方を
   *   消してももう片方は残る。1 つの一覧に混ぜると「どちらを取り消したのか」が
   *   user から見えなくなる。
   * 🔑 ここが**取り消しの唯一の出口**である ── 許可は期限なしで憶えるので、
   *   出口が無いと二度と外せない。
   */
  private buildExtensions(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-extensions');
    const h = document.createElement('h3');
    h.textContent = '目次を見せているアプリ';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    // ⚠ **見えるものを書く**(「projection を渡す」では判断できない)
    note.textContent =
      'ここに載っているアプリは、ノートの題名・種類・日付・印の一覧を読めます。' +
      '本文と添付は渡りません。' +
      '中身が 1 バイトでも変われば許可は外れ、次に開くときまた聞きます。';
    this.extensionList = document.createElement('ul');
    this.extensionList.setAttribute('data-pkc-field', 'extension-list');
    wrap.append(h, note, this.extensionList);
    return wrap;
  }

  /** ⚠ **毎回組み直す**(許可はこの面の外で増える ── `syncSameOrigin` と同じ理由)。 */
  private syncExtensions(state: AppState): void {
    const list = this.extensionList;
    if (!list) return;
    const keys = this.extensionGrants.list();
    list.textContent = '';
    if (keys.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'まだ目次を見せているアプリはありません';
      list.append(li);
      return;
    }
    for (const key of keys) {
      const li = document.createElement('li');
      li.setAttribute('data-pkc-asset-key', key);
      const name = document.createElement('span');
      // ⚠ 題名は**いま並んでいるタイル**から引く(`syncSameOrigin` と同じ作法)
      const tile = state.launcherTiles?.find((t) => t.assetKey === key);
      name.textContent = tile?.title ?? `(一覧に無いアプリ ${key.slice(4, 12)}…)`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-pkc-action', 'revoke-extension');
      btn.setAttribute('data-pkc-asset-key', key);
      btn.textContent = '取り消す';
      li.append(name, btn);
      list.append(li);
    }
  }

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
   * 🔴 **貼付でどの形を読むか**(user 指示 2026-08-25)。
   *
   * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
   * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
   *
   * 🔑 **診断のフラグ(`paste.inspect`)と対**である ── そちらを点けると
   * 「何が届いて、どれを使ったか」が画面に出るので、**どれに切り替えればよいかが分かる**。
   */
  private buildPasteSource(): HTMLElement {
    const wrap = document.createElement('section');
    wrap.setAttribute('data-pkc-region', 'settings-paste-source');
    const h = document.createElement('h3');
    h.textContent = '貼り付け';
    wrap.append(h);

    const dl = document.createElement('dl');
    const dt = document.createElement('dt');
    dt.textContent = '読み取る形';
    const dd = document.createElement('dd');
    const select = document.createElement('select');
    select.setAttribute('data-pkc-action', 'set-paste-source');
    select.setAttribute('data-pkc-field', 'paste-source-select');
    select.setAttribute('aria-label', '貼り付けで読み取る形');
    for (const m of PASTE_SOURCES) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      opt.title = m.hint;
      select.append(opt);
    }
    dd.append(select);
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'settings-note');
    note.textContent =
      'コピーすると、同じ内容が複数の形(ウェブページの形 / リッチテキスト / ただの文字)で' +
      '持ち回られます。どれが正確かは相手のアプリによって違うので、崩れるときは切り替えてください。' +
      'フラグの「貼り付けたとき、何が届いてどれを使ったかを画面に出す」を点けると、' +
      '実際に何が届いたかが見えます(中身は出しません)。';
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
   * ⚠ 画面の値を**いまの設定に合わせる**(器は 1 度しか組まない ── 映さないと
   * 古い値が見える。CLAUDE.md §7「設定画面の値の同期」)。
   */
  private syncPasteSource(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="paste-source-select"]',
    );
    const cur = this.pasteSource.get();
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
  /**
   * ⚠ 画面の値を**いまの設定に合わせる**(器は 1 度しか組まない ── 映さないと
   * 古い値が見える。CLAUDE.md §7「設定画面の値の同期」)。
   */
  private syncOpenInEdit(): void {
    const box = this.region.querySelector<HTMLInputElement>('[data-pkc-field="open-in-edit"]');
    if (box) box.checked = this.openInEdit.enabled();
  }

  private syncAlarmEnabled(): void {
    const box = this.region.querySelector<HTMLInputElement>('[data-pkc-field="alarm-enabled"]');
    if (box) box.checked = this.alarmEnabled.enabled();
  }

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

  /**
   * ⚠ 画面の値を**いまの大きさに合わせる**(#504)。器は 1 度しか組まないので、
   *   映さないと**別の面へ行って戻ると古い値が見える**(§7 の「設定画面の値の同期」)。
   * ⚠ 正本は DOM(`applyTextScale` が当てた属性)── 保存を読み直さない。
   */
  private syncTextScale(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="text-scale-select"]',
    );
    const cur = currentTextScale(document.documentElement);
    if (select && select.value !== cur) select.value = cur;
  }

  /**
   * ⚠ 画面の値を**いまの段数に合わせる**(#505)。器は 1 度しか組まないので、
   *   映さないと**別の面へ行って戻ると古い値が見える**(§7)。
   * ⚠ 正本は DOM(`applyReadColumns` が当てた属性)── 保存を読み直さない。
   */
  private syncReadColumns(): void {
    const select = this.region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="read-columns-select"]',
    );
    const cur = currentReadColumns(document.documentElement);
    if (select && select.value !== cur) select.value = cur;
    this.syncColumnsEffective(cur);
  }

  /**
   * 🔴 **「いま何段か」を画面の字にする**(#526)。
   *
   * ⚠ **器を実測して決める** ── 選んだ数ではなく、**CSS が実際に作る数**である。
   *   採寸できない環境(happy-dom / 面が畳まれている)では**何も言わない**
   *   ── 嘘を書くより黙るほうがよい。
   */
  private syncColumnsEffective(chosen: ReadColumns): void {
    const el = this.region.querySelector<HTMLElement>('[data-pkc-field="read-columns-effective"]');
    if (!el) return;
    const host = document.querySelector<HTMLElement>('[data-pkc-field="detail-body"]');
    const width = host?.getBoundingClientRect().width ?? 0;
    const fontPx = host === null ? 0 : Number.parseFloat(getComputedStyle(host).fontSize);
    const count = readColumnsSpec(chosen).count;
    if (width <= 0 || !Number.isFinite(fontPx) || fontPx <= 0) {
      el.textContent = '';
      return;
    }
    const eff = effectiveColumns(width, count, fontPx);
    if (count <= 1) {
      el.textContent = '';
      return;
    }
    if (eff === count) {
      el.textContent = `いまの画面では ${eff} 段で出ています。`;
      return;
    }
    if (eff <= 1) {
      el.textContent =
        `いまの画面は段組みに足りないので、ふつうの縦送りで出ています` +
        `(${count} 段には ${Math.ceil(minWidthForColumns(2, fontPx))}px 以上の幅が要ります)。`;
      return;
    }
    el.textContent =
      `いまの画面では ${eff} 段で出ています` +
      `(${count} 段には ${Math.ceil(minWidthForColumns(count, fontPx))}px 以上の幅が要ります)。`;
  }

  /**
   * ⚠ 保存の状態を映す(#347)。🔴 **器は 1 度しか組まない**ので、映さないと
   * **起動直後の「まだ確かめていません」で凍る** ── 最初の保存で分かった後も
   * 画面だけ古いままになる(この repo が何度も踏んでいる形)。
   */
  private syncPersist(state: AppState): void {
    const el = this.region.querySelector<HTMLElement>('[data-pkc-field-persist="persist-state"]');
    if (!el) return;
    const text = PERSIST_TEXT[state.persistState];
    if (el.textContent !== text) el.textContent = text;
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

/**
 * 🔴 **保存の状態を、user の言葉で書く**(#347、user 指示 2026-08-21
 * 「画面で何が起きるかで書く」)。
 *
 * 🔑 **`denied` / `unsupported` は「次の手」まで書く** ── 「消えることがあります」
 * だけだと、user は不安になるだけで**何もできない**。効く手は
 * 「**ホーム画面(デスクトップ)に追加する**」である(入れると多くのブラウザが
 * 自動で消さない扱いにする)。
 * ⚠ `unknown` を「断られました」と書かない ── **まだ頼んでいない**のであって、
 * 断られたのではない(起動直後は必ずここを通る)。
 */
const PERSIST_TEXT: Record<PersistState, string> = {
  persisted: 'このブラウザは、このアプリのデータを消さない扱いにしています。',
  denied:
    '空き容量が足りなくなると、このブラウザがデータを消すことがあります。' +
    'ホーム画面(デスクトップ)に追加すると、消さない扱いになることがあります。' +
    'バックアップは「書き出しと片づけ」から取れます。',
  unsupported:
    'このブラウザは、消さない扱いに対応していません。' +
    '空き容量が足りなくなると、データが消えることがあります。' +
    'バックアップを定期的に取ってください(「書き出しと片づけ」から取れます)。',
  unknown: 'まだ確かめていません。最初に何か保存したときに確かめます。',
};

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
