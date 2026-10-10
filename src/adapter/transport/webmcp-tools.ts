/**
 * ブラウザの AI(WebMCP)に渡す**道具 5 本**の定義(#1407 段① / 段④)。
 *
 * | 道具 | 範囲 | できること |
 * |---|---|---|
 * | `pkc_search_notes` | read | 全文検索して、見つかったノートを**本文つき**で返す |
 * | `pkc_read_note` | read | ID で 1 件読む |
 * | `pkc_list_tags` | read | タグの一覧(件数つき) |
 * | `pkc_create_note` | write | ノートを 1 件作る |
 * | `pkc_append_note` | write | ノートの末尾に字を書き足す(#1407 段④) |
 *
 * ## 守っていること
 *
 * 1. 🔴 **許可は `execute` の中で見る**(`gate`)── 道具の登録は flag がオンなら済んでいるが、
 *    **許可が無いまま中身が渡る経路を作らない**。断られたら例外ではなく
 *    `isError: true` の結果で返す(AI が理由を読める)。
 * 2. 🔴 **作る道は `pkc.createEntry`(C-4)と同じ関数を通る** ── 検査も(`parseCreateEntryParams`)、
 *    画面に出る形も(`deps.createEntry` は `main.ts` が bridge に渡す物と**同じ 1 本**)。
 *    2 つ目の作成経路を作らない。
 * 3. 🔴 **生の SQL は出さない。** 探すのは既存の全文検索の op、タグは既存のタグの集計である。
 * 4. 🔴 **system 領域のノート(メッセージ等)は読ませない** ── 読む道は `entryMetas`(user 領域だけ)
 *    を通った ID に限る(`getBody` は領域を見ないので、ID を直に渡すと漏れる)。
 * 5. 🔴 **呼び出しの回数に上限を置く**(1 分に `MAX_PER_MINUTE` ── `pkc.createEntry` の窓口と同じ数)。
 *    AI の道具は postMessage の窓口(`message-bridge`)を通らないので、あちらの上限が効かない。
 *    超えたら断る(許可を聞く前に ── 暴走した AI にダイアログを出し続けさせない)。
 * 6. 返す本文には上限を置く(`MAX_BODY`。作る側と同じ桁)。切ったら `bodyTruncated: true` と言う
 *    (黙って切ると、AI は「これが全文」と読む)。
 * 7. 🔴 **書き足す道は既存の追記(`APPEND_TO_ENTRY`)と同じ 1 本**(`appendAndSettle` ── PDF の
 *    「ノートへ引く」と同じ口)。「書き足しました」は **disk に着いてから**返す。編集中などで
 *    断られたら、その理由を返す(AI が「書いた」と user に言ってしまわない)。
 *
 * ⚠ 画面に出る字(説明文・断り文)は `ui-terms` の門を通る。
 */

import { collectEntryTags } from '@features/flavor/entry-tags';
import { UNSET } from '@features/query/group-by';
import { AGENT_DENIED_TEXT, type AgentGate } from '@features/agent/agent-gate';
import type { ModelContextTool, ToolResult } from '@features/agent/webmcp-types';
import { MAX_BODY, parseCreateEntryParams, type CreateEntryInput } from './create-entry-params';
import { AGENT_ORIGIN_LABEL } from './outside-create';
import type { Via } from './message-bridge';
import { MAX_PER_MINUTE } from './protocol';
import type { AppendOutcome } from '@adapter/state/append-settle';

/** 探す件数の既定と上限。 */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

/** 作ったノートを「どこから来たか」で言うときの名前(ステータスバーに出る)。実体は作成の 1 本の側。 */
export { AGENT_ORIGIN_LABEL };

/** ノート 1 件の見取り(`entryMetas` の 1 行)。 */
export interface AgentMeta {
  title: string;
  archetype: string;
  updatedAt: string | null;
}

export interface AgentToolDeps {
  /**
   * user 領域のノートの見取り。⚠ **無い ID は「読めない」**(system 領域は `entryMetas` に入らない)。
   */
  meta: (id: string) => AgentMeta | undefined;
  /** 全文検索(既存の `searchEntries`)。user 領域の ID の並びと、切ったか。 */
  search: (query: string, limit: number) => Promise<{ ids: string[]; truncated: boolean }>;
  /** 本文を取る(既存の `getBodies`)。無い ID は結果に出ない。 */
  bodies: (ids: string[]) => Promise<Map<string, string>>;
  /** タグの集計(既存の `queryScan('tags')`)。 */
  tags: () => Promise<{ groups: ReadonlyArray<{ value: string; total: number }>; omitted: number }>;
  /**
   * 🔴 `pkc.createEntry` と**同じ関数**(`main.ts` が bridge へ渡す物)。
   * 作れなかったとき(いまの状態では作れない)は `null`。
   */
  createEntry: (
    input: CreateEntryInput,
    origin: string,
    via: Via,
  ) => Promise<string | null> | string | null;
  /**
   * 🔴 ノートの末尾へ書き足し、disk に着くまで待つ(`appendAndSettle` ── PDF の引用と同じ 1 本)。
   * ⚠ ID は `meta` を通った物だけが来る(system 領域へは書かせない)。
   */
  append: (id: string, text: string) => Promise<AppendOutcome>;
  /** 許可の門(`createAgentGate`)。`signal` は AI が依頼を取り消したとき abort される。 */
  gate: AgentGate;
  /** 時計(回数の窓を測る)。省略 = `Date.now`。 */
  now?: () => number;
}

/** 回数の上限に当たったときの断り。 */
export const AGENT_RATE_LIMIT_TEXT = '呼び出しが多すぎます。1 分ほど待ってください';

/**
 * 書き足しの結末を待つ上限(ms)。PDF の引用(`QUOTE_SETTLE_TIMEOUT_MS`)と同じ桁 ──
 * ふつうは 1 秒かからない(待つのは保存の往復だけ)。
 */
export const AGENT_APPEND_SETTLE_TIMEOUT_MS = 8000;

/** 書き足しが着いたか分からないときの断り(`pkc_append_note`)。⚠「書けなかった」とは言い切らない。 */
export const AGENT_APPEND_TIMEOUT_TEXT =
  '書き足せたか確かめられませんでした。同じ字をもう一度送らず、ユーザーにノートを確かめてもらってください';

/** 書き足せなかったときの断り(reducer / 保存が理由を言わなかった回)。 */
export const AGENT_APPEND_FAILED_TEXT = 'いま書き足せませんでした。PKC3 で編集中の可能性があります';

/** 作れなかったときの断り(`pkc_create_note`)。 */
export const AGENT_CREATE_FAILED_TEXT = 'いま作れませんでした。PKC3 で編集中の可能性があります';

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** AI へ返すノート 1 件。 */
function noteOf(id: string, meta: AgentMeta, body: string): Record<string, unknown> {
  const cut = body.length > MAX_BODY;
  return {
    id,
    title: meta.title,
    kind: meta.archetype,
    updatedAt: meta.updatedAt,
    tags: collectEntryTags(body).all,
    body: cut ? body.slice(0, MAX_BODY) : body,
    // ⚠ 切ったことは言う(黙って切ると、AI は「これが全文」と読む)
    ...(cut ? { bodyTruncated: true } : {}),
  };
}

export function buildAgentTools(deps: AgentToolDeps): ModelContextTool[] {
  /** 1 分の窓で数える(5 本まとめて 1 つ ── 呼び手は AI 1 つなので origin ごとには分けない)。 */
  const clock = deps.now ?? Date.now;
  let windowStart = 0;
  let count = 0;
  const withinRate = (): boolean => {
    const t = clock();
    if (count === 0 || t - windowStart >= 60_000) {
      windowStart = t;
      count = 1;
      return true;
    }
    count += 1;
    return count <= MAX_PER_MINUTE;
  };

  const search: ModelContextTool = {
    name: 'pkc_search_notes',
    title: 'ノートを探す',
    description:
      'PKC3 のノートを全文検索して、見つかったノートを本文つきで返します。ユーザーのノートの内容を知る必要があるときに使います。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探す語(題名と本文が対象)' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: SEARCH_MAX_LIMIT,
          description: `返す件数(既定 ${String(SEARCH_DEFAULT_LIMIT)}、上限 ${String(SEARCH_MAX_LIMIT)})`,
        },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (raw, options) => {
      if (!withinRate()) return fail(AGENT_RATE_LIMIT_TEXT);
      const input = asRecord(raw);
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query === '') return fail('query は空でない文字列である必要があります');
      const asked = input.limit;
      if (asked !== undefined && (typeof asked !== 'number' || !Number.isFinite(asked))) {
        return fail('limit は数である必要があります');
      }
      const limit = Math.min(
        SEARCH_MAX_LIMIT,
        Math.max(1, Math.floor(asked ?? SEARCH_DEFAULT_LIMIT)),
      );
      if (!(await deps.gate({ action: 'search', query }, options.signal))) return fail(AGENT_DENIED_TEXT);
      const found = await deps.search(query, limit);
      const ids = found.ids.filter((id) => deps.meta(id) !== undefined).slice(0, limit);
      const bodies = await deps.bodies(ids);
      const notes: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const meta = deps.meta(id);
        const body = bodies.get(id);
        if (meta !== undefined && body !== undefined) notes.push(noteOf(id, meta, body));
      }
      // ⚠ 切ったことは言う(黙って切ると、AI は「これで全部」と読む)
      return ok({ notes, truncated: found.truncated });
    },
  };

  const read: ModelContextTool = {
    name: 'pkc_read_note',
    title: 'ノートを読む',
    description:
      'ID を指定して、PKC3 のノート 1 件を本文つきで返します。pkc_search_notes で見つけたノートの全文を読むときに使います。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'ノートの ID' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (raw, options) => {
      if (!withinRate()) return fail(AGENT_RATE_LIMIT_TEXT);
      const input = asRecord(raw);
      const id = typeof input.id === 'string' ? input.id : '';
      if (id === '') return fail('id は空でない文字列である必要があります');
      const meta = deps.meta(id);
      // ⚠ 見取りに無い ID は読ませない(system 領域のノートを、ID を直に渡して読む道を塞ぐ)。
      //   ⚠ 許可を聞く前に断る ── 読めないノートの題名をダイアログに出さない
      if (meta === undefined) return fail('そのノートは見つかりません');
      if (!(await deps.gate({ action: 'read', title: meta.title }, options.signal))) {
        return fail(AGENT_DENIED_TEXT);
      }
      const body = (await deps.bodies([id])).get(id);
      if (body === undefined) return fail('そのノートは見つかりません');
      return ok(noteOf(id, meta, body));
    },
  };

  const tags: ModelContextTool = {
    name: 'pkc_list_tags',
    title: 'タグの一覧',
    description:
      'PKC3 で使われているタグを、使われている件数の多い順に返します。どんな話題のノートがあるかを知りたいときに使います。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async (_raw, options) => {
      if (!withinRate()) return fail(AGENT_RATE_LIMIT_TEXT);
      if (!(await deps.gate({ action: 'tags' }, options.signal))) return fail(AGENT_DENIED_TEXT);
      const scanned = await deps.tags();
      return ok({
        // ⚠ 「タグが無いノート」の組(UNSET)はタグではない
        tags: scanned.groups.filter((g) => g.value !== UNSET).map((g) => ({ name: g.value, count: g.total })),
        omitted: scanned.omitted,
      });
    },
  };

  const create: ModelContextTool = {
    name: 'pkc_create_note',
    title: 'ノートを作る',
    description:
      'PKC3 に新しいノートを 1 件作ります。ユーザーが頼んだ内容をノートに残すときに使います。題名を省くと本文の最初の行が題名になります。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'ノートの題名(省略可)' },
        body: { type: 'string', description: 'ノートの本文(Markdown)' },
      },
      required: ['body'],
    },
    annotations: { consequentialHint: true },
    execute: async (raw, options) => {
      if (!withinRate()) return fail(AGENT_RATE_LIMIT_TEXT);
      const input = asRecord(raw);
      if (typeof input.body !== 'string') return fail('body は文字列である必要があります');
      // 🔴 検査は `pkc.createEntry` と同じ関数(題名の上限・本文の上限・題名の作り方)
      const parsed = parseCreateEntryParams({ title: input.title, body: input.body });
      if (!parsed.ok) return fail(parsed.message);
      if (!(await deps.gate({ action: 'create', title: parsed.input.title }, options.signal))) {
        return fail(AGENT_DENIED_TEXT);
      }
      // 🔴 作るのも同じ関数(`main.ts` が bridge に渡す `createEntry`)── 画面に出る形も C-4 と同じ
      const id = await deps.createEntry(parsed.input, AGENT_ORIGIN_LABEL, 'origin');
      // 🔴 作れなかったときに成功を返さない(AI が「作った」と user に言ってしまう)
      if (id === null) return fail(AGENT_CREATE_FAILED_TEXT);
      return ok({ id, title: parsed.input.title });
    },
  };

  const append: ModelContextTool = {
    name: 'pkc_append_note',
    title: 'ノートに書き足す',
    description:
      'ID を指定して、PKC3 のノートの末尾に字(Markdown)を書き足します。既にあるノートに続きを残すときに使います。本文の途中や既存の字は変えません。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ノートの ID(pkc_search_notes などで分かる)' },
        text: { type: 'string', description: '書き足す字(Markdown)' },
      },
      required: ['id', 'text'],
    },
    annotations: { consequentialHint: true },
    execute: async (raw, options) => {
      if (!withinRate()) return fail(AGENT_RATE_LIMIT_TEXT);
      const input = asRecord(raw);
      const id = typeof input.id === 'string' ? input.id : '';
      if (id === '') return fail('id は空でない文字列である必要があります');
      if (typeof input.text !== 'string' || input.text.trim() === '') {
        return fail('text は空でない文字列である必要があります');
      }
      // ⚠ 上限は作る側と同じ桁(1 回に書き足せる量)
      if (input.text.length > MAX_BODY) {
        return fail(`text が長すぎます(上限 ${String(MAX_BODY)} 字)`);
      }
      const meta = deps.meta(id);
      // ⚠ 見取りに無い ID へは書かせない(system 領域のノートを、ID を直に渡して書き換える道を塞ぐ)。
      //   ⚠ 許可を聞く前に断る ── 書けないノートの題名をダイアログに出さない
      if (meta === undefined) return fail('そのノートは見つかりません');
      if (!(await deps.gate({ action: 'append', title: meta.title }, options.signal))) {
        return fail(AGENT_DENIED_TEXT);
      }
      const r = await deps.append(id, input.text);
      // 🔴 書けなかったときに成功を返さない(AI が「書き足した」と user に言ってしまう)
      if (r.ok) return ok({ id, title: meta.title });
      if (r.reason === 'timeout') return fail(AGENT_APPEND_TIMEOUT_TEXT);
      return fail(r.error ?? AGENT_APPEND_FAILED_TEXT);
    },
  };

  return [search, read, tags, create, append];
}
