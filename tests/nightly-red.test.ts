/** @vitest-environment node */
/**
 * 夜が赤いことを台帳に出す導線(#221)。
 *
 * 🔴 ここを test で縛る理由: **この経路は夜にしか走らない**。手で確かめる機会が
 * 無いので、「書いたけれど動かない通知」になりやすい ── そして壊れていても
 * **症状は「静かなまま」**(まさに 13 晩気づかなかった当の形)である。
 *
 * ⚠ 見るのは「関数が何か返した」ではなく、**どの API をどう叩いたか**。
 *   ここを緩めると、URL や method を取り違える変異が丸ごと生き延びる。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
// @ts-expect-error -- 通知の規則は素の .mjs(ビルド対象外の CI script 群)
import { reconcileNightlyIssue, unmetSteps, LABEL } from '../scripts/nightly-red.mjs';

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** 記録つきの偽 `fetch`。`openIssues` が「いま開いている issue」の返り値。 */
function fakeFetch(openIssues: unknown[], opts: { labelStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (method === 'GET') return { ok: true, status: 200, json: async () => openIssues };
    if (url.endsWith('/labels')) {
      const status = opts.labelStatus ?? 201;
      return { ok: status < 300, status, json: async () => ({}) };
    }
    return { ok: true, status: 201, json: async () => ({ number: 999 }) };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const BASE = {
  repo: 'sm06224/PKC3',
  token: 't',
  runUrl: 'https://github.com/sm06224/PKC3/actions/runs/12345',
  today: '2026-08-17',
};

/** 書き込み(GET 以外)だけ取り出す。 */
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

describe('夜が赤いときの台帳', () => {
  it('赤 + 開いている issue が無い → label を用意してから 1 本立てる', async () => {
    const { fetch, calls } = fakeFetch([]);
    const out = await reconcileNightlyIssue({
      ...BASE,
      fetch,
      failedSteps: ['Probe — sidebar (15k 行の DOM 同一性)', 'Probe — kanban (トグル往復 / move 数)'],
    });
    expect(out.action).toBe('created');
    expect(out.issue).toBe(999);

    /**
     * 🔴 **一覧の引き方も見る**(2026-08-17 のレビュー 🔴-3)。初稿は GET を
     * `writes()` で捨てていたので、`labels=` を落とす変異が生き延びた ──
     * その形だと**開いている無関係な issue の先頭**(例: 台帳 #180)に
     * 「✅ 緑に戻りました」と書いて**閉じる**。
     */
    const q = new URL(calls[0]!.url).search;
    expect(q, '開いているものだけに絞っていない').toContain('state=open');
    expect(q, 'label で絞っていない').toContain(`labels=${encodeURIComponent(LABEL)}`);

    const w = writes(calls);
    expect(w.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /repos/sm06224/PKC3/labels',
      'POST /repos/sm06224/PKC3/issues',
    ]);
    // ⚠ **全部の呼びに鍵が付くこと** ── 付け忘れると 401/403 で、
    //   「通知が届かない」だけが起きる(2026-08-17 のレビュー ⚠-12)
    for (const c of calls) expect(c.headers.authorization, `${c.method} ${c.url}`).toBe('Bearer t');
    const issue = w[1]!.body!;
    expect(issue.labels).toEqual([LABEL]);
    expect(String(issue.title)).toContain('2026-08-17');
    // ⚠ **落ちた step 名が本文に入ること** ── 入っていないと、issue を読んでも
    //   何が壊れたか分からず、結局 Actions を開く羽目になる(直したい症状そのもの)
    expect(String(issue.body)).toContain('Probe — sidebar (15k 行の DOM 同一性)');
    expect(String(issue.body)).toContain('Probe — kanban (トグル往復 / move 数)');
    expect(String(issue.body)).toContain(BASE.runUrl);
  });

  it('赤 + 既に開いている → 積むだけ(2 本目を立てない)', async () => {
    const { fetch, calls } = fakeFetch([{ number: 42 }]);
    const out = await reconcileNightlyIssue({
      ...BASE,
      fetch,
      failedSteps: ['Probe — editor (打鍵 / 対照群)'],
    });
    expect(out).toEqual({ action: 'commented', issue: 42 });
    const w = writes(calls);
    expect(w).toHaveLength(1);
    expect(new URL(w[0]!.url).pathname).toBe('/repos/sm06224/PKC3/issues/42/comments');
    expect(String(w[0]!.body!.body)).toContain('Probe — editor (打鍵 / 対照群)');
  });

  it('緑 + 開いている → 戻ったと書いて閉じる', async () => {
    const { fetch, calls } = fakeFetch([{ number: 42 }]);
    const out = await reconcileNightlyIssue({ ...BASE, fetch, failedSteps: [] });
    expect(out).toEqual({ action: 'closed', issue: 42 });
    const w = writes(calls);
    expect(w.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /repos/sm06224/PKC3/issues/42/comments',
      'PATCH /repos/sm06224/PKC3/issues/42',
    ]);
    expect(w[1]!.body).toMatchObject({ state: 'closed' });
  });

  it('緑 + 開いていない → 1 バイトも書かない', async () => {
    const { fetch, calls } = fakeFetch([]);
    const out = await reconcileNightlyIssue({ ...BASE, fetch, failedSteps: [] });
    expect(out).toEqual({ action: 'noop', issue: null });
    expect(writes(calls)).toEqual([]);
  });

  it('🔴 一覧に混ざった PR には書かない(issues API は PR も返す)', async () => {
    const { fetch, calls } = fakeFetch([{ number: 7, pull_request: { url: 'x' } }, { number: 8 }]);
    const out = await reconcileNightlyIssue({ ...BASE, fetch, failedSteps: ['x'] });
    expect(out.issue).toBe(8);
    expect(new URL(writes(calls)[0]!.url).pathname).toBe('/repos/sm06224/PKC3/issues/8/comments');
  });

  it('label が既に在る(422)のは失敗ではない ── そのまま issue を立てる', async () => {
    const { fetch, calls } = fakeFetch([], { labelStatus: 422 });
    const out = await reconcileNightlyIssue({ ...BASE, fetch, failedSteps: ['x'] });
    expect(out.action).toBe('created');
    expect(writes(calls)).toHaveLength(2);
  });

  /**
   * 🔴 **1 か所ずつ落とす**(2026-08-17 の変異試験で書き直した)。
   *
   * 初稿は「全部の応答を 403 にする」1 件だけで、`if (!res.ok) throw` を
   * **`return {}` へ変える変異が生き延びた** ── label 作成だけは別経路で状態を
   * 見ているので、**そちらが投げて test が緑になっていた**(救い手が変わった
   * だけ。CLAUDE.md §1)。落とす場所を 1 つに絞ると殺せる。
   */
  it('🔴 一覧の取得が落ちたら止まる(黙って「開いていない」と読まない)', async () => {
    const fetch = (async (_url: string, init: RequestInit = {}) =>
      (init.method ?? 'GET') === 'GET'
        ? { ok: false, status: 403, json: async () => ({}) }
        : { ok: true, status: 201, json: async () => ({ number: 1 }) }) as unknown as typeof globalThis.fetch;
    await expect(reconcileNightlyIssue({ ...BASE, fetch, failedSteps: ['x'] })).rejects.toThrow(
      '403',
    );
  });

  it('🔴 緑の回も、一覧は label で絞ってから閉じる', async () => {
    // ⚠ 閉じる経路のほうが危ない(無関係な issue を閉じる)。両方向で見る
    const { fetch, calls } = fakeFetch([{ number: 42 }]);
    await reconcileNightlyIssue({ ...BASE, fetch, failedSteps: [] });
    const q = new URL(calls[0]!.url).search;
    expect(q).toContain('state=open');
    expect(q).toContain(`labels=${encodeURIComponent(LABEL)}`);
  });

  it('🔴 コメントの投稿が落ちたら止まる(閉じるほうへ進まない)', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${new URL(url).pathname}`);
      if (method === 'GET') return { ok: true, status: 200, json: async () => [{ number: 42 }] };
      if (url.endsWith('/comments')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof globalThis.fetch;
    await expect(reconcileNightlyIssue({ ...BASE, fetch, failedSteps: [] })).rejects.toThrow('500');
    // ⚠ 「落ちたのに閉じた」を作らない ── PATCH まで進んでいないこと
    expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });
});

/**
 * 何を「赤」と数えるか(#221 のレビュー 🔴-1)。
 *
 * 🔴 初稿はこの判定を **workflow の `node -e` 1 行**に書いていた ──
 * ① `skipped` / `cancelled` を**緑と読む**(仕込みが落ちて以降が飛んだ晩に
 *    「✅ 緑に戻りました」と誤報して issue を閉じる)
 * ② その 1 行は**どの test からも実行されない**(CLAUDE.md §2)
 * だから script 側へ出し、ここで全経路を通す。
 */
describe('揃わなかった step の数え方', () => {
  const json = (o: unknown) => JSON.stringify(o);

  it('落ちた step を id:outcome で返す', () => {
    expect(
      unmetSteps(json({ npm_ci: { outcome: 'success' }, probe_sidebar: { outcome: 'failure' } })),
    ).toEqual(['probe_sidebar:failure']);
  });

  it('🔴 走らなかった(skipped)も赤に数える ── 「確かめていない」は緑ではない', () => {
    expect(
      unmetSteps(json({ npm_ci: { outcome: 'failure' }, probe_schedule: { outcome: 'skipped' } })),
    ).toEqual(['npm_ci:failure', 'probe_schedule:skipped']);
  });

  it('cancelled も赤に数える', () => {
    expect(unmetSteps(json({ a: { outcome: 'cancelled' } }))).toEqual(['a:cancelled']);
  });

  it('走っている最中(outcome が空)は数えない ── 自分自身を赤にしない', () => {
    expect(unmetSteps(json({ a: { outcome: 'success' }, ledger: { outcome: '' } }))).toEqual([]);
  });

  it('🔴 空を「緑」と読まない(id を落とすと静かに空になる)', () => {
    expect(() => unmetSteps(json({}))).toThrow('空');
    expect(() => unmetSteps(undefined)).toThrow('空');
    expect(() => unmetSteps('')).toThrow('空');
  });

  it('🔴 JSON として読めないなら止まる(集計の故障を緑にしない)', () => {
    expect(() => unmetSteps('{')).toThrow('JSON');
    expect(() => unmetSteps(json([1, 2]))).toThrow('空');
  });
});

/**
 * CLI の口(`node scripts/nightly-red.mjs`)── **vitest からは 1 度も実行されない**
 * 部分なので、ここだけ実際に起動して確かめる(CLAUDE.md §2「どの test からも
 * 実行されない file に判断を書かない」)。⚠ 壊れたときの症状は「何もせず exit 0」
 * = 静かな緑である。
 */
describe('台帳 CLI の口', () => {
  const run = (env: Record<string, string>): { code: number; out: string } => {
    try {
      const out = execFileSync('node', ['scripts/nightly-red.mjs'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // ⚠ 実際の GitHub 環境変数を継がせない(手元の値で通ってしまわないように)
        env: { PATH: process.env.PATH ?? '', ...env },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  it('repo / token が無ければ 2 で落ちる(黙って何もしない形にしない)', () => {
    const r = run({});
    expect(r.code).toBe(2);
    expect(r.out).toContain('GITHUB_REPOSITORY');
  });

  it('🔴 steps が渡っていなければ落ちる(空を緑と読まない)', () => {
    const r = run({ GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_RUN_ID: '1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('STEPS');
  });
});
