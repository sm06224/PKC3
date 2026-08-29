/**
 * 🔴 **取り込みの戻り道**(#535 ②)。
 *
 * ## なぜ要るか
 *
 * `.vcf` を 1 回押すと **200 件のノートが増える**のに、戻す道が無かった ──
 * フォルダタブで 200 行を自力で見つけて印を付け、`delete-selected` で消すしかなく、
 * ⚠ **一覧タブには印が無い**のでそこでは消せない。
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
import type { Dispatchable } from '@adapter/state/app-state';

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
}

export interface ImportUndo {
  /** 取り込んだ直後に呼ぶ。⚠ 前の記憶は捨てる(戻せるのは**直前の 1 回**だけ)。 */
  remember(lids: readonly string[]): void;
  /** いま出せる操作(無ければ null)。 */
  pending(): NoticeAction | null;
  /** ごみ箱へ入れる。⚠ 2 度押しても 2 度は走らない。 */
  undo(): void;
}

export function createImportUndo(deps: ImportUndoDeps): ImportUndo {
  let lids: readonly string[] = [];
  return {
    remember(next) {
      lids = [...next];
    },
    pending() {
      if (lids.length === 0) return null;
      return {
        label: '取り消す',
        action: 'undo-import',
        title: `いま取り込んだ ${lids.length} 件をごみ箱へ入れます(ごみ箱から戻せます)`,
      };
    },
    undo() {
      if (lids.length === 0) return;
      deps.dispatch({ type: 'DELETE_ENTRIES', lids: [...lids] });
      // ⚠ **先に忘れる** ── 帯や面の更新で例外が出ても、2 度目の取り消しを残さない
      lids = [];
      deps.clear();
      deps.notify('取り込んだ分をごみ箱へ入れました。ごみ箱から戻せます');
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
  return { title: notes.length > 0 ? '取込時の注意' : '取り込みました', action };
}
