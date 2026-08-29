/** @vitest-environment node */
/**
 * 🔴 **マクロが入ったかを数える道具**(`check-macro-wiring.py`、#431)を検める。
 *
 * ## なぜ道具そのものを test するのか
 *
 * 2026-08-28、この道具は**揃っている一式を「登録 3/4・実体 2/4」と報告した**。
 * 原因は製品ではなく**印の側**だった:
 *
 * | 印 | 何が誤りだったか |
 * |---|---|
 * | `ScriptProviderForBasicOnly` | 🔴 **上流に存在しない名前**(私が並べただけ) |
 * | `SbiRuntime` / `SbiParser` | 🔴 **入った一式でも 0 件**(名前が wasm に残らない) |
 *
 * ⚠ どちらも「**進んでいるのに進んでいないと読む**」向きに効く ── 直したのに
 * 直っていないと判断して、次の焼きを 1 本捨てるところだった。
 * 🔑 CLAUDE.md「検品する側・test する側も変異試験の対象にする」。
 *
 * ## 🔴 守る主張はこれ 1 つ:**印は 1 つずつ効いている**
 *
 * 「揃った一式で緑・空の一式で赤」だけでは足りない ── **1 つも数えられていない印**が
 * 混ざっていても、他の印が救って両方成り立つ(CLAUDE.md §1「門を N 個置いたら、
 * N 個目だけが鳴る場面を N 通り作る」)。だから**印ごとに 1 つだけ落として**見る。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/check-macro-wiring.py';
const SRC = readFileSync(SCRIPT, 'utf-8');

/** 道具が持つ印を**道具から読む**(ここで綴り直すと §7 の食い違いを作る)。 */
function markers(name: string): string[] {
  const m = new RegExp(`^${name} = \\(([^)]*)\\)`, 'm').exec(SRC);
  if (m?.[1] === undefined) throw new Error(`${name} を読めない`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

const DEFINITION = markers('DEFINITION');
const REGISTRATION = markers('REGISTRATION');
const IMPLEMENTATION = markers('IMPLEMENTATION');

const CFG = '/instdir/share/config/soffice.cfg';
const RDB = '/instdir/program/services/services.rdb';

/**
 * 偽の一式を組む。
 *
 * ⚠ **`services.rdb` は loose file ではない** ── `soffice.data` の中に在り、
 *   位置は目録の `start` / `end` が持つ(道具の docstring が実物で確かめている)。
 *   ここでも同じ形にしないと、道具の切り出しを消す変異が素通りする。
 */
function pack(opts: {
  def?: readonly string[];
  reg?: readonly string[];
  impl?: readonly string[];
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-macro-'));
  const rdb = Buffer.from(`<rdb>${(opts.reg ?? []).join(' ')}</rdb>`, 'utf-8');
  // ⚠ 前に詰め物を置く ── `start` を 0 に決め打ちする実装では通らないようにする
  const pad = Buffer.alloc(64, 0x20);
  writeFileSync(join(dir, 'soffice.data'), Buffer.concat([pad, rdb]));
  writeFileSync(
    join(dir, 'soffice.data.js.metadata'),
    JSON.stringify({
      files: [
        { filename: RDB, start: pad.length, end: pad.length + rdb.length },
        ...(opts.def ?? []).map((n, i) => ({
          filename: n.includes('/') && !n.startsWith('basic') ? `${CFG}/${n}` : `/instdir/${n}`,
          start: i,
          end: i + 1,
        })),
      ],
    }),
  );
  writeFileSync(join(dir, 'soffice.wasm'), `xx${(opts.impl ?? []).join('yy')}zz`);
  return dir;
}

function run(dir: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function withPack<T>(opts: Parameters<typeof pack>[0], fn: (dir: string) => T): T {
  const dir = pack(opts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('マクロの検品(#431)', () => {
  it('⚠ 印が 1 つも読めていないなら、この file 全体が空振りである', () => {
    expect(DEFINITION.length, '定義の印を読めていない').toBeGreaterThan(2);
    expect(REGISTRATION.length, '登録の印を読めていない').toBeGreaterThan(1);
    expect(IMPLEMENTATION.length, '実体の印を読めていない').toBeGreaterThan(2);
  });

  it('🔴 揃った一式は緑(3 段とも満点)', () => {
    withPack({ def: DEFINITION, reg: REGISTRATION, impl: IMPLEMENTATION }, (dir) => {
      const r = run(dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`定義: ${DEFINITION.length}/${DEFINITION.length}`);
      expect(r.out).toContain(`登録: ${REGISTRATION.length}/${REGISTRATION.length}`);
      expect(r.out).toContain(`実体: ${IMPLEMENTATION.length}/${IMPLEMENTATION.length}`);
    });
  });

  it('🔴 マクロの入っていない一式は赤(登録も実体も 0)', () => {
    withPack({ def: DEFINITION }, (dir) => {
      const r = run(dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`登録: 0/${REGISTRATION.length}`);
      expect(r.out).toContain(`実体: 0/${IMPLEMENTATION.length}`);
    });
  });

  /**
   * 🔴 **ここが本体。** 印を 1 つだけ落として、**その 1 つだけ**が減ることを見る。
   *
   * ⚠ これが無いと「一度も数えられない印」が混ざっても緑のまま通る ──
   *   2026-08-28 に `SbiRuntime` / `SbiParser` / `ScriptProviderForBasicOnly` の
   *   **3 つがまさにその状態**で、揃った一式を「3/4・2/4」と報告していた。
   */
  it.each([
    ['登録', 'REGISTRATION'],
    ['実体', 'IMPLEMENTATION'],
    ['定義', 'DEFINITION'],
  ] as const)('🔴 %s の印は 1 つずつ効いている(落とすとその 1 件だけ減る)', (label, which) => {
    const all = { REGISTRATION, IMPLEMENTATION, DEFINITION }[which];
    for (const drop of all) {
      const kept = all.filter((n) => n !== drop);
      withPack(
        {
          def: which === 'DEFINITION' ? kept : DEFINITION,
          reg: which === 'REGISTRATION' ? kept : REGISTRATION,
          impl: which === 'IMPLEMENTATION' ? kept : IMPLEMENTATION,
        },
        (dir) => {
          const r = run(dir);
          expect(
            r.out,
            `${label} の「${drop}」を落としても数が減らない ── この印は一度も数えられていない`,
          ).toContain(`${label}: ${kept.length}/${all.length}`);
          expect(r.code, `${drop} を落としたのに緑`).toBe(1);
          expect(r.out, `${drop} が ❌ として名指しされていない`).toContain(`❌ ${drop}`);
        },
      );
    }
  });

  /**
   * ⚠ **印どうしが互いに満たし合っていない**(部分文字列の重なり)。
   * 🔑 `SbModule` と `SbModuleXxx` のような関係が在ると、片方を落としても
   *   もう片方が数を埋めてしまう ── 上の test だけでは見えない。
   */
  it('🔴 印は互いの部分文字列になっていない', () => {
    for (const group of [REGISTRATION, IMPLEMENTATION, DEFINITION]) {
      for (const a of group) {
        for (const b of group) {
          if (a === b) continue;
          expect(b.includes(a), `「${a}」が「${b}」に含まれている(片方を落としても埋まる)`).toBe(
            false,
          );
        }
      }
    }
  });

  it('🔴 見る物が無い回は「判定不能」── 数を出さない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-macro-empty-'));
    try {
      const r = run(dir);
      expect(r.code, '空のディレクトリで数を出した').toBe(2);
      expect(r.out).toContain('判定不能');
      expect(r.out, '見る物が無いのに件数を出している').not.toContain('定義:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **上流に無い名前を印にしない**(2026-08-28 の当の誤り)。
   * ⚠ 実物の綴り(`scripting/source/basprov/basprov.cxx`)は
   *   `com.sun.star.comp.scripting.ScriptProviderForBasic` /
   *   `com.sun.star.script.provider.ScriptProviderForBasic` の 2 つで、
   *   `…ForBasicOnly` という綴りは**存在しない**。
   */
  it('🔴 在りえない名前が印に戻っていない', () => {
    for (const ghost of ['ScriptProviderForBasicOnly', 'SbiRuntime', 'SbiParser']) {
      expect(
        [...REGISTRATION, ...IMPLEMENTATION].includes(ghost),
        `「${ghost}」が印に戻っている ── 揃った一式を「揃っていない」と報告する`,
      ).toBe(false);
    }
    // ⚠ **理由は残す**(消すと、次に読む人が「入れ忘れでは」と考え直す)
    expect(SRC, '外した理由が書かれていない').toContain('ScriptProviderForBasicOnly');
  });
});
