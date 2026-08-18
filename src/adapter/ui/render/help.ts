/**
 * ヘルプの面(P11 段④。user 指示 2026-08-07)。
 *
 * > 「**お知らせ掲載内容は過去のお知らせとして、最大 10 件を最新のリリース、
 * > 開発版の PKC3 のヘルプ画面から参照できるようにしてください /
 * > ヘルプ画面にはマニュアル導線も含めてください**」
 *
 * ## 作りは「設定 / フラグ」と同型
 *
 * ⚠ **かぶせる窓にしない。** この repo にモーダルは 1 件も無い ── 面はすべて
 * 「同じものが常に同じ場所にある」作法(`settings.ts:7-11`)。ここもそれに従う。
 * ⚠ 器は **1 度だけ組む**。面の切替は `hidden` の付け外しなので、器を捨てると
 * 押される寸前のボタンが消える(2026-08-07 に本文の面で実際に踏んだ)。
 *
 * ## マニュアルは**同梱**する(裁定 Q4)
 *
 * `docs/manual.md` を `?raw` で焼き込む。⚠ 外部リンクにすると
 * **オフラインで読めない**(マニュアル自身が「オフラインで使う」と書いている)し、
 * アプリ初の外向きリンクにもなる。同梱なら**版とマニュアルが必ず一致**し、
 * SW の precache に自動で載る(entry chunk の一部になるため)。
 *
 * ⚠ **重い処理はワーカーへ**(user 指示 2026-08-03 不可侵)── マニュアル全文の
 * 描画は共有の `MarkdownClient` に出す。1 度描いたら以後は描き直さない。
 *
 * ## 🔴 マニュアル側に文書内アンカーを持たせない
 *
 * 本文の見出しは `id=<slug>` を焼く。面は `hidden` で**同一 document に常駐**するので、
 * `#slug` は**先に作られた本文面の見出し**に当たる。マニュアルに `[…](#…)` や
 * `:::toc` を書くと、そこから壊れる ── `tests/adapter/help-pane.test.ts` が
 * 「マニュアルに文書内アンカーが 0 件」を機械で守る。
 */
import { APP_ID, APP_VERSION, BUILD_KIND } from '@runtime/release-meta';
import { NOTICES, noticeDate, recentNotices, type Notice } from '@features/notice/notice-log';
import manualText from '../../../../docs/manual.md?raw';
import { KEY_COMMANDS, chordLabel } from '@features/keymap';
import { appKeymap, type KeymapStore } from './keymap';

/** 焼き込んだマニュアルの原文(test から掴めるよう named export)。 */
export const MANUAL_TEXT: string = manualText;

/**
 * 版の表示。⚠ **1 か所で組む** ── 手組みの template を面ごとに増やさない。
 *
 * ⚠ 種別を**引数で受ける**(2026-08-08、変異試験の指摘)。`BUILD_KIND` は build 時に
 * 焼き込まれるので、既定引数のままだと **test から分岐を 1 つも動かせない** ──
 * 「開発版 / 検証版の刻印を落とす」変異が誰にも殺されなかった。
 */
export function versionText(kind: string = BUILD_KIND): string {
  const suffix = kind === 'product' ? '' : kind === 'stage' ? '(検証版)' : '(開発版)';
  return `${APP_ID} v${APP_VERSION}${suffix}`;
}

/**
 * markdown を描く口(worker 経路。⚠ 失敗したら素の原文を出す)。
 *
 * ⚠ **描画の材料も受ける**(2026-08-08。Issue #100 段①)── マニュアルもこの
 * コンテナの中で読まれる文書なので、`pkc://<自分>/…` の扱いは本文と揃える。
 * 揃えないと、同じ 1 行が**面によって別物に見える**(片方はリンク、片方は
 * 「別の PKC」の badge)。
 */
export interface HelpMarkdownPort {
  render(text: string, opts?: { currentContainerId?: string }): Promise<string>;
}

export class HelpRenderer {
  private built = false;
  private manualHost: HTMLElement | null = null;
  /** ショートカットの一覧(#256)。⚠ 器は捨てず、中身だけ書き換える。 */
  private keys: HTMLElement | null = null;
  private offKeymap: (() => void) | null = null;

  constructor(
    private readonly region: HTMLElement,
    /** ⚠ アプリ全体で 1 個の `MarkdownClient` を渡す(面ごとに作らない)。 */
    private readonly markdown: HelpMarkdownPort | null = null,
    /**
     * 登記表。⚠ **注入できるようにする**(2026-08-08、変異試験の指摘)──
     * `NOTICES` が 1 件しか無いので、**上限も並びも「測っていない次元」**だった
     * (`recentNotices` を通さず丸ごと出す変異が素通りした)。
     */
    private readonly notices: readonly Notice[] = NOTICES,
    /**
     * 🔴 **キーの割当**(#256)。⚠ **一覧はここで手書きしない** ── PKC2 は
     * ヘルプの一覧を手書きの配列で持っていたので実装とズレた(2 件確認)。
     * ここは `KEY_COMMANDS` + いまの割当を描くだけである。
     */
    private readonly keymap: KeymapStore = appKeymap,
  ) {}

  /**
   * @param currentContainerId いま開いているコンテナ(Issue #100 段①)。
   *   ⚠ 器は 1 度しか組まないので、**描くときの値**がそのまま焼かれる ──
   *   コンテナを切り替える経路が入ったら、ここも作り直しの対象になる。
   */
  render(currentContainerId = ''): void {
    if (this.built) return;
    this.built = true;
    this.region.textContent = '';

    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'pane-title');
    head.textContent = 'ヘルプ';
    this.region.append(head);

    const body = document.createElement('div');
    body.setAttribute('data-pkc-region', 'help-body');
    this.region.append(body);

    // ── ① この版 ────────────────────────────────────────
    /**
     * 🔴 **設定から移してきた**(P11)。設定は「あなたが選ぶもの」の場所で、
     * 版は選べない ── 困ったときに見る場所がここである。
     * ⚠ **2 か所に出さない**(`settings.ts` から消した)── 同じ値を 2 経路で
     *   描くと、片方だけ直して食い違う。`docs-parity` が両方を見る。
     * ⚠ 版の種別(検証版 / 開発版)は**文字で出す** ── 設定は hover の `title`
     *   にしか入れておらず、タッチ端末・キーボードだけの user には届かなかった。
     */
    const ver = document.createElement('p');
    ver.setAttribute('data-pkc-field', 'help-version');
    ver.textContent = versionText();
    body.append(ver);

    // ── ② 過去のお知らせ ────────────────────────────────
    const nh = document.createElement('h3');
    nh.textContent = 'これまでのお知らせ';
    body.append(nh);

    const list = document.createElement('div');
    list.setAttribute('data-pkc-region', 'help-notices');
    // ⚠ **件数を切るのは `recentNotices` だけ**(面ごとに slice を書かない)
    for (const n of recentNotices(this.notices)) {
      const item = document.createElement('section');
      /**
       * ⚠ **`data-pkc-notice` は使わない** ── 取込の注意(`notices.ts`)が
       * 既にその名前で、同じ document に居る。名前がかぶると、片方を数える
       * 検査がもう片方まで拾う(CLAUDE.md「id らしく見える名前は id として扱われる」)。
       */
      item.setAttribute('data-pkc-help-notice', n.id);
      const t = document.createElement('h4');
      t.setAttribute('data-pkc-field', 'notice-title');
      // ⚠ 日付は id から引く(field を二重に持たない)
      t.textContent = `${noticeDate(n.id)} ${n.title}`;
      const ul = document.createElement('ul');
      for (const line of n.items) {
        const li = document.createElement('li');
        // ⚠ **素のテキスト**として出す(記法は書かない決まり。test が守る)
        li.textContent = line;
        ul.append(li);
      }
      item.append(t, ul);
      list.append(item);
    }
    body.append(list);

    // ── ③ ショートカットキー ────────────────────────────
    /**
     * 🔑 **いま効いている割当**を出す(user 指示 2026-08-18)。
     * ⚠ 割り当て直す口は**設定の面 1 か所**にする ── 同じ操作を 2 か所に置くと、
     *   どちらが正か user にも分からなくなる。ここは読む場所である。
     * ⚠ 面は 1 度しか組まないので、割当が変わったら**この節だけ**描き直す
     *   (器を捨てない ── 2026-08-07 の dead click の型)。
     */
    const kh = document.createElement('h3');
    kh.textContent = 'ショートカットキー';
    body.append(kh);
    const kn = document.createElement('p');
    kn.setAttribute('data-pkc-field', 'settings-note');
    kn.textContent =
      'Ctrl は Mac では ⌘ でも同じように効きます。割り当て直しは設定の面でできます。';
    body.append(kn);
    this.keys = document.createElement('div');
    this.keys.setAttribute('data-pkc-region', 'help-keymap');
    body.append(this.keys);
    this.syncKeys();
    // ⚠ 購読は器と同じ寿命(面は畳んでも捨てない)── 二重に張らないよう 1 度だけ
    this.offKeymap?.();
    this.offKeymap = this.keymap.onChange(() => {
      this.syncKeys();
    });

    // ── ④ マニュアル ────────────────────────────────────
    const mh = document.createElement('h3');
    mh.textContent = 'マニュアル';
    body.append(mh);

    this.manualHost = document.createElement('div');
    this.manualHost.setAttribute('data-pkc-region', 'help-manual');
    this.manualHost.className = 'pkc-md-rendered';
    // ⚠ 描く前も**器は置く**(後から差し込むので、器が無いと入れ先が消える)
    this.manualHost.textContent = 'マニュアルを読み込んでいます…';
    body.append(this.manualHost);

    void this.drawManual(currentContainerId);
  }

  /**
   * ショートカットの一覧を描く。⚠ **表(`KEY_COMMANDS`)が正本**。
   * ⚠ 割当が空のコマンドも**行ごと出す** ── 「割当なし」が見えないと、
   *   user は「そんな操作は無い」と読む(外した本人が戻せなくなる)。
   */
  private syncKeys(): void {
    const host = this.keys;
    if (!host) return;
    const bindings = this.keymap.getBindings();
    host.textContent = '';
    const dl = document.createElement('dl');
    for (const cmd of KEY_COMMANDS) {
      const dt = document.createElement('dt');
      dt.setAttribute('data-pkc-field', 'help-key-command');
      dt.setAttribute('data-pkc-command', cmd.id);
      dt.textContent = cmd.label;
      const dd = document.createElement('dd');
      dd.setAttribute('data-pkc-field', 'help-key-chords');
      dd.setAttribute('data-pkc-command', cmd.id);
      const list = bindings[cmd.id] ?? cmd.defaults;
      dd.textContent = list.length === 0 ? '割当なし' : list.map((c) => chordLabel(c)).join(' / ');
      dl.append(dt, dd);
    }
    host.append(dl);
  }

  /**
   * マニュアルを描く。
   * ⚠ ワーカーが使えないときは**素の原文**を出す ── 白紙にしない。
   *
   * ⚠ **二重描画のガードは置かない**(2026-08-08、変異試験の指摘)。`render()` の
   * `built` ガードが先に効くので、ここは構造上 1 度しか呼ばれない ──
   * 置いていたガードは**誰も通らない死んだ防御**で、消しても test は 1 件も
   * 落ちなかった(「在るのに効かない」は次に読む人を惑わせる)。
   */
  private async drawManual(currentContainerId: string): Promise<void> {
    if (!this.manualHost) return;
    const host = this.manualHost;
    if (!this.markdown) {
      host.textContent = MANUAL_TEXT;
      return;
    }
    try {
      host.innerHTML = await this.markdown.render(MANUAL_TEXT, { currentContainerId });
    } catch {
      host.textContent = MANUAL_TEXT;
    }
  }
}
