/** @vitest-environment node */
/**
 * 依存の脆弱性の門(#675)。
 *
 * 🔴 ここを test で縛る理由は 2 つある:
 *
 * ① **この経路は registry が壊れた日にしか走らない。** 手で確かめる機会が無いので、
 *    「書いたけれど判定が逆」になっていても誰も気づけない ── そして症状は
 *    **緑のまま素通り**(= 門が消えたのと同じ)である。
 * ② `.github/workflows/ci.yml` の `run:` は **どの test からも実行されない層**
 *    (CLAUDE.md §2)。だから判定は `scripts/audit-gate.mjs` へ出してある ──
 *    ここが空だと、出した意味が無くなる。
 *
 * ⚠ 見るのは「関数が何か返した」ではなく、**3 つの読みが分かれること**である:
 *   脆弱がある(落とす)/ 届かなかった(警告して通す)/ 読めない(落とす)。
 *   ここを緩めると、`|| true` と同じ ── **門の撤廃**になる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- CI script 群は素の .mjs(ビルド対象外)
import { readAudit, readRun, verdict, annotate, ATTEMPTS, ATTEMPT_TIMEOUT_MS } from '../scripts/audit-gate.mjs';

type Read =
  | { kind: 'ran'; high: number; critical: number }
  | { kind: 'unreachable'; why: string }
  | { kind: 'unreadable'; why: string };

const ran = (high: number, critical: number): string =>
  JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical } } });

/**
 * 🔴 **実物の出力**(2026-09-03 の run 33812565047 verify から写した)。
 * ⚠ 自作の綴りだけで検めると、**本物の形が変わったことに気づけない**。
 */
const REAL_503 = JSON.stringify({
  error: {
    code: 'E503',
    summary:
      '503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Service Unavailable',
    detail: '',
  },
});

describe('readAudit ── 3 つの読みに分かれる', () => {
  it('件数が返れば ran(0 件でも ran ── 「通じた」ことが分かる)', () => {
    expect(readAudit(ran(0, 0))).toEqual({ kind: 'ran', high: 0, critical: 0 });
    expect(readAudit(ran(2, 1))).toEqual({ kind: 'ran', high: 2, critical: 1 });
  });

  it('実物の 503 は unreachable(こちらの非ではないと名指しできる)', () => {
    const read = readAudit(REAL_503) as Read;
    expect(read.kind).toBe('unreachable');
    expect((read as { why: string }).why).toContain('503');
  });

  it.each([
    ['ENOTFOUND', 'ENOTFOUND registry.npmjs.org'],
    ['ETIMEDOUT', 'ETIMEDOUT'],
    ['502', '502 Bad Gateway - POST https://registry.npmjs.org/…'],
    ['endpoint の言い回し', 'audit endpoint returned an error'],
  ])('%s も unreachable と読む', (_name, summary) => {
    expect((readAudit(JSON.stringify({ error: { summary } })) as Read).kind).toBe('unreachable');
  });

  /**
   * 🔴 **ここが門の要**である。知らない error を `unreachable` に丸めると、
   * 「確かめられなかった」の顔で**何でも通る**ようになる(fail open)。
   */
  it.each([
    ['見知らぬ error', JSON.stringify({ error: { code: 'EWEIRD', summary: '知らない理由' } })],
    ['理由が空の error', JSON.stringify({ error: {} })],
    ['件数も error も無い', JSON.stringify({ auditReportVersion: 2 })],
    ['JSON ではない', 'npm error something'],
    ['空', ''],
    ['object ではない', '"just a string"'],
    ['件数が数ではない', JSON.stringify({ metadata: { vulnerabilities: { high: 'x', critical: 0 } } })],
  ])('%s は unreadable(落とす側へ倒す)', (_name, out) => {
    expect((readAudit(out) as Read).kind).toBe('unreadable');
  });

  it('理由は空にしない ── 空だと「読めない」と見分けが付かない', () => {
    const read = readAudit(JSON.stringify({ error: {} })) as Read;
    expect((read as { why: string }).why).not.toBe('');
  });
});

describe('readRun ── 時間切れは「届かなかった」であって「読めない」ではない', () => {
  it('ETIMEDOUT は unreachable', () => {
    const read = readRun({ error: { code: 'ETIMEDOUT' } }) as Read;
    expect(read.kind).toBe('unreachable');
    expect((read as { why: string }).why).toContain(String(ATTEMPT_TIMEOUT_MS / 1000));
  });

  it('SIGTERM で殺された回も unreachable', () => {
    expect((readRun({ error: { code: '' }, signal: 'SIGTERM' }) as Read).kind).toBe('unreachable');
  });

  it('npm が起動できない回は unreadable(環境が壊れているので黙って通さない)', () => {
    expect((readRun({ error: { code: 'ENOENT', message: 'spawn npm ENOENT' } }) as Read).kind).toBe(
      'unreadable',
    );
  });

  it('素直に返った回は stdout を読む', () => {
    expect(readRun({ stdout: ran(0, 0) })).toEqual({ kind: 'ran', high: 0, critical: 0 });
  });
});

describe('verdict ── 通す / 落とすの向き', () => {
  it('high も critical も 0 なら通す', () => {
    const out = verdict([readAudit(ran(0, 0))]);
    expect(out.pass).toBe(true);
    expect(out.level).toBe('ok');
  });

  it.each([
    ['high が 1 件', 1, 0],
    ['critical が 1 件', 0, 1],
  ])('%s なら落とす(これが本来の門)', (_name, high, critical) => {
    const out = verdict([readAudit(ran(high, critical))]);
    expect(out.pass).toBe(false);
    expect(out.level).toBe('error');
    expect(out.message).toContain('脆弱性');
  });

  it('届かなかった回は警告して通す ── ただし「確かめていない」と書く', () => {
    const out = verdict([readAudit(REAL_503), readAudit(REAL_503)]);
    expect(out.pass).toBe(true);
    expect(out.level).toBe('warning');
    expect(out.message).toContain('確かめられていません');
  });

  /**
   * ⚠ 途中の瞬断で**結論を決めない** ── 最後に繋がった回が答えである。
   * (これが無いと、1 回目が 503 だっただけで「確かめていない」と言い続ける)
   */
  it('503 のあとに繋がったら、その回で決める', () => {
    const out = verdict([readAudit(REAL_503), readAudit(ran(3, 0))]);
    expect(out.pass).toBe(false);
    expect(out.message).toContain('3 件');
  });

  it('読めない回は落とす(門が空振りしていないか見に行かせる)', () => {
    const out = verdict([readAudit('npm error something')]);
    expect(out.pass).toBe(false);
    expect(out.level).toBe('error');
    expect(out.message).toContain('audit-gate.mjs');
  });

  it('1 回も走らせていなければ落とす', () => {
    expect(verdict([]).pass).toBe(false);
  });
});

describe('注記の形', () => {
  it('警告と error は Actions の注記になり、ok は素の 1 行のまま', () => {
    expect(annotate('warning', 'x')).toBe('::warning::x');
    expect(annotate('error', 'x')).toBe('::error::x');
    expect(annotate('ok', 'x')).toBe('x');
  });
});

/**
 * 🔴 **workflow が本当にこの門を呼んでいるか**(CLAUDE.md §8「入力を守る検査と、
 * 出力が届いたかを見る検査は別物」)。⚠ 上の test は全部
 * `scripts/audit-gate.mjs` を直に呼ぶので、**ci.yml が素の `npm audit` に
 * 戻っても 1 件も落ちない**。
 */
describe('ci.yml がこの門を呼んでいる', () => {
  const CI = readFileSync('.github/workflows/ci.yml', 'utf-8');
  /** ⚠ コメントに満たされない形で見る ── 行頭が `run:` の実行行だけを読む。 */
  const runLines = CI.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('run:'));

  it('塞ぐ側の audit は scripts/audit-gate.mjs を呼ぶ', () => {
    expect(runLines).toContain('run: node scripts/audit-gate.mjs');
  });

  it('塞ぐ側に素の `npm audit --audit-level` を残さない(2 か所で判定しない)', () => {
    expect(runLines.filter((l) => l.includes('--audit-level'))).toEqual([]);
  });

  it('参考の audit は時間を区切る(job の 10 分を食わせない)', () => {
    const info = runLines.filter((l) => l.includes('npm audit') && l.includes('|| true'));
    expect(info).toHaveLength(1);
    expect(info[0]).toMatch(/timeout \d+ npm audit/);
  });
});

describe('時間の見積り', () => {
  /**
   * 🔴 落ちた run の verify は **9 分 16 秒**(`npm ci` 4 分 + `npm audit` 5 分)で、
   * job の timeout は **10 分**だった。⚠ 門が伸びると**門が job を殺す**。
   */
  it('最悪でも 2 分半に収まる', () => {
    expect(ATTEMPTS * ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(150_000);
  });
});
