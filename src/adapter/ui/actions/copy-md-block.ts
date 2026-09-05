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
import { copyMarkdownAndHtml, copyPlainText } from '@adapter/platform/clipboard';
import { COPY_CHROME_SELECTOR, isCopyControl } from '@features/export/clipboard-html';
import {
  TABLE_COPY_CHOICES,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
  type TableCopyFormat,
  type TableCopyRow,
} from '@features/markdown/table-copy';
import { safeName } from '@features/export/file-name';
import { dayStamp } from '@features/datetime/date-math';

/**
 * この塊の**表**が在る場所。⚠ 選択子はここ 1 本 ── ⧉(見えている面)と
 * ▾(この表)は**別の問い**だが、表の在り処という**同じ規約**を読む。
 * 2 本書くと、fence の規約が変わったとき片方だけが追随する(§7)。
 */
const BLOCK_TABLE_SELECTOR = ':scope > .pkc-render-slot > table, :scope > table';

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
  return block.querySelector<HTMLElement>(`${BLOCK_TABLE_SELECTOR}, :scope > pre`);
}

/**
 * 🔴 **この塊の表**(#708 段①)── ⧉ と違い、**ソース面に切り替えていても表を返す**。
 *
 * ⚠ ▾ は「**この表を**どの形で持ち出すか」を聞く口なので、原文を見ている間も
 *   答えは同じ表である ── ここで `null` にすると、`‹/›` を押しただけで
 *   形を選ぶ道が消える(押せるのに何も起きない口になる)。
 */
export function findMdBlockTable(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(BLOCK_TABLE_SELECTOR);
}

/**
 * 表の copy から UI 装飾(行番号列 / 並べ替え / 絞り込み)を落とす。
 * table 対話機能は PKC3 未移植だが、注入されたときに copy が黙って UI ごと
 * 貼り付ける回帰(PKC2 で実際に起きた「Excel 見出しが name↕⌕」)を先に封じる。
 * 表示中の DOM は壊さず、clone から装飾ノードだけ除く。
 */
/**
 * 🔴 **落とす物の定義を寄せた**(2026-09-05、#735)。
 *
 * ⚠ 直す前はここに **PKC2 由来の 4 つ**(並べ替え / 絞り込みの飾り)しか無く、
 *   #418 が足した csv の**升をいじるボタン**(`edit-cell` の印 /
 *   `.pkc-csv-shape`)を落とさなかった ── csv の表を ⧉ でコピーして Word や
 *   メールへ貼ると、**押せない小さなボタンが一緒に貼られた**。
 * 🔑 `COPY_CHROME_SELECTOR`(読む面のリッチコピーが使う定義)を**借りる** ──
 *   「操作子とは何か」を 2 か所で決めない(CLAUDE.md §7)。
 * ⚠ PKC2 由来の 4 つは**残す** ── あちらは `data-pkc-action` を持たない**飾り**で、
 *   注入されたときに黙って貼られるのを止めるために置いた物である。
 */
const TABLE_CHROME_SELECTOR = [
  COPY_CHROME_SELECTOR,
  '.pkc-md-table-rownum',
  '.pkc-md-table-filter-row',
  '.pkc-md-table-sort',
  '.pkc-md-table-filter-toggle',
].join(', ');

/**
 * 🔴 **消してよいのは「押す器」だけ**(`isCopyControl`)。
 * ⚠ csv の表は**升そのもの**に `edit-cell` の印を付けるので、
 *   選択子に当たった要素を何でも消すと**表の中身が丸ごと消える**。
 * ⚠ PKC2 由来の飾り(行番号 / 並べ替え / 絞り込み)は `data-pkc-action` を
 *   持たないので、**そちらは要素ごと消す**(押す器ではないが、貼り先には要らない)。
 */
function isTableChrome(el: Element): boolean {
  return el.hasAttribute('data-pkc-action') ? isCopyControl(el) : true;
}

export function stripTableChromeForCopy(inner: HTMLElement): HTMLElement {
  if (inner.tagName.toLowerCase() !== 'table') return inner;
  if (!inner.querySelector(TABLE_CHROME_SELECTOR)) return inner;
  const clone = inner.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll(TABLE_CHROME_SELECTOR)) {
    if (isTableChrome(el)) el.remove();
    // ⚠ 残す要素の内部属性は落とす(貼り先で意味を持たない印を延々と付けない)
    else for (const name of el.getAttributeNames()) {
      if (name.startsWith('data-pkc-')) el.removeAttribute(name);
    }
  }
  return clone;
}

/**
 * 🔴 **表の升を読むのはここ 1 か所**(#708 段①)。
 *
 * 🔑 形(TSV / markdown / CSV)ごとに読み方を書くと、**同じ表から違う升が出る** ──
 *   読むのは 1 回、字にするのは `features/markdown/table-copy.ts` に任せる
 *   (CLAUDE.md §7)。
 * ⚠ **升の中の tab / 改行はここで空白へ潰す** ── TSV は tab で壊れ、markdown の表は
 *   改行で行が切れる。潰す規則を形ごとに持つと、片方だけ潰し忘れる。
 * ⚠ **自分の表の行だけ**を拾う(`closest('table')`)── 入れ子の表があると、
 *   内側の行が外側の行としても出て**同じ中身が 2 回入る**
 *   (`html-to-markdown.ts` の `tableBlocks` が実測で踏んだ罠)。
 * ⚠ 升の**中に居るボタン**(行・列の口)は字を持たない決まりなので `textContent` に
 *   混ざらない ── その決まりは `csv-table.ts` 側が持ち、ここでは前提にする。
 */
export function readTableRows(table: HTMLElement): TableCopyRow[] {
  const rows: TableCopyRow[] = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('table') !== table) continue;
    const cells = [...tr.children].filter((c) => {
      const t = c.tagName.toLowerCase();
      return t === 'th' || t === 'td';
    });
    if (cells.length === 0) continue;
    rows.push({
      /**
       * 🔴 **升は潰さずに返す**(2026-09-05、着地前レビュー A-1)。
       *
       * ⚠ 直す前は**ここで tab / 改行を空白 1 個へ潰していた** ── ところが
       *   `csv` の囲みは **引用で囲めば升に改行を入れられる**(`csv-table.ts` の
       *   仕様)ので、`"1\n2"` と書いた升が **`.csv` で保存した瞬間に `1 2` へ
       *   変わっていた**(user のデータが静かに別物になる)。
       * 🔑 **潰すのは、潰さないと壊れる形の側の仕事**である ── TSV は tab と改行で
       *   表が崩れ、GFM の表は改行で行が切れるが、**CSV は `"…"` で包めば通る**。
       *   1 か所の都合を 3 形式に使い回していたのが誤りだった(CLAUDE.md §7
       *   「誤差の向きを決めて、両側に使い回さない」)。
       * ⚠ 改行の綴りだけ揃える(`\r\n` / `\r` → `\n`)── 貼り先ごとに違う字が出ないように。
       */
      cells: cells.map((cell) => (cell.textContent ?? '').replace(/\r\n?/g, '\n').trim()),
      head: cells.every((c) => c.tagName.toLowerCase() === 'th'),
    });
  }
  return rows;
}

export function extractMdBlockPlainText(inner: HTMLElement): string {
  const tag = inner.tagName.toLowerCase();
  if (tag === 'pre') return inner.textContent ?? '';
  // ⚠ 既定の 1 押しは TSV(表計算に貼る)── 形を選ぶ口(▾)が出来た後も変えない
  if (tag === 'table') return tableToTsv(readTableRows(inner));
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

/**
 * 形を選ぶ口が要るもの。
 *
 * 🔴 **optional にしない**(CLAUDE.md §7)── 配線を落としても `tsc` が黙る形に
 *   すると、戻ってくる症状は「▾ を押しても何も出ない」という**いちばん気づけない
 *   dead click** である。
 */
export interface CopyMdBlockDeps {
  /** 形を選ばせる(`app-dialog.ts` の `pickCopyFormatInApp`)。やめたら `null`。 */
  pick(
    choices: readonly { readonly id: string; readonly label: string }[],
  ): Promise<string | null>;
  /** file を渡す(`platform/download.ts` の `downloadBlob`)。 */
  download(name: string, blob: Blob): void;
  /** 落とす file の名前の素 ── **その表が載っているノート**の題名(空でもよい)。 */
  noteTitle(): string;
  /**
   * 🔴 **渡らなかったことを言う**(2026-09-05、動線レビュー 欠陥 2)。
   *
   * ⚠ 直す前は「光らせないだけ」だった ── ▾ は**小窓を開いて行を選んで閉じる
   *   3 手**なので、それだけやって無反応だと user は「入ったが貼り先が悪い」と
   *   読み、**別の場所を探しに行く**(実際には何も入っていない)。
   * ⚠ **optional にしない**(この file の上の註記と同じ理由)。
   * 🔑 文言は他のコピーと同じ(`copy-source.ts` の `finishCopy`)── 合図の形を
   *   2 つ作らない。
   */
  fail(message: string): void;
  /**
   * 🔴 **保存したことを言う**(同 欠陥 7)。⚠ 光る合図は「**コピーが渡った**」の
   *   意味でこの製品に統一されているので、**保存に使い回すと区別できない** ──
   *   しかも ▾ は普段は見えない(触れたときだけ出る)ので、光っても気づけない。
   * 🔑 他の 2 つの書き出し(設定の持ち出し / 連絡先)と同じく、画面の下へ 1 行出す。
   */
  saved(message: string): void;
}

/**
 * 🔴 **`.csv` は BOM 付きで渡す**(#708 段①)。
 *
 * ⚠ BOM が無いと、Windows の Excel は `.csv` を**その環境の既定の文字集合**で
 *   読むので、日本語の升が**そのまま文字化けする** ── 「表計算で開く」ための
 *   file なのに開けない、という形になる。
 * ⚠ BOM は表計算・エディタ・`pandas` のいずれも読み飛ばす(`utf-8-sig`)。
 * ⚠ **生バイトで書かない**(CLAUDE.md §9)── 見えない字なので、次に触る人が
 *   消したことに気づけない。
 */
const CSV_BOM = '\uFEFF';

/** 渡らなかったときの字。⚠ 他のコピー(`copy-source.ts`)と**同じ 1 つ**にする。 */
const COPY_FAILED = 'コピーできませんでした';

/** 落とす file の名前。⚠ 名前の規則は `safeName` 1 本(`features/export/file-name.ts`)。 */
function csvFileName(title: string): string {
  const base = safeName(title === '' ? '表' : title);
  return `${base}-${dayStamp(new Date())}.csv`;
}

/**
 * 🔴 **選ばれた形で持ち出す**(#708 段①)。
 *
 * ⚠ 字を作るのは `table-copy.ts`、渡すのはここ ── 逆にしない
 *   (features 層は clipboard も download も持たない)。
 * @returns 渡せたか。⚠ `false` なら合図を出さない(黙って成功した顔をしない)
 */
async function putTable(
  format: TableCopyFormat,
  table: HTMLElement,
  deps: CopyMdBlockDeps,
): Promise<boolean> {
  const rows = readTableRows(table);
  switch (format) {
    case 'tsv':
      // ⚠ ⧉ の 1 押しと**同じ物**を渡す(text/plain = TSV、text/html = 表そのもの)
      return copyMarkdownAndHtml(tableToTsv(rows), table.outerHTML);
    case 'html':
      // ⚠ 素の字としても HTML を渡す ── 「HTML が欲しい」人は原文を貼りたい
      return copyMarkdownAndHtml(table.outerHTML, table.outerHTML);
    case 'markdown': {
      const md = tableToMarkdown(rows);
      if (md === null) return false;
      return copyPlainText(md);
    }
    case 'csv':
      return copyPlainText(tableToCsv(rows));
    case 'csv-file': {
      const name = csvFileName(deps.noteTitle());
      deps.download(name, new Blob([CSV_BOM + tableToCsv(rows)], { type: 'text/csv;charset=utf-8' }));
      // ⚠ 名前を持っているのはここだけ ── 呼び側で組み直さない(§7)
      deps.saved(`${name} を保存しました`);
      return true;
    }
  }
}

/**
 * click handler 本体(binder の ACTIONS から呼ばれる)。
 *
 * 🔴 **口は 2 つ、仕事は 1 つ**(#708 段①)── ⧉ は今までどおり 1 押しで
 *   TSV + HTML、▾ は形を選んでから同じ道を通る。
 * ⚠ 選んでいる間に面が組み直されることがあるので、**表は選び終えてから引き直す**
 *   (`insert-snippet` が 2026-08-23 に実機で踏んだ罠と同じ形)。
 */
export function handleCopyMdBlock(target: HTMLElement, deps: CopyMdBlockDeps): void {
  const block = target.closest<HTMLElement>('.pkc-md-block');
  if (!block) return;

  if (target.hasAttribute('data-pkc-copy-menu') && findMdBlockTable(block) !== null) {
    void deps.pick(TABLE_COPY_CHOICES).then(async (id) => {
      // ⚠ 「やめた」は断り文を出さない ── user が自分で閉じたので、伝えることは無い
      if (id === null) return;
      // ⚠ 一覧から消えた id は黙って落とす(無い形で書き出すより何もしない方がよい)
      const chosen = TABLE_COPY_CHOICES.find((c) => c.id === id);
      if (chosen === undefined) return;
      /**
       * ⚠ 表は引き直す。⚠ **これは再描画を守っていない**(2026-09-05 の着地前レビュー ⑤ で
       *   判明 ── 掴んでいるのは `block` 自身なので、面が組み直されても
       *   **剥がれた木の中の表**が返る)。ここが `null` になるのは
       *   「▾ が在るのに表が無い塊」だけで、いまその塊は作られない。
       * 🔑 それでも引き直しと断りは残す ── 将来そういう塊ができたとき、
       *   **無言で終わらせない**ための門である(コメントのほうを実装に合わせた)。
       */
      const again = findMdBlockTable(block);
      if (again === null) {
        deps.fail(COPY_FAILED);
        return;
      }
      const done = await putTable(chosen.id, stripTableChromeForCopy(again), deps);
      if (!done) {
        deps.fail(COPY_FAILED);
        return;
      }
      // 🔑 **保存だけは字で言う**(上の `saved` の註記)── 光る合図はコピーの意味
      if (chosen.id === 'csv-file') return;
      flashCopied(target);
    });
    return;
  }

  const inner = findMdBlockCopySource(block);
  if (!inner) return;
  const source = stripTableChromeForCopy(inner);
  const plain = extractMdBlockPlainText(source);
  void copyMarkdownAndHtml(plain, source.outerHTML).then((ok) => {
    // ⚠ ⧉ の側も同じ口へ寄せた(2026-09-05)── 直す前は**こちらも無言**で、
    //   「光る方だけ成功」を user に読ませていた(この file の `flashCopied` の註記の裏)
    if (ok) flashCopied(target);
    else deps.fail(COPY_FAILED);
  });
}
