/**
 * #195 / C-5 段③: **拡張からの書き戻し ── 語彙の検め**。
 *
 * 🚫 PKC2 は write op が **9 種**まで育ち、さらに DSL まで生えた。
 *   ⚠ 1 語ずつは全部もっともらしく、**どれも「あと 1 つだけ」だった**。
 *   ここが守るのは「**語彙が 1 つのままであること**」でもある。
 *
 * 🔴 見るのは 3 点:
 * ① 語彙の外は**名前を添えて**断るか(拡張の作者が綴り間違いと読まない形)
 * ② 🔴 **渡した覚えのない lid** を拒否するか(段② の「取りに行く口は作らない」と同じ原理)
 * ③ 🔴 **1 件でも不正なら全体拒否**か(部分適用を作らない)
 */
import { describe, expect, it } from 'vitest';
import { EXT_WRITE_OPS_MAX, parseExtWrite } from '../../src/features/extension/ext-write';

const given = (...lids: string[]): ReadonlySet<string> => new Set(lids);
const op = (lid: string, body = 'あたらしい本文'): unknown => ({ op: 'setBody', lid, body });

describe('通る形', () => {
  it('渡した 1 件の本文を書き戻せる', () => {
    const r = parseExtWrite({ ops: [op('a')] }, given('a'));
    expect(r.ok && r.ops).toEqual([{ op: 'setBody', lid: 'a', body: 'あたらしい本文' }]);
  });

  it('渡した複数件をまとめて書き戻せる', () => {
    const r = parseExtWrite({ ops: [op('a'), op('b')] }, given('a', 'b'));
    expect(r.ok && r.ops.map((o) => o.lid)).toEqual(['a', 'b']);
  });

  it('⚠ 空の本文も通す(全部消したのも user の意思である)', () => {
    const r = parseExtWrite({ ops: [op('a', '')] }, given('a'));
    expect(r.ok && r.ops[0]!.body).toBe('');
  });
});

describe('🔴 渡した覚えのない lid は拒否する', () => {
  it('1 件も渡していなければ、何も書けない', () => {
    const r = parseExtWrite({ ops: [op('a')] }, given());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why, '理由が「渡されていない」になっていない').toContain('渡されていません');
  });

  it('🔴 渡した 1 件に紛れ込ませても、全体が落ちる(部分適用を作らない)', () => {
    const r = parseExtWrite({ ops: [op('a'), op('よそ')] }, given('a'));
    expect(r.ok, '紛れ込ませた 1 件で全体が落ちていない').toBe(false);
  });

  it('⚠ 別のアプリへ渡した物は書けない(集合は link ごと)', () => {
    // `given` が空 = この link には 1 件も渡していない、という状態
    expect(parseExtWrite({ ops: [op('b')] }, given('a')).ok).toBe(false);
  });
});

describe('🔴 語彙の外は、名前を添えて断る', () => {
  it('知らない op は「意図的です」まで言う(綴り間違いと読ませない)', () => {
    const r = parseExtWrite({ ops: [{ op: 'deleteEntry', lid: 'a' }] }, given('a'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain('deleteEntry');
    expect(!r.ok && r.why, '意図的だと書いていない').toContain('意図的');
  });

  it('🔴 作成の口は無い(新規は pkc.createEntry を通ると書いてある)', () => {
    const r = parseExtWrite({ ops: [{ op: 'createEntry', lid: 'a', body: 'x' }] }, given('a'));
    expect(!r.ok && r.why).toContain('pkc.createEntry');
  });

  it('lid が無い / 文字列でない', () => {
    expect(parseExtWrite({ ops: [{ op: 'setBody', body: 'x' }] }, given('a')).ok).toBe(false);
    expect(parseExtWrite({ ops: [{ op: 'setBody', lid: '', body: 'x' }] }, given('a')).ok).toBe(
      false,
    );
  });

  it('body が文字列でない(数値・null・undefined)', () => {
    for (const body of [1, null, undefined, {}]) {
      expect(
        parseExtWrite({ ops: [{ op: 'setBody', lid: 'a', body }] }, given('a')).ok,
        `body=${String(body)} を通した`,
      ).toBe(false);
    }
  });
});

describe('🔴 形そのものを断る', () => {
  it('object でない / ops が無い / ops が空', () => {
    expect(parseExtWrite(null, given('a')).ok).toBe(false);
    expect(parseExtWrite([], given('a')).ok).toBe(false);
    expect(parseExtWrite({}, given('a')).ok).toBe(false);
    expect(parseExtWrite({ ops: [] }, given('a')).ok).toBe(false);
  });

  it('⚠ 上限を超えたら断る(件数を添える)', () => {
    const ops = Array.from({ length: EXT_WRITE_OPS_MAX + 1 }, (_, i) => op(`l${i}`));
    const all = given(...ops.map((_, i) => `l${i}`));
    const r = parseExtWrite({ ops }, all);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain(String(EXT_WRITE_OPS_MAX + 1));
  });

  it('⚠ 上限ちょうどは通す(境界で 1 件損しない)', () => {
    const ops = Array.from({ length: EXT_WRITE_OPS_MAX }, (_, i) => op(`l${i}`));
    const all = given(...ops.map((_, i) => `l${i}`));
    expect(parseExtWrite({ ops }, all).ok).toBe(true);
  });

  it('🔴 同じノートが 2 回あれば断る(どちらが残るか見えない)', () => {
    const r = parseExtWrite({ ops: [op('a', '1'), op('a', '2')] }, given('a'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain('2 回');
  });

  it('⚠ どの手が悪いかを位置で言う(拡張の作者が直せる)', () => {
    const r = parseExtWrite({ ops: [op('a'), { op: 'x' }] }, given('a'));
    expect(!r.ok && r.why, '位置が出ていない').toContain('ops[1]');
  });
});
