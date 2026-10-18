/**
 * ブラウザの AI(WebMCP)に何を許すか ── **範囲 2 つと、聞くときの規則**(#1407 段①)。
 *
 * ## 範囲は 3 つ(裁定「許可すれば渡す」+ 段④の書き足し)
 *
 * | 範囲 | できること | 渡るもの |
 * |---|---|---|
 * | `read` | 探す・読む・タグの一覧 | **本文**(見つかったノートの本文が AI の提供元へ送られる) |
 * | `write` | ノートを作る | 何も出ない(作るだけ) |
| `append` | 既存のノートの末尾に書き足す(#1407 段④)| 何も出ない(書くだけ)── ⚠ `write` と分ける: 作ってよいと許した人に、既存のノートを書き換える許可まで黙って広げない |
 *
 * **既定はどれも許可なし。** 道具そのものは flag がオンなら登録するが、`execute` の先頭で
 * ここを通り、許可が無ければ**アプリのダイアログで聞く**。
 *
 * ## 聞き方(4 択)
 *
 * - **この 1 回だけ** ── その 1 回だけ通す。続けて呼ばれると、そのたびにまた聞く
 * - **常に許す** ── この端末に憶える(container には入れない。許可は書き出して配る物ではない)
 * - **許さない** ── 通さない。⚠ 例外は投げず、AI が理由を読める結果で返す
 * - **この相手は断る(次に起動するまで)** ── 通さない。その相手の呼び出しは、起動し直すまで**聞かずに**断る(依頼 363。
 *   許可の台帳は変えない ── 許可リストから外さずに黙らせる)
 *
 * ⚠ **ダイアログが出せないとき**(`ask` が無い / 出す途中で落ちた)は**許さない**と同じ扱い
 * (聞けないのに通すのは、許可を飛ばすのと同じである)。
 *
 * ⚠ **pure**(時計も画面も持たない ── `now` と `ask` は呼び手が渡す)。
 */

/** 許す範囲。 */
export type AgentScope = 'read' | 'write' | 'append';

export const AGENT_SCOPES: readonly AgentScope[] = ['read', 'write', 'append'];

/**
 * ダイアログの答え。
 * `block` = **この相手は断る(次に起動するまで)**(依頼 363)── 許可の台帳には触れず、この起動の間だけ、
 * その相手(ブラウザの AI / 組み込み先の origin)の呼び出しを聞かずに断る。
 */
export type AgentAnswer = 'once' | 'always' | 'deny' | 'block';

/** 設定の一覧に出す範囲の名前。 */
export const AGENT_SCOPE_LABEL: Readonly<Record<AgentScope, string>> = {
  read: 'ノートを探す・読む',
  write: 'ノートを作る',
  append: 'ノートに書き足す',
};

/**
 * 🔴 **いま AI が何をしようとしているか**(ダイアログに「何を」を出すため)。
 * 範囲(`read` / `write`)はここから決まる ── 呼び手が範囲だけを渡して、何をするかを隠さない。
 * ⚠ `query` / `title` は AI が決めた字 ── 画面に出す前に `agentLabel` を通す。
 */
export type AgentTarget = (
  | { action: 'search'; query: string }
  | { action: 'read'; title: string }
  | { action: 'tags' }
  | { action: 'create'; title: string }
  | { action: 'append'; title: string }
) & {
  /**
   * 🔴 呼んでいるのが**他のページに組み込まれた AI**のとき、そのページの origin(#1407 段⑥)。
   * 無い = PKC3 を開いているブラウザの AI。⚠ 許可の台帳は origin ごとに別で、ダイアログは origin を
   * そのまま名指しする(`agentAskNote`)。origin は呼び手(`agent-embed.ts`)が許可リストから引いた値で、
   * AI が決める字ではない。
   */
  from?: string;
};

export function scopeOf(target: AgentTarget): AgentScope {
  if (target.action === 'create') return 'write';
  // 🔴 書き足すは**別の範囲**(#1407 段④ レビュー)── 「作る」を常に許した人は、既存のノートを書き換える許可まで
  //    与えていない(段①の字は「ノートを作る」だった)。同じ範囲にすると、その「常に許す」が黙って広がる
  if (target.action === 'append') return 'append';
  return 'read';
}

/** ダイアログの題名の中に入れる字の上限。 */
export const AGENT_LABEL_MAX = 40;

/**
 * AI が決めた字を、ダイアログに出せる形にする ── 制御文字を落として 1 行にし、
 * 40 字で切る(切ったら末尾に「…」)。`create-entry-params.ts` の `oneLine` と同じ作法。
 * ⚠ AI の字を長いまま出すと、本来の文(許すと何が起きるか)が画面の外へ押し出される。
 */
export function agentLabel(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const one = out.replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length > AGENT_LABEL_MAX ? `${chars.slice(0, AGENT_LABEL_MAX).join('')}…` : one;
}

/** ダイアログの題名。 */
export const AGENT_ASK_TITLE = 'ブラウザの AI からの依頼';

/**
 * ダイアログの本文(1 行目)。
 * ⚠ 読む側は**何が外へ出るか**を書く(「許すと本文が AI の提供元へ送られます」)── 判断の材料はそこにある。
 * ⚠ タグの一覧は、範囲(read)が同じなので探す・読むと同じ文にする(「常に許す」は範囲ぜんたいに効く)。
 */
export function agentAskNote(target: AgentTarget): string {
  // 🔴 組み込まれたページの AI は origin をそのまま名指しする(`agentLabel` で切らない ── 切ると別の origin に見える)
  const who = target.from === undefined ? 'ブラウザの AI' : `${target.from} のページに組み込まれた AI`;
  switch (target.action) {
    case 'search':
      return `${who} が、『${agentLabel(target.query)}』でノートを探して読もうとしています。許すと、当たったノートの本文が AI の提供元へ送られます。`;
    case 'read':
      return `${who} が、『${agentLabel(target.title)}』を読もうとしています。許すと、そのノートの本文が AI の提供元へ送られます。`;
    case 'tags':
      // 🔑 頼まれたこと(タグの一覧)を先に言い、許す範囲が探す・読むと同じことを続ける(#1087)
      return `${who} が、タグの一覧を見ようとしています。許すと、ノートを探して読むこともできるようになり、見つかったノートの本文が AI の提供元へ送られます。`;
    case 'create':
      return `${who} が、『${agentLabel(target.title)}』というノートを作ろうとしています。`;
    case 'append':
      return `${who} が、『${agentLabel(target.title)}』の末尾に書き足そうとしています。`;
  }
}

/** ダイアログの本文(2 行目)。「この 1 回だけ」が続けて呼ばれたときの動きを先に言う。 */
export const AGENT_ASK_NOTE_MORE = '続けて呼ばれると、そのたびに聞きます。';

/** 3 択のボタンの字。 */
export const AGENT_ASK_LABELS = {
  once: 'この 1 回だけ',
  always: '常に許す',
  deny: '許さない',
  block: 'この相手は断る(次に起動するまで)',
} as const;

/**
 * 断ったときに AI へ返す字。
 * ⚠ AI は断られると同じ依頼を繰り返しがちなので、**繰り返さず user に伝える**ところまで書く。
 */
export const AGENT_DENIED_TEXT =
  'ユーザーが許可しませんでした。同じ依頼を繰り返さず、そのことをユーザーに伝えてください。';

/** この端末に憶えている許可(`adapter/platform/agent-grants.ts` が実体)。 */
export interface AgentGrantsLike {
  /** ⚠ `from` = 組み込まれたページの origin(`AgentTarget.from`)。無い = このブラウザの AI。台帳は別。 */
  isAlways(scope: AgentScope, from?: string): boolean;
  setAlways(scope: AgentScope, from?: string): void;
  /** 最後に使われた時刻を控える(設定の一覧に出す)。 */
  touch(scope: AgentScope, at: number, from?: string): void;
}

export interface AgentGateDeps {
  grants: AgentGrantsLike;
  /**
   * ダイアログで聞く。`null` = 出せない(許さない扱い)。
   * `signal` が abort されたら、出ている(または待っている)ダイアログを閉じて `'deny'` を返す。
   */
  ask: ((target: AgentTarget, signal?: AbortSignal) => Promise<AgentAnswer>) | null;
  now: () => number;
}

/** 通してよいかを答える門。`signal` は AI が依頼を取り消したとき abort される。 */
export type AgentGate = (target: AgentTarget, signal?: AbortSignal) => Promise<boolean>;

/**
 * 通してよいかを答える門。
 *
 * 🔑 **ダイアログを出しうる依頼は 1 本の列に並べる**(許可済みの依頼は並べず、すぐ通す)── AI は同時に何本も呼べる。並べないと、同じ範囲のダイアログが
 * 2 枚重なり、1 枚目で「常に許す」を選んでも 2 枚目が聞き直してしまう
 * (列に並べて、順番が来たら許可を**もう一度読む**)。
 *
 * 🔴 **取り消された依頼は聞かない**(`signal`)── 列に並んでいる間に AI が取り消したなら、
 * 順番が来ても聞かず(許可の台帳も触らず)断る。聞いている最中なら、ダイアログごと閉じる。
 */
export function createAgentGate(deps: AgentGateDeps): AgentGate {
  let chain: Promise<unknown> = Promise.resolve();
  /**
   * 🔴 **この起動の間だけ断る相手**(依頼 363「この相手は断る」)。キーは相手(`from`。無い = このブラウザの AI)。
   * ⚠ 台帳(`grants`)には書かない ── 起動し直せば空に戻る。
   */
  const blocked = new Set<string>();
  const partyOf = (target: AgentTarget): string => target.from ?? '';
  /**
   * 🔴 **ダイアログを出しうる依頼で、まだ答えが出ていない物**(列に並んでいる / いま出ている)。
   * 同じ相手・同じ範囲の「許さない」が出たら、列で待っていた依頼を**聞き直さず**断る(依頼 363
   * 「同じ相手の確認は、1 つ出ている間は重ねて出さない」)。
   */
  interface Waiting {
    readonly party: string;
    readonly scope: AgentScope;
    refused: boolean;
  }
  const waiting = new Set<Waiting>();
  const decide = async (target: AgentTarget, me: Waiting, signal?: AbortSignal): Promise<boolean> => {
    const scope = scopeOf(target);
    // ⚠ 関数にして毎回読む(`await` をまたぐと、型が「まだ取り消されていない」で固まる)
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) return false;
    // 列で待っている間に「この相手は断る」「許さない」が出ていた ── 聞き直さない
    if (blocked.has(me.party) || me.refused) return false;
    let allowed = deps.grants.isAlways(scope, target.from);
    if (!allowed) {
      let answer: AgentAnswer = 'deny';
      try {
        if (deps.ask !== null) answer = await deps.ask(target, signal);
      } catch {
        // 出せなかった = 許さない(聞けないのに通さない)
        answer = 'deny';
      }
      // 聞いている間に取り消された ── 答えが何であれ通さず、台帳も触らない
      if (cancelled()) return false;
      if (answer === 'always') deps.grants.setAlways(scope, target.from);
      if (answer === 'block') blocked.add(me.party);
      if (answer === 'deny') {
        for (const w of waiting) if (w !== me && w.party === me.party && w.scope === scope) w.refused = true;
      }
      allowed = answer === 'once' || answer === 'always';
    }
    if (allowed) deps.grants.touch(scope, deps.now(), target.from);
    return allowed;
  };
  return (target, signal) => {
    // 🔴 断ると決めた相手は、列にも並べず・聞かずに断る(許可済みの台帳より先 ── 断るは今日の判断)
    if (blocked.has(partyOf(target))) return Promise.resolve(false);
    // 🔴 既に許してある依頼は列に並べない ── 別の origin のダイアログが開いている間、
    //   許可済みの呼び出し(別のページの AI・ブラウザの AI)まで待たされるのを防ぐ。
    //   並べるのは**ダイアログを出しうる依頼だけ**(同じ範囲の 2 枚重なりを防ぐ列の目的はそのまま)
    if (signal?.aborted !== true && deps.grants.isAlways(scopeOf(target), target.from)) {
      deps.grants.touch(scopeOf(target), deps.now(), target.from);
      return Promise.resolve(true);
    }
    const me: Waiting = { party: partyOf(target), scope: scopeOf(target), refused: false };
    waiting.add(me);
    const run = chain.then(() => decide(target, me, signal)).finally(() => waiting.delete(me));
    // ⚠ 前が転んでも列は進める
    chain = run.catch(() => undefined);
    return run;
  };
}
