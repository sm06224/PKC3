/** @vitest-environment happy-dom */
/**
 * 🔴 **PKC2 のポータブル形式(単一 HTML)で書き出す**(台帳 #1416)。
 *
 * 守る主張:
 * ① 変換の中身 ── 種類ごとに PKC2 の形(textlog = JSON のログ / todo = JSON / form = JSON / 添付 = JSON + base64)になり、
 *   PKC3 独自の種類はノートになる(件数で言う)
 * ② 元の HTML の `#pkc-data` だけを入れ替える(前後は 1 バイトも変えない)── 元が PKC2 の HTML でなければ断る
 * ③ **往復**: 書き出した HTML を PKC3 自身の取り込み(`parsePkc2Html` → `convertPkc2Container`)で読むと、元のノートが戻る
 *   (PKC2 が読む形を、PKC3 の読み手を物差しにして確かめる)
 */
import { describe, expect, it } from 'vitest';
import {
  markdownToLogRows,
  pkc2DataParts,
  pkc2HtmlFileName,
  planPkc2Container,
  Pkc2ShellError,
  shellSchemaVersion,
  splitPkc2Shell,
  toIsoStamp,
  type Pkc2ExportEntry,
} from '../../src/features/export/pkc2-container';
import { parsePkc2Html } from '../../src/features/import/pkc2-html';
import { convertPkc2Container } from '../../src/features/import/pkc2-convert';

const NOW = new Date(Date.UTC(2026, 9, 29, 3, 0, 0));

const SHELL =
  '<!DOCTYPE html><html lang="ja" data-pkc-app="pkc2" data-pkc-version="2.5.0" data-pkc-schema="1" data-pkc-kind="dev">' +
  '<head><meta charset="UTF-8"><title>PKC2</title></head><body><div id="pkc-root"></div>' +
  '<script id="pkc-data" type="application/json">{"container":{"meta":{"container_id":"old"},"entries":[],"relations":[],"revisions":[],"assets":{}}}</script>\n' +
  '<script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1,"version":"2.5.0"}</script>\n' +
  '<script id="pkc-core">/* app code */ var a = "</scr" + "ipt>";</script></body></html>';

const e = (over: Partial<Pkc2ExportEntry> & { lid: string; archetype: string; body: string }): Pkc2ExportEntry => ({
  title: over.lid,
  entryOrder: 1,
  createdAt: '2026-10-01 00:00:00',
  updatedAt: '2026-10-02 00:00:00',
  ...over,
});

const ENTRIES: Pkc2ExportEntry[] = [
  e({ lid: 'f1', archetype: 'folder', title: '資料', body: 'フォルダの説明', entryOrder: 1 }),
  e({ lid: 't1', archetype: 'text', title: 'メモ', body: '---\ntags: [買い物, 家事]\n---\n牛乳を買う ![](asset:abc123)\n', entryOrder: 2 }),
  e({
    lid: 'l1',
    archetype: 'textlog',
    title: '日誌',
    body: '## 2026-10-10 12:30:05\n\n朝会\n\n## 2026-10-10 18:00:00 ★\n\n振り返り\n\n```md\n## 2026-10-11 00:00:00\n```\n',
    entryOrder: 3,
  }),
  e({ lid: 'd1', archetype: 'todo', title: '見積', body: '---\nstatus: done\ndate: 2026-10-20\nowner: 山田\n---\n見積を送る\n', entryOrder: 4 }),
  e({ lid: 'fm', archetype: 'form', title: 'フォーム', body: '---\nform.name: 山田\nform.checked: true\n---\n備考\n', entryOrder: 5 }),
  e({
    lid: 'a1',
    archetype: 'attachment',
    title: '請求書.pdf',
    body: '---\nattachment.name: 請求書.pdf\nattachment.mime: application/pdf\nattachment.size: 12\nattachment.asset_key: abc123\n---\n',
    entryOrder: 6,
  }),
  e({ lid: 's1', archetype: 'stack', title: 'スタック', body: '- [[メモ]]\n', entryOrder: 7 }),
];

function plan() {
  return planPkc2Container({
    title: 'テスト箱',
    containerId: 'cid-1',
    entries: ENTRIES,
    relations: [
      { id: 'r1', fromLid: 'f1', toLid: 't1', kind: 'structural', createdAt: null, updatedAt: null },
      { id: 'r2', fromLid: 'f1', toLid: 'gone', kind: 'structural', createdAt: null, updatedAt: null },
    ],
    assets: new Map([['abc123', { mime: 'application/pdf', size: 12 }]]),
    now: NOW,
    schemaVersion: 1,
  });
}

describe('変換の中身 (#1416)', () => {
  it('🔴 種類ごとに PKC2 の形になる', () => {
    const p = plan();
    const by = new Map(p.container.entries.map((x) => [x.lid, x]));
    expect(by.get('f1')!.archetype).toBe('folder');
    expect(by.get('t1')!.archetype).toBe('text');
    expect(by.get('t1')!.tags).toEqual(['買い物', '家事']);
    expect(by.get('t1')!.body, '本文は原文のまま').toContain('牛乳を買う ![](asset:abc123)');
    const log = JSON.parse(by.get('l1')!.body) as { entries: Array<{ text: string; flags: string[]; createdAt: string }> };
    expect(log.entries, 'fence の中の見出しで割れている').toHaveLength(2);
    expect(log.entries[0]!.text).toBe('朝会');
    expect(log.entries[1]!.flags).toEqual(['important']);
    expect(log.entries[1]!.text).toContain('```md\n## 2026-10-11 00:00:00\n```');
    expect(JSON.parse(by.get('d1')!.body)).toEqual({ status: 'done', description: '見積を送る\n', date: '2026-10-20' });
    expect(JSON.parse(by.get('fm')!.body)).toEqual({ name: '山田', note: '備考\n', checked: true });
    expect(JSON.parse(by.get('a1')!.body)).toEqual({ name: '請求書.pdf', mime: 'application/pdf', size: 12, asset_key: 'abc123' });
    expect(by.get('s1')!.archetype, 'PKC3 独自の種類はノートになる').toBe('text');
  });

  it('つながりは両端がある物だけ。順序・時刻・題名が入る', () => {
    const p = plan();
    expect(p.container.relations.map((r) => r.id)).toEqual(['r1']);
    expect(p.container.meta.entry_order).toEqual(['f1', 't1', 'l1', 'd1', 'fm', 'a1', 's1']);
    expect(p.container.meta.title).toBe('テスト箱');
    expect(p.container.entries[0]!.created_at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('🔴 落ちる物は黙らず言う(独自の種類・前書き・つながり・記法・履歴)', () => {
    const w = plan().warnings.join('\n');
    expect(w).toContain('PKC3 独自の種類');
    expect(w).toContain('前書き');
    expect(w).toContain('つながり 1 件');
    expect(w).toContain('字のまま');
    expect(w).toContain('履歴');
  });

  it('PKC2 の許さない字の添付 key は付け替え、本文の参照も揃える', () => {
    const p = planPkc2Container({
      title: 't',
      containerId: 'c',
      entries: [e({ lid: 'x', archetype: 'text', body: '![](asset:sha256:ab/cd)' })],
      relations: [],
      assets: new Map([['sha256:ab/cd', { mime: 'image/png', size: 1 }]]),
      now: NOW,
      schemaVersion: 1,
    });
    const to = p.assetKeys.get('sha256:ab/cd')!;
    expect(to).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(p.container.entries[0]!.body).toBe(`![](asset:${to})`);
  });

  it('ログの前置き(日時見出しの前の字)は捨てずに 1 件目にする / (日時なし) は作成時刻', () => {
    const rows = markdownToLogRows('前置き\n\n## (日時なし)\n\n日時が無い行\n', '2026-10-01T00:00:00.000Z');
    expect(rows.map((r) => r.text)).toEqual(['前置き', '日時が無い行']);
    expect(rows[1]!.createdAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('時刻の正規化: 保存形(UTC)→ ISO。読めなければ fallback', () => {
    expect(toIsoStamp('2026-10-01 09:08:07', 'x')).toBe('2026-10-01T09:08:07.000Z');
    expect(toIsoStamp(null, 'x')).toBe('x');
    expect(toIsoStamp('でたらめ', 'x')).toBe('x');
  });

  it('ファイル名は pkc2-<題名>-<日付>.html', () => {
    expect(pkc2HtmlFileName('テスト 箱', new Date(2026, 9, 29))).toBe('pkc2-テスト-箱-20261029.html');
    expect(pkc2HtmlFileName('', new Date(2026, 9, 29))).toBe('pkc2-pkc2-20261029.html');
  });
});

describe('元の HTML の差し替え (#1416)', () => {
  it('🔴 pkc-data の中だけ入れ替わり、前後は 1 バイトも変わらない', async () => {
    const { before, after } = splitPkc2Shell(SHELL);
    expect(before.endsWith('<script id="pkc-data" type="application/json">')).toBe(true);
    expect(after.startsWith('</script>\n<script id="pkc-meta"')).toBe(true);
    const parts = await pkc2DataParts(plan().container, (async function* () {})());
    const out = before + (await new Blob(parts).text()) + after;
    expect(out.startsWith(before)).toBe(true);
    expect(out.endsWith(after)).toBe(true);
    expect(out).not.toContain('"container_id":"old"');
    expect(shellSchemaVersion(SHELL)).toBe(1);
  });

  it('PKC2 の HTML でないものは理由つきで断る', () => {
    expect(() => splitPkc2Shell('<html><body>ふつうのページ</body></html>')).toThrow(Pkc2ShellError);
    expect(() => splitPkc2Shell('<script id="pkc-data">{}')).toThrow(/PKC2/);
  });
});

describe('往復: 書き出した HTML を PKC3 の取り込みで読む (#1416)', () => {
  it('🔴 ノート・ログ・ToDo・フォーム・添付(bytes)・フォルダの関係が戻る', async () => {
    const { before, after } = splitPkc2Shell(SHELL);
    const p = plan();
    async function* assets() {
      yield { key: p.assetKeys.get('abc123')!, base64: btoa('hello pdf!!') };
    }
    const parts = await pkc2DataParts(p.container, assets());
    const html = before + (await new Blob(parts).text()) + after;

    const payload = parsePkc2Html(html);
    const conv = convertPkc2Container(payload.container as never, {
      existingLids: new Set(),
      orderBase: 0,
      genLid: (() => {
        let n = 0;
        return () => `n${++n}`;
      })(),
      genAssetKey: (() => {
        let n = 0;
        return () => `k${++n}`;
      })(),
    });
    const by = new Map(conv.entries.map((x) => [x.title, x]));
    expect(by.get('メモ')!.archetype).toBe('text');
    expect(by.get('メモ')!.body).toContain('牛乳を買う');
    expect(by.get('日誌')!.archetype).toBe('textlog');
    expect(by.get('日誌')!.body).toContain('朝会');
    expect(by.get('見積')!.archetype).toBe('todo');
    expect(by.get('見積')!.body).toContain('status: done');
    expect(by.get('フォーム')!.archetype).toBe('form');
    expect(by.get('請求書.pdf')!.archetype).toBe('attachment');
    expect(conv.assets, '添付の bytes が戻っていない').toHaveLength(1);
    expect(atob(conv.assets[0]!.base64)).toBe('hello pdf!!');
    expect(conv.relations.filter((r) => r.kind === 'structural')).toHaveLength(1);
  });
});

describe('#pkc-data が HTML として閉じる / 添付を文字列で溜めない (#1416 レビュー)', () => {
  const nasty = (): Pkc2ExportEntry[] => [
    e({ lid: 'n1', archetype: 'text', title: '<script>alert(1)</script>', body: '前置き <!-- ここから\n<script>x</script> --> 後ろ </SCRIPT>\n' }),
  ];
  const build = async (entries: Pkc2ExportEntry[]) => {
    const { before, after } = splitPkc2Shell(SHELL);
    const p = planPkc2Container({
      title: 't',
      containerId: 'c',
      entries,
      relations: [],
      assets: new Map(),
      now: NOW,
      schemaVersion: 1,
    });
    const parts = await pkc2DataParts(p.container, (async function* () {})());
    return before + (await new Blob(parts).text()) + after;
  };

  it('🔴 本文の `<!--` とタイトルの `<script>` があっても、#pkc-data が閉じて JSON.parse できる', async () => {
    const html = await build(nasty());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const data = doc.getElementById('pkc-data');
    expect(data, '#pkc-data が無い').not.toBeNull();
    const parsed = JSON.parse(data!.textContent ?? '') as { container: { entries: Array<{ title: string; body: string }> } };
    expect(parsed.container.entries[0]!.title).toBe('<script>alert(1)</script>');
    expect(parsed.container.entries[0]!.body).toContain('<!-- ここから');
    expect(doc.getElementById('pkc-meta')?.textContent).toContain('"app":"pkc2"');
  });

  it('🔴 #pkc-data の範囲には生の `<` が 1 つも無い(独立した不変量。パーサーの実装に依らない)', async () => {
    const html = await build(nasty());
    const { before, after } = splitPkc2Shell(SHELL);
    const data = html.slice(before.length, html.length - after.length);
    expect(data).not.toContain('<');
    expect(data).toContain('\\u003c');
  });

  it('🔴 添付の base64 は文字列で残らない(部品の中の添付は Blob)', async () => {
    const p = plan();
    const big = 'QUJD'.repeat(50_000);
    async function* assets() {
      yield { key: 'k1', base64: big };
      yield { key: 'k2', base64: 'QUJD' };
    }
    const parts = await pkc2DataParts(p.container, assets());
    expect(parts.filter((x) => typeof x !== 'string')).toHaveLength(2);
    expect(
      parts.some((x) => typeof x === 'string' && x.includes(big.slice(0, 64))),
      '巨大な base64 が文字列で残っている',
    ).toBe(false);
    const parsed = JSON.parse(await new Blob(parts).text()) as { container: { assets: Record<string, string> } };
    expect(parsed.container.assets.k1).toBe(big);
    expect(parsed.container.assets.k2).toBe('QUJD');
  });
});
