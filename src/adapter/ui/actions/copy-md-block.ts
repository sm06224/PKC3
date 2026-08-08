/**
 * `data-pkc-action="copy-md-block"` の処理(PKC2 PR #196 系の移植)。
 * markdown-render が code fence / 表 / renderable fence に付ける ⧉ ボタンから、
 * 「今ユーザーに見えている面」を text/plain(表は TSV)+ text/html でコピーする。
 *
 * ⚠ 選択子は renderable fence の標準規約 DOM(`.pkc-render-slot` + 隠し
 * `pre.pkc-render-source`)前提。fence 規約を変えるならここを連動させること
 * (PKC2 #996: 直下決め打ちにした結果、csv 表が生 CSV に劣化した回帰の教訓)。
 *
 * rich-copy-transform(class → inline style 複製、Word 貼り付け品質)は未移植 ──
 * スタイル導入(P3-7)後に outerHTML 素通しでは足りないと分かってから持ち込む。
 */
import { copyMarkdownAndHtml } from '@adapter/platform/clipboard';

/**
 * copy 元の面を選ぶ:
 * - ソース面表示中(トグル ON)→ 見えているソース
 * - レンダリング面 → **document 順**最初の一致(slot 内 table が隠しソースより
 *   先 = csv 系は TSV / rich table。html / mermaid は copy 可能な描画要素が
 *   無いので隠しソースへ落ちる)
 */
export function findMdBlockCopySource(block: HTMLElement): HTMLElement | null {
  const toggle = block.querySelector<HTMLInputElement>(
    ':scope > .pkc-render-toggle-input',
  );
  if (toggle?.checked) {
    return block.querySelector<HTMLElement>(':scope > pre.pkc-render-source');
  }
  return block.querySelector<HTMLElement>(
    ':scope > .pkc-render-slot > table, :scope > pre, :scope > table',
  );
}

/**
 * 表の copy から UI 装飾(行番号列 / 並べ替え / 絞り込み)を落とす。
 * table 対話機能は PKC3 未移植だが、注入されたときに copy が黙って UI ごと
 * 貼り付ける回帰(PKC2 で実際に起きた「Excel 見出しが name↕⌕」)を先に封じる。
 * 表示中の DOM は壊さず、clone から装飾ノードだけ除く。
 */
const TABLE_CHROME_SELECTOR =
  '.pkc-md-table-rownum, .pkc-md-table-filter-row, .pkc-md-table-sort, .pkc-md-table-filter-toggle';

export function stripTableChromeForCopy(inner: HTMLElement): HTMLElement {
  if (inner.tagName.toLowerCase() !== 'table') return inner;
  if (!inner.querySelector(TABLE_CHROME_SELECTOR)) return inner;
  const clone = inner.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll(TABLE_CHROME_SELECTOR)) el.remove();
  return clone;
}

export function extractMdBlockPlainText(inner: HTMLElement): string {
  const tag = inner.tagName.toLowerCase();
  if (tag === 'pre') return inner.textContent ?? '';
  if (tag === 'table') {
    const rows: string[] = [];
    for (const tr of inner.querySelectorAll('tr')) {
      const cells: string[] = [];
      for (const cell of tr.querySelectorAll('th, td')) {
        // セル内の tab / 改行は TSV を壊す ── スペースに collapse
        cells.push((cell.textContent ?? '').replace(/[\t\r\n]+/g, ' ').trim());
      }
      rows.push(cells.join('\t'));
    }
    return rows.join('\n');
  }
  return inner.textContent ?? '';
}

/** 連打時に先行 timer が後発 flash を早期に消さないための timer 台帳。 */
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * 押した結果を短く光らせる(コピー系のボタン共通の合図)。
 * 2026-08-08 に読む面のコピー(`copy-source.ts`)と共用にした ── 合図の形を
 * 2 つ作ると、user は「光る方だけ成功」と読む。
 */
export function flashCopied(target: HTMLElement): void {
  target.setAttribute('data-pkc-flash', 'true');
  const prev = flashTimers.get(target);
  if (prev !== undefined) clearTimeout(prev);
  flashTimers.set(
    target,
    setTimeout(() => {
      target.removeAttribute('data-pkc-flash');
      flashTimers.delete(target);
    }, 700),
  );
}

/** click handler 本体(binder の ACTIONS から呼ばれる)。 */
export function handleCopyMdBlock(target: HTMLElement): void {
  const block = target.closest<HTMLElement>('.pkc-md-block');
  if (!block) return;
  const inner = findMdBlockCopySource(block);
  if (!inner) return;
  const source = stripTableChromeForCopy(inner);
  const plain = extractMdBlockPlainText(source);
  void copyMarkdownAndHtml(plain, source.outerHTML).then((ok) => {
    if (ok) flashCopied(target);
  });
}
