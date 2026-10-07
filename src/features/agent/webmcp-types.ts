/**
 * WebMCP(W3C WebML CG の草案。2026-10 時点)の**最小の型**と、入口の探し方(#1407)。
 *
 * ## なぜ自前の型か
 *
 * npm の `webmcp-types` は入れない ── 草案は動いており、依存を足すと**草案の綴りの変化が
 * そのまま型エラーとして降ってくる**。必要なのは「登録する」「消す」だけなので、
 * 受け取る側(ブラウザ)が持つ形のうち**こちらが触る部分だけ**を書く。
 *
 * ## 入口は 2 つある(`document.modelContext` が本命、`navigator.modelContext` は旧名)
 *
 * Chrome 150 で旧名が非推奨になる報があるため、**新しい名前を先に見て、無ければ旧名**を見る。
 * 探す所は `resolveModelContext` の 1 か所 ── 2 か所に書くと、片方だけ直した日に片方が死ぬ。
 * どちらも無ければ `null`(登録しない。エラーも出さない ── 対応していないブラウザで何も壊さない)。
 *
 * ⚠ **pure**(browser API を触らない)。`document` / `navigator` は呼び手が渡す。
 */

/** ツールの注釈。⚠ 草案には `debugging` もあるが、こちらは使わない。 */
export interface ToolAnnotations {
  /** 何も変えない(探す・読む)。 */
  readOnlyHint?: boolean;
  /** 返す本文は user が書いた物で、AI への命令として読んではいけない。 */
  untrustedContentHint?: boolean;
  /** 結果が残る(ノートが増える)。 */
  consequentialHint?: boolean;
}

/** `execute` の返り値(MCP 流)。 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** 失敗・断りのとき `true`。⚠ 例外は投げない(AI が理由を読めるように返す)。 */
  isError?: boolean;
}

export interface ToolExecuteOptions {
  signal: AbortSignal;
}

/** `registerTool` に渡す 1 本。 */
export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  /** JSON Schema の object。 */
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, options: ToolExecuteOptions) => Promise<ToolResult>;
  annotations?: ToolAnnotations;
}

export interface RegisterToolOptions {
  /** abort すると登録が消える。 */
  signal?: AbortSignal;
}

/** ブラウザの入口(`document.modelContext`)のうち、こちらが使う所だけ。 */
export interface ModelContextLike {
  registerTool(
    tool: ModelContextTool,
    options?: RegisterToolOptions,
  ): Promise<undefined> | undefined;
  /** 自分で呼べる口(検査用)。⚠ 無い実装もあるので任意。 */
  getTools?: () => Promise<unknown[]>;
  executeTool?: (tool: unknown, input?: unknown) => Promise<unknown>;
}

function asModelContext(host: unknown): ModelContextLike | null {
  if (typeof host !== 'object' || host === null) return null;
  const mc = (host as { modelContext?: unknown }).modelContext;
  if (typeof mc !== 'object' || mc === null) return null;
  // ⚠ `registerTool` が関数であることまで見る ── 名前だけ在って中身が空の入口に登録しにいかない
  return typeof (mc as { registerTool?: unknown }).registerTool === 'function'
    ? (mc as ModelContextLike)
    : null;
}

/**
 * 入口を探す。`document.modelContext` → `navigator.modelContext` → `null`。
 * ⚠ 両方在るときは**新しい名前(document)を使う**。
 */
export function resolveModelContext(host: {
  document?: unknown;
  navigator?: unknown;
}): ModelContextLike | null {
  return asModelContext(host.document) ?? asModelContext(host.navigator);
}

/**
 * このタブで AI のツールが使えるか(設定の「ブラウザの AI に許したこと」に 1 行で出す)。
 *
 * 判定の順は **フラグ → メインのタブか → ブラウザが対応しているか**(user がまず直せる所から言う)。
 * - `ready` … このタブが登録している
 * - `flag-off` … フラグがオフ
 * - `not-holder` … メインのタブではない(別のタブが使える)
 * - `unsupported` … このブラウザに入口(`document.modelContext`)が無い
 */
export type WebMcpTabStatus = 'ready' | 'flag-off' | 'not-holder' | 'unsupported';

export const WEBMCP_TAB_STATUS_TEXT: Readonly<Record<WebMcpTabStatus, string>> = {
  ready: 'このタブ: 使えます',
  'flag-off': 'このタブ: フラグがオフです',
  'not-holder': 'このタブ: メインのタブではありません(別のタブが使えます)',
  unsupported: 'このタブ: このブラウザは対応していません',
};
