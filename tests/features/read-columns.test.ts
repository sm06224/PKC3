/** @vitest-environment happy-dom */
/**
 * 🔴 **読む面の段組み**(#505 段①。user 指示 2026-08-28)。
 *
 * 見るのは 5 点:
 * ① 🔴 **既定が現行そのまま**(選ばなければ見え方が 1 バイトも変わらない)
 * ② 当てると DOM に印と値が乗る(画面が正本)
 * ③ 🔴 **当てるだけでは保存しない**
 * ④ 🔴 **CSS の 3 本が揃っている**(1 本でも欠けると横送りにならない)
 * ⑤ 🔴 **縦のホイールが横送りになる**(無いとマウスだけで読めない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_READ_COLUMNS,
  isReadColumns,
  READ_COLUMN_CHOICES,
  columnsFit,
  READ_COLUMN_GAP_PX,
  READ_COLUMN_MIN_PX,
  readColumnsSpec,
  wheelToInline,
} from '../../src/features/read-columns';
import {
  applyReadColumns,
  chooseReadColumns,
  columnScroller,
  currentReadColumns,
  installColumnWheel,
  READ_COLUMNS_ATTR,
  READ_COLUMNS_VAR,
} from '../../src/adapter/ui/render/read-columns';

const CSS = (): string => readFileSync('src/styles/app.css', 'utf-8');

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(READ_COLUMNS_ATTR);
  document.documentElement.style.removeProperty(READ_COLUMNS_VAR);
  document.body.textContent = '';
});

describe('段組みの表', () => {
  /**
   * 🔴 **既定は 1 段 = 現行そのまま**。⚠ ここがずれると、**設定を触っていない
   *   user の画面が動く** ── 2026-08-28 の裁定に正面から反する。
   */
  it('🔴 既定は 1 段 ── 選ばなければ見え方が変わらない', () => {
    expect(DEFAULT_READ_COLUMNS).toBe('1');
    expect(readColumnsSpec(DEFAULT_READ_COLUMNS).count).toBe(1);
  });

  it('4 段まで、段数が単調に増える(選ばせる幅を絞る)', () => {
    expect(READ_COLUMN_CHOICES).toHaveLength(4);
    const n = READ_COLUMN_CHOICES.map((c) => c.count);
    for (let i = 1; i < n.length; i++) {
      expect(n[i]!, `${READ_COLUMN_CHOICES[i]!.id} が 1 つ前より小さい`).toBeGreaterThan(n[i - 1]!);
    }
    // ⚠ id と段数が食い違わない(`'3'` を選んで 2 段、を作らない)
    for (const c of READ_COLUMN_CHOICES) expect(Number(c.id)).toBe(c.count);
  });

  it('知らない id は既定へ落ちる(呼び側で分岐させない)', () => {
    expect(isReadColumns('9')).toBe(false);
    expect(isReadColumns(3)).toBe(false);
    expect(readColumnsSpec('9' as never).id).toBe('1');
  });
});

describe('当てる / 選ぶ / 起動時に戻す', () => {
  it('当てると印と値が DOM に乗る(画面が正本)', () => {
    applyReadColumns(document.documentElement, '3');
    expect(document.documentElement.getAttribute(READ_COLUMNS_ATTR)).toBe('3');
    expect(document.documentElement.style.getPropertyValue(READ_COLUMNS_VAR)).toBe('3');
    expect(currentReadColumns(document.documentElement)).toBe('3');
  });

  /**
   * 🔴 **1 段のときも印を書く**。⚠ 「属性が無い = 1 段」にすると、
   *   CSS が `:not([...='1'])` で書けず、smoke も「消えた」と「そもそも付いて
   *   いない」を見分けられない(CLAUDE.md §1)。
   */
  it('🔴 1 段へ戻したときも印は消えない(印の有無を意味に使わない)', () => {
    applyReadColumns(document.documentElement, '2');
    applyReadColumns(document.documentElement, '1');
    expect(document.documentElement.getAttribute(READ_COLUMNS_ATTR)).toBe('1');
    expect(currentReadColumns(document.documentElement)).toBe('1');
  });

  it('🔴 当てるだけでは保存しない / 選んだときだけ保存する', () => {
    applyReadColumns(document.documentElement, '2');
    expect(localStorage.getItem('pkc3.read-columns'), '当てただけで保存した').toBeNull();
    chooseReadColumns(document.documentElement, '3');
    expect(localStorage.getItem('pkc3.read-columns')).toBe('3');
  });

  it('保存が壊れていても既定へ落ちる(起動を止めない)', () => {
    localStorage.setItem('pkc3.read-columns', 'いっぱい');
    expect(currentReadColumns(document.documentElement)).toBe('1');
  });
});

/**
 * 🔴 **CSS の 3 本は 1 組**(#505)。⚠ 1 本でも欠けると横送りにならないので、
 *   「段組みの規則が在る」ではなく **3 本それぞれ**を名指しで見る。
 * ⚠ 見るのは**実行する行**(コメントに満たされない ── CLAUDE.md §1)。
 */
describe('CSS(2 本で 1 組)', () => {
  /** コメントを落とし、`@media` の手前までを見る。 */
  const codeOnly = (): string => {
    const css = CSS().replace(/\/\*[\s\S]*?\*\//g, '');
    const i = css.indexOf('@media');
    return i === -1 ? css : css.slice(0, i);
  };

  /**
   * ⚠ かつてここに 3 本目「外のスクロール箱の `overflow: hidden`」の検査が在ったが、
   *   **変異試験 M7 が SURVIVED** で no-op だと分かったので、規則ごと消した
   *   (①で面が `flex: 1 1 0` になると器は伸びず、実測でも
   *   `scrollHeight === clientHeight` = 653)。
   */
  it('🔴 ① 読む面を器の高さで止める(既定は中身の高さまで伸びる)', () => {
    expect(codeOnly(), '面が伸びたままだと段の高さが決まらず、段組みにならない').toMatch(
      /data-pkc-columns-on\]\s*\{[^}]*flex:\s*1 1 0/,
    );
  });

  it('🔴 ② 本文の器を横スクローラにして段を流す', () => {
    const css = codeOnly();
    expect(css, '段組みになっていない').toMatch(
      /\[data-pkc-field='detail-body'\]\s*\{[^}]*columns:\s*[^;]*var\(--pkc-read-cols/,
    );
    expect(css, '横に送れない').toMatch(
      /\[data-pkc-field='detail-body'\]\s*\{[^}]*overflow-x:\s*auto/,
    );
  });

  /**
   * 🔴 **寸法は変数で渡し、予備の値は TS の定数と一致させる**(#505)。
   *
   * ⚠ 予備の値を**書かない**のは駄目 ── 定義の無い `var()` は**宣言ごと捨てられる**
   *   ので、段組みが 1 ドットも出ない(#465 / #466 で実際に出荷した穴。
   *   `tests/features/css-vars.test.ts` が全体を見張っている)。
   * ⚠ かといって書きっぱなしにすると **2 本目の数字**になる ── だから
   *   ここで TS の定数と突合する。
   */
  it('🔴 段組みの寸法が、TS の定数と一致する(片方だけ動かさない)', () => {
    const m = /\[data-pkc-field='detail-body'\]\s*\{([^}]*)\}/.exec(codeOnly());
    expect(m, '段組みの規則を読めない(空振り)').not.toBeNull();
    const rule = m![1]!;
    const cols = /columns:\s*([^\s]+)\s+var\(--pkc-read-cols,\s*([^)]+)\);/.exec(rule);
    expect(cols, 'columns が「最小幅 + 段数の変数」の形になっていない').not.toBeNull();
    expect(cols![1]!.trim(), '最小幅が TS の定数とずれている').toBe(`${READ_COLUMN_MIN_PX}px`);
    // ⚠ 予備は 1(= 段組みしない)── JS が動かない回に段へ流れないこと
    expect(cols![2]!.trim(), '段数の予備は 1 であるべき').toBe('1');
    const gap = /column-gap:\s*([^;]+);/.exec(rule);
    expect(gap, 'column-gap が無い').not.toBeNull();
    expect(gap![1]!.trim(), 'すき間が TS の定数とずれている').toBe(`${READ_COLUMN_GAP_PX}px`);
  });

  /**
   * 🔴 **段組みの規則は、印が付いた面にだけ効く**。
   * ⚠ 印は JS が「2 段置ける」と判断したときだけ付く ── ここが `:root` の
   *   選択そのものを見ていると、**狭い画面で横送りが残る**(実測でそうなった)。
   */
  it('🔴 段組みの規則は、すべて [data-pkc-columns-on] へ絞ってある', () => {
    const css = codeOnly();
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .map((m) => m[1] ?? '')
      .filter((sel) => sel.includes('data-pkc-columns-on'));
    expect(rules.length, '段組みの規則が 1 本も無い(空振り)').toBeGreaterThanOrEqual(2);
    // ⚠ user の選択そのものを CSS が見ていない(見ると狭い画面で横送りが残る)
    expect(
      css.includes("[data-pkc-read-columns]:not"),
      'CSS が user の選択を直に見ている(器の狭さを無視してしまう)',
    ).toBe(false);
  });
});

/**
 * 🔴 **狭い画面では段組みごと止める**(#505「狭い画面で壊れない」)。
 *
 * ⚠ CSS の `columns` に任せると段数だけ 1 へ落ちて**横送りが残る** ──
 *   1100px のノート PC で「横スクロールで 1 段ずつめくる」画面になっていた(実測)。
 */
describe('器に収まるか', () => {
  it('🔴 2 段ぶん置けない器では成り立たない(縦送りへ戻す)', () => {
    const need = READ_COLUMN_MIN_PX * 2 + READ_COLUMN_GAP_PX;
    expect(columnsFit(need, 2), '足りているのに止めた').toBe(true);
    expect(columnsFit(need - 1, 2), '足りないのに段組みを続けた').toBe(false);
  });

  /**
   * 🔴 **判定は常に 2 段ぶん**。⚠ 選ばれた段数ぶんで数えると、3 段を選んだ user の
   *   1400px の画面が**丸ごと縦送りへ落ちる**(2 段なら読めるのに)。
   */
  it('🔴 3 段を選んでいても、2 段置ければ成り立つ', () => {
    const two = READ_COLUMN_MIN_PX * 2 + READ_COLUMN_GAP_PX;
    expect(columnsFit(two, 3), '2 段置けるのに止めた').toBe(true);
    expect(columnsFit(two, 4)).toBe(true);
  });

  it('1 段のときは、どれだけ広くても段組みではない', () => {
    expect(columnsFit(99_999, 1)).toBe(false);
    expect(columnsFit(99_999, 0)).toBe(false);
  });
});

/**
 * 🔴 **縦のホイールで横へ送れる**(#505。実測で必須と分かった ──
 *   段組みでは縦ホイールが 1px も動かさない: 1727 → 1727)。
 */
describe('ホイールの読み替え', () => {
  it('縦だけ回したら、その分を横へ渡す', () => {
    expect(wheelToInline(0, 120)).toBe(120);
    expect(wheelToInline(0, -120)).toBe(-120);
  });

  /**
   * ⚠ **横成分があるときは触らない** ── 横ホイールはブラウザがそのまま横送りに
   *   するので、足すと**倍の速さで飛ぶ**。
   */
  it('🔴 横成分があるときは何もしない(倍速で飛ばさない)', () => {
    expect(wheelToInline(40, 120)).toBe(0);
    expect(wheelToInline(-40, 0)).toBe(0);
  });

  /** 読む面の器を 1 つ組む(本物と同じ綴りで名乗らせる)。 */
  function rig(): { root: HTMLElement; host: HTMLElement; inner: HTMLElement } {
    const root = document.createElement('div');
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-view-pane', 'detail');
    pane.setAttribute('data-pkc-detail-mode', 'view');
    const host = document.createElement('div');
    host.setAttribute('data-pkc-field', 'detail-body');
    const inner = document.createElement('p');
    host.append(inner);
    pane.append(host);
    root.append(pane);
    document.body.append(root);
    // happy-dom は採寸しない ── 送れる余地を手で作る
    Object.defineProperty(host, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(host, 'clientWidth', { value: 1000, configurable: true });
    host.scrollLeft = 0;
    return { root, host, inner };
  }

  const wheel = (target: Node, deltaY: number, deltaX = 0): WheelEvent => {
    const ev = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  };

  it('🔴 段組み中は、縦のホイールで横へ送れる', () => {
    const { root, host, inner } = rig();
    applyReadColumns(document.documentElement, '2');
    installColumnWheel(root, document);
    const ev = wheel(inner, 300);
    expect(host.scrollLeft, '縦ホイールで横へ送れていない').toBe(300);
    expect(ev.defaultPrevented, '既定を止めていない(縦にも動いてしまう)').toBe(true);
  });

  /**
   * 🔴 **対照群** ── 1 段のときは**奪わない**。⚠ これが無いと
   *   「段組みだから動いた」のか「いつでも動く」のかが分からない。
   */
  it('🔴 1 段のときは、ふつうの縦送りを奪わない', () => {
    const { root, host, inner } = rig();
    applyReadColumns(document.documentElement, '1');
    installColumnWheel(root, document);
    const ev = wheel(inner, 300);
    expect(host.scrollLeft, '1 段なのに横へ送った').toBe(0);
    expect(ev.defaultPrevented, '1 段なのに既定を止めた').toBe(false);
  });

  it('🔴 端まで送ったら既定へ返す(外側の面が送れなくなるのを避ける)', () => {
    const { root, host, inner } = rig();
    applyReadColumns(document.documentElement, '2');
    installColumnWheel(root, document);
    host.scrollLeft = 3000; // = scrollWidth - clientWidth
    const ev = wheel(inner, 300);
    expect(ev.defaultPrevented, '端なのに既定を止めた').toBe(false);
    // 逆向きは端ではないので、まだ効く
    expect(wheel(inner, -300).defaultPrevented).toBe(true);
  });

  it('器の外で回しても奪わない(右の情報ペインの送りを殺さない)', () => {
    const { root } = rig();
    const outside = document.createElement('div');
    root.append(outside);
    applyReadColumns(document.documentElement, '2');
    installColumnWheel(root, document);
    expect(wheel(outside, 300).defaultPrevented).toBe(false);
  });

  it('外したら、もう奪わない(張りっぱなしにしない)', () => {
    const { root, host, inner } = rig();
    applyReadColumns(document.documentElement, '2');
    installColumnWheel(root, document)();
    wheel(inner, 300);
    expect(host.scrollLeft).toBe(0);
  });

  it('編集に入っている面の器は掴まない(段組みは view だけ)', () => {
    const { root, inner } = rig();
    root.querySelector('[data-pkc-view-pane]')!.setAttribute('data-pkc-detail-mode', 'edit');
    applyReadColumns(document.documentElement, '2');
    installColumnWheel(root, document);
    expect(columnScroller(root)).toBeNull();
    expect(wheel(inner, 300).defaultPrevented).toBe(false);
  });
});

/**
 * 🔴 **設定画面から実体まで繋がっているか**(#505)。
 *
 * ⚠ **合成した `<select>` を押さない**(`page-format.test.ts` / #504 の注記そのまま)──
 *   自分で作った要素に自分で `data-pkc-action` を付けて押すと、**本物の設定画面が
 *   その action を付け忘れても緑**になる。
 */
describe('段組み(設定画面と配線)', () => {
  function pane(): { region: HTMLElement; settings: SettingsRenderer } {
    const region = document.createElement('div');
    document.body.append(region);
    const settings = new SettingsRenderer(region, new JobMonitor());
    return { region, settings };
  }

  it('選択肢が表と 1 対 1(選べない段数・在らない段数を作らない)', () => {
    const { region, settings } = pane();
    settings.render(initialState);
    const opts = [
      ...region.querySelectorAll<HTMLOptionElement>(
        '[data-pkc-field="read-columns-select"] option',
      ),
    ];
    expect(opts.map((o) => o.value)).toEqual(READ_COLUMN_CHOICES.map((c) => c.id));
    expect(opts.map((o) => o.textContent)).toEqual(READ_COLUMN_CHOICES.map((c) => c.label));
  });

  /**
   * 🔴 **組み立てのときも映す**(#504 の変異試験 M8 が SURVIVED で教えた形)。
   * 器は 1 度しか組まないので、起動時に保存から復元した値をここで映さないと、
   * 選択欄は既定のまま = **画面が嘘をつく**。
   */
  it('🔴 組み立て直後の選択欄が、いま当たっている段数を映す', () => {
    applyReadColumns(document.documentElement, '3');
    const { region, settings } = pane();
    settings.render(initialState);
    const select = region.querySelector<HTMLSelectElement>(
      '[data-pkc-field="read-columns-select"]',
    );
    expect(select?.value).toBe('3');
    // 対照群 ── 別の値でも映る(1 つに固まっているのではない)
    applyReadColumns(document.documentElement, '2');
    settings.render(initialState);
    expect(select?.value).toBe('2');
  });

  it('🔴 選択欄 → binder → 実体 が繋がっている(押して無言にならない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const dispatcher = { getState: () => initialState, dispatch: vi.fn() };
    bindActions(root, dispatcher as never, {});
    const settings = new SettingsRenderer(root, new JobMonitor());
    settings.render(initialState);
    const select = root.querySelector<HTMLSelectElement>('[data-pkc-field="read-columns-select"]');
    expect(select, '設定画面に段組みの選択欄が無い').not.toBeNull();
    select!.value = '2';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
    // 🔑 実体は DOM(押した結果が画面に当たっている)
    expect(currentReadColumns(document.documentElement)).toBe('2');
    expect(localStorage.getItem('pkc3.read-columns'), '押したのに憶えていない').toBe('2');
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(CLAUDE.md「どの test からも実行され
 * ない file に判断を書かない」)。⚠ 弱い pin だと自覚して使う。
 */
describe('main.ts の配線(原文 pin)', () => {
  it('🔴 起動時に段数を当て、ホイールの読み替えを張っている', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code, '起動時に当てていない(選んでも次の起動で戻る)').toMatch(
      /applyReadColumns\(document\.documentElement,\s*initialReadColumns\(\)\)/,
    );
    expect(code, 'ホイールの読み替えを張っていない(マウスだけで読めない)').toMatch(
      /installColumnWheel\(root\)/,
    );
  });
});
