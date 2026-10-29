/**
 * コマンドシェル(#274)と 2 ペインの命令行(#241)が共有する**命令表**の型。**pure module**。
 *
 * ## 🔑 層は 1 つ、口は 2 つ
 *
 * 命令表(`commands.ts`)は 1 つで、シェル(アプリ。別ウィンドウ + 左のペインのタブ)と
 * 2 ペインの命令行が同じ表を読む。違うのは `ShellEnv.surface` と、「対象」の取り方だけ:
 * シェルは自分の現在地(`cwd`)と選んでいるノート、2 ペインは焦点のペインの場所と選んだ行。
 *
 * ## 🔑 命令は副作用を持たない
 *
 * 命令は `ShellPlan`(出力の行 + 実行してほしい `ShellEffect` の列)を返すだけで、state も DOM も触らない。
 * 実行は adapter(`adapter/ui/actions/shell-run.ts`)が**既存の実体**(移す・コピー・ゴミ箱・追記・タグ・
 * 書き出し・操作の実行)を呼ぶ ── 新しい書き込みの経路を作らない。
 * ⚠ 任意の字を実行する口(eval)は構造的に無い(語彙は閉じた表)。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { PlanOp } from '@features/structure/structure-plan';

export type ShellSurface = 'shell' | 'dual';

export interface ShellEnv {
  readonly surface: ShellSurface;
  readonly metas: ReadonlyMap<string, EntryMeta>;
  readonly relations: readonly Relation[];
  /** 現在地(シェルの `cwd` / 2 ペインの焦点のペインの場所)。`null` = ルート。 */
  readonly cwd: string | null;
  /** 2 ペインの反対側の場所。`undefined` = 反対側が無い(シェル)。`null` = ルート。 */
  readonly other: string | null | undefined;
  /** 「いまの対象」(`.`)。シェル = 選んでいるノート / 2 ペイン = 印を付けた行、無ければカーソルの行。 */
  readonly marked: readonly string[];
  /** 直前の一覧の ID(番号 `#1` `#2` で引ける)。 */
  readonly last: readonly string[];
  /** 既知のタグ(補完用。省略可)。 */
  readonly tags?: readonly string[];
  readonly newLid: () => string;
}

/** 出力の表。`lids` は行ごとのノート ID(押すと開く)。ノートでない行は `null`。 */
export interface ShellTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly lids: readonly (string | null)[];
  /** 行を押したとき入力欄へ戻す命令(履歴の表)。`null` = 戻さない。省略 = 全部 `null`。 */
  readonly recall?: readonly (string | null)[];
}

export type ShellEffect =
  /** 作る・改名(整理案と同じ `PlanOp`。適用は整理案の適用と同じ 1 本)。 */
  | { readonly type: 'plan'; readonly ops: readonly PlanOp[] }
  | { readonly type: 'create'; readonly title: string; readonly body: string; readonly parent: string | null }
  | { readonly type: 'append'; readonly lid: string; readonly text: string }
  | { readonly type: 'move'; readonly lids: readonly string[]; readonly to: string | null }
  | { readonly type: 'copy'; readonly lids: readonly string[]; readonly to: string | null }
  | { readonly type: 'trash'; readonly lids: readonly string[] }
  | { readonly type: 'tag'; readonly lids: readonly string[]; readonly tags: readonly string[]; readonly mode: 'add' | 'remove' }
  | { readonly type: 'export'; readonly lid: string; readonly format: 'md' | 'pdf' }
  | { readonly type: 'open'; readonly lid: string }
  /** 2 ペイン: 焦点のペインの場所を変える。 */
  | { readonly type: 'enter'; readonly scope: string | null }
  /** 2 ペイン: 印を付ける(`set`)/ 外す(`clear`)。 */
  | { readonly type: 'select'; readonly lids: readonly string[]; readonly mode: 'set' | 'clear' }
  | { readonly type: 'sql'; readonly sql: string }
  | { readonly type: 'search'; readonly query: string }
  /** 既存の操作(`KEY_COMMANDS`)を名前で呼ぶ。 */
  | { readonly type: 'operation'; readonly query: string }
  | { readonly type: 'operations'; readonly query: string }
  | { readonly type: 'history' }
  | { readonly type: 'history-clear' }
  | { readonly type: 'clear' }
  | { readonly type: 'copy-result' };

export interface ShellPlan {
  /** 出力の文(1 行ずつ)。 */
  readonly lines: readonly string[];
  readonly table?: ShellTable;
  /** 実行してほしいこと(順に)。 */
  readonly effects: readonly ShellEffect[];
  /** 危険な命令の確認文。あれば実行の前に確認を通す。 */
  readonly confirm?: string;
  /** 断り。あれば `effects` は空。 */
  readonly error?: string;
  /** シェルの現在地を変える(`cd`)。 */
  readonly cwd?: string | null;
  /** 次の `#n` の元にする ID の並び。 */
  readonly numbered?: readonly string[];
}

export type ArgKind = 'note' | 'notes' | 'folder' | 'text' | 'tag' | 'operation' | 'command' | 'sql' | 'format' | 'verb';

export type ShellGroup = '探す・開く' | '作る・書く' | '整理する' | '調べる・呼ぶ' | 'シェル';
