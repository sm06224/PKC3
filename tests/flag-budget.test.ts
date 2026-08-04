/**
 * flag の予算(**最大 15 個**)を CI で止める。
 *
 * > 「**flags は最大 15 個(CI test で pin)+ 各 flag に畳む条件の宣言必須。
 * > 正規設定(settings)と分離する**」(user 指示 2026-07-30。正本 doc §6)
 *
 * 🔴 この pin は **2026-08-04 まで存在しなかった**(引き継ぎ先の指摘で判明)。
 * `CLAUDE.md` と正本 doc に「CI test で pin」と書いてあるのに、数える test が
 * どこにも無く、予算は**散文の中だけ**にあった。PKC2 が 85 個まで増やしたのは
 * まさにこの状態からである。
 *
 * ## いま PKC3 に flag は 0 個である ── だから何を pin するのか
 *
 * 数えるものが 0 件の検査は**空振り**であり、それを合格と読むのが
 * この repo が繰り返し踏んだ罠である(`CLAUDE.md` 検証の規律)。
 * そこで pin するのは「0 個であること」ではなく、次の 3 つにした:
 *
 * 1. **宣言された flag は 15 個以下**(増えたら落ちる)
 * 2. **各 flag が畳む条件を宣言している**(宣言の無い flag は永久に残る)
 * 3. 🔑 **予算の外から flag を生やせない** ── `flags` 表を登記所
 *    (`src/features/flags.ts`)の外から読み書きしたら落ちる。
 *    これが「まだ機構が無い」状態でも**効いている**条件である
 *    (機構を先に作ると、user 指示の「新機能を盛り込みすぎない」に反する ──
 *    使う人が居ない登記所は premature abstraction である。だから
 *    **最初の flag を入れる人に登記所を作らせる**形にした)
 *
 * ## 検出器そのものも検品する
 *
 * ⚠ 検査する側が壊れると「通った」という事実だけが残る(`CLAUDE.md`)。
 * だから下の「検出器の検品」で、**16 個宣言した合成 source は 16 と数え、
 * 畳む条件の無い宣言は違反として挙がり、予算の外の読み書きは捕まる**ことを
 * 直接 assert している。ここが緑でなければ、上の 3 つは何も保証していない。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** user 指示 2026-07-30 の上限。⚠ **目標ではなく上限**(v3.0 は数個で足りる想定)。 */
const FLAG_BUDGET = 15;

/**
 * flag の登記所として予約したパス。⚠ **まだ存在しない** ── 最初の flag を
 * 入れる人がここに作る(そのとき本 test の 3 が「登記所の外から生やすな」を強制する)。
 */
const REGISTRY_PATH = 'src/features/flags.ts';

interface DeclaredFlag {
  name: string;
  hasFoldCondition: boolean;
}

/**
 * `defineFlag('name', { … })` の宣言を拾う。
 *
 * ⚠ **コメントを落とさない**。誤差の向きを決める(`CLAUDE.md`)── 数え過ぎは
 * 「予算を超えた」で人が見に来るだけだが、数え落ちは**予算を黙って超えさせる**。
 * だから広く拾う側に倒す。
 */
export function declaredFlags(source: string): DeclaredFlag[] {
  const out: DeclaredFlag[] = [];
  const re = /defineFlag\s*\(\s*['"`]([^'"`]+)['"`]\s*,([\s\S]{0,400}?)\)\s*[;,)]/g;
  for (const m of source.matchAll(re)) {
    out.push({
      name: m[1] ?? '',
      // 畳む条件の綴りは `foldWhen`(登記所を作るときの契約。散文ではなく field)
      hasFoldCondition: /\bfoldWhen\s*:\s*['"`][^'"`]+['"`]/.test(m[2] ?? ''),
    });
  }
  return out;
}

/**
 * 予算の外から `flags` 表を触っている箇所を拾う。
 *
 * ⚠ 拾うのは **DML**(`from` / `into` / `update` / `delete from` + `flags`)だけ。
 * `schema.ts` の `CREATE TABLE IF NOT EXISTS flags` は表を**用意する**だけで
 * flag を生やさないので、対象にしない ── 構文で分けている(`CLAUDE.md`
 * 「形ではなく構文で拾う」)。
 */
export function adHocFlagAccess(source: string): string[] {
  const re = /\b(?:from|into|update|delete\s+from)\s+flags\b/gi;
  return [...source.matchAll(re)].map((m) => m[0]);
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SRC = tsFiles('src').map((f) => ({ file: f, text: readFileSync(f, 'utf-8') }));

describe('flag の予算(user 指示 2026-07-30)', () => {
  it('🔴 宣言された flag は 15 個以下である', () => {
    const all = SRC.flatMap(({ file, text }) =>
      declaredFlags(text).map((f) => `${f.name} (${file})`),
    );
    // ⚠ 落ちたときに読むべきものを message に入れる(数だけでは畳めない)
    expect(all.length, `flag が予算(${FLAG_BUDGET})を超えた:\n${all.join('\n')}`).toBeLessThanOrEqual(
      FLAG_BUDGET,
    );
  });

  it('🔴 すべての flag が畳む条件(foldWhen)を宣言している', () => {
    const missing = SRC.flatMap(({ file, text }) =>
      declaredFlags(text)
        .filter((f) => !f.hasFoldCondition)
        .map((f) => `${f.name} (${file})`),
    );
    expect(missing, '畳む条件の無い flag は永久に残る ── foldWhen を書く').toEqual([]);
  });

  it('🔴 flag の登記所の外から flags 表を読み書きしていない', () => {
    const offenders = SRC.filter(({ file }) => file !== REGISTRY_PATH).flatMap(({ file, text }) =>
      adHocFlagAccess(text).map((hit) => `${file}: ${hit}`),
    );
    expect(
      offenders,
      `flags 表は ${REGISTRY_PATH} だけが触る(予算の外で flag が増えるのを止めるため)`,
    ).toEqual([]);
  });

  it('🔴 予算の数が CLAUDE.md の記述と一致している', () => {
    // 散文と定数がずれると、どちらが正本か分からなくなる(PKC2 の腐り方)
    const claude = readFileSync('CLAUDE.md', 'utf-8');
    const m = /flags は最大 (\d+) 個/.exec(claude);
    expect(m, 'CLAUDE.md から flag の上限を読み取れない(記述が変わった?)').not.toBeNull();
    expect(Number(m![1])).toBe(FLAG_BUDGET);
  });
});

/**
 * 🔴 **検出器の検品**(空振り防止)。
 *
 * 上の 4 件は「flag が 0 個」の今、検出器が**何も見つけられない実装でも緑**になる。
 * ここで既知の違反を食わせて、**見えることを確かめてから**上を信用する。
 */
describe('検出器の検品 ── 既知の違反が見えるか', () => {
  it('16 個の宣言を 16 と数える(予算超過が実際に落ちる)', () => {
    const src = Array.from(
      { length: 16 },
      (_, i) => `defineFlag('exp.${i}', { foldWhen: '計測が済んだら' });`,
    ).join('\n');
    const found = declaredFlags(src);
    expect(found).toHaveLength(16);
    expect(found.length).toBeGreaterThan(FLAG_BUDGET); // = 上の 1 が落ちる状態
  });

  it('畳む条件の無い宣言を違反として挙げる', () => {
    const src = [
      `defineFlag('good', { foldWhen: '既定 ON にしたら畳む' });`,
      `defineFlag('bad', { default: false });`,
      `defineFlag('empty', { foldWhen: '' });`,
    ].join('\n');
    const missing = declaredFlags(src)
      .filter((f) => !f.hasFoldCondition)
      .map((f) => f.name);
    expect(missing).toEqual(['bad', 'empty']);
  });

  it('flags 表への読み書きを捕まえる(DDL は捕まえない)', () => {
    expect(adHocFlagAccess(`db.exec('SELECT v FROM flags WHERE k = ?')`)).toHaveLength(1);
    expect(adHocFlagAccess(`db.exec('INSERT INTO flags (k, v) VALUES (?, ?)')`)).toHaveLength(1);
    expect(adHocFlagAccess(`db.exec('UPDATE flags SET v = ?')`)).toHaveLength(1);
    expect(adHocFlagAccess(`db.exec('DELETE FROM flags WHERE k = ?')`)).toHaveLength(1);
    // 表を用意するだけの DDL は flag を生やさない ── 落としてはいけない
    expect(
      adHocFlagAccess(`CREATE TABLE IF NOT EXISTS flags (k TEXT PRIMARY KEY, v TEXT)`),
    ).toEqual([]);
    // 無関係な語(`extraFlags` / `src.flags`)を誤検知しない
    expect(adHocFlagAccess(`const merged = new Set(); for (const f of src.flags) merged.add(f);`)).toEqual(
      [],
    );
  });

  it('いま実際に走っている scan が空でない(scan 自体の空振りを止める)', () => {
    // ⚠ `SRC` が 0 件なら上の 3 件は**何も見ていない**。file を集める側の
    //    壊れ(パスの綴り違い・再帰の抜け)をここで落とす
    expect(SRC.length).toBeGreaterThan(100);
    expect(SRC.some(({ file }) => file.endsWith('storage/schema.ts'))).toBe(true);
  });
});
