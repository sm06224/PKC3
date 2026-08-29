/**
 * 読む面の段組みの保存・適用・送り(#505 段①)。意味論は `features/read-columns.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.page-format` / `pkc3.text-scale` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見え方**である
 *   (#505「憶えるのは**ノートごとではなく画面の設定**」)。
 *
 * 🔑 当て方は `text-scale.ts` と**同じ形**にする(属性 1 つ + CSS 変数)──
 *   2 本目の作法を作らない(CLAUDE.md §7)。
 */
import {
  columnsFit,
  effectiveColumns,
  minWidthForColumns,
  nextReadColumns,
  READ_COLUMN_BASE_FONT_PX,
  DEFAULT_READ_COLUMNS,
  isReadColumns,
  readColumnsSpec,
  wheelToInline,
  type ReadColumns,
} from '@features/read-columns';
// ⚠ 綴りを写さない ── 見張る属性の正本は当てている側に在る(CLAUDE.md §7)
import { TEXT_SCALE_ATTR } from './text-scale';

const KEY = 'pkc3.read-columns';

/** 🔴 **当たっている段数の印**。CSS が読み、smoke と設定画面が同じ物を見る。 */
export const READ_COLUMNS_ATTR = 'data-pkc-read-columns';
/** `app.css` の `columns: calc(1em * 448 / 13) var(--pkc-read-cols, 1)` と 1 対 1。 */
export const READ_COLUMNS_VAR = '--pkc-read-cols';
/**
 * ⚠ かつて最小幅とすき間も変数で渡していたが、**変異試験 M9 / M14 が SURVIVED** で
 *   「渡さなくても何も変わらない」= 同じ数字を 2 か所に置いていただけ、と分かった。
 *   いまは `app.css` のリテラルが実体で、`features/read-columns.ts` の定数との
 *   一致は test が突合する(2026-08-28)。
 */
/**
 * 🔴 **段組みが実際に効いている面の印**(器に付く)。
 * ⚠ 根の `data-pkc-read-columns`(= user の選択)とは**別物**である ──
 *   選んでいても器が狭ければ効かない。CSS が見るのは**こちら**。
 */
export const COLUMNS_ON_ATTR = 'data-pkc-columns-on';

/**
 * 🔴 **段の高さを CSS へ渡す変数**(#527)。⚠ **パーセントでは効かない**ので px で渡す
 * (多段組の中では高さのパーセントが解決できない ── 実測)。
 * ⚠ 予備の値を書かない `var()` は**宣言ごと捨てられる**ので、当てる側は必ず既定を書く
 * (`app.css` の `var(--pkc-col-h, none)`)。
 */
export const COLUMN_H_VAR = '--pkc-col-h';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存されている段数(起動時の初期値)。⚠ 読めなければ既定(1 段)。 */
export function initialReadColumns(): ReadColumns {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isReadColumns(v) ? v : DEFAULT_READ_COLUMNS;
  } catch {
    return DEFAULT_READ_COLUMNS;
  }
}

/**
 * いま当たっている段数(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**(`text-scale.ts` と同じ)。
 */
export function currentReadColumns(target: HTMLElement): ReadColumns {
  const v = target.getAttribute(READ_COLUMNS_ATTR);
  return v !== null && isReadColumns(v) ? v : DEFAULT_READ_COLUMNS;
}

/**
 * 当てる。⚠ **保存しない**(保存は `chooseReadColumns` だけが持つ)。
 *
 * ⚠ **印は 1 段のときも書く** ── 「属性が無い = 1 段」にすると、CSS 側が
 *   `:not([...])` で書けず、smoke も「消えた」と「そもそも付いていない」を
 *   見分けられない(CLAUDE.md §1「代替物で満たせるガードにしない」)。
 */
export function applyReadColumns(target: HTMLElement, cols: ReadColumns): void {
  const spec = readColumnsSpec(cols);
  target.setAttribute(READ_COLUMNS_ATTR, spec.id);
  target.style.setProperty(READ_COLUMNS_VAR, String(spec.count));
}

/** user が選んだ ── 当てて**保存する**。 */
export function chooseReadColumns(target: HTMLElement, cols: ReadColumns): void {
  applyReadColumns(target, cols);
  try {
    readStorage()?.setItem(KEY, cols);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}

/**
 * 段組みの本文が入る器(横送りの持ち主)。
 *
 * 🔴 **編集中も対象にする**(#523。user 指示 2026-08-28
 * 「**段組のままでインライン編集がしたい**」)。
 *
 * ⚠ 直す前は `detail-mode="view"` だけを見ていた ── 編集へ入った瞬間に
 *   印も段の高さも付かなくなるので、**段組みが丸ごとほどけた**。
 *   ⚠ その判断はこちら側が下したもので(「user の字が『閲覧時に』だから」)、
 *   今回の要望と正面から食い違っていた。
 *
 * 🔑 **1 面(live)だけが対象になるのは、この選択子の副作用ではなく構造である** ──
 *   live は本文の中の塊 1 つを `<textarea>` に差し替えるので器が
 *   `editor-live` 1 枚で済むが、2 ペインは `editor-split` を組んで
 *   **全文 1 枚の `<textarea>`** を置くため、ここに 1 つも当たらない
 *   (当たらなければ下の `off()` へ落ちて、これまでどおり段組みは切れる)。
 * ⚠ だから 2 ペインを名指しで除外する条件は**書かない** ── 書くと
 *   「同じ判定が 2 か所」になる(CLAUDE.md §7)。
 */
export function columnScroller(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[data-pkc-detail-mode="view"] [data-pkc-field="detail-body"],' +
      '[data-pkc-detail-mode="editor"] [data-pkc-region="editor-live"]',
  );
}

/**
 * 段組みの親(器)。
 * ⚠ 編集中も返す ── 実際に段組みにするかは、上の `columnScroller` が
 *   本文の器を見つけられたかで決まる(2 ペインは見つからない)。
 */
function viewPane(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[data-pkc-view-pane="detail"][data-pkc-detail-mode="view"],' +
      '[data-pkc-view-pane="detail"][data-pkc-detail-mode="editor"]',
  );
}

/**
 * 🔴 **段の高さを px で決める**(#505。**これが無いと本文が黙って消える**)。
 *
 * ⚠ 実測(2026-08-28、2560×900・40 段落・2 段):
 *
 * | 高さの決め方 | `scrollWidth` | 下へのはみ出し |
 * |---|---|---|
 * | `flex: 1 1 auto` | 1679(= 器と同じ = **送れない**) | 🔴 **87px 見えない** |
 * | `flex: 1 1 0` | 1679(**送れない**) | 🔴 **87px 見えない** |
 * | `height: 0` + `flex-grow: 1` | 36431 = 🔴 **段が 42 本に爆発** | ─ |
 * | **明示 px**(これ) | 2527 ✅ | ✅ 無し |
 *
 * 🔑 理由は「**確定した高さ**でないと、ブラウザは段を増やさず縦へ溢れさせる」こと。
 *   溢れた分は `overflow-y: hidden` が刈るので、**画面から本文が消えて誰も気づかない**
 *   (CLAUDE.md が繰り返し踏んでいる「静かに壊れる」向き)。
 *
 * @returns 実際に当てた高さ(px)。段組みでないときは `null`(inline の高さを外す)
 */
/**
 * 🔴 **最後に採れた「読む面」の採寸**(#551、2026-08-29)。
 *
 * ⚠ 設定画面が出ている間、読む面は `hidden` = **幅 0** である
 *   (`center.ts` が面を排他で出し、`app.css` の `[hidden] { display: none !important }`)。
 *   そのため設定の「いまの画面では N 段で出ています」は **常に空文字**だった
 *   ── #526 で足した注記が、**配った日から 1 度も出ていなかった**(test も 0 件)。
 * 🔑 **測る場所を 2 か所に作らない**(CLAUDE.md §7)── ここが既に測っているので、
 *   その値を憶えて設定に読ませる。設定が独自に採寸すると、
 *   「段組の判定」と「設定の表示」が**別々の規則**になる。
 * ⚠ **採れた回だけ更新する** ── 0 を憶えると、畳んだ瞬間に嘘になる。
 */
let lastPaneMetrics: { width: number; fontPx: number } | null = null;

/** 最後に採れた読む面の採寸(まだ 1 度も採れていなければ `null`)。 */
export function lastReadPaneMetrics(): { width: number; fontPx: number } | null {
  return lastPaneMetrics;
}

/**
 * 🔴 **段組みが畳まれたことを、user に言う**(#551。user 報告 2026-08-29)。
 *
 * > user の言葉:「**段組表示の際、左右のペインサイズを変化させると、
 * >  段組の境界線が壊れる**」
 *
 * ⚠ 実測すると「線が壊れる」ではなく **段組みごと黙って消えていた** ──
 *   仕切りを動かして器が 912px を割った瞬間、`columnsFit` が false になり、
 *   縦送りの 1 本の長文へ戻る。**予告も説明も画面に 1 文字も出ない**。
 * 🔑 畳むこと自体は**正しい設計**である(#505。CSS 任せだと段数だけ 1 に落ちて
 *   横送りが残る)── 直すのは**黙っていること**のほうである。
 *   CLAUDE.md「欠陥の多くは**さっきまでやっていたことが消える**形で出る」。
 *
 * ⚠ **新しい見え方を作らない** ── 出すのは `cycleReadColumns` が既に使っている
 *   画面下の帯で、文言もそちらと同じ形にする(要る幅を px で言う)。
 */
let foldNotify: ((text: string) => void) | null = null;

/** 段組みの状態。 */
type FoldState = 'columns' | 'folded' | 'single';

/** 段組みの状態。⚠ `null` = まだ 1 度も判定していない(起動直後)。 */
let foldState: FoldState | null = null;

/** 帯へ出す口を配る(`main.ts` が起動時に 1 度だけ呼ぶ)。 */
export function setColumnFoldNotify(fn: ((text: string) => void) | null): void {
  foldNotify = fn;
}

/** ⚠ test 用 ── 状態を「まだ判定していない」へ戻す。 */
export function resetColumnFoldState(): void {
  foldState = null;
}

/**
 * 状態が**変わったときだけ**言う。
 *
 * ⚠ **起動直後は言わない**(`prev === null`)── 狭い画面で開いただけで
 *   帯が出ると、user は「自分が何かした」と読む。
 * ⚠ **1 段を選んでいるときは言わない** ── 畳まれたのではなく、そう選んでいる。
 * ⚠ 面が居ない・採寸できない回は**状態を触らない**(2 ペイン編集へ入って
 *   戻ってきただけで帯が出るのを防ぐ)。
 */
function noteFoldState(next: FoldState, say: (prev: FoldState) => string | null): void {
  const prev = foldState;
  foldState = next;
  if (prev === null || prev === next || foldNotify === null) return;
  const text = say(prev);
  if (text !== null) foldNotify(text);
}

export function fitColumnHeight(root: ParentNode, doc: Document = document): number | null {
  /**
   * ⚠ **面は「読む面かどうか」に関わらず引く** ── 編集へ入ったときに印を
   *   外せないと、DOM が「段組み中」と嘘をつく(変異試験 M10 が教えた)。
   */
  const anyPane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]');
  const host = columnScroller(root);
  const pane = viewPane(root);
  const off = (): null => {
    // ⚠ 読む面が居なくても、印は**居る面から**外す
    (pane ?? anyPane)?.removeAttribute(COLUMNS_ON_ATTR);
    host?.style.removeProperty('height');
    // ⚠ **高さの変数も外す**(#527)── 残すと、段組みを切った後の縦送りの面でも
    //    図が段の高さに縮む(印だけ外して変数を残す = DOM が嘘をつく形)
    host?.style.removeProperty(COLUMN_H_VAR);
    return null;
  };
  // ⚠ 切るときは**印も高さも外す** ── どちらかが残ると、縦送りの面が刈られる
  if (host === null || pane === null) return off();
  const count = readColumnsSpec(currentReadColumns(doc.documentElement)).count;
  const before = pane.getBoundingClientRect();
  // ⚠ 採寸できない環境(happy-dom / 畳んだ面)では触らない ── 0px にすると本文が消える
  if (before.height === 0 || before.width === 0) return null;
  /**
   * 🔑 **採れた採寸を憶える**(#551)── 設定画面はここを読む。
   * ⚠ 0 の回は上で返しているので、ここへ来た値は必ず有効である。
   */
  {
    const fp = Number.parseFloat(getComputedStyle(host).fontSize);
    if (Number.isFinite(fp) && fp > 0) lastPaneMetrics = { width: before.width, fontPx: fp };
  }
  /**
   * 🔴 **2 段置けないなら段組みごと止める**(#505「狭い画面で壊れない」)。
   * ⚠ CSS の `columns` に任せると段数だけ 1 へ落ちて**横送りが残る** ──
   *   ノート PC で「横スクロールで 1 段ずつめくる」画面になっていた(実測)。
   * 🔑 幅は印を付けても変わらない(印が変えるのは**高さ**)ので、ここで決めてよい。
   *
   * 🔴 **畳む境目も、文字の大きさに載せる**(#509)。
   *
   * ⚠ CSS 側は `calc(1em * 448 / 13)` で段の幅を決めているので、ここが
   *   固定 448px のままだと**2 つが食い違う** ── 特大(17px)で
   *   912px の器を「2 段置ける」と判断し、CSS は 586px の段を 1 本しか
   *   置けないので、**横送りだけが残る**(#505 で 1 度出荷しかけた形)。
   * 🔑 だから**器そのものの `font-size` を採る** ── CSS の `1em` と
   *   同じ入力である(実測で `--pkc-text-size` と一致することを確かめた)。
   */
  const fontPx = Number.parseFloat(getComputedStyle(host).fontSize);
  const fp = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : READ_COLUMN_BASE_FONT_PX;
  const paneWidth = host.clientWidth || before.width;
  if (!columnsFit(paneWidth, count, fp)) {
    /**
     * ⚠ 要る幅は **2 段ぶん**で言う ── `columnsFit` が 2 段で判定しているので、
     *   ここで 3 段ぶんの数を出すと**帯だけ別の規則**になる(§7)。
     */
    noteFoldState(count <= 1 ? 'single' : 'folded', () =>
      count <= 1
        ? null
        : `幅が足りないので段組みをやめました(${count} 段には ${Math.ceil(
            minWidthForColumns(2, fp),
          )}px 以上の幅が要ります)`,
    );
    return off();
  }
  /**
   * ⚠ **「戻しました」は、幅で畳まれていたときだけ**(2026-08-29、着地前の smoke が
   *   既存の test を落として教えた)。1 稿目は**あらゆる遷移**で言っていたので、
   *   user が `Alt+C` で 1 段 → 2 段 と選んだ直後にも出て、
   *   🔴 **`cycleReadColumns` が出した「本文の段組み: 2 段」を上書きしていた**
   *   ── 押した答えが消える、いちばん困る形である(CLAUDE.md §10)。
   * 🔑 判定は `prev === 'folded'` 1 つ ── 自分で選んだ結果には黙る。
   */
  noteFoldState('columns', (prev) => {
    if (prev !== 'folded') return null;
    const eff = effectiveColumns(paneWidth, count, fp);
    return `段組みに戻しました(${eff} 段)`;
  });
  pane.setAttribute(COLUMNS_ON_ATTR, '');
  /**
   * 🔴 **印を付けた「後で」採り直す**(#505。ここで 1 度外した)。
   *
   * ⚠ 印は面を `flex: 1 0 auto`(中身の高さまで伸びる)から `flex: 1 1 0`
   *   (器の高さで止まる)へ変える ── つまり**印を付けた瞬間に面の高さが変わる**。
   *   印より前に採った値を使うと、**伸びていた頃の高さ**(実測 1330px。正しくは
   *   568px)を入れることになり、本文が 2 段に収まって**横へ送れない**。
   * ⚠ この誤りは**見張りが後から採り直して直す**ので、症状は
   *   「たまに段にならない」という間欠の顔で出た(4 走中 2 走)──
   *   直すまで 2 度、待ちの側を疑って外した。
   */
  const paneRect = pane.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const cs = getComputedStyle(pane);
  const inset =
    (Number.parseFloat(cs.paddingBottom) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0);
  const avail = Math.floor(paneRect.bottom - inset - hostRect.top);
  if (!Number.isFinite(avail) || avail <= 0) return off();
  const next = `${avail}px`;
  // ⚠ 同じ値なら書かない ── 書くと ResizeObserver がまた鳴って回り続ける
  if (host.style.height !== next) host.style.height = next;
  /**
   * 🔴 **段の高さを CSS へ下ろす**(#527。2026-08-28)。
   *
   * ⚠ これが無いと、**縦に長い図と写真が段からはみ出して消える** ── 実測で
   *   3 段のとき図の **82%**(2345px)が刈られ、user には**戻す手段が 1 本も無い**
   *   (縦のホイールは横送りへ読み替えられ、`overflow-y: hidden` なので
   *   スクロールバーも出ず、器の外は `elementFromPoint` にも当たらない)。
   * 🔑 これは `:108-121` が 1 度直した「**画面から本文が消えて誰も気づかない**」と
   *   **同じ穴の別経路**である。
   *
   * ⚠ **パーセントでは効かない**(実測)── 多段組の中では高さのパーセントが
   *   解決できないので、**px で下ろす**必要がある。
   * 🔑 ついでに「図を保存」が別の段へ落ちる件も直る ── 実測すると、離れ始める
   *   境目は**ちょうど図が段より高くなったとき**(522px)で、根が同じである。
   *   ⚠ `break-inside: avoid` は効かない(段より高い箱は指示しても割られる)。
   */
  if (host.style.getPropertyValue(COLUMN_H_VAR) !== next)
    host.style.setProperty(COLUMN_H_VAR, next);
  return avail;
}

/**
 * 🔴 **順ぐりに段数を変えて、いま何段になったかを言う**(#522 + #526)。
 *
 * 🔑 **2 つの user 報告を 1 か所で解く**:
 *   - #522「**段組表示の切替導線をショートカットに用意したい**」
 *   - #526「**2〜4 のどの数字を選んでもレンダリングは変わらなかった それはバグ?**」
 *
 * ⚠ 後者は**バグではない** ── CSS は `columns: <1 段の下限> <段数>` なので
 *   ブラウザは**入る数だけ**作る。実測すると器が **928〜1390px のあいだは
 *   2/3/4 が全部 2 段**になる。決まっていなかったのは **user に言うこと**だけだった。
 * 🔑 だから**押した所で言う** ── 読みながら押す動線に、そのまま答えが載る。
 *
 * ⚠ **選んだ数は落とさない**(効かない段数へも回す)── いま狭くても、
 *   広い画面で開けば効く。「効く数だけ回す」形にすると、
 *   **狭い画面で選んだ設定が広い画面へ持って行けない**。
 */
export function cycleReadColumns(
  root: ParentNode,
  notify: (text: string) => void,
  doc: Document = document,
): void {
  const cur = currentReadColumns(doc.documentElement);
  const next = nextReadColumns(cur);
  chooseReadColumns(doc.documentElement, next);
  const spec = readColumnsSpec(next);
  const host = columnScroller(root);
  // ⚠ 採寸できないなら**数だけ言う**(嘘の「いま N 段」を出さない)
  const width = host?.getBoundingClientRect().width ?? 0;
  const fontPx = host === null ? 0 : Number.parseFloat(getComputedStyle(host).fontSize);
  if (spec.count <= 1) {
    notify('本文の段組み: 1 段');
    return;
  }
  if (width <= 0 || !Number.isFinite(fontPx) || fontPx <= 0) {
    notify(`本文の段組み: ${spec.count} 段`);
    return;
  }
  const eff = effectiveColumns(width, spec.count, fontPx);
  if (eff === spec.count) {
    notify(`本文の段組み: ${spec.count} 段`);
    return;
  }
  const need = Math.ceil(minWidthForColumns(eff <= 1 ? 2 : spec.count, fontPx));
  notify(
    eff <= 1
      ? `本文の段組み: ${spec.count} 段 ── いまの画面は幅が足りないので 1 段で出ています(${need}px 以上が要ります)`
      : `本文の段組み: ${spec.count} 段 ── いまの画面では ${eff} 段で出ています(${spec.count} 段には ${need}px 以上が要ります)`,
  );
}

/**
 * 🔴 **段の高さを、器の変化に追随させる**(#505)。
 *
 * ⚠ 見張るものが **3 つ**要る。1 つでも欠けると足りない:
 *   ① **器の大きさ**(窓のリサイズ・ペインの畳み)── `ResizeObserver`
 *   ② 🔴 **本文の器の入れ替え**(ノートを開き直すと `detail.ts` が骨組みごと
 *      作り直す)── 新しい器には inline の高さが無いので、**そのままだと刈られる**。
 *      `MutationObserver` の `childList` で捕まえる
 *   ③ 🔴 **判定の入力そのもの**(#509)── 段数(`data-pkc-read-columns`)と
 *      **文字の大きさ**(`data-pkc-text-scale`)である。
 *
 *      🔴 **段数のほうは載っていなかった**(実測 2026-08-28)── これを外すと
 *      「段数を選んだ直後」の印が**付かない**(器も骨組みも変わらないので①②が
 *      鳴らない)。設定画面から本文へ戻る道では面が出入りして救われていたが、
 *      **選んだ瞬間には効いていなかった**。
 *
 *      ⚠ **文字の大きさのほうは、外しても いまは壊れない**。素直に読むと
 *      「器の外寸は変わらないから①は鳴らない」はずだが、**実測では鳴った**
 *      (計装して数えたら `RO` が 2 回)── 面の高さが中身に追随しているためである。
 *      🔑 それでも**残す**。段組み中の面は `flex: 1 1 0` = **追随しない**のが設計で
 *      あり(上の CSS の①)、いま救っているのは**その設計が効き切っていない**
 *      という偶然だからである。⚠ 消すなら「文字を変えても面が 1px も動かない」
 *      test と対で消すこと ── そこが直った日に、症状は
 *      **特大の user にだけ横送りが残る**という形で静かに戻る。
 *
 * ⚠ **面 1 枚と、その親の直下だけ**を見る(document 全体を見張らない ── 常駐を
 *   作らない)。⚠ 1 稿目は `root` を `subtree: true` で見ており、**画面のどこが
 *   変わっても鳴る**状態だった(自分の docstring を自分で破っていた)。
 *
 * @returns 外す関数
 */
export function installColumnFit(root: HTMLElement, doc: Document = document): () => void {
  const fit = (): void => void fitColumnHeight(root, doc);
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const ro = RO === undefined ? null : new RO(fit);
  /** 面の中の見張り(骨組みの入れ替え・面の切替)。 */
  const inner = MO === undefined ? null : new MO(fit);
  /** 面そのものの出入り。 */
  const outer = MO === undefined ? null : new MO(() => rewatch());
  let watched: HTMLElement | null = null;

  function rewatch(): void {
    const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]');
    if (pane !== null && pane !== watched) {
      if (watched !== null) ro?.unobserve(watched);
      ro?.observe(pane);
      inner?.disconnect();
      /**
       * ⚠ 直下の子だけ(骨組みの組み直し)+ 面の切替 ── 本文の中の書き換えは見ない。
       *
       * ⚠ **この 2 行は変異試験 N / O が SURVIVED である。承知のうえで残している** ──
       *   いまの test では上の `ResizeObserver` が先に鳴って救う(ノートを開き直すのも
       *   編集へ入るのも、結果として**面の高さが変わる**ため)。
       * 🔑 だが救っているのは**高さが変わったという副作用**であって、
       *   「骨組みが変わった」「面が切り替わった」という**当の出来事ではない** ──
       *   高さが偶然同じ遷移が 1 つ出た日に、静かに外れる側である。
       *   ⚠ 消すなら「面の高さが変わらない切替」を作る test と対で消すこと。
       */
      inner?.observe(pane, { childList: true });
      inner?.observe(pane, { attributes: true, attributeFilter: ['data-pkc-detail-mode'] });
      watched = pane;
    }
    fit();
  }

  /**
   * ⚠ **`root` を `subtree: true` で見張らない**(1 稿目はそう書いていた)──
   *   それでは**画面のどこが変わっても**ここが鳴る = 常駐の重さを足すことになり、
   *   このモジュール自身の「面 1 枚だけを見る」という約束を破っていた。
   * 🔑 面(pane)は**中央の器の直下の子**なので、器を `childList` で見れば
   *   入れ替わりは捕まる(`subtree` は要らない)。
   */
  const center = root.querySelector<HTMLElement>('[data-pkc-region="detail"]') ?? root;
  outer?.observe(center, { childList: true });

  /**
   * 🔴 **判定の入力が変わったら測り直す**(#509)。
   *
   * ⚠ **`style` は見張らない** ── `applyTextScale` は属性と CSS 変数を**対で**書く
   *   ので、属性 1 つで足りる。`style` まで見ると、段の高さを入れる自分の書込
   *   (`host.style.height`)とは別の要素とはいえ、見張る面が無駄に増える。
   * ⚠ 見る先は `documentElement` ── `applyReadColumns` / `applyTextScale` が
   *   当てる先そのものである(2 か所目の当て先を作らない)。
   * ⚠ 属性の綴りも**写さない**(`TEXT_SCALE_ATTR` を引く)── 片方だけ改名されると
   *   見張りが静かに外れ、症状は「特大のときだけ たまに横送りが残る」になる。
   */
  const rootAttrs = MO === undefined ? null : new MO(fit);
  rootAttrs?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: [READ_COLUMNS_ATTR, TEXT_SCALE_ATTR],
  });

  /**
   * ⚠ かつて `resize` も聞いていたが、**変異試験 P が KILLED / Q が SURVIVED** で
   *   「窓を狭めたら `ResizeObserver` が先に鳴る」= 聞く必要が無いと分かった
   *   (2026-08-28)。⚠ 同じ物を 2 か所で見張らない(CLAUDE.md §7)。
   */
  rewatch();
  return () => {
    ro?.disconnect();
    inner?.disconnect();
    outer?.disconnect();
    rootAttrs?.disconnect();
  };
}

/**
 * 🔴 **縦のホイールで横へ送れるようにする**(#505。実測で必須と分かった)。
 *
 * ⚠ これが無いと、段組みは**マウスだけでは読めない** ── 縦のホイールでは
 *   1px も動かず(実測 1727 → 1727)、横ホイールを持つマウスは少数である。
 *   不可侵指示 2026-08-03「マウスだけで完結し、キーボードは近道」に当たる。
 *
 * 🔑 **器ごとに張らない。shell に 1 本**だけ張って、その都度いまの器を引く ──
 *   本文の器はノートを変えるたびに作り直されるので、器に張ると
 *   **張り直しを忘れた面だけ送れない**(§7 の「同じ判定が複数の場所にある」)。
 *
 * @returns 外す関数(呼ばなければ張りっぱなし ── shell と同じ寿命)
 */
export function installColumnWheel(root: HTMLElement, doc: Document = document): () => void {
  const onWheel = (ev: WheelEvent): void => {
    // ⚠ 1 段のときは**何もしない**(ふつうの縦送りを奪わない)
    if (currentReadColumns(doc.documentElement) === '1') return;
    const host = columnScroller(root);
    if (host === null) return;
    // ⚠ その器の中で起きたホイールだけ(右の情報ペインの送りを奪わない)
    const t = ev.target;
    if (!(t instanceof Node) || !host.contains(t)) return;
    /**
     * 🔴 **自分で縦に送れる物の上では、奪わない**(#523。2026-08-28)。
     *
     * ⚠ 編集中も段組みのままにした結果、**編集の箱がこの器の中に入った**。
     *   箱は段の高さで頭打ちになり、超えた分は**箱の中で送る**形なのに、
     *   ここが無条件に横送りへ読み替えると **箱の中を送る手段が消える** ──
     *   打った字が箱の中で見えないまま、マウスでは届かない。
     * ⚠ これは #527(図が段からはみ出して届かない)と**同じ形の穴**である
     *   ── 直した当人が、隣に 1 つ作りかけていた。
     * 🔑 判定は「**その物がまだその向きへ送れるか**」1 つ ── 送り切っていれば
     *   これまでどおり横へ流す(端で止まって外側が動かなくなる形を作らない)。
     * ⚠ `row-source` を名指ししない ── 名指しすると、器の中に別の
     *   送れる物(将来の面)が入ったとき同じ穴が戻る。
     */
    for (let n: Node | null = t; n !== null && n !== host; n = n.parentNode) {
      if (!(n instanceof HTMLElement)) continue;
      const room = n.scrollHeight - n.clientHeight;
      if (room <= 0) continue;
      const down = ev.deltaY > 0;
      if ((down && n.scrollTop < room) || (!down && n.scrollTop > 0)) return;
    }
    // ⚠ **送り切っていたら既定に返す** ── 端で止めると、外側の面が送れなくなる
    const dx = wheelToInline(ev.deltaX, ev.deltaY);
    if (dx === 0) return;
    const max = host.scrollWidth - host.clientWidth;
    if (max <= 0) return;
    const next = host.scrollLeft + dx;
    if ((dx < 0 && host.scrollLeft <= 0) || (dx > 0 && host.scrollLeft >= max)) return;
    ev.preventDefault();
    host.scrollLeft = Math.max(0, Math.min(max, next));
  };
  // ⚠ `passive: false` ── 既定を止めるので、明示しないと `preventDefault` が効かない
  root.addEventListener('wheel', onWheel, { passive: false });
  return () => root.removeEventListener('wheel', onWheel);
}
