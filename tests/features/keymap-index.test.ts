/** @vitest-environment node */
/**
 * #1087: 打鍵 → コマンドの照合を索引にした(打鍵のたびに全コマンドの割当を読み直さない)。
 * 🔑 期待値は**直す前の線形の照合**をここに書き写したもの ── 索引と全数で突き合わせる。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_ORDER,
  KEY_COMMANDS,
  chordFromString,
  matchCommand,
  resolveBindings,
  sameChord,
  chordToString,
  type KeyContext,
  type KeymapBindings,
} from '../../src/features/keymap';

function linear(s: string, context: KeyContext, bindings: KeymapBindings): string | null {
  for (const c of KEY_COMMANDS) {
    if (!c.contexts.includes(context)) continue;
    const list = bindings[c.id] ?? c.defaults;
    if (list.some((b) => sameChord(b, s))) return c.id;
  }
  return null;
}

/** 割当に現れる和音 + 割り当てていない和音いくつか。 */
function chordsOf(bindings: KeymapBindings): string[] {
  const out = new Set<string>(['Mod+Alt+Shift+F12', 'Alt+Q', 'Shift+Escape']);
  for (const c of KEY_COMMANDS) for (const b of bindings[c.id] ?? c.defaults) out.add(b);
  return [...out];
}

describe('#1087 和音の索引', () => {
  it('🔴 既定の割当で、全部の面 × 全部の和音が、直す前の照合と同じ答えになる', () => {
    const b = resolveBindings({});
    const chords = chordsOf(b);
    expect(chords.length, '空振り防止: 和音が少なすぎる').toBeGreaterThan(50);
    let hits = 0;
    for (const ctx of CONTEXT_ORDER) {
      for (const raw of chords) {
        const chord = chordFromString(raw);
        if (chord === null) continue;
        const want = linear(chordToString(chord), ctx, b);
        if (want !== null) hits++;
        expect(matchCommand(chord, ctx, b), `${ctx} / ${raw}`).toBe(want);
      }
    }
    expect(hits, '空振り防止: 1 つも当たっていない').toBeGreaterThan(20);
  });

  it('🔴 割当を変えた新しい object では、変えた後の答えになる(古い索引を使わない)', () => {
    const before = resolveBindings({});
    const cmd = KEY_COMMANDS.find((c) => c.contexts.includes('global') && c.defaults.length > 0)!;
    const chord = chordFromString(cmd.defaults[0]!)!;
    expect(matchCommand(chord, 'global', before), '前提: 既定で当たる').toBe(linear(chordToString(chord), 'global', before));
    const after = resolveBindings({ [cmd.id]: [] });
    expect(matchCommand(chord, 'global', after)).toBe(linear(chordToString(chord), 'global', after));
    expect(matchCommand(chord, 'global', after), '外した割当がまだ当たる').not.toBe(cmd.id);
  });

  it('🔴 同じ和音が 2 つのコマンドに当たるときは、表の先に在るほうを返す(直す前と同じ)', () => {
    const inGlobal = KEY_COMMANDS.filter((c) => c.contexts.includes('global'));
    const first = inGlobal.find((c) => c.defaults.length > 0)!;
    const later = inGlobal[inGlobal.length - 1]!;
    expect(later.id, '前提: 2 つが別のコマンド').not.toBe(first.id);
    const b = resolveBindings({ [later.id]: [first.defaults[0]!] });
    const chord = chordFromString(first.defaults[0]!)!;
    expect(linear(chordToString(chord), 'global', b), '前提: 線形は先のほう').toBe(first.id);
    expect(matchCommand(chord, 'global', b)).toBe(first.id);
  });
});
