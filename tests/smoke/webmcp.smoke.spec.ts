/**
 * 🔴 **ブラウザの AI(WebMCP)に渡す道具 5 本**(#1407 段① / 段④)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は「許可の門」「道具の定義」「登録の条件」を別々に見ている。
 * ここで守るのは**それらが 1 本につながったときの user の動線**:
 *   AI が呼ぶ → PKC3 の中にダイアログが出る(フォーカスは「許さない」)→ 答える →
 *   結果が AI へ返る / 設定の一覧が(画面を描き直さずに)変わる /
 *   作った物が左の一覧に出て、読んでいたノートは動かない。
 *
 * ## 差し込み(⚠ 本物の WebMCP ではない)
 *
 * この箱の Chromium は 141 で、本物の `document.modelContext` は無い
 * (WebMCP は Chrome 149 の Origin Trial)。だから `addInitScript` で
 * **入口を模した最小の物**を置く:
 *  - `registerTool(tool, { signal })` … tools を Map に積み、`signal` の abort で消す
 *  - `getTools()` … いま積まれている物
 *  - `executeTool(tool, input)` … `tool.execute(input, { signal })` を呼ぶ
 * ⚠ 言えるのは「アプリの側の登録・許可・結果の返し方」まで。**本物のブラウザが
 * AI からこの入口を呼ぶ経路**は見ていない(実機の Chrome で確かめる物)。
 *
 * 🔑 起動は 3 つ(OFF の起動 → ON へ再起動 → 2 枚目のタブ)。フラグは起動時に
 * 1 度だけ読む(`needsRestart`)ので、OFF と ON を 1 起動には載せられない。
 * ON の起動の道中に、動線 2〜9 を全部載せた。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  gotoApp,
  bootedHere,
  clickReal,
  createEntry,
  dismissAnnounce,
  collectPageErrors,
  useSplitEditor,
  writesLanded,
} from './helpers';

const FLAGS_KEY = 'pkc3.flags';
const GRANTS_KEY = 'pkc3.agent-grants';
const MARKER = 'zqmarker7391';

/** 入口を模した差し込み。⚠ 全 frame で走る(sandbox の frame には要らない ── top だけに置く)。 */
async function installModelContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    interface Tool {
      name: string;
      execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
    }
    const tools = new Map<string, Tool>();
    const modelContext = {
      registerTool(tool: Tool, options?: { signal?: AbortSignal }) {
        if (tools.has(tool.name)) throw new Error(`重複した道具: ${tool.name}`);
        tools.set(tool.name, tool);
        options?.signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true });
        return Promise.resolve(undefined);
      },
      getTools() {
        return Promise.resolve([...tools.values()].map((t) => ({ name: t.name })));
      },
      executeTool(tool: Tool | string, input: unknown) {
        const name = typeof tool === 'string' ? tool : tool.name;
        const t = tools.get(name);
        if (t === undefined) return Promise.reject(new Error(`未登録: ${name}`));
        return t.execute(input, { signal: new AbortController().signal });
      },
    };
    Object.defineProperty(document, 'modelContext', { value: modelContext, configurable: true });
    const w = window as unknown as Record<string, unknown>;
    /** 待たずに投げる。結果は `__mcpResult` で取る。 */
    w.__mcpCall = (name: string, input: unknown) => {
      w.__mcpPending = modelContext.executeTool(name, input);
    };
    w.__mcpResult = () => w.__mcpPending;
  });
}

/** 登録されている道具の名前(昇順)。 */
async function toolNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const mc = (document as unknown as { modelContext: { getTools: () => Promise<{ name: string }[]> } })
      .modelContext;
    return (await mc.getTools()).map((t) => t.name).sort();
  });
}

/** 待たずに投げる(ダイアログが出てから答えるため)。 */
async function callNoWait(page: Page, name: string, input: unknown): Promise<void> {
  await page.evaluate(
    ([n, i]) => {
      (window as unknown as { __mcpCall: (a: string, b: unknown) => void }).__mcpCall(n as string, i);
    },
    [name, input] as const,
  );
}

interface McpResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function takeResult(page: Page): Promise<McpResult> {
  return page.evaluate(
    () => (window as unknown as { __mcpResult: () => Promise<McpResult> }).__mcpResult(),
  );
}

function textOf(r: McpResult): string {
  return r.content.map((c) => c.text).join('\n');
}

/** ダイアログの 3 択。⚠ 「許さない」は取り消し側(`dialog-cancel`)、あとの 2 つは行。 */
const ASK_NOTE = '[data-pkc-field="pick-agent-grant-note"]';
const ASK_ROW = '[data-pkc-field="pick-agent-grant"]';
const ASK_DENY = '[data-pkc-field="dialog-cancel"]';

async function expectAsk(page: Page, noteHas: string): Promise<void> {
  const note = page.locator(ASK_NOTE);
  await expect(note, '許可のダイアログが出ていない').toBeVisible();
  await expect(note, 'ダイアログの 1 行目に何をしようとしているかが出ていない').toContainText(noteHas);
  expect(
    await page.locator(ASK_ROW).allTextContents(),
    'ダイアログの選び口が「この 1 回だけ」「常に許す」ではない',
  ).toEqual(['この 1 回だけ', '常に許す']);
  await expect(page.locator(ASK_DENY)).toHaveText('許さない');
}

test('🔴 WebMCP: OFF では登録されず / ON で 5 本 / 許可のダイアログ → 結果 / 作っても選択は動かず / 取り消すとまた聞く / 2 枚目のタブには無い', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSplitEditor(page);
  await installModelContext(page);

  // ── 1. フラグ OFF(既定): 入口は在るのに、登録されない ──
  await gotoApp(page);
  expect(await toolNames(page), 'フラグがオフなのに道具が登録された').toEqual([]);

  // ── 2. フラグを立てて再起動(フラグ画面の「再起動」と同じ ── 起動時に 1 度だけ読む) ──
  await page.evaluate(
    ([k]) => localStorage.setItem(k, JSON.stringify({ 'agent.webmcp': true })),
    [FLAGS_KEY] as const,
  );
  await page.reload();
  await bootedHere(page);
  await expect
    .poll(() => toolNames(page), { message: 'メインのタブで 5 本が登録されない', timeout: 15_000 })
    .toEqual(['pkc_append_note', 'pkc_create_note', 'pkc_list_tags', 'pkc_read_note', 'pkc_search_notes']);
  await dismissAnnounce(page);

  // 設定 → システム → 許可 の節:「このタブ: 使えます」。許したことはまだ無い。
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const agents = page.locator('[data-pkc-region="settings-agents"]');
  await expect(agents.locator('[data-pkc-field="agent-tab-status"]')).toHaveText('このタブ: 使えます');
  await expect(agents.locator('[data-pkc-field="agent-list"]')).toContainText('まだ許したことはありません');
  await clickReal(page, '[data-pkc-action="close-pane"]');

  // ── 3. ノートを 2 件作る。目印の語は 1 件目だけ。**最後に作った 2 件目を読んでいる**状態にする ──
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`# 探される側\n\n${MARKER} が入った本文`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('探される側');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 読んでいる側\n\n別の本文');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const reading = page.locator('[data-pkc-field="detail-body"] h1');
  await expect(reading).toContainText('読んでいる側');
  await writesLanded(page);
  const rows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await expect(rows, '前提: 一覧に 2 件').toHaveCount(2);

  // ── 4. search を**待たずに**投げる → 中にダイアログ。焦点は「許さない」 ──
  await callNoWait(page, 'pkc_search_notes', { query: MARKER });
  await expectAsk(page, `『${MARKER}』`);
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-pkc-field') ?? null),
    '最初の焦点が「許さない」に無い(打鍵の最中に出ても通す側を押さない)',
  ).toBe('dialog-cancel');

  // ── 5. 「許さない」→ isError・断りの字・台帳は空のまま ──
  await clickReal(page, ASK_DENY);
  await expect(page.locator(ASK_NOTE)).toBeHidden();
  const denied = await takeResult(page);
  expect(denied.isError, '断ったのに isError でない').toBe(true);
  expect(textOf(denied)).toContain('ユーザーが許可しませんでした');
  expect(
    await page.evaluate((k) => localStorage.getItem(k), GRANTS_KEY),
    '断ったのに許可が台帳に残った',
  ).toBeNull();

  // ── 6. もう一度 → 「常に許す」→ 目印のノートの body が返る。設定の一覧は**描き直さずに**変わる ──
  //    (設定の面を開いたまま呼ぶ ── 手で render を呼ばない)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(agents.locator('[data-pkc-field="agent-list"]')).toContainText('まだ許したことはありません');
  await callNoWait(page, 'pkc_search_notes', { query: MARKER });
  await expectAsk(page, `『${MARKER}』`);
  await clickReal(page, `${ASK_ROW}[data-pkc-agent-grant-index="1"]`);
  await expect(page.locator(ASK_NOTE)).toBeHidden();
  const found = await takeResult(page);
  expect(found.isError, `検索が失敗した: ${textOf(found)}`).toBeFalsy();
  const foundJson = JSON.parse(textOf(found)) as {
    notes: { id: string; title: string; body: string }[];
  };
  expect(foundJson.notes, '目印のノートがちょうど 1 件見つかる').toHaveLength(1);
  expect(foundJson.notes[0]!.body, 'body に本文が入っていない').toContain(MARKER);
  const foundId = foundJson.notes[0]!.id;
  const readRow = agents.locator('li[data-pkc-agent-scope="read"]');
  await expect(readRow, '「探す・読む」の行が(描き直さずに)出ていない').toBeVisible();
  await expect(readRow.locator('[data-pkc-field="agent-scope-name"]')).toHaveText('ノートを探す・読む');
  await expect(readRow.locator('[data-pkc-action="revoke-agent"]')).toHaveText('許可を取り消す');
  await clickReal(page, '[data-pkc-action="close-pane"]');

  // ── 7. 常に許す済みの範囲 → ダイアログ無しで返る(read / list_tags) ──
  await callNoWait(page, 'pkc_read_note', { id: foundId });
  const readRes = await takeResult(page);
  expect(readRes.isError, `読めなかった: ${textOf(readRes)}`).toBeFalsy();
  expect(textOf(readRes)).toContain(MARKER);
  await expect(page.locator(ASK_NOTE), '常に許したのにダイアログが出た').toBeHidden();
  await callNoWait(page, 'pkc_list_tags', {});
  const tagsRes = await takeResult(page);
  expect(tagsRes.isError, `タグの一覧が失敗した: ${textOf(tagsRes)}`).toBeFalsy();
  expect(JSON.parse(textOf(tagsRes))).toHaveProperty('tags');
  await expect(page.locator(ASK_NOTE)).toBeHidden();

  // ── 8. create → 作る側のダイアログ(別の範囲なので聞く)。選択は動かず、一覧が 1 件増え、知らせに「開く」 ──
  await callNoWait(page, 'pkc_create_note', { title: 'AI が作った', body: 'AI の本文' });
  await expectAsk(page, '『AI が作った』というノートを作ろう');
  await clickReal(page, `${ASK_ROW}[data-pkc-agent-grant-index="0"]`); // この 1 回だけ
  await expect(page.locator(ASK_NOTE)).toBeHidden();
  const made = await takeResult(page);
  expect(made.isError, `作れなかった: ${textOf(made)}`).toBeFalsy();
  expect(JSON.parse(textOf(made)) as { id: string }).toHaveProperty('id');
  await expect(rows, '作ったノートが左の一覧に増えていない').toHaveCount(3);
  await expect(reading, '作ったら読んでいたノートが動いた(選択が奪われた)').toContainText('読んでいる側');
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status).toContainText('ブラウザの AI がノートを作りました');
  await expect(page.locator('[data-pkc-field="status-open"]'), '知らせに「開く」が無い').toBeVisible();
  // 「この 1 回だけ」は憶えない ── もう一度作るとまた聞く
  await callNoWait(page, 'pkc_create_note', { title: 'AI が作った 2', body: '二つ目' });
  await expectAsk(page, '『AI が作った 2』');
  await clickReal(page, `${ASK_ROW}[data-pkc-agent-grant-index="0"]`);
  const made2 = await takeResult(page);
  expect(made2.isError, `2 回目が作れなかった: ${textOf(made2)}`).toBeFalsy();
  await expect(rows).toHaveCount(4);
  await expect(reading).toContainText('読んでいる側');
  const ledger = JSON.parse(
    (await page.evaluate((k) => localStorage.getItem(k), GRANTS_KEY)) ?? '{}',
  ) as { read?: { always?: boolean }; write?: { always?: boolean } };
  expect(ledger.read?.always, '「常に許す」が台帳に残っていない').toBe(true);
  expect(ledger.write?.always, '「この 1 回だけ」が write の許可として台帳に残った').not.toBe(true);

  // ── 8b. append(#1407 段④)→ 書き足す側のダイアログ(write)。末尾に足され、選択は動かない。
  //    disk に着いたかは read で読み直して見る(read は「常に許す」済み ── ダイアログ無し)
  await callNoWait(page, 'pkc_append_note', { id: foundId, text: 'AI が足した続き' });
  await expectAsk(page, '『探される側』の末尾に書き足そう');
  await clickReal(page, `${ASK_ROW}[data-pkc-agent-grant-index="0"]`); // この 1 回だけ
  await expect(page.locator(ASK_NOTE)).toBeHidden();
  const appended = await takeResult(page);
  expect(appended.isError, `書き足せなかった: ${textOf(appended)}`).toBeFalsy();
  expect(JSON.parse(textOf(appended))).toEqual({ id: foundId, title: '探される側' });
  await expect(reading, '書き足したら読んでいたノートが動いた').toContainText('読んでいる側');
  await callNoWait(page, 'pkc_read_note', { id: foundId });
  const reread = JSON.parse(textOf(await takeResult(page))) as { body: string };
  expect(reread.body, '書き足した字が本文の末尾に無い').toMatch(/AI が足した続き\s*$/u);
  expect(reread.body, '書き足したら元の本文が消えた').toContain(MARKER);

  // ── 9. 許可を取り消す → 一覧から消え、search はまた聞く ──
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, readRow.locator('[data-pkc-action="revoke-agent"]'));
  // 台帳からも消えている
  expect(
    JSON.parse((await page.evaluate((k) => localStorage.getItem(k), GRANTS_KEY)) ?? '{}') as {
      read?: { always?: boolean };
    },
    '取り消したのに台帳に read が残っている',
  ).not.toHaveProperty('read.always', true);
  await expect(readRow, '取り消したのに一覧に残っている').toHaveCount(0);
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await callNoWait(page, 'pkc_search_notes', { query: MARKER });
  await expectAsk(page, `『${MARKER}』`);
  await clickReal(page, ASK_DENY);
  expect((await takeResult(page)).isError).toBe(true);

  // ── 10. 2 枚目のタブ(follower)では 0 本・設定は「メインのタブではありません」 ──
  const pageB = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await useSplitEditor(pageB);
  await installModelContext(pageB);
  await gotoApp(pageB);
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText('保存はメインのタブ経由');
  expect(await toolNames(pageB), '2 枚目のタブにも道具が登録された').toEqual([]);
  // ⚠ お知らせは 1 枚目で既読にした(同じ profile)── 2 枚目には出ない
  await clickReal(pageB, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(
    pageB.locator('[data-pkc-region="settings-agents"] [data-pkc-field="agent-tab-status"]'),
  ).toContainText('メインのタブではありません');
  // メインのタブの登録は 2 枚目のタブに左右されない
  expect(await toolNames(page)).toHaveLength(5);

  expect(errors, 'pageerror が出た(1 枚目)').toEqual([]);
  expect(errorsB, 'pageerror が出た(2 枚目)').toEqual([]);
});
