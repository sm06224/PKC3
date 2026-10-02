/**
 * 🔴 **Markdown プレビュー内のテーブル列ソート機能**(#1150)。
 *
 * ## 何をするか
 * - ノートのプレビュー画面に表示される Markdown 表（`<table>`）のヘッダー（`<th>`）を
 *   クリックまたは Enter/Space キーで操作した際、その列の値に応じて行（`<tr>`）を
 *   昇順（asc）→ 降順（desc）→ 初期状態（none）に 3 態トグルで並び替える。
 * - 数値（通貨記号 `¥`, `$`, `€`, `£`, `円`、カンマ区切り、パーセント等）と
 *   自然言語文字列（ロケール自然順）をスマートに判別してソート。
 * - DOM 上の `tbody` の行配置のみを変更し、Markdown 本文ファイルは一切書き換えない非破壊設計。
 * - アクセシビリティ（`aria-sort`, `role="button"`, `tabindex="0"`）を完備。
 */

/** ソート可能な値の判別結果。 */
interface ComparableValue {
  readonly num: number;
  readonly isNum: boolean;
  readonly str: string;
}

/**
 * セル文字列から数値と文字列を判別する。
 * カンマ区切り数値、通貨記号、パーセントなどを安全に解析する。
 */
export function parseComparable(raw: string): ComparableValue {
  const str = raw.trim();
  if (str === '') {
    return { num: NaN, isNum: false, str: '' };
  }
  // 先頭の通貨記号や末尾の単位・パーセント、桁区切りカンマを除去して数値判定
  const cleaned = str
    .replace(/^[¥$€£\s]+|[円%\s]+$/g, '')
    .replace(/,/g, '');
  const num = Number(cleaned);
  const isNum = cleaned !== '' && !isNaN(num) && isFinite(num);
  return { num, isNum, str };
}

/**
 * 2 つの行の当該列を比較する。
 */
export function compareRows(
  rowA: Element,
  rowB: Element,
  colIndex: number,
  direction: 'asc' | 'desc',
): number {
  const cellA = rowA.children[colIndex]?.textContent ?? '';
  const cellB = rowB.children[colIndex]?.textContent ?? '';
  const valA = parseComparable(cellA);
  const valB = parseComparable(cellB);

  const diff =
    valA.isNum && valB.isNum
      ? valA.num - valB.num
      : valA.str.localeCompare(valB.str, undefined, { numeric: true, sensitivity: 'base' });

  if (diff === 0) {
    // 同値時は元のインデックスで安定ソート
    const idxA = Number(rowA.getAttribute('data-pkc-orig-index') ?? 0);
    const idxB = Number(rowB.getAttribute('data-pkc-orig-index') ?? 0);
    return idxA - idxB;
  }

  return direction === 'desc' ? -diff : diff;
}

/**
 * 🔴 **その表の並べ替えを、元の並び(none)へ戻す**(#1264 欠陥 5)。
 *
 * 見出しを 2 回押して欄を開くとき、1 回目・2 回目の押しで**行が 2 回並べ替わってから欄が開く**
 * (Esc でやめると降順の ▼ が残る)。欄を開く**前**にここを通せば、並びも ▲▼ も元へ戻る。
 * ⚠ 状態は見出しの `data-pkc-sort-direction` が持つ(`applyTableSort` の押し手はそれを読む)ので、
 *   **属性と行の並びを両方戻す** ── 片方だけだと次の 1 回押しが「降順の次の none」と読まれて食い違う。
 * ⚠ 並べ替えを付けていない表(`data-pkc-orig-index` が無い)では何もしない。
 * @returns 戻したか(元から並べ替えが無ければ `false` ── 何も動かさない)
 */
export function resetTableSort(table: Element): boolean {
  const headers = Array.from(table.querySelectorAll<HTMLElement>('th[data-pkc-sort-direction]'));
  if (!headers.some((th) => (th.getAttribute('data-pkc-sort-direction') ?? 'none') !== 'none')) return false;
  for (const th of headers) {
    th.setAttribute('data-pkc-sort-direction', 'none');
    th.setAttribute('aria-sort', 'none');
  }
  const tbody = table.querySelector('tbody');
  if (tbody === null) return true;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  rows.sort(
    (a, b) =>
      Number(a.getAttribute('data-pkc-orig-index') ?? 0) - Number(b.getAttribute('data-pkc-orig-index') ?? 0),
  );
  tbody.append(...rows);
  return true;
}

/**
 * ホスト要素配下の Markdown 表に列ソート機能を付与する。
 * 冪等に動作し、既に付与済みの表は二重処理しない。
 */
export function applyTableSort(root: ParentNode = document): void {
  const tables = root.querySelectorAll<HTMLTableElement>('.pkc-md-rendered table');
  for (const table of tables) {
    if (table.hasAttribute('data-pkc-table-sort-ready')) continue;
    table.setAttribute('data-pkc-table-sort-ready', 'true');

    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!tbody) continue;

    // ヘッダーセルの取得
    const headers = Array.from(
      (thead ?? table).querySelectorAll<HTMLTableCellElement>('tr:first-child th'),
    );
    if (headers.length === 0) continue;

    // データ行の初期順序を記録
    const initialRows = Array.from(tbody.querySelectorAll('tr'));
    initialRows.forEach((tr, idx) => {
      if (!tr.hasAttribute('data-pkc-orig-index')) {
        tr.setAttribute('data-pkc-orig-index', String(idx));
      }
    });

    headers.forEach((th, colIndex) => {
      th.setAttribute('data-pkc-sort-direction', 'none');
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.setAttribute('aria-sort', 'none');
      th.title = 'クリックで並び替え';

      const icon = document.createElement('span');
      icon.className = 'pkc-table-sort-icon';
      icon.setAttribute('aria-hidden', 'true');
      // 🔴 印の字(↕ ▲ ▼)は**ここでは持たない** ── CSS の `::after` が
      //   `data-pkc-sort-direction` から出す(`app.css`)。字を要素に入れると
      //   `textContent` / 範囲選択 / ⧉ のコピーに `名前↕` と混ざる(#1150 / #1151)。
      th.appendChild(icon);

      const triggerSort = (): void => {
        const current = th.getAttribute('data-pkc-sort-direction') ?? 'none';
        const next: 'none' | 'asc' | 'desc' =
          current === 'none' ? 'asc' : current === 'asc' ? 'desc' : 'none';

        // 他の全ヘッダーの状態をリセット
        headers.forEach((otherTh) => {
          otherTh.setAttribute('data-pkc-sort-direction', 'none');
          otherTh.setAttribute('aria-sort', 'none');
        });

        // 対象ヘッダーの状態を更新
        th.setAttribute('data-pkc-sort-direction', next);
        if (next === 'asc') {
          th.setAttribute('aria-sort', 'ascending');
        } else if (next === 'desc') {
          th.setAttribute('aria-sort', 'descending');
        } else {
          th.setAttribute('aria-sort', 'none');
        }

        // 行の並び替え
        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (next === 'none') {
          rows.sort((a, b) => {
            const idxA = Number(a.getAttribute('data-pkc-orig-index') ?? 0);
            const idxB = Number(b.getAttribute('data-pkc-orig-index') ?? 0);
            return idxA - idxB;
          });
        } else {
          rows.sort((a, b) => compareRows(a, b, colIndex, next));
        }

        tbody.append(...rows);
      };

      th.addEventListener('click', (e) => {
        // セル内のリンク等のクリック時は発火させない
        const target = e.target as HTMLElement | null;
        if (target && target.tagName === 'A') return;
        // 🔴 升の中のボタン(見出しの ✎)・開いている編集欄の中の押しは並べ替えない(#1240)
        if (target?.closest('button, input') != null) return;
        triggerSort();
      });

      th.addEventListener('keydown', (e) => {
        // 🔴 見出しの中の欄・ボタンで打った鍵は並べ替えの鍵ではない(#1240)── 欄で
        //   空白を打つと `preventDefault` が字を消し、Enter が並べ替えてしまう
        if (e.target !== th) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerSort();
        }
      });
    });
  }
}
