/**
 * 「チェックを 1 つ置く」設定の行(`dt` / `dd`)の組み立てと、値の映し方(#1382)。
 *
 * 🔑 `settings.ts` に同じ形が 14 回書いてあったのを 1 か所へ寄せた(属性の順も字も変えていない)。
 * ⚠ 説明(`note`)は節ごとに有る・無いが違う ── 呼び側が `notes` で渡す。
 */
import { buildSettingsNote } from './note';

export interface CheckboxRowSpec {
  /** `dt` の字。 */
  term: string;
  /** `data-pkc-action`(binder が受ける名前)。 */
  action: string;
  /** `data-pkc-field`(`sync` が探す名前)。 */
  field: string;
  /** チェックの右の字(先頭の空白も含めて渡す)。 */
  label: string;
  /** `label` に付ける hover(無ければ付けない)。 */
  title?: string;
  /** `dd` の中、`label` の後ろに足す説明の字(1 行ずつ `buildSettingsNote` になる)。 */
  notes?: readonly string[];
}

export interface CheckboxRow {
  dt: HTMLElement;
  dd: HTMLElement;
  box: HTMLInputElement;
}

export function buildCheckboxRow(spec: CheckboxRowSpec): CheckboxRow {
  const dt = document.createElement('dt');
  dt.textContent = spec.term;
  const dd = document.createElement('dd');
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('data-pkc-action', spec.action);
  box.setAttribute('data-pkc-field', spec.field);
  label.append(box, document.createTextNode(spec.label));
  if (spec.title !== undefined) label.title = spec.title;
  dd.append(label);
  for (const n of spec.notes ?? []) dd.append(buildSettingsNote(n));
  return { dt, dd, box };
}

/**
 * ⚠ 画面の値を**いまの設定に合わせる**(器は 1 度しか組まない ── 映さないと古い値が見える。
 * CLAUDE.md §7「設定画面の値の同期」)。
 */
export function syncCheckbox(region: ParentNode, field: string, on: () => boolean): void {
  const box = region.querySelector<HTMLInputElement>(`[data-pkc-field="${field}"]`);
  if (box) box.checked = on();
}
