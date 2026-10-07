/**
 * ブラウザの AI(WebMCP)に何を許すか ── **範囲 2 つと、聞くときの規則**(#1407 段①)。
 *
 * ## 範囲は 2 つ(裁定「許可すれば渡す」)
 *
 * | 範囲 | できること | 渡るもの |
 * |---|---|---|
 * | `read` | 探す・読む・タグの一覧 | **本文**(見つかったノートの本文が AI の提供元へ送られる) |
 * | `write` | ノートを作る | 何も出ない(作るだけ) |
 *
 * **既定はどちらも許可なし。** 道具そのものは flag がオンなら登録するが、`execute` の先頭で
 * ここを通り、許可が無ければ**アプリのダイアログで聞く**。
 *
 * ## 聞き方(3 択)
 *
 * - **今回だけ** ── その 1 回だけ通す。2 回目はまた聞く
 * - **常に許す** ── この端末に憶える(container には入れない。許可は書き出して配る物ではない)
 * - **許さない** ── 通さない。⚠ 例外は投げず、AI が理由を読める結果で返す
 *
 * ⚠ **ダイアログが出せないとき**(`ask` が無い / 出す途中で落ちた)は**許さない**と同じ扱い
 * (聞けないのに通すのは、許可を飛ばすのと同じである)。
 *
 * ⚠ **pure**(時計も画面も持たない ── `now` と `ask` は呼び手が渡す)。
 */

/** 許す範囲。 */
export type AgentScope = 'read' | 'write';

export const AGENT_SCOPES: readonly AgentScope[] = ['read', 'write'];

/** ダイアログの答え。 */
export type AgentAnswer = 'once' | 'always' | 'deny';

/** 設定の一覧に出す範囲の名前。 */
export const AGENT_SCOPE_LABEL: Readonly<Record<AgentScope, string>> = {
  read: 'ノートを探す・読む',
  write: 'ノートを作る',
};

/** ダイアログの題名。 */
export const AGENT_ASK_TITLE = 'ブラウザの AI からの依頼';

/**
 * ダイアログの本文。
 * ⚠ 読む側は**何が外へ出るか**を書く(「許すと本文が AI の提供元へ送られます」)── 判断の材料はそこにある。
 */
export const AGENT_ASK_NOTE: Readonly<Record<AgentScope, string>> = {
  read: 'ブラウザの AI が、ノートを探して読もうとしています。許すと、見つかったノートの本文が AI の提供元へ送られます。',
  write: 'ブラウザの AI が、ノートを作ろうとしています。',
};

/** 3 択のボタンの字。 */
export const AGENT_ASK_LABELS = {
  once: '今回だけ',
  always: '常に許す',
  deny: '許さない',
} as const;

/** 断ったときに AI へ返す字。 */
export const AGENT_DENIED_TEXT = 'user が許可しませんでした';

/** この端末に憶えている許可(`adapter/platform/agent-grants.ts` が実体)。 */
export interface AgentGrantsLike {
  isAlways(scope: AgentScope): boolean;
  setAlways(scope: AgentScope): void;
  /** 最後に呼ばれた時刻を控える(設定の一覧に出す)。 */
  touch(scope: AgentScope, at: number): void;
}

export interface AgentGateDeps {
  grants: AgentGrantsLike;
  /** ダイアログで聞く。`null` = 出せない(許さない扱い)。 */
  ask: ((scope: AgentScope) => Promise<AgentAnswer>) | null;
  now: () => number;
}

/**
 * 通してよいかを答える門。
 *
 * 🔑 **1 本の列に並べる** ── AI は同時に何本も呼べる。並べないと、同じ範囲のダイアログが
 * 2 枚重なり、1 枚目で「常に許す」を選んでも 2 枚目が聞き直してしまう
 * (列に並べて、順番が来たら許可を**もう一度読む**)。
 */
export function createAgentGate(deps: AgentGateDeps): (scope: AgentScope) => Promise<boolean> {
  let chain: Promise<unknown> = Promise.resolve();
  const decide = async (scope: AgentScope): Promise<boolean> => {
    let allowed = deps.grants.isAlways(scope);
    if (!allowed) {
      let answer: AgentAnswer = 'deny';
      try {
        if (deps.ask !== null) answer = await deps.ask(scope);
      } catch {
        // 出せなかった = 許さない(聞けないのに通さない)
        answer = 'deny';
      }
      if (answer === 'always') deps.grants.setAlways(scope);
      allowed = answer === 'once' || answer === 'always';
    }
    if (allowed) deps.grants.touch(scope, deps.now());
    return allowed;
  };
  return (scope) => {
    const run = chain.then(() => decide(scope));
    // ⚠ 前が転んでも列は進める
    chain = run.catch(() => undefined);
    return run;
  };
}
