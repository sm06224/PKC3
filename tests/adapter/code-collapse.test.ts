/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  applyCodeCollapse,
  countCodeLines,
  isCodeCollapsed,
  setCodeCollapsed,
  toggleCodeCollapse,
  CODE_COLLAPSE_LINE_THRESHOLD,
} from '../../src/adapter/ui/render/code-collapse';
import { extractMdBlockPlainText, findMdBlockCopySource } from '../../src/adapter/ui/actions/copy-md-block';
import { readFileSync } from 'node:fs';

describe('code block collapse / expand (Issue #1139)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('countCodeLines', () => {
    it('counts lines accurately with various line endings', () => {
      expect(countCodeLines('')).toBe(0);
      expect(countCodeLines('const a = 1;')).toBe(1);
      expect(countCodeLines('const a = 1;\n')).toBe(1);
      expect(countCodeLines('const a = 1;\r\n')).toBe(1);
      expect(countCodeLines('line 1\nline 2\nline 3')).toBe(3);
      expect(countCodeLines('line 1\r\nline 2\r\nline 3\r\n')).toBe(3);
    });
  });

  describe('applyCodeCollapse', () => {
    it('skips short code blocks under threshold (< 18 lines)', () => {
      const shortCode = Array.from({ length: 10 }, (_, i) => `console.log(${i});`).join('\n');
      host.innerHTML = `
        <div class="pkc-md-block" data-pkc-md-block-kind="code">
          <pre><code class="language-javascript">${shortCode}</code></pre>
        </div>
      `;

      applyCodeCollapse(host);

      const block = host.querySelector('.pkc-md-block')!;
      expect(block.hasAttribute('data-pkc-code-collapsible')).toBe(false);
      expect(block.querySelector('.pkc-code-collapse-bar')).toBeNull();
      expect(block.querySelector('.pkc-code-collapse-top-btn')).toBeNull();
    });

    it('attaches collapse controls to long code blocks (>= 18 lines) in initial collapsed state', () => {
      const longLines = 25;
      const longCode = Array.from({ length: longLines }, (_, i) => `const row${i} = ${i};`).join('\n');
      host.innerHTML = `
        <div class="pkc-md-block" data-pkc-md-block-kind="code">
          <button class="pkc-md-copy-btn" type="button">⧉</button>
          <pre><code class="language-typescript">${longCode}</code></pre>
        </div>
      `;

      applyCodeCollapse(host);

      const block = host.querySelector<HTMLElement>('.pkc-md-block')!;
      expect(block.hasAttribute('data-pkc-code-collapsible')).toBe(true);
      expect(block.getAttribute('data-pkc-code-lines')).toBe(String(longLines));
      expect(isCodeCollapsed(block)).toBe(true);

      const topBtn = block.querySelector<HTMLButtonElement>('.pkc-code-collapse-top-btn');
      expect(topBtn).not.toBeNull();
      expect(topBtn?.getAttribute('aria-expanded')).toBe('false');
      expect(topBtn?.textContent).toBe('▾');
      expect(topBtn?.getAttribute('data-pkc-action')).toBe('toggle-code-collapse');

      const bar = block.querySelector<HTMLElement>('.pkc-code-collapse-bar');
      expect(bar).not.toBeNull();
      const barBtn = bar?.querySelector<HTMLButtonElement>('.pkc-code-collapse-btn');
      expect(barBtn).not.toBeNull();
      expect(barBtn?.getAttribute('aria-expanded')).toBe('false');
      expect(barBtn?.textContent).toBe(`▾ すべて表示 (${longLines} 行)`);
      expect(barBtn?.getAttribute('data-pkc-action')).toBe('toggle-code-collapse');
    });

    it('is idempotent and preserves existing state on re-render', () => {
      const longCode = Array.from({ length: 20 }, (_, i) => `item_${i}`).join('\n');
      host.innerHTML = `
        <div class="pkc-md-block" data-pkc-md-block-kind="code">
          <pre><code>${longCode}</code></pre>
        </div>
      `;

      applyCodeCollapse(host);
      const block = host.querySelector<HTMLElement>('.pkc-md-block')!;

      // Expand it
      toggleCodeCollapse(block);
      expect(isCodeCollapsed(block)).toBe(false);

      // Re-apply
      applyCodeCollapse(host);

      // Should still be expanded and have exactly 1 bar and 1 top button
      expect(isCodeCollapsed(block)).toBe(false);
      expect(block.querySelectorAll('.pkc-code-collapse-bar')).toHaveLength(1);
      expect(block.querySelectorAll('.pkc-code-collapse-top-btn')).toHaveLength(1);
    });

    /**
     * 🔴 **描画のたびの冪等更新は scroll しない**(#1467 段 1)。
     * ⚠ 直す前は `setCodeCollapsed` の畳む側が `scrollIntoView` を撃っていたので、本文を描き直すたびに
     *   **畳んである塊の数だけ**視点が動き、ffmpeg のヘルプの形(30 行の囲み 200 本)では追記 1 回が 28.5 秒だった。
     * 🔑 対照群: user が押して畳んだときは 1 回だけ寄せる(押した帯を見失わない)。
     */
    it('🔴 再描画の冪等更新では scrollIntoView を 1 回も撃たない(押して畳んだときだけ 1 回)', () => {
      const longCode = Array.from({ length: 30 }, (_, i) => `item_${i}`).join('\n');
      host.innerHTML = Array.from(
        { length: 5 },
        () => `<div class="pkc-md-block" data-pkc-md-block-kind="code"><pre><code>${longCode}</code></pre></div>`,
      ).join('');
      const calls: HTMLElement[] = [];
      // ⚠ happy-dom の scrollIntoView は Element.prototype に在る ── HTMLElement 側に自前の property を生やして
      //   先に拾わせ、終わったら delete で消す(代入で戻すと継承物の写しが残る)
      HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
        calls.push(this);
      };
      try {
        applyCodeCollapse(host);
        const blocks = [...host.querySelectorAll<HTMLElement>('.pkc-md-block')];
        expect(blocks.every((b) => isCodeCollapsed(b)), '前提が崩れている(初期は畳む)').toBe(true);
        expect(calls, '初回の付与で scroll した').toHaveLength(0);
        applyCodeCollapse(host); // 再描画(冪等更新)
        applyCodeCollapse(host);
        expect(calls, '再描画のたびに畳んだ塊へ scrollIntoView を撃っている(追記 1 回で 201 回になる)').toHaveLength(0);
        // 対照群: 展開 → 押して畳む、で 1 回だけ寄せる
        toggleCodeCollapse(blocks[2]!);
        expect(calls, '展開で scroll した').toHaveLength(0);
        toggleCodeCollapse(blocks[2]!);
        expect(calls, '押して畳んだのに寄せていない(帯を見失う)').toEqual([blocks[2]]);
      } finally {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    });

    /**
     * 🔴 **再描画の冪等更新は DOM に 1 byte も触らない**(#1467 段 3-d)。
     * ⚠ 直す前は同じ属性・同じ字を毎回書き直していた ── 同じ値でも `setAttribute` / `textContent` は
     *   スタイルの無効化を予約するので、折りたたんだ囲み 200 本のノートでは描き直しのたびに
     *   `:has(> .pkc-code-collapse-top-btn)` の再評価 800 件と塊 200 の無効化が走っていた(trace)。
     * 🔑 観測点は**本物の MutationObserver**(属性・子・字の全部)── 書き方を変えても拾う。
     */
    it('🔴 再描画の冪等更新では、属性も字も 1 つも書き直さない(押して変えたときだけ動く)', async () => {
      const longCode = Array.from({ length: 30 }, (_, i) => `item_${i}`).join('\n');
      host.innerHTML = Array.from(
        { length: 3 },
        () => `<div class="pkc-md-block" data-pkc-md-block-kind="code"><pre><code>${longCode}</code></pre></div>`,
      ).join('');
      applyCodeCollapse(host);
      const records: string[] = [];
      const mo = new MutationObserver((ms) => {
        for (const m of ms) records.push(`${m.type}:${m.attributeName ?? ''}`);
      });
      mo.observe(host, { attributes: true, childList: true, characterData: true, subtree: true });
      applyCodeCollapse(host);
      applyCodeCollapse(host);
      await new Promise((r) => setTimeout(r, 0));
      expect(records, '再描画の冪等更新が DOM を書き直している(同じ値でも無効化を予約する)').toEqual([]);
      // 対照群: 押して展開すると属性と字が動く(観測点が死んでいない証拠)
      toggleCodeCollapse(host.querySelector<HTMLElement>('.pkc-md-block')!);
      await new Promise((r) => setTimeout(r, 0));
      expect(records.length, '押して変えたのに何も動かない(観測点が空振り)').toBeGreaterThan(0);
      mo.disconnect();
    });

    it('skips blocks that have .pkc-render-slot (e.g. CSV table views)', () => {
      const longCode = Array.from({ length: 30 }, (_, i) => `val,${i}`).join('\n');
      host.innerHTML = `
        <div class="pkc-md-block" data-pkc-md-block-kind="code" data-pkc-render-lang="csv">
          <div class="pkc-render-slot"><table><tbody><tr><td>test</td></tr></tbody></table></div>
          <pre class="pkc-render-source"><code>${longCode}</code></pre>
        </div>
      `;

      applyCodeCollapse(host);
      expect(host.querySelectorAll('.pkc-code-collapse-bar')).toHaveLength(0);
    });
  });

  describe('toggleCodeCollapse & setCodeCollapsed', () => {
    it('toggles between collapsed and expanded cleanly', () => {
      const longLines = 22;
      const longCode = Array.from({ length: longLines }, (_, i) => `x_${i} = ${i};`).join('\n');
      host.innerHTML = `
        <div class="pkc-md-block" data-pkc-md-block-kind="code">
          <pre><code>${longCode}</code></pre>
        </div>
      `;

      applyCodeCollapse(host);
      const block = host.querySelector<HTMLElement>('.pkc-md-block')!;
      const topBtn = block.querySelector<HTMLButtonElement>('.pkc-code-collapse-top-btn')!;
      const barBtn = block.querySelector<HTMLButtonElement>('.pkc-code-collapse-btn')!;

      // Initially collapsed
      expect(isCodeCollapsed(block)).toBe(true);
      expect(topBtn.textContent).toBe('▾');
      expect(barBtn.textContent).toBe(`▾ すべて表示 (${longLines} 行)`);

      // Toggle -> Expand
      toggleCodeCollapse(block);
      expect(isCodeCollapsed(block)).toBe(false);
      expect(topBtn.textContent).toBe('▴');
      expect(topBtn.getAttribute('aria-expanded')).toBe('true');
      expect(barBtn.textContent).toBe('▴ 折りたたむ');
      expect(barBtn.getAttribute('aria-expanded')).toBe('true');

      // Toggle -> Collapse
      toggleCodeCollapse(block);
      expect(isCodeCollapsed(block)).toBe(true);
      expect(topBtn.textContent).toBe('▾');
      expect(topBtn.getAttribute('aria-expanded')).toBe('false');
      expect(barBtn.textContent).toBe(`▾ すべて表示 (${longLines} 行)`);
      expect(barBtn.getAttribute('aria-expanded')).toBe('false');

      // Direct setCodeCollapsed
      setCodeCollapsed(block, false);
      expect(isCodeCollapsed(block)).toBe(false);
      expect(barBtn.textContent).toBe('▴ 折りたたむ');
      setCodeCollapsed(block, true);
      expect(isCodeCollapsed(block)).toBe(true);
      expect(barBtn.textContent).toBe(`▾ すべて表示 (${longLines} 行)`);
    });

    it('exposes correct threshold constant', () => {
      expect(CODE_COLLAPSE_LINE_THRESHOLD).toBe(18);
    });
  });

  describe('copy compatibility (copy-md-block)', () => {
    it('faithfully copies full code content even when collapsed', () => {
      const longLines = 24;
      const codeLines = Array.from({ length: longLines }, (_, i) => `echo "line ${i}"`);
      const fullText = codeLines.join('\n');
      host.innerHTML = `
        <div class="pkc-md-block" data-pkc-md-block-kind="code">
          <button class="pkc-md-copy-btn" data-pkc-action="copy-md-block" data-pkc-copy-kind="code" type="button">⧉</button>
          <pre><code class="language-bash">${fullText}</code></pre>
        </div>
      `;

      applyCodeCollapse(host);
      const block = host.querySelector<HTMLElement>('.pkc-md-block')!;
      expect(isCodeCollapsed(block)).toBe(true);

      const source = findMdBlockCopySource(block);
      expect(source).not.toBeNull();
      const extracted = extractMdBlockPlainText(source!);
      expect(extracted).toBe(fullText);
    });
  });

  describe('print styles integrity', () => {
    it('app.css ensures code collapse controls are hidden and code is fully expanded in print', () => {
      const css = readFileSync('src/styles/app.css', 'utf-8');
      const printSection = css.slice(css.indexOf('@media print'));
      expect(printSection).toContain('.pkc-code-collapse-bar');
      expect(printSection).toContain('.pkc-code-collapse-top-btn');
      expect(printSection).toMatch(
        /\.pkc-md-rendered\s+\.pkc-md-block\[data-pkc-code-collapsed\]\s*>\s*pre\s*\{[^}]*max-height:\s*none\s*!important/i,
      );
    });
  });
});
