/**
 * 🔴 **取り込みの戻り道**(#535 ②)。
 *
 * ## なぜ要るか
 *
 * `.vcf` を 1 回押すと **200 件のノートが増える**のに、戻す道が無かった ──
 * フォルダタブで 200 行を自力で見つけて印を付け、`delete-selected` で消すしかなく、
 * ⚠ (当時の)一覧タブには印が無いのでそこでは消せなかった(「一覧」は #813 段③ で外した)。
 * 🔑 「1 押しで 200 件増えるのに、1 押しで戻せない」は、片道の操作である
 * (user 指示 2026-08-23「片道の操作を作らない」)。
 *
 * ## 🔴 新しい消し方を作らない(CLAUDE.md §7)
 *
 * 戻すのは `DELETE_ENTRIES` ── **ごみ箱へ入れる既存の口**そのものである。
 * ⚠ だから「取り消し」で消えた物は**ごみ箱から戻せる**(本当に消えるのではない)。
 * ここが持つのは「**いま取り込んだのはどれか**」という記憶だけで、
 * 消す規則も後始末(選択の解除・履歴の掃除)も reducer が 1 か所で持っている。
 *
 * ## ⚠ 件数を 2 度数えない
 *
 * `DELETE_ENTRIES` は**居ないものを黙って落とす**ので、実際に何件消えたかは
 * ここでは分からない。🔑 だから**終わった後の文言に件数を書かない** ──
 * 書くと、その数を出すためにここで生死をもう一度数えることになり、
 * 判定が 2 か所に生える(2026-08-20 の「数えている対象が名前と違う」の型)。
 * ⚠ **押す前**の説明には件数を書いてよい(取り込んだ数は、こちらが知っている)。
 */
import { phaseBlockReason, type AppPhase, type Dispatchable } from '@adapter/state/app-state';
import type { TagColorEntry } from '@features/tag-color';

/** 注意の面の頭に置く、1 つだけの操作。 */
export interface NoticeAction {
  readonly label: string;
  /** `data-pkc-action`(受け口は binder が持つ)。 */
  readonly action: string;
  /** 押す前に読む説明 ── ⚠ 「何が起きるか」で書く(user 指示 2026-08-21)。 */
  readonly title: string;
}

export interface ImportUndoDeps {
  dispatch(action: Dispatchable): void;
  /** 画面下の帯へ 1 行。 */
  notify(message: string): void;
  /** 注意の面を畳む(戻した後に「取り消す」を残さない)。 */
  clear(): void;
  /**
   * 🔴 **いまの phase**(#1087)── `DELETE_ENTRIES` は `ready` 以外で**黙って捨てられる**ので、
   *   撃つ前に見る。⚠ 必須にしてある(配線を落としたら tsc が落とす)。
   */
  phase(): AppPhase;
  /** 断る理由を出す(`OP_FAILED`)。 */
  fail(message: string): void;
  /**
   * 🔴 **取り込みで足したタグの色を外す**(台帳 #1852 束 F2 / 依頼 119-5 A)。⚠ **省略可** ── 無い配線は従来どおり「色は残ります」と言う。
   * 渡された色のうち、**いまも同じ色が付いている物だけ**を外す(取り込んだ後に user が選び直した色・前から在った色は触らない)。
   */
  removeTagColors?(colors: readonly TagColorEntry[]): Promise<void>;
  /**
   * 🔴 **取り込みで足したピン留めを外す**(#1377)。⚠ **省略可**。渡るのは取り込みで足した lid だけ(前から在ったピンは触らない)。
   * ノートはゴミ箱へ入るが、ピンは(戻すと戻る仕様で)残る ── 取り込みで足した分は取り消しで外す。
   */
  removeNotePins?(lids: readonly string[]): Promise<void>;
}

export interface ImportUndo {
  /**
   * 取り込んだ直後に呼ぶ。⚠ 前の記憶は捨てる(戻せるのは**直前の 1 回**だけ)。
   * 🔴 `tagColors` = この取り込みでタグの色も足したか(#1087)。
   * 🔴 `addedColors` = 足した色そのもの(依頼 119-5 A)。あれば取り消しが**その色だけ**を外す(前から在った色は触らない)。
   *   無い(足した色が分からない配線)ときは、足した色は**残る** ── 「戻した」と言い切らず、残ることを言う。
   */
  remember(
    lids: readonly string[],
    opts?: {
      readonly tagColors?: boolean;
      readonly addedColors?: readonly TagColorEntry[];
      /** 🔴 足したピン留めの lid(#1377)。 */
      readonly addedPins?: readonly string[];
    },
  ): void;
  /** いま出せる操作(無ければ null)。 */
  pending(): NoticeAction | null;
  /** ごみ箱へ入れる。⚠ 2 度押しても 2 度は走らない。 */
  undo(): void;
}

export function createImportUndo(deps: ImportUndoDeps): ImportUndo {
  let lids: readonly string[] = [];
  let colorsKept = false;
  /** 外す色(`removeTagColors` が渡っているときだけ憶える)。 */
  let colorsToRemove: readonly TagColorEntry[] = [];
  /** 外すピン(`removeNotePins` が渡っているときだけ憶える)。 */
  let pinsToRemove: readonly string[] = [];
  return {
    remember(next, opts) {
      lids = [...next];
      colorsToRemove = deps.removeTagColors !== undefined ? [...(opts?.addedColors ?? [])] : [];
      // 外せる色が分かっているなら「残る」とは言わない
      colorsKept = opts?.tagColors === true && colorsToRemove.length === 0;
      pinsToRemove = deps.removeNotePins !== undefined ? [...(opts?.addedPins ?? [])] : [];
    },
    pending() {
      if (lids.length === 0) return null;
      return {
        label: '取り込みを取り消す',
        action: 'undo-import',
        title:
          `いま取り込んだ ${lids.length} 件をゴミ箱へ入れます(ゴミ箱から戻せます)` +
          (colorsKept ? '。取り込んだタグの色は残ります' : '') +
          (colorsToRemove.length > 0 ? '。取り込みで足したタグの色も外します' : '') +
          (pinsToRemove.length > 0 ? '。取り込みで足したピン留めも外します' : ''),
      };
    },
    undo() {
      if (lids.length === 0) return;
      /**
       * 🔴 **編集中は断り、記憶は手放さない**(#1087)── 直す前は `DELETE_ENTRIES` が
       *   黙って捨てられたのに「ゴミ箱へ入れました」と言い、記憶も忘れて**戻り道ごと消えていた**。
       */
      // ⚠ 断りの前置きは `phaseBlockReason` 1 か所から引く(編集中 / 保存失敗 / 読み込み中で字が違う)
      const blocked = phaseBlockReason(deps.phase());
      if (blocked !== null) {
        deps.fail(`${blocked}取り込みを取り消してください`);
        return;
      }
      deps.dispatch({ type: 'DELETE_ENTRIES', lids: [...lids] });
      const removing = colorsToRemove;
      const keptNote = colorsKept;
      const removingPins = pinsToRemove;
      // ⚠ **先に忘れる** ── 帯や面の更新で例外が出ても、2 度目の取り消しを残さない
      lids = [];
      colorsToRemove = [];
      pinsToRemove = [];
      colorsKept = false;
      deps.clear();
      deps.notify(
        '取り込んだ分をゴミ箱へ入れました。ゴミ箱から戻せます' +
          (keptNote ? '(取り込んだタグの色は残ります)' : '') +
          (removing.length > 0 ? '。取り込みで足したタグの色も外しました' : '') +
          (removingPins.length > 0 ? '。取り込みで足したピン留めも外しました' : ''),
      );
      // 🔴 足したピンを外す(#1377)。外せなくても取り消しは済んでいる ── 失敗は言う
      if (removingPins.length > 0 && deps.removeNotePins !== undefined) {
        deps.removeNotePins(removingPins).catch(() => {
          deps.notify('取り込みで足したピン留めを外せませんでした(ノートは取り消しました)');
        });
      }
      // 🔴 足した色を外す(依頼 119-5 A)。外せなくても取り消しは済んでいる ── 失敗は言う(黙って食い違わせない)
      if (removing.length > 0 && deps.removeTagColors !== undefined) {
        deps.removeTagColors(removing).catch(() => {
          deps.notify('取り込みで足したタグの色を外せませんでした(ノートは取り消しました)');
        });
      }
    },
  };
}

/**
 * 取込の後に出す面の題と操作を決める。
 *
 * 🔑 **`main.ts` に判断を置かない**(CLAUDE.md §2「どの test からも実行されない
 * file に判断を書かない」)── あちらは配線だけを持つ。
 * ⚠ 注意が 0 件でも**面は出す**(戻り道がそこに在るため)。そのとき題を
 * 「注意」のままにすると、**何も無いのに注意と言う**ことになる。
 */
export function importPanel(
  notes: readonly string[],
  action: NoticeAction | null,
): { readonly title: string; readonly action: NoticeAction | null } {
  return { title: notes.length > 0 ? '取り込み時の注意' : '取り込みました', action };
}

/**
 * 🔴 **取り込めなかった理由の面**(依頼 70-C1)── 成功のときの注意と**同じ面・同じ題**で、
 * 閉じるまで残す(画面下の 1 行は別のノートを選ぶと消えていた)。
 *
 * ⚠ **操作を付けるのは、途中まで書けた失敗だけ**(`action` を渡したときだけ)。1 件も書けていない失敗に
 *   直前の取り込みの「取り込みを取り消す」を出すと、**今回の失敗の面から前の回を消せてしまう**。
 *   途中まで書けた失敗は、書けた分の id を憶えた直後(`imported`)に呼ばれるので、出る取り消しは今回の分である。
 */
export function importFailurePanel(message: string, action: NoticeAction | null = null): {
  readonly title: string;
  readonly notes: readonly string[];
  readonly action: NoticeAction | null;
} {
  return { title: importPanel([message], null).title, notes: [message], action };
}
