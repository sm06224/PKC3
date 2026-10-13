/**
 * 🔴 **取り込みの失敗は、成功のときの注意と同じ面に出す**(Gemini 裁定、#1163 の依頼 70-C1)。
 *
 * ## 何が起きていたか
 *
 * 取り込めなかった理由は `OP_FAILED` で画面下の灰色の 1 行に出ていた。別のノートを
 * 選ぶと消えるので、理由を読み終える前に無くなる。一方、成功した取り込みの注意は
 * 「取り込み時の注意」の面に出て、閉じるまで残る。**同じ取り込みの結果が、
 * 成功と失敗で別の場所・別の寿命**だった。
 *
 * ## 作り
 *
 * 入口は 7 つあった(種類の混在 / 複数のバックアップ / md / vcf / ics / pptx / PKC2)。
 * ⚠ 入口ごとに面を呼ぶと必ずどれかが旧い出し方のまま残るので、**この 1 本**を通す。
 * 面を出す口(`reportFailure`)が無い配線(test の簡易 deps)だけ、従来どおり `OP_FAILED`。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

export interface ImportFailureDeps {
  /** 失敗の理由を、取り込みの注意の面へ出す。⚠ 面を持つ配線だけが渡す。 */
  reportFailure?(message: string, undoable?: boolean): void;
}

export function failImport(dispatcher: Dispatcher, deps: ImportFailureDeps, msg: string, undoable = false): null {
  if (deps.reportFailure !== undefined) deps.reportFailure(msg, undoable);
  else dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
  return null;
}
