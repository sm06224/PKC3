/**
 * フレーバー registry(P3 設計メモ §3)。text が fallback。
 *
 * `extractMeta` は**保存経路の唯一の抽出関数**── entries 表の抽出列
 * (status / date / archived)は必ずここを通って書かれる。呼び出しは
 * reducer の COMMIT_EDIT(イベント発火時に同期で行全体を確定)、
 * effect 層の REQUEST_TODO_TOGGLE(splice 書換後の行確定)、
 * effect 層の REQUEST_RESTORE / REQUEST_TRASH_RESTORE(P5b: revision body の
 * 行確定)、P6 import の変換パイプライン、の 4 箇所が規約。
 */
import type { FlavorExtract, FlavorSpec } from './flavor-spec';
import { todoFlavor } from './todo-flavor';
import { textlogFlavor } from './textlog-flavor';
import { formFlavor } from './form-flavor';
import { attachmentFlavor } from './attachment-flavor';
import { spreadsheetFlavor } from './spreadsheet-flavor';
import { textFlavor } from './text-flavor';
import { snippetFlavor } from './snippet-flavor';
import { smartFlavor } from './smart-flavor';
import { stackFlavor } from './stack-flavor';

const REGISTRY: ReadonlyMap<string, FlavorSpec> = new Map(
  [
    todoFlavor,
    textlogFlavor,
    formFlavor,
    attachmentFlavor,
    spreadsheetFlavor,
    snippetFlavor,
    smartFlavor,
    stackFlavor,
    textFlavor,
  ].map((f) => [f.archetype, f]),
);

/**
 * 🔴 **登録されている archetype を数え上げる**(2026-08-27)。
 *
 * ⚠ **test が「全数」を名乗るために要る。** `tests/features/flavor.test.ts` は
 *   「フレーバーを足した人が `NO_EXTRACT` を返したら、その場で落ちる」と
 *   宣言していたのに、⚠ **一覧を手で書いていた** ── だから後から足した 2 つ
 *   (`snippet` / `smart`)は**その検査を 1 度も通っていなかった**
 *   (CLAUDE.md「宣言が在るぶん、次に読む人は数え直さない」)。
 * 🔑 数え上げをここから出せば、**足した瞬間に検査の母集団に入る**。
 */
export function registeredArchetypes(): readonly string[] {
  return [...REGISTRY.keys()];
}

/** 未知 / 個別登録の無い archetype(folder / generic / opaque 含む)は text fallback。 */
export function getFlavor(archetype: string): FlavorSpec {
  return REGISTRY.get(archetype) ?? textFlavor;
}

/** 保存経路の唯一の抽出関数。 */
export function extractMeta(archetype: string, body: string): FlavorExtract {
  return getFlavor(archetype).extract(body);
}

/** 新規作成時の初期 body(P3-7a)。 */
export function seedBodyFor(archetype: string): string {
  return getFlavor(archetype).seed?.() ?? '';
}

export type { FlavorExtract, FlavorSpec };
export { NO_EXTRACT } from './flavor-spec';
