/**
 * 🔴 Office の上のバーの文書名を、閉じた文書のまま残さない(#1363 の 3)。
 *
 * ⚠ `public/office/office-title-watch.js` は **bundle されない素の JS**(`host.html` が `<script src>` で読む)。
 *   `readFileSync` + `new Function` で読み込んで判断を直に当てる。配線は `host.html` の原文 pin。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

interface Watch {
  observe(present: boolean): string | null;
  shown(): boolean;
}
interface Api {
  TITLE_POLL_MS: number;
  MISSES_TO_CLEAR: number;
  createTitleWatch(name: string): Watch;
}

function load(): Api {
  const src = readFileSync('public/office/office-title-watch.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeTitleWatch as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const api = load();

describe('バーの文書名の見張り(#1363 の 3)', () => {
  it('🔴 題名から名前が消えて続いたら、名前を外す(1 度だけ)', () => {
    const w = api.createTitleWatch('New Text.docx');
    expect(api.MISSES_TO_CLEAR, '外すまでの回数が 2 以上でない(前提)').toBeGreaterThanOrEqual(2);
    const out: (string | null)[] = [];
    for (let i = 0; i < api.MISSES_TO_CLEAR + 3; i += 1) out.push(w.observe(false));
    expect(out.filter((x) => x !== null), '外す字を 1 度だけ返していない').toEqual(['']);
    expect(out.indexOf(''), '決めた回数より早く / 遅く外した').toBe(api.MISSES_TO_CLEAR - 1);
    expect(w.shown()).toBe(false);
  });

  it('⚠ 1 回だけ見えなかったのでは外さない(題名が一瞬取れない回でちらつかない)', () => {
    const w = api.createTitleWatch('a.odt');
    for (let i = 0; i < 10; i += 1) {
      expect(w.observe(false)).toBeNull();
      expect(w.observe(true), '見えている間に字を書き換えた').toBeNull();
    }
    expect(w.shown()).toBe(true);
  });

  it('🔑 外した後に同じ文書がまた見えたら、名前を戻す', () => {
    const w = api.createTitleWatch('a.odt');
    for (let i = 0; i < api.MISSES_TO_CLEAR; i += 1) w.observe(false);
    expect(w.shown()).toBe(false);
    expect(w.observe(true)).toBe('a.odt');
    expect(w.observe(true), '同じ字を書き直している').toBeNull();
  });

  it('⚠ 見張る間隔は打鍵ごとではない(Qt の DOM を歩くので)', () => {
    expect(api.TITLE_POLL_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe('host.html の配線(#1363 の 3)', () => {
  const host = readFileSync('public/office/host.html', 'utf-8');

  it('🔴 判断の script を読み、開けた直後に見張りを始める', () => {
    expect(host, 'script を読んでいない').toContain('<script src="office-title-watch.js"></script>');
    const opened = host.indexOf('if (launched && wantDoc && !docSeen && docOpened(docLeaf)) {');
    expect(opened, '開けた分岐が見つからない').toBeGreaterThan(0);
    const branch = host.slice(opened, host.indexOf('return;', opened));
    expect(branch, '開けた分岐で見張りを始めていない').toContain('watchTitle(docLeaf, nameEl.textContent');
  });

  it('🔑 見張りは「開いたか」と同じ観測点(docOpened)で見て、返った字だけをバーへ書く', () => {
    const at = host.indexOf('function watchTitle(');
    expect(at, 'watchTitle が無い').toBeGreaterThan(0);
    const body = host.slice(at, host.indexOf('\n  }\n', at));
    expect(body).toContain('w.observe(docOpened(leaf))');
    expect(body).toContain('if (next !== null) nameEl.textContent = next;');
    expect(body).toContain('TW.TITLE_POLL_MS');
  });
});
