/**
 * ブラウザの AI(WebMCP)に渡す**道具 4 本**の定義(#1407 段①)。
 *
 * | 道具 | 範囲 | できること |
 * |---|---|---|
 * | `pkc_search_notes` | read | 全文検索して、見つかったノートを**本文つき**で返す |
 * | `pkc_read_note` | read | ID で 1 件読む |
 * | `pkc_list_tags` | read | タグの一覧(件数つき) |
 * | `pkc_create_note` | write | ノートを 1 件作る |
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
 * 5. 返す本文には上限を置く(`MAX_BODY`。作る側と同じ桁)。切ったら `bodyTruncated: true` と言う
 *    (黙って切ると、AI は「これが全文」と読む)。
 *
 * ⚠ 画面に出る字(説明文・断り文)は `ui-terms` の門を通る。
 */

import { collectEntryTags } from '@features/flavor/entry-tags';
import { UNSET } from '@features/query/group-by';
import {
  AGENT_DENIED_TEXT,
  type AgentScope,
} from '@features/agent/agent-gate';
import type { ModelContextTool, ToolResult } from '@features/agent/webmcp-types';
import { MAX_BODY, parseCreateEntryParams, type CreateEntryInput } from './create-entry-params';
import type { Via } from './message-bridge';

/** 探す件数の既定と上限。 */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

/** 作ったノートを「どこから来たか」で言うときの名前(帯に出る)。 */
export const AGENT_ORIGIN_LABEL = 'ブラウザの AI';

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
  /** 🔴 `pkc.createEntry` と**同じ関数**(`main.ts` が bridge へ渡す物)。 */
  createEntry: (input: CreateEntryInput, origin: string, via: Via) => Promise<string> | string;
  /** 許可の門(`createAgentGate`)。 */
  gate: (scope: AgentScope) => Promise<boolean>;
}

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
    execute: async (raw) => {
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
      if (!(await deps.gate('read'))) return fail(AGENT_DENIED_TEXT);
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
    execute: async (raw) => {
      const input = asRecord(raw);
      const id = typeof input.id === 'string' ? input.id : '';
      if (id === '') return fail('id は空でない文字列である必要があります');
      if (!(await deps.gate('read'))) return fail(AGENT_DENIED_TEXT);
      const meta = deps.meta(id);
      // ⚠ 見取りに無い ID は読ませない(system 領域のノートを、ID を直に渡して読む道を塞ぐ)
      if (meta === undefined) return fail('そのノートは見つかりません');
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
    execute: async () => {
      if (!(await deps.gate('read'))) return fail(AGENT_DENIED_TEXT);
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
    execute: async (raw) => {
      const input = asRecord(raw);
      if (typeof input.body !== 'string') return fail('body は文字列である必要があります');
      // 🔴 検査は `pkc.createEntry` と同じ関数(題名の上限・本文の上限・題名の作り方)
      const parsed = parseCreateEntryParams({ title: input.title, body: input.body });
      if (!parsed.ok) return fail(parsed.message);
      if (!(await deps.gate('write'))) return fail(AGENT_DENIED_TEXT);
      // 🔴 作るのも同じ関数(`main.ts` が bridge に渡す `createEntry`)── 画面に出る形も C-4 と同じ
      const id = await deps.createEntry(parsed.input, AGENT_ORIGIN_LABEL, 'origin');
      return ok({ id, title: parsed.input.title });
    },
  };

  return [search, read, tags, create];
}
