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
import type { EntryMeta } from '@core/model/entry-meta';
import { bodyLockOf, isCodeDraft } from '@adapter/state/app-state';
import { isAppendable } from '@features/flavor/append-spec';
import { listAppendTargets } from '@features/markdown/append-target';
import { CANCEL_EDIT_HINT, COMMIT_EDIT_HINT, iconButton } from './icons';
import { takeAppendFocus } from './focus-request';
import { refoldPeeked } from './pane-visibility';
import { sizeTextareaToContent } from './row-swap';
import { hintTitle } from './shortcut-hint';
import { EDITING_STATE_WORD } from './status-line';
// 🔑 指で触るだけの端末かの判定は 1 か所(#722 P2-12)── 各面で `matchMedia` を書かない
import { isTouchOnly } from './touch-device';

/**
 * 打つ欄が中身に合わせて伸びる上限(行)と、何も打っていないときの行数(#1443)。
 * ⚠ 上限は本文を押しのけないための数 ── 超えたら欄の中で送る。
 */
const APPEND_ROWS_CAP = 12;
const APPEND_ROWS_DEFAULT = 2;

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
  if (lock?.lid === lid) {
    /**
     * 🔴 **章の欄が握っているときは畳む**(#1044 段2、F-C)。⚠ `AppendMode` に
     *   `section` 用の見た目(専用の帯・出口)は持たせていない ── ここで
     *   `'editing'` へ流すと**全文編集の「保存 / やめる」ボタン**が出て、押しても
     *   章の欄には効かない(押した物と効く先が食い違う)。素の追記欄を出さない
     *   ほうが安全(design doc §3「同じノートへの他の書込は断る」)。
     */
    if (lock.holder === 'section') return { kind: 'hidden' };
    return { kind: lock.holder, lid };
  }
  // ⚠ 本文が届いていない間は出さない(追記の基底は disk だが、
  //    「開けていないノートに書く」導線は user から見て嘘になる)
  if (state.openBody?.lid !== lid) return { kind: 'hidden' };
  if (state.phase !== 'ready') return { kind: 'hidden' };
  return { kind: 'ready', lid };
}

/**
 * 🔴 **章・コード枠の欄を開いている間、追記欄の場所に出す 1 行**(台帳 #1852 束 R1、依頼 86-7 B)。
 *
 * 以前は追記欄が理由なく消えた(1 画面の編集の間は「編集中」と出口が出る)。場所が動かないよう、同じ場所に 1 行だけ出す
 * (ボタンは出さない ── 出口は章の欄の「保存 / やめる」。ここに別の押し口を置くと、押した物と効く先が食い違う)。
 * ⚠ `appendModeOf` は変えない(`hidden` のまま。binder の門が読む判定を増やさない)── 表示の側だけがこの 1 行を足す。
 */
export const SECTION_EDITING_NOTE = '章を編集中';
export const CODE_EDITING_NOTE = 'コードを編集中';

/** 章・コード枠の欄が、いま開いているノートの追記欄を押さえているか(`appendModeOf` が `hidden` を返した理由の 1 つ)。 */
export function appendHeldBySection(state: AppState): boolean {
  const lid = state.selectedLid;
  if (!lid || state.viewMode !== 'detail') return false;
  if (!isAppendable(state.entryMetas.get(lid)?.archetype)) return false;
  const lock = bodyLockOf(state);
  return lock?.lid === lid && lock.holder === 'section';
}

export class AppendBoxRenderer {
  private readonly region: HTMLElement;
  private readonly center: HTMLElement | null;
  private readonly form: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  /** 追記先の選択(#395 段①)。⚠ 器は 1 度だけ組み、中身だけ差し替える。 */
  private readonly target: HTMLSelectElement;
  /** 直前の追記を外す(#395 段①)。⚠ 追記が通ったときだけ出す。 */
  private readonly undo: HTMLButtonElement;
  /** 枠の下段(#1890)。左に追記先の `<select>`、右に「元に戻す」「本文に追記する」。 */
  private readonly bar: HTMLElement;
  /** いま並べている追記先の指紋。⚠ 同じなら触らない(選んだ物が飛ばない)。 */
  private targetSig: string | null = null;
  /** 前回見出しを拾った本文(同じ字なら拾い直さない)。 */
  private targetBody: string | null = null;
  private readonly lockBar: HTMLElement;
  private readonly lockText: HTMLElement;
  private readonly resolve: HTMLElement;
  private readonly discard: HTMLElement;
  private readonly release: HTMLElement;
  private last: AppendMode['kind'] | 'section' | null = null;
  private lastLid: string | null = null;
  /** 別のノートへ移るとき預かった打ちかけ(lid → 字)。⚠ 空の字は持たない。 */
  private readonly drafts = new Map<string, string>();
  /**
   * 🔴 **打ちかけと一緒に、選んでいた追記先も預かる**(lid → 節の印。#1087)。⚠ 直す前は字だけ戻り、
   *   追記先は前のノートで選んでいた物のまま(または「末尾」)で、戻ったノートの字が**別の場所へ**入りえた。
   *   ⚠ 「末尾」(空)は持たない。
   */
  private readonly targets = new Map<string, string>();
  /** ノートを移った直後、本文が届いて一覧を組み直すとき選び直す印(1 回で使い切る)。 */
  private desiredTarget: string | null = null;
  /** 🔴 次に打てる状態で描いたとき、1 回だけ打つ欄へ焦点を入れる(下の `focusInputOnceReady`)。 */
  private focusPending = false;

  constructor(region: HTMLElement) {
    this.region = region;
    /** 追記欄を抱える MAIN(掴む帯の規則が `data-pkc-append-hidden` を読む)。test の素の器では無いこともある。 */
    this.center = region.closest<HTMLElement>('[data-pkc-region="center"]');

    this.form = document.createElement('div');
    this.form.setAttribute('data-pkc-field', 'append-form');
    this.input = document.createElement('textarea');
    this.input.setAttribute('data-pkc-field', 'append-input');
    // ⚠ 読み上げから見て無名にしない(2026-08-19 の全数監査)
    this.input.setAttribute('aria-label', '追記する内容');
    this.input.rows = APPEND_ROWS_DEFAULT;
    /**
     * 🔴 **打った行数に合わせて欄が伸びる**(#1443)。⚠ 計算は `row-swap.ts` の
     *   `sizeTextareaToContent` **1 本**(2 つ目を作らない)。手で高さを決めていれば
     *   `fitToContent` が何もしない。
     */
    this.input.addEventListener('input', () => this.fitToContent());
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
     * 🔴 **追記先を選ぶ**(#395 段①)。
     *
     * > user の物語: 長い議事録の「決定事項」の節に 1 行だけ足したい。
     *
     * ⚠ **既定は「末尾」**(これまでと同じ)── 選ばなければ挙動は 1 ミリも変わらない。
     * ⚠ 見出しが 1 つも無いノートでは**畳む**(選べる物が「末尾」だけの選択肢は、
     *   押せるのに意味が無い)。
     */
    this.target = document.createElement('select');
    this.target.setAttribute('data-pkc-field', 'append-target');
    this.target.setAttribute('aria-label', '追記先');
    this.target.title = '追記を入れる場所です。既定は本文の末尾で、見出しを選ぶとその節の終わりに入ります';
    /**
     * 🔴 **足したものを、本文を開かずに外せる**(#395 段①。user 指示 2026-08-23
     * 「**片道の操作を作らない**」)。
     *
     * ⚠ 追記は**本文を開かずに足せる**ので、外すのも開かずにできなければ
     *   「間違えて足したら本文まで開く」になる ── それは動線を 1 つ失うのと同じ。
     * ⚠ 追記が通ったときだけ出す(何も足していないのに押せる口を出さない)。
     */
    this.undo = iconButton('undo-append', '追記を元に戻す');
    /**
     * ⚠ **「追記した」とだけ書かない**(#684 段④ の UX レビュー I3)── ここで消えるのは
     *   追記した字だけでなく、**落として差し込んだ添付の行**と**一覧から落としたリンク**
     *   でもある。追記した覚えのない user は、このボタンが自分の写真を消すものだと読めない。
     */
    this.undo.title = '直前に足した内容(追記・ドロップして入れた行)を、本文から取り除きます';
    /**
     * 🔴 **枠 1 つの中に、打つ欄(上)と下段(追記先 左 / 元に戻す・追記 右)をまとめる**(#1890。
     * user 指示 2026-10-19「追記のテキストボックスに追記ボタンや追記先プルダウン、元に戻すボタンを組み込む」)。
     *
     * ⚠ 直す前は追記先が欄の**上の行**、ボタンが欄の**横**にあり、打つ欄の横幅をボタンが取っていた(#496 → #1443)。
     * 🔑 枠(`append-form`)が見た目の箱で、打つ欄は枠の中で全幅を使う。下段(`append-bar`)は
     *   左に追記先、右に押す物。⚠ **追記先の幅は枠の中で固定**(`app.css` の `append-target`:
     *   固定幅 + `max-width: 100%` + `min-width: 0` + 省略表示)── 見出しが長いノートでも下段の右の押す物は動かず、
     *   枠の外へ何も押し出さない(#496 の再発防止)。
     * ⚠ **`<select>` を器で包まない** ── 見出しが無いノートでは `hidden` になる。下段には押す物が
     *   常にあるので空の行は残らない(`margin-left: auto` で押す物は右に寄ったまま)。
     */
    this.bar = document.createElement('div');
    this.bar.setAttribute('data-pkc-field', 'append-bar');
    const actions = document.createElement('span');
    actions.setAttribute('data-pkc-field', 'append-actions');
    actions.append(this.undo, iconButton('append-entry', '本文に追記する'));
    this.bar.append(this.target, actions);
    this.form.append(this.input, this.bar);

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
    this.resolve = iconButton('commit-edit', '編集を保存する');
    this.resolve.title = COMMIT_EDIT_HINT;
    this.discard = iconButton('cancel-edit', '編集をやめる');
    this.discard.title = CANCEL_EDIT_HINT;
    // 書込が返らないとき ── 最後の出口
    this.release = iconButton('force-release', '書き込みを打ち切る');
    this.lockBar.append(this.lockText, this.resolve, this.discard, this.release);

    this.region.append(this.lockBar, this.form);
  }

  /**
   * 🔴 **高さを手で決めているか**(#1443)。2 つの道を両方見る ──
   *   ① 境目の帯で決めた高さ(#497。`shell` の `--pkc-pane-append`)
   *   ② 欄の角を掴んで引いた高さ(ブラウザが `style.height` に書く)
   * ⚠ どちらも user の決めた高さなので、自動で変えない。
   * 🔑 `field-sizing: content` が使えるブラウザでは、明示の `height`(CSS の変数 / 掴んだ inline)が
   *   もともと勝つので、この門が守るのは **`rows` を書いて合わせる経路**(使えないブラウザ)である。
   *   ⚠ そちらは明示の高さが見た目で勝っていても `rows` だけは書き換わるので、
   *   帯の解除や掴み直しのときに食い違いが出ないよう、手で決めている間は書かない。
   */
  private isHandSized(): boolean {
    if (this.input.style.height !== '') return true;
    const shell = this.region.closest<HTMLElement>('[data-pkc-region="shell"]');
    return shell !== null && shell.style.getPropertyValue('--pkc-pane-append') !== '';
  }

  /**
   * 🔴 **まだ送っていない字の全部**(いま打っている欄 + 別のノートへ移るとき預かった分)。
   * ⚠ 追記欄に画像を貼ると、bytes は置かれるが参照は**この字の中にしか無い**(送るまでノートに書かない)。
   *   使われていない添付の整理はノートと履歴しか見ないので、ここを渡さないと貼った画像を消していた
   *   (#1087、添付の見直し。`main.ts` の整理の口が読む)。
   */
  pendingTexts(): string[] {
    const out = [...this.drafts.values()];
    if (this.input.value !== '') out.push(this.input.value);
    return out;
  }

  private keepDraft(lid: string, text: string): void {
    if (text === '') this.drafts.delete(lid);
    else this.drafts.set(lid, text);
  }

  /** 打った行数に合わせて高さを揃える。手で決めた高さがあれば何もしない。 */
  private fitToContent(): void {
    if (this.isHandSized()) return;
    sizeTextareaToContent(this.input, APPEND_ROWS_CAP);
    // 空のときも 2 行を下回らない(`rows` を書く経路は 1 まで縮む)
    if (Number(this.input.rows) < APPEND_ROWS_DEFAULT) this.input.rows = APPEND_ROWS_DEFAULT;
  }

  /** 飛んでいる追記書込 ── 書いたノートと、書き始めの基準(**成功したかの判別材料**)。 */
  private writing: { lid: string; persisted: string | null; meta: EntryMeta | null } | null = null;

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
     *   ── **その器が、面の切替で消していた**。マニュアル「画面を組み替える」 が
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
      /**
       * 🔴 **欄は空にするが、打ちかけは捨てない**(#1635 項 1)。⚠ 直す前は、別のノートへ
       *   移るたびに前のノートの打ちかけが黙って消えていた。
       * 🔑 打ちかけは**ノート(lid)ごとに預かり**、戻ってきたそのノートの欄にだけ出す。
       *   欄は移った先のノートの預かりで置き換えるので、**A 宛ての字が B へ追記されることは
       *   ない**(上の「別のノートへ書いてしまわない」は守る)。
       */
      if (this.lastLid !== null) this.keepDraft(this.lastLid, this.input.value);
      this.input.value = this.drafts.get(mode.lid) ?? '';
      this.fitToContent();
      if (this.lastLid !== null) {
        if (this.target.value === '') this.targets.delete(this.lastLid);
        else this.targets.set(this.lastLid, this.target.value);
      }
      // 一覧は移った先の本文から組み直す(前のノートの一覧に、預かった印を当てない)
      this.desiredTarget = this.targets.get(mode.lid) ?? '';
      this.targetBody = null;
      this.targetSig = null;
      this.lastLid = mode.lid;
    }
    // 🔑 **通ったときだけ欄を空にする**。失敗・強制解放では打った内容を残す ──
    // 「押したら消えたが保存されていない」は、この機構で一番やってはいけない負け方。
    // ⚠ 判別は `persisted`(disk で確認できた内容)の変化で見る ── `error` の
    // 有無で見ると、無関係な別の失敗に引きずられる
    /**
     * 🔴 **書込の結末は「書いたノート」の証拠だけで決める**(#1635 項 1 の続き)。
     * ⚠ 直す前は `writing → それ以外` に変わった瞬間の `openBody` を見ていた ── 書込が飛んでいる間に
     *   別のノート B を選ぶと、その瞬間に `appendModeOf` が `writing` を返さなくなり、`openBody` が
     *   A のままか B のものかで **成功を取り違えた**(失敗・未了を成功と読んで A の字を消す / 通ったのを
     *   見逃して A の字を預かり、戻ると出て二重に追記される)。
     * 🔑 書き始めに「どのノートか」と「そのノートの基準」を覚え、**錠が解けてから**そのノートの証拠で
     *   判定する。離れていて本文が読めていないときは `entryMetas` の入れ替わり
     *   (`ENTRY_APPENDED` だけが新しい meta を作る。失敗・強制解放は触らない)を見る。
     */
    if (this.writing === null && mode.kind === 'writing') {
      const own = state.openBody?.lid === mode.lid;
      this.writing = {
        lid: mode.lid,
        persisted: own ? state.openBody!.persisted : null,
        // 追記(`writeLock`)のときだけ meta で判定する。タイル設定の書込(`tileWrite`)は meta を使わない
        meta: state.writeLock?.lid === mode.lid ? (state.entryMetas.get(mode.lid) ?? null) : null,
      };
    }
    if (this.writing !== null) {
      const lock = bodyLockOf(state);
      const stillWriting = lock !== null && lock.lid === this.writing.lid && lock.holder === 'writing';
      if (!stillWriting) {
        const w = this.writing;
        this.writing = null;
        const landed =
          state.openBody?.lid === w.lid && w.persisted !== null
            ? state.openBody.persisted !== w.persisted
            : w.meta !== null && state.entryMetas.get(w.lid) !== w.meta;
        if (landed) {
          if (w.lid === this.lastLid) this.clear();
          else this.drafts.delete(w.lid);
        }
      }
    }
    /**
     * 🔴 **追記先の一覧は、下の早期 return より前で更新する**(#395 段①)。
     *
     * ⚠ 下の 1 行は「種類が同じなら DOM を触らない」だが、**本文は種類を変えずに
     *   変わる**(追記した / 別の窓が書いた / 編集を保存した)── 後ろに置くと
     *   **見出しを足しても一覧に出てこない**(押しても選べない、無言の穴)。
     */
    /**
     * ⚠ **本文が読めていない間は一覧に触らない**(2 稿目。test が拾った)。
     *
     * 1 稿目は `mode.kind === 'ready'` 以外で `null` を渡して**一覧を捨てて**いた ──
     * 追記は `ready → writing → ready` と動くので、**押すたびに選んだ追記先が
     * 「末尾」へ戻って**いた。⚠ この機構の主な使い方は「同じ節へ続けて足す」なので、
     * それができないのは機能が半分死んでいるのと同じである。
     * 🔑 すぐ上の「隠れている間は `lastLid` を動かさない」と**同じ作法**にする ──
     *   消す理由が無いものを、面や状態の切り替わりで捨てない。
     */
    /**
     * 🔴 **編集中は拾わない**(#1087)── 追記欄は使えない(`editing`)ので、打鍵ごとに本文全体を
     *   走査しても誰も見ない(400KB で約 2ms / 打鍵)。⚠ 一覧を捨てるのではなく**触らない**だけなので、
     *   編集が終わって `ready` へ戻った回に、本文が違えば(`targetBody` と比べて)拾い直す。
     *   「見出しを足しても一覧に出てこない」を、保存の後に起こさない。
     */
    if (mode.kind !== 'editing') {
      this.paintTargets(state.openBody?.lid === this.lastLid ? state.openBody.body : null);
    }
    /**
     * ⚠ **これも早期 return より前** ── 追記が通っても種類は `ready` のままなので、
     *   後ろに置くと「足したのに『元に戻す』が出てこない」(無言の穴)。
     * ⚠ **このノートの追記のときだけ**出す ── 別のノートを選んでいるときに出すと、
     *   押した人は「いま見ているノートが戻る」と読む。
     */
    const canUndo = mode.kind === 'ready' && state.lastAppend?.lid === mode.lid;
    if (this.undo.hidden !== !canUndo) this.undo.hidden = !canUndo;
    /**
     * 🔴 章・コード枠の欄が追記欄を押さえている間は、`hidden` ではなく 1 行の知らせにする(依頼 86-7 B)。
     * 字は章かコード枠かで変わる(同じ種類のままでも字だけ替わりうるので、早期 return の前に書く)。
     */
    const shown: AppendMode['kind'] | 'section' =
      mode.kind === 'hidden' && appendHeldBySection(state) ? 'section' : mode.kind;
    if (shown === 'section') {
      const draft = state.sectionDraft ?? null;
      const note = draft !== null && isCodeDraft(draft) ? CODE_EDITING_NOTE : SECTION_EDITING_NOTE;
      if (this.lockText.textContent !== note) this.lockText.textContent = note;
    }
    if (shown === this.last) {
      // ⚠ 種類が同じなら DOM を触らない ── ただし焦点の約束は**器に触らずに**果たす
      this.focusIfPending(mode);
      this.focusIfRequested(mode);
      return;
    }
    this.last = shown;
    this.region.hidden = shown === 'hidden';
    /**
     * 🔑 **祖先の印は、`hidden` を書くのと同じ場所で立てる**(#1467 段 3-h)── `app.css` が
     *   `:has([data-pkc-region='append'][hidden])` / `:has([data-pkc-field='append-lock']:not([hidden]))` で
     *   読んでいた 2 つ。MAIN を `:has()` の主語にすると、本文の下に何かが挿さるたびに `p` 3,654 個が
     *   当て直されていた(20,000 行の追記 1 回で 4 回)。印なら、変えた要素の規則だけが動く。
     */
    this.center?.toggleAttribute('data-pkc-append-hidden', this.region.hidden);
    this.form.hidden = shown !== 'ready';
    this.lockBar.hidden = shown === 'ready' || shown === 'hidden';
    this.region.toggleAttribute('data-pkc-lock-open', !this.lockBar.hidden);
    // 🔴 編集中かどうかの印(台帳 #1852、依頼 237 = A)。スマホの画面では、編集中は中央の帯の保存 / やめるだけにする(CSS が読む)
    this.region.toggleAttribute('data-pkc-lock-editing', mode.kind === 'editing');
    this.resolve.hidden = mode.kind !== 'editing';
    this.discard.hidden = mode.kind !== 'editing';
    this.release.hidden = mode.kind !== 'writing';
    if (mode.kind === 'editing') {
      /**
       * 🔴 **1 語だけにする**(C4 / #1038 段 D)。⚠ 直す前は「このノートは編集中
       * です。「編集を保存する」か「編集をやめる」を押すと追記できます。」という
       * 文だったが、「編集中」は画面の下の 1 行(`status-line.ts`)も言うように
       * なったので、同じ状態を 2 通りの言葉で言わない。保存 / キャンセルの出口
       * (`resolve` / `discard`)は隣に出したままなので、押すものは減らない。
       */
      this.lockText.textContent = EDITING_STATE_WORD;
    } else if (mode.kind === 'writing') {
      this.lockText.textContent = '追記を書き込んでいます…(返ってこないときは「書き込みを打ち切る」)';
    }
    // ⚠ **器を出した後**に当てる ── `hidden` のままの欄には焦点が乗らない
    this.focusIfPending(mode);
    this.focusIfRequested(mode);
  }

  /**
   * 🔴 **「今日」で既に在るノートを選んだあと、追記欄にカーソルを置く**(#1087 流れ 29)。
   * ⚠ 上の `focusIfPending` と違い、**押した本人の頼み**なので焦点がどこに在っても置く
   *   (「今日」を押した直後は、題名の探す欄などに焦点が残っていることがある)。
   * ⚠ 指で触るだけの端末では置かない(ソフトキーボードが本文を隠す ── 編集の題名と同じ規則)。
   */
  private focusIfRequested(mode: AppendMode): void {
    if (mode.kind !== 'ready' || !takeAppendFocus(mode.lid)) return;
    if (isTouchOnly()) return;
    this.input.focus();
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
   * 追記先の一覧を本文から作り直す(#395 段①)。
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
    // 🔑 本文が前回と同じ字なら見出しを拾い直さない(#1087)── 状態が動くたびに本文全体を走査していた
    if (body === this.targetBody) return;
    this.targetBody = body;
    const heads = listAppendTargets(body);
    const sig = heads.map((h) => `${h.level}:${h.slug}:${h.text}`).join('\u0001');
    if (sig === this.targetSig) return;
    this.targetSig = sig;
    // 🔑 選んでいた物を覚えておいて、まだ在れば戻す
    const keep = this.desiredTarget ?? this.target.value;
    this.desiredTarget = null;
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
    // 通った(または空にした)ノートの預かりは要らない ── 戻ってきて古い字が出ない
    if (this.lastLid !== null) this.drafts.delete(this.lastLid);
    this.fitToContent();
    if (!refoldPeeked(this.region)) this.input.focus();
  }
}
