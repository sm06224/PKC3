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

const REGISTRY: ReadonlyMap<string, FlavorSpec> = new Map(
  [
    todoFlavor,
    textlogFlavor,
    formFlavor,
    attachmentFlavor,
    spreadsheetFlavor,
    textFlavor,
  ].map((f) => [f.archetype, f]),
);

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
