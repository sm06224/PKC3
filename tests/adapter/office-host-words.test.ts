/** @vitest-environment node */
/**
 * Office の窓(`public/office/host.html`)が止まったときの字。
 *
 * ⚠ 原文を読む検査(窓は実ブラウザでしか動かない ── 実際に出るかは smoke の領分)。
 *   守っているのは「日本語の 1 文が先頭に在る」「内部のファイル名で止まらない」「原文は残す」。
 *   使わない語(BANNED_TERMS)の門は `tests/features/ui-terms.test.ts` が `public/office/host.html` にも当てている。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('public/office/host.html', 'utf8');

describe('Office が止まったとき', () => {
  it('🔴 日本語の 1 文が原文より先に並び、原文は小さく添えて残す', () => {
    const lead = html.indexOf("lead.textContent = 'Office の内部でエラーが起きました。読み込み直すと直ることがあります。'");
    const appendLead = html.indexOf('msgEl.appendChild(lead);');
    const appendRaw = html.indexOf('msgEl.appendChild(why);');
    expect(lead, '日本語の 1 文が無い').toBeGreaterThan(0);
    expect(appendLead, '日本語の文を並べていない').toBeGreaterThan(0);
    expect(appendLead, '原文が日本語の文より先に並ぶ').toBeLessThan(appendRaw);
    expect(html, '原文(不具合報告に要る)を捨てている').toContain('why.textContent = String(reason).slice(0, 300);');
  });
});

describe('起動できなかったとき', () => {
  it('🔴 一式の一部が足りないときは内部のファイル名で止まらず、取り込み直す場所を言う。原文は添える', () => {
    expect(html).toContain(
      "fail('Office の一式の一部が足りません。システム → 保存領域 → Office 表示 で取り込み直してください。', need[i] + ' がありません')",
    );
    expect(html, '内部のファイル名で止まる旧い字が残っている').not.toContain("fail('一式を読めません: '");
  });

  it('🔴 起動の失敗は日本語の 1 文が先で、原文は detail に回す', () => {
    expect(html).toContain("fail('Office を起動できませんでした。読み込み直すと直ることがあります。', String((e && e.message) || e).slice(0, 160))");
    expect(html).not.toContain("fail('起動に失敗しました: '");
  });

  it('fail は detail を小さい字の別行に置く(本文の字と混ぜない)', () => {
    const fn = html.slice(html.indexOf('function fail(s, detail)'), html.indexOf("setStatus('失敗')"));
    expect(fn).toContain("raw.className = 'why'");
    expect(fn).toContain('msgEl.textContent = s;');
  });
});

describe('O3/O4: 窓の起動と見張り', () => {
  it('🔴 O3: main() の呼び出しは catch で fail に落とす(await が try の外で落ちても「展開中…」で止まらない)', () => {
    // 呼び出しの行そのもの(注釈ではなく)を探す
    const call = html.indexOf('\n  main().catch(function (e) {');
    expect(call, 'main() に catch が無い').toBeGreaterThan(0);
    const body = html.slice(call, call + 400);
    expect(body).toContain("fail('Office を起動できませんでした。読み込み直すと直ることがあります。'");
    expect(html.includes('\n  main();'), '裸の main(); が残っている').toBe(false);
  });

  it('🔴 O4: 36 秒で諦めた後も粗い間隔で確かめ続け、開いたら watchTitle を始める', () => {
    const at = html.indexOf("setStatus('この文書は開けませんでした (36 秒)');");
    expect(at, '36 秒の枝が無い').toBeGreaterThan(0);
    const branch = html.slice(at, at + 1800);
    expect(branch, '粗い間隔の見張りが無い').toContain('}, 5000);');
    expect(branch, '開いたかを確かめていない').toContain('docOpened(docLeaf)');
    expect(branch, '開いたら失敗の表示を表示中へ戻す').toContain("setStatus('表示中 (");
    expect(branch, '開いてもタイトルの見張りが始まらない').toContain('watchTitle(docLeaf');
    expect(branch, '上限(180 秒)が無い').toContain('lateTries >= 29');
  });
});
