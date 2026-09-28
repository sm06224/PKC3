/**
 * Code Block Collapse / Expand (Issue #1139).
 *
 * 長大なコードブロック（閾値行数以上）をワンクリックで折りたたみ／展開可能にし、
 * ドキュメント全体の見通し・スクロール性を向上させる。
 */

/**
 * 折りたたみ対象とする最小行数の閾値。
 * 18行（約380px）以上で長大と判定し、折りたたみ操作子を付与する。
 */
export const CODE_COLLAPSE_LINE_THRESHOLD = 18;

/**
 * コード文字列の行数を数える。
 * 末尾の改行（\n）は除外して行数を算出する。
 */
export function countCodeLines(codeText: string): number {
  if (!codeText) return 0;
  const normalized = codeText.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!normalized) return 0;
  return normalized.split('\n').length;
}

/**
 * コードブロックが現在折りたたまれているかを判定する。
 */
export function isCodeCollapsed(block: Element): boolean {
  return block.hasAttribute('data-pkc-code-collapsed');
}

/**
 * コードブロックの折りたたみ／展開状態を更新する。
 */
export function setCodeCollapsed(block: HTMLElement, collapsed: boolean): void {
  const lineCountAttr = block.getAttribute('data-pkc-code-lines');
  const lineCount = lineCountAttr ? Number(lineCountAttr) : 0;
  const topBtn = block.querySelector<HTMLButtonElement>('.pkc-code-collapse-top-btn');
  const barBtn = block.querySelector<HTMLButtonElement>('.pkc-code-collapse-btn');

  if (collapsed) {
    block.setAttribute('data-pkc-code-collapsed', '');

    if (topBtn) {
      topBtn.setAttribute('aria-expanded', 'false');
      topBtn.setAttribute('title', 'コードブロックを展開する');
      topBtn.setAttribute('aria-label', 'コードブロックを展開する');
      topBtn.textContent = '▾';
    }

    if (barBtn) {
      barBtn.setAttribute('aria-expanded', 'false');
      const label = lineCount > 0 ? `▾ すべて表示 (${lineCount} 行)` : '▾ すべて表示';
      barBtn.textContent = label;
      barBtn.setAttribute('aria-label', lineCount > 0 ? `コードをすべて表示 (${lineCount} 行)` : 'コードをすべて表示');
    }

    if (typeof block.scrollIntoView === 'function') {
      block.scrollIntoView({ block: 'nearest' });
    }
  } else {
    block.removeAttribute('data-pkc-code-collapsed');

    if (topBtn) {
      topBtn.setAttribute('aria-expanded', 'true');
      topBtn.setAttribute('title', 'コードブロックを折りたたむ');
      topBtn.setAttribute('aria-label', 'コードブロックを折りたたむ');
      topBtn.textContent = '▴';
    }

    if (barBtn) {
      barBtn.setAttribute('aria-expanded', 'true');
      barBtn.textContent = '▴ 折りたたむ';
      barBtn.setAttribute('aria-label', 'コードを折りたたむ');
    }
  }
}

/**
 * コードブロックの折りたたみ／展開を反転する。
 */
export function toggleCodeCollapse(block: HTMLElement): void {
  setCodeCollapsed(block, !isCodeCollapsed(block));
}

/**
 * プレビュー内の長大なコードブロック要素に折りたたみ・展開操作子を付与する。
 * 冪等性: 既に .pkc-code-collapse-bar が付いているブロックには重複追加しない。
 */
export function applyCodeCollapse(host: HTMLElement): void {
  const blocks = host.querySelectorAll<HTMLElement>('.pkc-md-block[data-pkc-md-block-kind="code"]');
  for (const block of blocks) {
    // 描画済みスロット（CSVテーブルやmermaid等）を持つものは除外
    if (block.querySelector(':scope > .pkc-render-slot')) continue;

    const pre = block.querySelector<HTMLPreElement>(':scope > pre, :scope > pre.pkc-render-source');
    if (!pre) continue;

    const codeEl = pre.querySelector('code');
    const text = codeEl?.textContent ?? pre.textContent ?? '';
    const lines = countCodeLines(text);

    if (lines < CODE_COLLAPSE_LINE_THRESHOLD) continue;

    // 既に初期化済みの場合はライン数の最新化のみ
    block.setAttribute('data-pkc-code-collapsible', 'true');
    block.setAttribute('data-pkc-code-lines', String(lines));

    if (block.querySelector('.pkc-code-collapse-bar')) {
      // 冪等更新
      const collapsed = isCodeCollapsed(block);
      setCodeCollapsed(block, collapsed);
      continue;
    }

    // 初期状態は折りたたみ
    block.setAttribute('data-pkc-code-collapsed', '');

    // 右上トグルボタン
    const topBtn = block.ownerDocument.createElement('button');
    topBtn.type = 'button';
    topBtn.className = 'pkc-code-collapse-top-btn';
    topBtn.setAttribute('data-pkc-action', 'toggle-code-collapse');
    topBtn.setAttribute('aria-expanded', 'false');
    topBtn.setAttribute('title', 'コードブロックを展開する');
    topBtn.setAttribute('aria-label', 'コードブロックを展開する');
    topBtn.textContent = '▾';
    block.append(topBtn);

    // 下部展開バー
    const bar = block.ownerDocument.createElement('div');
    bar.className = 'pkc-code-collapse-bar';

    const barBtn = block.ownerDocument.createElement('button');
    barBtn.type = 'button';
    barBtn.className = 'pkc-code-collapse-btn';
    barBtn.setAttribute('data-pkc-action', 'toggle-code-collapse');
    barBtn.setAttribute('aria-expanded', 'false');
    barBtn.setAttribute('aria-label', `コードをすべて表示 (${lines} 行)`);
    barBtn.textContent = `▾ すべて表示 (${lines} 行)`;

    bar.append(barBtn);
    block.append(bar);
  }
}
