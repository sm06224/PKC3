/**
 * 追記欄(P8 段⑧)。
 *
 * > user 指示 2026-08-03「**追記型は今すぐ実装して、今のままだと、なんの意味もない**」
 * > 「**編集競合は競合ロックと強制解放も念頭にしてください**」
 *
 * 🔴 前の実装(段⑥)は「編集画面を開いて末尾へ飛ぶ」だけだった ── 5000 行の
 * ログでも毎回全文を textarea に載せる。**追記型の意味が無い**。ここは編集画面を
 * 通らず、打って押したら**その場で disk へ書く**。
 *
 * 🔑 **器を作り直さない**。本文は追記のたびに書き換わって再描画されるので、
 * 同じ器に入れると**打ちかけの文字も focus も消える**。だから `shell` が
 * 別 region を持ち、この描画器は**中身を作るのは 1 回だけ**で、以後は
 * 表示・ロック状態だけを更新する。
 *
 * ⚠ 変換中(IME)の Enter で送らない ── `isComposing` を見る。
 */
import type { AppState } from '@adapter/state/app-state';
import { bodyLockOf } from '@adapter/state/app-state';
import { isAppendable } from '@features/flavor/append-spec';
import { listAppendTargets } from '@features/markdown/append-target';
import { CANCEL_EDIT_HINT, COMMIT_EDIT_HINT, iconButton } from './icons';
import { refoldPeeked } from './pane-visibility';
import { hintTitle } from './shortcut-hint';
// 🔑 指で触るだけの端末かの判定は 1 か所(#722 P2-12)── 各面で `matchMedia` を書かない
import { isTouchOnly } from './touch-device';

/** 追記欄の見え方。⚠ ここが唯一の判定(描画側と binder で二重に持たない)。 */
export type AppendMode =
  | { kind: 'hidden' }
  | { kind: 'ready'; lid: string }
  /** 自分の編集が握っている ── 保存 / 破棄で解ける(強制解放の穏当な形)。 */
  | { kind: 'editing'; lid: string }
  /** 書込が飛んでいる ── 通常は一瞬。返ってこなければ強制解放。 */
  | { kind: 'writing'; lid: string };

/**
 * いま追記欄をどう出すか。**pure** なので unit で全パターン見られる。
 * ⚠ 「本文が読めていない」ときは出さない ── 押しても書けないボタンを出さない。
 */
export function appendModeOf(state: AppState): AppendMode {
  const lid = state.selectedLid;
  if (!lid || state.viewMode !== 'detail') return { kind: 'hidden' };
  if (!isAppendable(state.entryMetas.get(lid)?.archetype)) return { kind: 'hidden' };
  const lock = bodyLockOf(state);
  if (lock?.lid === lid) return { kind: lock.holder, lid };
  // ⚠ 本文が届いていない間は出さない(追記の基底は disk だが、
  //    「開けていないノートに書く」導線は user から見て嘘になる)
  if (state.openBody?.lid !== lid) return { kind: 'hidden' };
  if (state.phase !== 'ready') return { kind: 'hidden' };
  return { kind: 'ready', lid };
}

export class AppendBoxRenderer {
  private readonly region: HTMLElement;
  private readonly form: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  /** 入り先の選択(#395 段①)。⚠ 器は 1 度だけ組み、中身だけ差し替える。 */
  private readonly target: HTMLSelectElement;
  /** 直前の追記を外す(#395 段①)。⚠ 追記が通ったときだけ出す。 */
  private readonly undo: HTMLButtonElement;
  /** 打つ欄と押す物の行(#496)。⚠ 入り先の `<select>` は**この上**に出る。 */
  private readonly row: HTMLElement;
  /** いま並べている入り先の指紋。⚠ 同じなら触らない(選んだ物が飛ばない)。 */
  private targetSig: string | null = null;
  private readonly lockBar: HTMLElement;
  private readonly lockText: HTMLElement;
  private readonly resolve: HTMLElement;
  private readonly discard: HTMLElement;
  private readonly release: HTMLElement;
  private last: AppendMode['kind'] | null = null;
  private lastLid: string | null = null;
  /** 🔴 次に打てる状態で描いたとき、1 回だけ打つ欄へ焦点を入れる(下の `focusInputOnceReady`)。 */
  private focusPending = false;

  constructor(region: HTMLElement) {
    this.region = region;

    this.form = document.createElement('div');
    this.form.setAttribute('data-pkc-field', 'append-form');
    this.input = document.createElement('textarea');
    this.input.setAttribute('data-pkc-field', 'append-input');
    // ⚠ 読み上げから見て無名にしない(2026-08-19 の全数監査)
    this.input.setAttribute('aria-label', '追記する内容');
    this.input.rows = 2;
    // ⚠ placeholder は `title` ではないので、`applyShortcutHints` の対象外 ──
    //    ここは組み立てた字をそのまま入れる(割当を変えたら次の描画で追いつく)
    /**
     * 🔴 **指で触るだけの端末では、鍵の名前を出さない**(#722 P2-12)。
     *
     * ⚠ スマホには `Ctrl` も `Enter` も無いので、`(Ctrl + Enter)` は
     *   **押せない物の名前で欄の説明を半分埋めている**だけである。
     * ⚠ **鍵そのものは殺していない** ── 外付けキーボードを繋げばこれまでどおり効く。
     *   ここで変わるのは欄に出る字だけである。
     */
    this.input.placeholder = isTouchOnly()
      ? '追記する内容'
      : hintTitle('追記する内容', 'append-send');
    /**
     * 🔴 **入り先を選ぶ**(#395 段①)。
     *
     * > user の物語: 長い議事録の「決定事項」の節に 1 行だけ足したい。
     *
     * ⚠ **既定は「末尾」**(これまでと同じ)── 選ばなければ挙動は 1 ミリも変わらない。
     * ⚠ 見出しが 1 つも無いノートでは**畳む**(選べる物が「末尾」だけの選択肢は、
     *   押せるのに意味が無い)。
     */
    this.target = document.createElement('select');
    this.target.setAttribute('data-pkc-field', 'append-target');
    this.target.setAttribute('aria-label', '追記の入り先');
    this.target.title = '追記を入れる場所です。既定は本文の末尾で、見出しを選ぶとその節の終わりに入ります';
    /**
     * 🔴 **足したものを、本文を開かずに外せる**(#395 段①。user 指示 2026-08-23
     * 「**片道の操作を作らない**」)。
     *
     * ⚠ 追記は**本文を開かずに足せる**ので、外すのも開かずにできなければ
     *   「間違えて足したら本文まで開く」になる ── それは動線を 1 つ失うのと同じ。
     * ⚠ 追記が通ったときだけ出す(何も足していないのに押せる口を出さない)。
     */
    this.undo = iconButton('undo-append', '元に戻す');
    this.undo.title = '直前に追記した内容を、本文から取り除きます';
    /**
     * 🔴 **入り先は「打つ欄の上の行」に置く**(#496。user 指示 2026-08-27
     * 「**見出し選択リストはテキストボックスの上に置いて欲しい**」)。
     *
     * ⚠ 直す前は 4 つとも**横 1 列**で、`<select>` が先頭に居た ── `<select>` は
     *   規則が 1 つも無く UA 既定の**内容依存幅**なので、見出しが長いノートでは
     *   **64px → 765px**(実測 1440px 幅)まで伸びる。隣の `append-input` は
     *   `flex: 1` なので、その差がまるごと打つ欄から奪われ、
     *   **「追記」ボタンが右へ動く** = ノートを開くたびに押す物の位置が変わる。
     * 🔑 行を分ければ、`<select>` が伸びても**打つ欄と押す物は動かない**
     *   (幅を器に固定するのは `app.css` の側)。
     * ⚠ **`<select>` を器で包まない** ── 見出しが 1 つも無いノートでは
     *   `this.target.hidden = true` になるので、包むと**空の行が 1 本残る**
     *   (押す物の無い帯を増やさない)。`this.form` を縦に組み、
     *   `<select>` を直接その子にすれば、畳んだとき行ごと消える。
     */
    this.row = document.createElement('div');
    this.row.setAttribute('data-pkc-field', 'append-row');
    this.row.append(this.input, iconButton('append-entry', '追記'), this.undo);
    this.form.append(this.target, this.row);

    this.lockBar = document.createElement('div');
    this.lockBar.setAttribute('data-pkc-field', 'append-lock');
    this.lockText = document.createElement('span');
    this.lockText.setAttribute('data-pkc-field', 'append-lock-reason');
    /**
     * 編集が握っているとき ── **失わない出口を先に出す**。
     * 🔴 **字は中央の帯と同じ「保存 / キャンセル」**(#716)。⚠ 直す前は
     *   「保存して解放 / 編集を破棄」で、同じ action なのに上下で字が違った ──
     *   user は「別の操作か」と読む(押した結果は 1 バイトも違わない)。
     *   説明(`title`)も中央と同じ字にする ── 正本は `detail.ts` と 2 か所だが、
     *   `tests/adapter/action-labels.test.ts` が「同じ action は 1 種類の字」で縛る。
     */
    this.resolve = iconButton('commit-edit', '保存');
    this.resolve.title = COMMIT_EDIT_HINT;
    this.discard = iconButton('cancel-edit', 'キャンセル');
    this.discard.title = CANCEL_EDIT_HINT;
    // 書込が返らないとき ── 最後の出口
    this.release = iconButton('force-release', '強制解放');
    this.lockBar.append(this.lockText, this.resolve, this.discard, this.release);

    this.region.append(this.lockBar, this.form);
  }

  /** 書込に入った時点の disk 内容。**成功したかどうかの唯一の判別材料**。 */
  private persistedAtWrite: string | null = null;

  render(state: AppState): void {
    const mode = appendModeOf(state);
    /**
     * 選択が**別のノートへ移ったら**打ちかけを捨てる(別のノートへ書いてしまわない)。
     *
     * 🔴 **「隠れた」を「別のノートへ移った」と数えない**(user 目線レビュー U-1)。
     *
     * ⚠ 直す前は `mode.kind === 'hidden' ? null : mode.lid` と書いていたので、
     *   **面を開いただけで打ちかけが消えて**いた ── `appendModeOf` は
     *   `viewMode !== 'detail'` で `hidden` を返す(:39)ので、カレンダー /
     *   かんばん / 集計 / 2 ペイン / 設定 / フラグ / **ヘルプ**のどれを開いても
     *   `lid` が `null` に落ち、`lastLid` と違うので欄を空にしていた。
     * ⚠ 確認も、お知らせも、1 行も出ない ── **黙って消える**。
     * ⚠ しかも `main.ts:470` は「本文は追記のたびに書き換わって再描画されるので、
     *   **同じ器に入れると打ちかけの文字も focus も消える**」と書いて器を分けている
     *   ── **その器が、面の切替で消していた**。マニュアル §4 が
     *   「書きながらマニュアルを読んだり」をヘルプが開ける理由に挙げているのに、
     *   そのヘルプを開くと打ちかけが消える、という形だった。
     *
     * 🔑 隠れている間は `lastLid` を**動かさない** ── 戻ってきたとき同じノートなら
     *   打ちかけはそのまま。別のノートを選べば `lid` が変わるので、そのときに捨てる。
     * ⚠ 本文の到着待ち(`openBody?.lid !== lid`)も `hidden` なので、この規則は
     *   ノートを切り替えた直後の一瞬にも効く ── 届いた時点で `lid` が変わり、
     *   そこで正しく捨てられる(捨て損なわない)。
     */
    if (mode.kind !== 'hidden' && mode.lid !== this.lastLid) {
      this.input.value = '';
      this.lastLid = mode.lid;
    }
    // 🔑 **通ったときだけ欄を空にする**。失敗・強制解放では打った内容を残す ──
    // 「押したら消えたが保存されていない」は、この機構で一番やってはいけない負け方。
    // ⚠ 判別は `persisted`(disk で確認できた内容)の変化で見る ── `error` の
    // 有無で見ると、無関係な別の失敗に引きずられる
    if (this.last === 'writing' && mode.kind !== 'writing') {
      if (state.openBody?.persisted !== this.persistedAtWrite) this.clear();
      this.persistedAtWrite = null;
    } else if (mode.kind === 'writing' && this.last !== 'writing') {
      this.persistedAtWrite = state.openBody?.persisted ?? null;
    }
    /**
     * 🔴 **入り先の一覧は、下の早期 return より前で更新する**(#395 段①)。
     *
     * ⚠ 下の 1 行は「種類が同じなら DOM を触らない」だが、**本文は種類を変えずに
     *   変わる**(追記した / 別の窓が書いた / 編集を保存した)── 後ろに置くと
     *   **見出しを足しても一覧に出てこない**(押しても選べない、無言の穴)。
     */
    /**
     * ⚠ **本文が読めていない間は一覧に触らない**(2 稿目。test が拾った)。
     *
     * 1 稿目は `mode.kind === 'ready'` 以外で `null` を渡して**一覧を捨てて**いた ──
     * 追記は `ready → writing → ready` と動くので、**押すたびに選んだ入り先が
     * 「末尾」へ戻って**いた。⚠ この機構の主な使い方は「同じ節へ続けて足す」なので、
     * それができないのは機能が半分死んでいるのと同じである。
     * 🔑 すぐ上の「隠れている間は `lastLid` を動かさない」と**同じ作法**にする ──
     *   消す理由が無いものを、面や状態の切り替わりで捨てない。
     */
    this.paintTargets(state.openBody?.lid === this.lastLid ? state.openBody.body : null);
    /**
     * ⚠ **これも早期 return より前** ── 追記が通っても種類は `ready` のままなので、
     *   後ろに置くと「足したのに『元に戻す』が出てこない」(無言の穴)。
     * ⚠ **このノートの追記のときだけ**出す ── 別のノートを選んでいるときに出すと、
     *   押した人は「いま見ているノートが戻る」と読む。
     */
    const canUndo = mode.kind === 'ready' && state.lastAppend?.lid === mode.lid;
    if (this.undo.hidden !== !canUndo) this.undo.hidden = !canUndo;
    if (mode.kind === this.last) {
      // ⚠ 種類が同じなら DOM を触らない ── ただし焦点の約束は**器に触らずに**果たす
      this.focusIfPending(mode);
      return;
    }
    this.last = mode.kind;
    this.region.hidden = mode.kind === 'hidden';
    this.form.hidden = mode.kind !== 'ready';
    this.lockBar.hidden = mode.kind === 'ready' || mode.kind === 'hidden';
    this.resolve.hidden = mode.kind !== 'editing';
    this.discard.hidden = mode.kind !== 'editing';
    this.release.hidden = mode.kind !== 'writing';
    if (mode.kind === 'editing') {
      this.lockText.textContent = 'このノートは編集中です。保存するか、キャンセルすると追記できます。';
    } else if (mode.kind === 'writing') {
      this.lockText.textContent = '追記を書き込んでいます…(返ってこないときは強制解放)';
    }
    // ⚠ **器を出した後**に当てる ── `hidden` のままの欄には焦点が乗らない
    this.focusIfPending(mode);
  }

  /**
   * 🔴 **開いた直後、カーソルは追記欄に在る**(#690 I4、user 裁定 2026-09-04)。
   *
   * ## 物語
   *
   * 付箋は「隅に置いて追記欄にどんどん書き足す」ための窓である。⚠ 直す前は
   * 開いた直後の焦点が**本文**に在ったので、user は毎回**打つ欄を 1 度押してから**
   * 書き始めていた ── 何枚も開く使い方では、その 1 手が枚数ぶん積まれる。
   *
   * 🔑 **次に打てる状態(`ready`)で描いたとき、1 回だけ**打つ欄へ焦点を入れる。
   * ⚠ 本文が届く前に呼ばれる(付箋の旗が立つのは boot の後・本文の到着より前)ので、
   *   その場で `focus()` しても**まだ `hidden` の欄**には乗らない ── だから約束にして、
   *   描画が果たす。
   * ⚠ **奪い返さない** ── 1 回果たしたら忘れる。user が既にどこかで打っている
   *   (編集できる物に焦点が在る)なら、果たさずに忘れる。
   */
  focusInputOnceReady(): void {
    this.focusPending = true;
  }

  private focusIfPending(mode: AppendMode): void {
    if (!this.focusPending || mode.kind !== 'ready') return;
    this.focusPending = false;
    const active = this.region.ownerDocument.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    )
      return;
    this.input.focus();
  }

  /**
   * 入り先の一覧を本文から作り直す(#395 段①)。
   *
   * ⚠ **指紋が同じなら触らない** ── `<select>` を組み直すと**選んでいた物が
   *   「末尾」へ戻る**。追記のたびに本文は変わるので、ここを毎回組み直すと
   *   「連続して同じ節へ足す」ができなくなる(この機構の主な使い方である)。
   * ⚠ 見出しが消えたときは**選択が「末尾」へ落ちる** ── そこは正しい
   *   (存在しない印を握ったままにすると、押した瞬間に断られる)。
   */
  private paintTargets(body: string | null): void {
    // ⚠ 読めていない(`null`)= **触らない**。空の一覧に組み直さない
    if (body === null) return;
    const heads = listAppendTargets(body);
    const sig = heads.map((h) => `${h.level}:${h.slug}:${h.text}`).join('\u0001');
    if (sig === this.targetSig) return;
    this.targetSig = sig;
    // 🔑 選んでいた物を覚えておいて、まだ在れば戻す
    const keep = this.target.value;
    this.target.textContent = '';
    const end = document.createElement('option');
    end.value = '';
    end.textContent = '末尾';
    this.target.append(end);
    for (const h of heads) {
      const opt = document.createElement('option');
      opt.value = h.slug;
      // ⚠ 深さは**字下げ**で見せる(level を数字で出しても user には読めない)
      opt.textContent = `${'\u3000'.repeat(h.level - 1)}${h.text}`;
      this.target.append(opt);
    }
    if (keep !== '' && heads.some((h) => h.slug === keep)) this.target.value = keep;
    /**
     * ⚠ **見出しが 1 つも無いノートでは畳む** ── 「末尾」しか無い選択肢は、
     *   押せるのに選ぶ物が無い(業務画面の作法「押しても何も起きないを作らない」)。
     */
    this.target.hidden = heads.length === 0;
  }

  /**
   * 追記が通ったら欄を空にして、続けて打てるようにする(連続追記)。
   *
   * 🔴 **こちらが一時的に開いた欄なら、通った時点で元どおり畳む**(#655 ①。
   *   user 裁定 2026-09-04 案 B)。⚠ 畳み直すのは**通ったときだけ** ── 断られた /
   *   強制解放の回は打った字が残るので、欄も出したままにする(隠すと「押したら
   *   消えた」に見える)。
   * ⚠ 畳んだ欄には焦点を戻さない(`display: none` に焦点は乗らない ── 乗せようとして
   *   `body` へ落ちるより、押していた所に留める)。続けて足したい人はもう一度開く。
   */
  clear(): void {
    this.input.value = '';
    if (!refoldPeeked(this.region)) this.input.focus();
  }
}
