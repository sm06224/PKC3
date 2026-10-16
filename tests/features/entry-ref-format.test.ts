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
import { escapeLinkLabel, unescapeLinkLabel } from '../../src/features/markdown/link-format';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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

  /**
   * 🔴 **題名に記法の字が混じっても、描かれた見出しが題名と同じになる**(#1087)。
   * 以前は `[ ] \ |` だけを逃がしていたので、`*` や `==` を含む題名は強調に化け、`%%…%%` は消えた。
   * ⚠ 期待値は**実際に描いた a タグの字**(本文の字面から組まない)。語の途中の `_` は触らない(対照群)。
   */
  it.each([
    '*重要* メモ',
    'a*b*c',
    '_x_ y _z_',
    '`code` を書く',
    'a ==b== c',
    'a ~~b~~ c',
    'a^^b^^c',
    '%%隠す%% 見える',
    'a&amp;b',
    '10:30 会議 (**太字**)',
  ])('🔴 題名 %j は描くとそのままの字になる', (title) => {
    const doc = document.createElement('div');
    doc.innerHTML = renderMarkdown(formatEntryLink(title, 'n1'));
    const anchors = doc.querySelectorAll('a[data-pkc-entry-ref]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.textContent).toBe(title);
    // 表の欄の中でも同じ
    doc.innerHTML = renderMarkdown(`| h |\n|---|\n| ${formatEntryLink(title, 'n1')} |`);
    expect(doc.querySelector('a[data-pkc-entry-ref]')!.textContent).toBe(title);
  });

  it('🔑 対照群: 語の途中の `_` と 1 個だけの `=` `~` `^` `%` は逃がさない(源の字を汚さない)', () => {
    expect(formatEntryLink('snake_case_name', 'x')).toBe('[snake_case_name](entry:x)');
    expect(formatEntryLink('a=b ~ c ^ 100%', 'x')).toBe('[a=b ~ c ^ 100%](entry:x)');
  });

  it('🔑 読み手が逃がした字を元に戻せる(unescape は escape の逆)', () => {
    const title = '*a* _b_ `c` ==d== ~~e~~ ^^f^^ %%g%% &amp; [h] i\\j|k';
    expect(unescapeLinkLabel(escapeLinkLabel(title))).toBe(title);
  });

  /** ⚠ 宛先に裸で書けない字が混じる形も、リンクとして生きる。 */
  it('⚠ 宛先が裸で書けない字を含んでも、切れない形にする', () => {
    expect(formatEntryLink('あ', 'a b')).toBe('[あ](<entry:a b>)');
  });
});
