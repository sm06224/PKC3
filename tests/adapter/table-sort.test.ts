/**
 * 🔴 **Markdown プレビュー内のテーブル列ソート機能のテスト**(#1150)。
 */
import { describe, expect, it } from 'vitest';
import { applyTableSort, compareRows, parseComparable } from '../../src/adapter/ui/render/table-sort';

describe('table-sort: parseComparable', () => {
  it('通常の数値を正しく数値として判別する', () => {
    expect(parseComparable('123')).toEqual({ num: 123, isNum: true, str: '123' });
    expect(parseComparable('-45.6')).toEqual({ num: -45.6, isNum: true, str: '-45.6' });
    expect(parseComparable('0')).toEqual({ num: 0, isNum: true, str: '0' });
  });

  it('カンマ区切りの数値を正しく数値として判別する', () => {
    expect(parseComparable('1,234,567')).toEqual({ num: 1234567, isNum: true, str: '1,234,567' });
    expect(parseComparable('1,200.50')).toEqual({ num: 1200.5, isNum: true, str: '1,200.50' });
  });

  it('通貨記号やパーセント付きの数値を正しく数値として判別する', () => {
    expect(parseComparable('¥1,500')).toEqual({ num: 1500, isNum: true, str: '¥1,500' });
    expect(parseComparable('$99.99')).toEqual({ num: 99.99, isNum: true, str: '$99.99' });
    expect(parseComparable('1,000円')).toEqual({ num: 1000, isNum: true, str: '1,000円' });
    expect(parseComparable('85%')).toEqual({ num: 85, isNum: true, str: '85%' });
  });

  it('非数値文字列や空文字を正しく判別する', () => {
    expect(parseComparable('apple').isNum).toBe(false);
    expect(parseComparable('apple').str).toBe('apple');
    expect(parseComparable('東京都').isNum).toBe(false);
    expect(parseComparable('').isNum).toBe(false);
    expect(parseComparable('   ').isNum).toBe(false);
  });
});

describe('table-sort: compareRows', () => {
  it('数値列の昇順・降順を正しく比較する', () => {
    const rowA = document.createElement('tr');
    rowA.setAttribute('data-pkc-orig-index', '0');
    rowA.innerHTML = '<td>アイテムA</td><td>¥100</td>';

    const rowB = document.createElement('tr');
    rowB.setAttribute('data-pkc-orig-index', '1');
    rowB.innerHTML = '<td>アイテムB</td><td>¥200</td>';

    expect(compareRows(rowA, rowB, 1, 'asc')).toBeLessThan(0);
    expect(compareRows(rowA, rowB, 1, 'desc')).toBeGreaterThan(0);
  });

  it('文字列の昇順・降順を正しく比較する', () => {
    const rowA = document.createElement('tr');
    rowA.setAttribute('data-pkc-orig-index', '0');
    rowA.innerHTML = '<td>Apple</td>';

    const rowB = document.createElement('tr');
    rowB.setAttribute('data-pkc-orig-index', '1');
    rowB.innerHTML = '<td>Banana</td>';

    expect(compareRows(rowA, rowB, 0, 'asc')).toBeLessThan(0);
    expect(compareRows(rowA, rowB, 0, 'desc')).toBeGreaterThan(0);
  });

  it('同値時は元の出現インデックスで安定ソートする', () => {
    const rowA = document.createElement('tr');
    rowA.setAttribute('data-pkc-orig-index', '2');
    rowA.innerHTML = '<td>¥100</td>';

    const rowB = document.createElement('tr');
    rowB.setAttribute('data-pkc-orig-index', '5');
    rowB.innerHTML = '<td>¥100</td>';

    expect(compareRows(rowA, rowB, 0, 'asc')).toBe(-3);
  });
});

describe('table-sort: applyTableSort', () => {
  function createSampleTable(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'pkc-md-rendered';
    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>品名</th>
            <th>価格</th>
            <th>在庫</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>みかん</td><td>¥100</td><td>50個</td></tr>
          <tr><td>りんご</td><td>¥200</td><td>10個</td></tr>
          <tr><td>ぶどう</td><td>¥150</td><td>25個</td></tr>
        </tbody>
      </table>
    `;
    return container;
  }

  it('ヘッダーにソート属性とインジケータを初期付与する', () => {
    const container = createSampleTable();
    applyTableSort(container);

    const ths = container.querySelectorAll('th');
    expect(ths.length).toBe(3);
    for (const th of ths) {
      expect(th.getAttribute('data-pkc-sort-direction')).toBe('none');
      expect(th.getAttribute('aria-sort')).toBe('none');
      expect(th.getAttribute('role')).toBe('button');
      expect(th.getAttribute('tabindex')).toBe('0');
      const icon = th.querySelector('.pkc-table-sort-icon');
      expect(icon).not.toBeNull();
      expect(icon?.textContent).toBe('↕');
    }
  });

  it('ヘッダークリックで昇順 → 降順 → 初期順の 3 態トグルが行われる', () => {
    const container = createSampleTable();
    applyTableSort(container);

    const priceTh = container.querySelectorAll('th')[1]!;
    const tbody = container.querySelector('tbody')!;

    // 1 回目クリック: asc (昇順: ¥100 -> ¥150 -> ¥200)
    priceTh.click();
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('asc');
    expect(priceTh.getAttribute('aria-sort')).toBe('ascending');
    expect(priceTh.querySelector('.pkc-table-sort-icon')?.textContent).toBe('▲');
    let names = Array.from(tbody.querySelectorAll('tr')).map(
      (r) => r.children[0]?.textContent,
    );
    expect(names).toEqual(['みかん', 'ぶどう', 'りんご']);

    // 2 回目クリック: desc (降順: ¥200 -> ¥150 -> ¥100)
    priceTh.click();
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('desc');
    expect(priceTh.getAttribute('aria-sort')).toBe('descending');
    expect(priceTh.querySelector('.pkc-table-sort-icon')?.textContent).toBe('▼');
    names = Array.from(tbody.querySelectorAll('tr')).map(
      (r) => r.children[0]?.textContent,
    );
    expect(names).toEqual(['りんご', 'ぶどう', 'みかん']);

    // 3 回目クリック: none (初期状態: みかん -> りんご -> ぶどう)
    priceTh.click();
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('none');
    expect(priceTh.getAttribute('aria-sort')).toBe('none');
    expect(priceTh.querySelector('.pkc-table-sort-icon')?.textContent).toBe('↕');
    names = Array.from(tbody.querySelectorAll('tr')).map(
      (r) => r.children[0]?.textContent,
    );
    expect(names).toEqual(['みかん', 'りんご', 'ぶどう']);
  });

  it('別列をクリックした際に前の列のソート状態が解除される', () => {
    const container = createSampleTable();
    applyTableSort(container);

    const ths = container.querySelectorAll('th');
    const nameTh = ths[0]!;
    const priceTh = ths[1]!;

    // 価格で昇順ソート
    priceTh.click();
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('asc');

    // 品名をクリック
    nameTh.click();
    expect(nameTh.getAttribute('data-pkc-sort-direction')).toBe('asc');
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('none');
    expect(priceTh.getAttribute('aria-sort')).toBe('none');
    expect(priceTh.querySelector('.pkc-table-sort-icon')?.textContent).toBe('↕');
  });

  it('キーボード操作(Enter / Space)でソートがトリガーされる', () => {
    const container = createSampleTable();
    applyTableSort(container);

    const priceTh = container.querySelectorAll('th')[1]!;
    priceTh.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('asc');

    priceTh.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(priceTh.getAttribute('data-pkc-sort-direction')).toBe('desc');
  });

  it('applyTableSort は冪等であり二重に初期化されない', () => {
    const container = createSampleTable();
    applyTableSort(container);
    applyTableSort(container);

    const th = container.querySelector('th')!;
    const icons = th.querySelectorAll('.pkc-table-sort-icon');
    expect(icons.length).toBe(1);
  });
});
