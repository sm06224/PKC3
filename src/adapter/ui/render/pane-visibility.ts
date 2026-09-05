/**
 * 畳んだペインの保存と適用(#197)。意味論は `features/pane-visibility.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.editor-mode` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の見え方である。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 全部見えている側に落ちる
 *   (畳まれた状態で復帰できないほうが害が大きい)。
 */
import { fitColumnHeight } from './read-columns';
import {
  COLUMN_PANES,
  decodeHidden,
  encodeHidden,
  togglePane,
  type ColumnPaneId,
  type PaneId,
} from '@features/pane-visibility';
import { appPhone } from './phone-layout';

/** ⚠ 列の畳みだけをスマホで落とす ── 表は `features` 側の 1 本を引く。 */
const COLUMN_SET: ReadonlySet<PaneId> = new Set<ColumnPaneId>(COLUMN_PANES);

const KEY = 'pkc3.panes';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class PaneVisibilityStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: PaneId[] = [];
  /** 🔴 この窓の畳みを端末の記録から切り離したか(下の `sessionOnly`)。 */
  private detached = false;
  /**
   * 🔴 **こちらが一時的に見せているペイン**(#655 ①)。端末の記録には触れない。
   * ⚠ 1 枚だけ ── いま使うのは追記欄(`append`)で、同時に 2 枚を一時的に見せる
   *   場面は無い(要るときに増やす。先に器だけ広げない)。
   */
  private peeking: PaneId | null = null;
  /**
   * 🔴 **窓が低いあいだ、こちらが畳んでいるペイン**(#701。user 裁定 2026-09-04 案 A)。
   * ⚠ 端末の記録には**書かない**(`peek` と同じ作法)── 窓を高くすれば何も無かったように出る。
   * ⚠ 1 枚だけ(いま使うのは追記欄)。書き手は `append-autofold.ts` の 1 か所。
   */
  private auto: PaneId | null = null;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * いま畳んでいる物(= 画面に写す物)。⚠ 一時的に見せている物(`peeking`)は
   * **記録に在っても外して返す** ── 読む側は「畳まれているか」を聞いているので、
   * 見せているのに畳まれていると答えると、`toggle` が「戻す」側へ倒れる。
   */
  getHidden(): PaneId[] {
    const stored = this.storedHidden();
    return this.peeking === null ? stored : stored.filter((id) => id !== this.peeking);
  }

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  private storedHidden(): PaneId[] {
    const base = this.detached ? this.fallback : this.readRecord();
    // 🔑 こちらの畳み(`auto`)は記録の**上に重ねて**読む ── 記録そのものには無い
    if (this.auto === null || base.includes(this.auto)) return base;
    return decodeHidden(encodeHidden([...base, this.auto]));
  }

  private readRecord(): PaneId[] {
    try {
      return decodeHidden(this.storage?.getItem(KEY) ?? null);
    } catch {
      return this.fallback;
    }
  }

  /**
   * @returns 画面に写す物(`getHidden` と同じ ── 一時的に見せている物は外してある)
   */
  setHidden(hidden: readonly PaneId[]): PaneId[] {
    /**
     * 🔴 **一時的に見せている物は、記録では畳まれたまま**(#655 ①)。
     *
     * ⚠ 呼び側の一覧は `getHidden()`(見せている物を外した形)から組まれる ── そのまま
     *   記録すると、**別のペインを 1 回畳んだだけで** user の畳みが記録から消える
     *   (「探す」の近道が左を戻す / 集中モード / 帯の下限割れ、どれも同じ形)。
     * 🔑 一覧に**その物が入っている**ときだけ「畳む頼み」と読み、一時表示を終える
     *   ── 見せている欄の帯を押した人は、見えている物を畳みたいのである。
     */
    const peek = this.peeking;
    let record: readonly PaneId[] = hidden;
    if (peek !== null) {
      if (hidden.includes(peek)) this.peeking = null;
      else record = [...hidden, peek];
    }
    /**
     * 🔴 **こちらが畳んでいる物は記録に書かない**(#701)── 一覧に**入っていない**なら
     *   user が「戻す」を押した(掴んで広げた)ので、こちらの畳みは終わる。入っているなら
     *   記録からは外して書く(スマホを横に倒した 1 回が PC の見え方を変えない)。
     */
    const auto = this.auto;
    if (auto !== null) {
      if (!hidden.includes(auto)) this.auto = null;
      else record = record.filter((id) => id !== auto);
    }
    const next = decodeHidden(encodeHidden(record));
    this.fallback = next;
    if (!this.detached) {
      try {
        this.storage?.setItem(KEY, encodeHidden(next));
      } catch {
        // 保存できないだけ ── この session では効いている
      }
    }
    return this.peeking === null ? next : next.filter((id) => id !== this.peeking);
  }

  /**
   * 🔴 **畳んであるペインを、一時的に見せる**(#655 ①。user 裁定 2026-09-04 案 B)。
   *
   * ## 物語
   *
   * 「閲覧メインだから」と追記欄を畳んでいる人が、本文を読んでいて「ここに追記する」を
   * 押す。⚠ 直す前はここで `setHidden` を呼んでいたので、**user が自分で畳んだ設定を
   * こちらが黙って上書きして永続していた** ── 1 行足したいだけだったのに、次に開いた
   * ときも追記欄が出ている。
   *
   * 🔑 だから記録(`pkc3.panes`)には **1 byte も書かず**、見せるだけにする。
   *   送り終えたら(または欄の外で 1 操作したら)`unpeek` で元どおり畳む。
   * ⚠ 「無い環境の控え」「窓の切り離し」と**同じ器**に置く ── 畳みの台帳を 2 本にしない。
   *
   * @returns 新しく見せたら `true`(畳んでいなかった / もう見せているなら `false`)
   */
  peek(id: PaneId): boolean {
    if (this.peeking === id || !this.storedHidden().includes(id)) return false;
    this.peeking = id;
    return true;
  }

  /** 一時的に何かを見せているか(`peek` の後、`unpeek` / 畳む前)。 */
  isPeeking(): boolean {
    return this.peeking !== null;
  }

  /**
   * 🔴 **窓の高さに合わせて、こちらが畳む / 畳みをやめる**(#701)。書き手は
   *   `append-autofold.ts` の 1 か所。`null` で「こちらの畳みは無し」。
   * ⚠ 小窓(`sessionOnly` の後)では**何もしない** ── 追記のための窓に打つ欄が無い、を作らない。
   * ⚠ 見せている物(`peeking`)がその物なら、畳みをやめた時点で一時表示も終える
   *   (見せる理由が無くなるので ── 残すと、次の `unpeek` が畳んでいない物を畳む)。
   */
  setAutoFold(id: PaneId | null): void {
    if (this.detached) return;
    this.auto = id;
    if (id === null && this.peeking !== null && !this.storedHidden().includes(this.peeking))
      this.peeking = null;
  }

  /**
   * **こちらが**畳んでいる物か(帯の字「ここに追記する」を出す / 押したら一時表示にする判定)。
   * ⚠ user が自分でも畳んでいる(記録に在る)なら `false` ── その畳みは user の物なので、
   *   帯の字も出さず、押せば今までどおり「戻す」(記録から外す)。
   */
  isAutoFolded(id: PaneId): boolean {
    if (this.auto !== id) return false;
    const record = this.detached ? this.fallback : this.readRecord();
    return !record.includes(id);
  }

  /**
   * 一時的に見せていた物を、元どおり畳む。
   * @returns 畳み直した後の一覧(呼び側はそのまま `applyPaneVisibility` へ渡す)。
   *          何も見せていなければ `null`(画面に触る理由が無い)
   */
  unpeek(): PaneId[] | null {
    if (this.peeking === null) return null;
    this.peeking = null;
    return this.getHidden();
  }

  /**
   * 🔴 **この窓の畳みを、端末の記録から切り離す**(#690 ② A′、user 裁定 2026-09-04)。
   *
   * ## 物語
   *
   * 本体の窓で「閲覧メインだから」と追記欄を畳んでいる人が、付箋を開く。
   * 付箋の売りは「隅に置いて追記欄にどんどん書き足せる」なのに、⚠ 直す前は
   * **端末の記録が付箋にもそのまま効いて**、本文の下に 8px の帯だけが出ていた ──
   * 追記したくて開いた窓に、打つ欄が無い。
   *
   * 🔑 だから付箋では `reveal`(追記欄)を**必ず出した状態で始める**。
   * ⚠ その窓で帯を押して畳むことは**できる**(帯はこれまでどおり効く)── ただし
   *   その畳みは**端末の記録へ書かない**(閉じると忘れる)。書くと、付箋で畳んだ
   *   1 回が**本体の窓の見え方まで変える** ── 本体の畳み方には触らない。
   * ⚠ 以後この窓では `getHidden` / `setHidden` とも**記憶だけ**を見る ── 記録を
   *   読み続けると、本体の窓で畳み直した瞬間に付箋の追記欄も消える。
   * ⚠ 「無い環境の控え」(`fallback`)と同じ器を使う ── 2 本目の台帳を作らない。
   *
   * @returns 切り離した時点の畳み(呼び側はそのまま `applyPaneVisibility` へ渡す)
   */
  sessionOnly(reveal: PaneId): PaneId[] {
    // ⚠ こちらの畳み(#701)も外す ── 小窓は追記欄を必ず出す(以後 `setAutoFold` は効かない)
    if (this.auto === reveal) this.auto = null;
    const seed = this.getHidden().filter((id) => id !== reveal);
    this.detached = true;
    this.fallback = decodeHidden(encodeHidden(seed));
    return this.fallback;
  }

  toggle(id: PaneId): PaneId[] {
    return this.setHidden(togglePane(this.getHidden(), id));
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appFlags` と同じ規律)。 */
export const appPanes = new PaneVisibilityStore();

/**
 * 🔴 **こちらが一時的に見せていたペインを、元どおり畳んで画面へ写す**(#655 ①)。
 *
 * ⚠ 呼び手は 2 つ ── 追記が**通った**とき(`append-box.ts`)と、欄の外で
 *   **1 操作した**とき(`binder.ts` の `run`)。判定は `appPanes` の 1 か所、
 *   適用は `applyPaneVisibility` の 1 か所で、ここは 2 つを繋ぐだけである。
 * ⚠ `at` は shell の**中でも外でも**よい ── 追記欄の描画器は器の中に居るので
 *   `closest` で shell へ登り、その親を `applyPaneVisibility` の root にする
 *   (binder の `root` はもとより shell の外なので、そのまま使う)。
 *
 * @returns 畳み直したら `true`(何も見せていなければ `false` ── 画面には触らない)
 */
export function refoldPeeked(at: HTMLElement): boolean {
  const hidden = appPanes.unpeek();
  if (hidden === null) return false;
  const shell = at.closest<HTMLElement>('[data-pkc-region="shell"]');
  applyPaneVisibility(shell?.parentElement ?? at, hidden);
  return true;
}

/**
 * 🔴 **畳んだ状態を画面へ写す**(器 1 か所)。CSS は
 * `[data-pkc-hidden-panes~='sidebar']` で列を落とす。
 *
 * ⚠ **`hidden` を付けない** ── grid の area を消すのは CSS の仕事で、
 * 器に `hidden` を付けると「戻す」ボタン(中央の帯)まで巻き添えを食う設計に
 * 引き寄せられる。ここは属性 1 本に留める。
 * ⚠ 押しボタンの `aria-pressed` も同時に更新する ── 見た目だけ変えて読み上げに
 * 出さないと、畳んだことが読み上げ利用者に届かない。
 */
export function applyPaneVisibility(root: HTMLElement, hidden: readonly PaneId[]): void {
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]');
  if (!shell) return;
  /**
   * 🔴 **スマホ用画面では「列を畳んだ」を画面へ写さない**(#632 段①、設計 doc §2-9)。
   *
   * ⚠ スマホには**列が無い**(一覧 / 本文 / 情報が同じセルに重なって 1 枚ずつ出る)ので、
   *   畳む対象がそもそも居ない。それでも属性を書くと、`[hidden-panes~='sidebar']` の
   *   `display: none` が当たって**一覧ページが真っ白になる** ── #609 の行き止まり
   *   (畳んだ事実は保存に残るのに、狭い窓には戻す口が 1 つも無い)がそのまま再演する。
   * 🔑 **消さずに写さないだけ** ── 保存値(`pkc3.panes`)は触らないので、
   *   窓を広げて PC の版面へ戻れば畳んだ状態はそのまま効く。
   * 🔑 **追記欄(`append`)だけは通す** ── あれは中央の**中**の上下の畳みで、
   *   スマホでも境目が縦に残っている(掴む帯も出したままなので、戻す口がある)。
   *   ⚠ ここで一緒に落とすと、user 指示 2026-08-27「閲覧メインで使う時は消したい」の
   *   道がスマホでだけ死ぬ。
   * ⚠ 判定は `appPhone` **1 か所**を読む ── shell の属性を読む形にすると、
   *   boot で属性を書く前にここが走った回だけ列が畳まれる(順番で守る形になる)。
   */
  const shown = appPhone.isPhone() ? hidden.filter((id) => !COLUMN_SET.has(id)) : hidden;
  const value = encodeHidden(shown);
  if (value === '') shell.removeAttribute('data-pkc-hidden-panes');
  else shell.setAttribute('data-pkc-hidden-panes', value);
  /**
   * 🔴 **こちらが畳んでいる追記欄には、「ここに追記する」の帯を出す**(#701)。
   * ⚠ user が自分で畳んだ回には出さない ── あれは「閲覧メインだから消したい」で、
   *   帯の字を毎回見せるのは頼まれていない。こちらが黙って畳んだ回だけ、戻す口を字で示す。
   * ⚠ 印は shell の属性 1 つ ── CSS はこれを読んで取っ手を 1 行の帯に変える。
   */
  const autoBand = appPanes.isAutoFolded('append') && shown.includes('append');
  if (autoBand) shell.setAttribute('data-pkc-append-autofold', '');
  else shell.removeAttribute('data-pkc-append-autofold');
  for (const btn of root.querySelectorAll<HTMLElement>('[data-pkc-action="toggle-pane"]')) {
    const id = btn.getAttribute('data-pkc-pane');
    if (id === null) continue;
    btn.setAttribute('aria-pressed', shown.includes(id as PaneId) ? 'false' : 'true');
  }
  /**
   * 🔴 **畳んだら段組みを採り直す**(#525。2026-08-28)。
   *
   * ⚠ 直す前、**ペインの開閉は段組みの引き金として名指しされていなかった** ──
   *   `installColumnFit()` が見張るのは ①面の `ResizeObserver` ②③④⑤ 各種の
   *   `MutationObserver` で、開閉は**①が偶然拾っていただけ**である
   *   (面の幅が変わるから)。
   * 🔑 同じ file の別の所(`read-columns.ts` の文字の大きさの節)が
   *   「いま救っているのは**設計が効き切っていないという偶然**である」と
   *   自ら書いている ── その形をここでも畳む。
   *
   * ⚠ **体感は変わらない。** 実測した遅れは **1 フレーム(25ms)**で、
   *   観測 4 走とも同じだった ── 買うのは「偶然に頼らない」という規約だけである。
   *   🔑 それでも積む(user 指示「効果が小さいからやらない、を結論にしない」)。
   * ⚠ **呼び元を増やさない** ── 畳む口は 5 か所ある(`binder.ts` の toggle と
   *   フォーカスモード / `pane-resize.ts` の下限割れ 2 か所 / `main.ts` の復元)。
   *   そのどれかに書くと**判定が 5 か所に散る**(CLAUDE.md §7)ので、
   *   **画面へ写す 1 か所**であるここに置く。
   */
  fitColumnHeight(root, root.ownerDocument);
}
