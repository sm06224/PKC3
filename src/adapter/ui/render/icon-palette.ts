/**
 * 🔴 **目印を絵から選ぶ表**(#857 段② の裁定、2026-09-13)。
 *
 * > user 裁定:「**絵を並べた表にする**(タイルと同じ見た目 + いま付いている絵に枠)」
 *
 * ## なぜ取り出したか
 *
 * ⚠ 直す前、この表は **`detail.ts` の中の私有関数**だった(添付の設定の欄でしか
 *   使っていなかったので、それで足りていた)。段② で**グループの見出しにも**目印を
 *   置けるようにしたとき、小窓の側は「1 行選ぶ」の汎用の器へ**字だけの行**を流した
 *   ── 同じことをする 2 か所で、見た目が違う状態になっていた。
 *
 * 🔑 **小窓の側に 2 つ目の表を書かない。** 49 種の並べ方・「なし」の置き方・
 *   いま選んでいる物の示し方が **2 か所に散る**と、次に絵を 1 つ足した日に
 *   **片方だけ増える**(CLAUDE.md §7「同じ判定が複数の場所にある」)。
 *
 * ## ⚠ 押した後の行き先だけが違う
 *
 * | 使う所 | 押すとどうなるか |
 * |---|---|
 * | 添付の設定(`detail.ts`) | `data-pkc-action="pick-app-icon"` を binder が受ける |
 * | グループの小窓(`app-dialog.ts`) | その場で小窓が閉じて、選んだ値が返る |
 *
 * 🔑 だから**器は同じ、出口だけ呼び側が付ける**(`each`)。
 */
import { TILE_ICON_CHOICES } from '@features/icon/tile-icons';
import { iconSpan } from './icons';

/** 押し所に書く「どの絵か」。⚠ **空文字 = なし(外す)**。 */
export const ICON_NAME_ATTR = 'data-pkc-icon-name';

export interface IconPaletteSpec {
  /** いま付いている絵の名前(空なら「なし」に枠が付く)。 */
  readonly current: string;
  /** 表そのものに書く `data-pkc-field`。 */
  readonly field: string;
  /** 読み上げのための、この表の名前。 */
  readonly ariaLabel: string;
  /**
   * 先頭に「なし」を出すか(既定は出す)。
   *
   * ⚠ **出さないのは「入れる」ときだけ**(#853 段① ── 本文へ図案を挿し込む表)。
   *   そこには**外す物が無い**ので、「なし」は `::` という空の字を入れる押し所に
   *   なってしまう。
   * 🔑 **付ける表では必ず出す** ── 置けるなら外せなければならない(user 指示
   *   2026-08-23)。だから既定は `true` で、外す側が名乗る形にする。
   */
  readonly withNone?: boolean;
  /**
   * 押し所 1 つずつに呼ばれる ── **受け方は呼び側が決める**
   * (`data-pkc-action` を書くか、`click` を聞くか)。
   */
  readonly each: (btn: HTMLButtonElement, name: string) => void;
}

/**
 * 絵を並べた表を組む。
 *
 * ⚠ **図案だけのボタンにしている**(`icons.ts` の「図案だけのボタンを作らない」から外れる)
 *   ── ここの押し口は「操作」ではなく「**選ぶ対象そのもの**」で、文字を隣に置くと
 *   49 個ぶんの名前で面が埋まる(選ぶより読む面になる)。
 * 🔑 代わりに **`title` と読み上げの名前を必ず日本語で持たせる** ── 押す前に何か分かる
 *   道は残す。
 * ⚠ **先頭に「なし」** ── 置けるなら外せなければならない(user 指示 2026-08-23)。
 *   一覧の中に在るほうが、**押した所と同じ場所で戻せる**。
 *   ⚠ 出さないのは**入れるだけの表**(`withNone: false`)── 外す物が無いので、
 *     「なし」は空の字を入れる押し所になる(#853 段①)。
 * 🔑 いま選んでいる物は **`aria-pressed`(状態)で示す** ── 字を足さない
 *   (読み上げにも出るし、CSS が枠を描く)。
 */
/**
 * 🔑 **その字は、この表の中に在るか**(2026-09-13)。
 *
 * ⚠ 呼び側が `TILE_ICON_CHOICES` を直に読むと、**表を知っている所が 2 つ**になる
 *   ── 絵を 1 つ足した日に、片方だけが増える(§7)。だから判定もここが持つ。
 * ⚠ 空文字(= なし)は**表の中**である(先頭に在る)。
 */
export function isTableIcon(name: string): boolean {
  const n = name.trim();
  return n === '' || TILE_ICON_CHOICES.some((c) => c.name === n);
}

export function buildIconPalette(spec: IconPaletteSpec): HTMLElement {
  const now = spec.current.trim();
  const box = document.createElement('div');
  box.setAttribute('data-pkc-field', spec.field);
  /**
   * 🔴 **見た目の印は 1 つ**(2026-09-13)── CSS はこれ 1 つで当てる。
   * ⚠ `data-pkc-field` は**探すための名前**なので面ごとに違う(添付の設定 /
   *   グループの小窓)── そちらで CSS を当てると、**次に表を足した日に
   *   付け忘れて、そこだけ見た目が崩れる**(§7「同じ判定が複数の場所にある」)。
   */
  box.setAttribute('data-pkc-palette', '');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', spec.ariaLabel);

  const add = (name: string, label: string, drawn: boolean): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    // ⚠ **押した物が何かは、押した要素が持つ**(組み立て直さない ── §7)
    btn.setAttribute(ICON_NAME_ATTR, name);
    btn.setAttribute('aria-pressed', now === name ? 'true' : 'false');
    btn.title = label;
    if (drawn) {
      // ⚠ 読み上げの名前は**ここ**が持つ(図案の器は `aria-hidden`)
      btn.setAttribute('aria-label', label);
      btn.append(iconSpan(name as Parameters<typeof iconSpan>[0]));
    } else {
      const text = document.createElement('span');
      text.setAttribute('data-pkc-field', 'label');
      text.textContent = label;
      btn.append(text);
    }
    spec.each(btn, name);
    box.append(btn);
  };

  if (spec.withNone !== false) add('', 'なし', false);
  for (const c of TILE_ICON_CHOICES) add(c.name, c.label, true);
  return box;
}
