/**
 * 段の境界線の保存と適用(#525)。意味論は `features/column-rule.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.text-scale` / `pkc3.read-columns` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見え方**である。
 * 🔑 当て方は `text-scale.ts` と**同じ形**にする(属性 1 つ + CSS 変数)──
 *   2 本目の作法を作らない(§7)。
 */
import {
  columnRuleSpec,
  DEFAULT_COLUMN_RULE,
  isColumnRule,
  type ColumnRule,
} from '@features/column-rule';

const KEY = 'pkc3.column-rule';

/** 当てる先の印。⚠ CSS 変数だけだと「いま何が当たっているか」を DOM から読めない。 */
export const COLUMN_RULE_ATTR = 'data-pkc-column-rule';
/** `app.css` の `column-rule: var(--pkc-col-rule, 1px solid var(--border))` と 1 対 1。 */
export const COLUMN_RULE_VAR = '--pkc-col-rule';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存されている値(起動時の初期値)。⚠ 読めなければ既定。 */
export function initialColumnRule(): ColumnRule {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isColumnRule(v) ? v : DEFAULT_COLUMN_RULE;
  } catch {
    return DEFAULT_COLUMN_RULE;
  }
}

/**
 * いま当たっている線(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**。
 */
export function currentColumnRule(target: HTMLElement): ColumnRule {
  const v = target.getAttribute(COLUMN_RULE_ATTR);
  return v !== null && isColumnRule(v) ? v : DEFAULT_COLUMN_RULE;
}

/**
 * 当てる。⚠ **保存しない**(起動時の適用が「一度も選んでいないのに固定される」を
 * 作らないように、保存は `chooseColumnRule` だけが持つ)。
 *
 * 🔑 **描き直しは要らない** ── 線の色が変わるだけで HTML は 1 文字も変わらない。
 *   ⚠ ここで描き直すと**図が焼き直される**(器の幅は 1px も動いていないのに)。
 */
export function applyColumnRule(target: HTMLElement, rule: ColumnRule): void {
  target.setAttribute(COLUMN_RULE_ATTR, rule);
  target.style.setProperty(COLUMN_RULE_VAR, columnRuleSpec(rule).rule);
}

/** user が選んだ ── 当てて**保存する**。 */
export function chooseColumnRule(target: HTMLElement, rule: ColumnRule): void {
  applyColumnRule(target, rule);
  try {
    readStorage()?.setItem(KEY, rule);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
