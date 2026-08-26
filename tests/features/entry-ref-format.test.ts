/**
 * 🔴 **ノートを本文へ書く形**(#427 段①)。
 *
 * 守る主張:
 * 1. **貼れる 1 行になる**(裸の `entry:<lid>` ではない ── 貼っても何も出ない)
 * 2. **リンクを殺す字が escape される**(`]` 1 個でリンクが死ぬ)
 * 3. **空のラベルを作らない**(`[](entry:x)` は押す所が無い)
 * 4. 🔑 **規則は添付と同じ 1 本**(別に書けば必ずずれる)
 */
import { describe, expect, it } from 'vitest';
import { formatEntryLink } from '../../src/features/entry-ref/entry-ref-format';
import { formatAssetRef } from '../../src/features/asset/asset-ref-format';
import { parseEntryRef } from '../../src/features/entry-ref/entry-ref';

describe('ノートの参照を本文へ書く(#427 段①)', () => {
  it('🔴 貼れる 1 行になる(裸の entry: ではない)', () => {
    expect(formatEntryLink('先週の議事録', 'abc123')).toBe('[先週の議事録](entry:abc123)');
  });

  /**
   * 🔴 **読み手が同じものを読み戻せる** ── 書く側と読む側で綴りが違うと、
   * 貼った本人には**押せないリンク**に見える(理由は画面のどこにも出ない)。
   */
  it('🔴 書いた宛先を、読み手がそのまま読める', () => {
    const line = formatEntryLink('あ', 'L-42');
    const target = /\(([^)]*)\)/.exec(line)?.[1] ?? '';
    const parsed = parseEntryRef(target);
    expect(parsed.kind, '読み手が読めない形を書いた').toBe('entry');
    expect(parsed.kind === 'entry' ? parsed.lid : '').toBe('L-42');
  });

  it('🔴 リンクを殺す字を escape する', () => {
    // `]` が 1 個でもそのまま入ると、そこでリンクが切れる
    expect(formatEntryLink('会議 [第 2 回]', 'x')).toBe('[会議 \\[第 2 回\\]](entry:x)');
    // 改行はラベルの中で 1 行に潰す(段落が割れてリンクが死ぬ)
    expect(formatEntryLink('上\n下', 'x')).toBe('[上 下](entry:x)');
  });

  it('🔴 題名が空でも、押す所のあるリンクにする', () => {
    expect(formatEntryLink('', 'x'), '空のラベルを作った').toBe('[entry:x](entry:x)');
    expect(formatEntryLink('   ', 'x')).toBe('[entry:x](entry:x)');
  });

  /**
   * 🔑 **添付と同じ規則を通っている**(§7)。⚠ 別々に書くと、`]` の escape を
   * 片方だけ忘れる形で静かにずれる ── 同じ入力で**同じ形**になることを見る。
   */
  it('🔑 添付と同じ規則を通っている(規則を 2 本にしない)', () => {
    const label = '会議 [第 2 回]';
    expect(formatEntryLink(label, 'x')).toBe(formatAssetRef(label, 'entry:x', false));
  });

  /** ⚠ 宛先に裸で書けない字が混じる形も、リンクとして生きる。 */
  it('⚠ 宛先が裸で書けない字を含んでも、切れない形にする', () => {
    expect(formatEntryLink('あ', 'a b')).toBe('[あ](<entry:a b>)');
  });
});
