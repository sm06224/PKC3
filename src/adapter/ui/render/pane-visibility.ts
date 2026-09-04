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

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** ⚠ 読むたびに保存を見る(書き手が複数 ── UI と smoke の仕込み)。 */
  getHidden(): PaneId[] {
    if (this.detached) return this.fallback;
    try {
      return decodeHidden(this.storage?.getItem(KEY) ?? null);
    } catch {
      return this.fallback;
    }
  }

  setHidden(hidden: readonly PaneId[]): PaneId[] {
    const next = decodeHidden(encodeHidden(hidden));
    this.fallback = next;
    if (this.detached) return next;
    try {
      this.storage?.setItem(KEY, encodeHidden(next));
    } catch {
      // 保存できないだけ ── この session では効いている
    }
    return next;
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
