/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出した HTML / Word に、書き出した時点の SQL の答えを表にして焼く**(#1223 Q3 = B)。
 *
 * 閲覧側の HTML には引く相手(sqlite)が居ない ── 焼かないと「持ち出したら答えが消える」。
 * 原文の SQL はコード枠として**残る**(答えと食い違ったときに、何を引いたかが読める)。
 *
 * 守る主張:
 * 1. 閲覧用 HTML: 表 + 原文が入る / 引けなければ 1 行の注記 + 原文 / 器が無い本文は 1 度も引かない
 * 2. 画面の入口(`exportArchive`)が `deps.askSql` を使う ── 配線を落としたら鳴る
 * 3. Word: 同じ(画面の DOM を読まず、もう一度描くので焼かないと答えが無い)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  exportArchive,
  exportEntryDocx,
  type ExportDeps,
} from '../../src/adapter/ui/actions/export-archive';
import { writePortableHtml } from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { SQL_EMBED_ATTR, type SqlEmbedAnswer } from '../../src/features/markdown/sql-embed';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';

const SQL = 'SELECT n FROM t';
const BODY = '# 題\n\n前\n\n```sql embed\n' + SQL + '\n```\n\n後\n';
const ANSWER: SqlEmbedAnswer = { columns: ['n'], rows: [['ANSWER-CELL-1'], ['ANSWER-CELL-2']], truncated: false };

function source(body: string): ArchiveSource {
  return {
    cid: 'c1',
    title: 'T',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: 'ノート',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    listBodies: async () => ({ rows: [{ lid: 'n1', body }], done: true }),
    getBody: async () => body,
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

/** `#pkc-data` の entries[].html を取り出す(閲覧側と同じ読み方)。 */
async function htmlOfFirstEntry(blob: Blob): Promise<string> {
  const text = await blob.text();
  const m = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(text);
  if (!m) throw new Error('#pkc-data が見つかりません');
  return (JSON.parse(m[1]!) as { entries: Array<{ html: string }> }).entries[0]!.html;
}

const NOW = '2026-10-02T00:00:00.000Z';

describe('閲覧用 HTML(writePortableHtml)', () => {
  it('🔴 答えが表になって焼かれ、原文のコード枠も残る', async () => {
    const ask = vi.fn(async () => ANSWER);
    const { blob } = await writePortableHtml(
      source(BODY),
      NOW,
      (t, o) => renderMarkdown(t, o),
      false,
      undefined,
      undefined,
      ask,
    );
    const html = await htmlOfFirstEntry(blob);
    const d = document.createElement('div');
    d.innerHTML = html;
    expect([...d.querySelectorAll(`[${SQL_EMBED_ATTR}] tbody td`)].map((e) => e.textContent)).toEqual([
      'ANSWER-CELL-1',
      'ANSWER-CELL-2',
    ]);
    expect(d.querySelector('pre code.language-sql')!.textContent).toContain(SQL);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('🔴 引けなかったら、表ではなく 1 行の注記 + 原文(書き出しは止まらない)', async () => {
    const ask = vi.fn(async (): Promise<SqlEmbedAnswer> => {
      throw new Error('no such table: t');
    });
    const { blob } = await writePortableHtml(
      source(BODY),
      NOW,
      (t, o) => renderMarkdown(t, o),
      false,
      undefined,
      undefined,
      ask,
    );
    const d = document.createElement('div');
    d.innerHTML = await htmlOfFirstEntry(blob);
    expect(d.querySelector(`[${SQL_EMBED_ATTR}] table`)).toBeNull();
    expect(d.querySelector(`[${SQL_EMBED_ATTR}]`)!.textContent).toContain(
      '答えを引けませんでした: no such table: t',
    );
    expect(d.querySelector('pre code.language-sql')).not.toBeNull();
  });

  it('🔴 器が無い本文(素の ` ```sql `)は 1 度も引かず、HTML は焼き込みの有無で変わらない', async () => {
    const plain = '```sql\n' + SQL + '\n```\n';
    const ask = vi.fn(async () => ANSWER);
    const withAsk = await writePortableHtml(
      source(plain),
      NOW,
      (t, o) => renderMarkdown(t, o),
      false,
      undefined,
      undefined,
      ask,
    );
    const without = await writePortableHtml(source(plain), NOW, (t, o) => renderMarkdown(t, o));
    expect(ask).not.toHaveBeenCalled();
    expect(await htmlOfFirstEntry(withAsk.blob)).toBe(await htmlOfFirstEntry(without.blob));
  });

  it('引く口を渡さない(test 等)と、器は空のまま出る(原文は残る)', async () => {
    const { blob } = await writePortableHtml(source(BODY), NOW, (t, o) => renderMarkdown(t, o));
    const d = document.createElement('div');
    d.innerHTML = await htmlOfFirstEntry(blob);
    expect(d.querySelector(`[${SQL_EMBED_ATTR}]`)!.childElementCount).toBe(0);
    expect(d.querySelector('pre code.language-sql')).not.toBeNull();
  });
});

const fakeDispatcher = (phase: string) => {
  const dispatched: Array<{ type: string; error?: string }> = [];
  return {
    dispatched,
    dispatcher: {
      getState: () => ({ phase }),
      dispatch: (a: { type: string; error?: string }) => dispatched.push(a),
    } as unknown as Dispatcher,
  };
};

function deps(
  src: ArchiveSource,
  askSql: ExportDeps['askSql'],
): { d: ExportDeps; got: Array<{ name: string; blob: Blob }> } {
  const got: Array<{ name: string; blob: Blob }> = [];
  const d: ExportDeps = {
    source: src,
    download: (name, blob) => got.push({ name, blob }),
    report: () => {},
    settle: async () => {},
    renderFigureVector: async () => null,
    renderFigure: async () => null,
    renderBody: async (t, o) => renderMarkdown(t, o),
    askSql,
    now: () => new Date('2026-10-02T00:00:00Z'),
  };
  return { d, got };
}

describe('画面の入口が、引く口を使う(配線)', () => {
  it('🔴 閲覧用 HTML の書き出しで、答えが焼かれる', async () => {
    const ask = vi.fn(async () => ANSWER);
    const { d, got } = deps(source(BODY), ask);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportArchive(dispatcher, d, 'html')).toBe(1);
    const html = await htmlOfFirstEntry(got[0]!.blob);
    expect(html).toContain('ANSWER-CELL-1');
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('Word(exportEntryDocx)', () => {
  it('🔴 答えの表が文書に入る(原文の SQL も残る)', async () => {
    const ask = vi.fn(async () => ANSWER);
    const { d, got } = deps(source(BODY), ask);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    const text = await got[0]!.blob.text();
    expect(text, '答えの表が Word に入っていない').toContain('ANSWER-CELL-1');
    expect(text).toContain('ANSWER-CELL-2');
    expect(text, '原文の SQL が消えた').toContain(SQL);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('🔴 引けなかったら、1 行の注記が入る(書き出しは止まらない)', async () => {
    const ask = vi.fn(async (): Promise<SqlEmbedAnswer> => {
      throw new Error('no such table: t');
    });
    const { d, got } = deps(source(BODY), ask);
    const { dispatcher } = fakeDispatcher('ready');
    expect(await exportEntryDocx(dispatcher, d, 'n1')).toBe(true);
    expect(await got[0]!.blob.text()).toContain('答えを引けませんでした');
  });
});
