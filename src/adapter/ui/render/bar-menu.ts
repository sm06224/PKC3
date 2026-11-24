/**
 * 🔴 **ツールバーの「書き出す ▾」「その他 ▾」(1 段奥のメニュー)を作る 1 本の関数**(#1442 S3-2)。
 *
 * ## なぜ共通にしたか
 *
 * SQL 画面(段②)は、よく使う操作は帯に出し、たまにしか使わない操作は「その他 ▾」の 1 段奥へ回した。
 * 集計・差分マージ・計算・テキスト整形・2 ペインも同じ方針にするので、**メニューの作り方を 2 か所に書かない**
 * (閉じ方が片方だけ違う、が一番起きやすい)。SQL 画面もここを通る。
 *
 * ## 守ること(置き換えの作法 ── native `<details>` が暗黙に持っていた物と、足した物)
 *
 * - 押したら閉じる ── ただし**次のイベントで**閉じる(`setTimeout 0`)。同じ押しで別の一覧が開く項目
 *   (`keepOpenActions`)が、押した項目の位置を読むので、先に閉じると位置が 0 になる。
 * - 外を押したら閉じる。**聞き手は文書に 1 本だけ**(メニューごとに足すと、器を作り直す日に外し忘れた分が溜まる)。
 * - `Esc` で閉じて、焦点を「その他 ▾」(summary)へ戻す。`stopPropagation` で背後の `Esc`(ノート選択解除など)を巻き込まない。
 * - 項目のボタンは**元の `data-pkc-action` / `data-pkc-field` のまま**入れる(受け手・押せない状態・鍵はそのまま届く)。
 */

/** 聞き手を張った文書(別ウィンドウの文書にも 1 本ずつ)。 */
const listened = new WeakSet<Document>();

/**
 * 文書に外押しの聞き手を 1 本だけ張る(2 つ目以降は張らない)。
 * ⚠ 開いているメニューは**文書から引く**(一覧を module に持たない ── 2 ペインの帯のように作り直す器の分が溜まらない)。
 */
function ensureOutsideListener(doc: Document): void {
  if (listened.has(doc)) return;
  listened.add(doc);
  doc.addEventListener('pointerdown', (ev: Event) => {
    for (const d of doc.querySelectorAll<HTMLDetailsElement>('details[data-pkc-bar-menu][open]')) {
      if (ev.target instanceof Node && !d.contains(ev.target)) d.open = false;
    }
  });
}

export interface BarMenuOptions {
  /** 項目を並べる器の `data-pkc-field`(SQL 画面は既存の `sql-menu-list`。既定は `bar-menu-list`)。 */
  readonly listField?: string;
  /** 押しても**メニューを開いたままにする**項目の `data-pkc-action`(別の一覧をこの項目を錨に開く物)。 */
  readonly keepOpenActions?: readonly string[];
  /** 上へ開くか(画面の最下段にある帯用。既定は下へ)。 */
  readonly up?: boolean;
  /** 一覧をどちらの端へ揃えるか。既定は右端(帯の右端に居るメニュー用)。左寄せの帯の中に居るときは `'start'`(左の端から右へ開く)。 */
  readonly align?: 'start' | 'end';
}

/** 帯の「書き出す ▾」「その他 ▾」。`field` は details の `data-pkc-field`、`label` は summary の字。 */
export function makeBarMenu(
  field: string,
  label: string,
  hint: string,
  items: readonly HTMLElement[],
  opts: BarMenuOptions = {},
): HTMLDetailsElement {
  const doc = items[0]?.ownerDocument ?? document;
  const d = doc.createElement('details');
  d.setAttribute('data-pkc-field', field);
  // 🔴 共通の見た目(app.css)はこの印を読む。⚠ field 名の列挙は増やさない
  d.setAttribute('data-pkc-bar-menu', '');
  const sum = doc.createElement('summary');
  sum.textContent = label;
  sum.title = hint;
  const list = doc.createElement('div');
  list.setAttribute('data-pkc-field', opts.listField ?? 'bar-menu-list');
  list.setAttribute('data-pkc-bar-menu-list', opts.up === true ? 'up' : 'down');
  if (opts.align === 'start') list.setAttribute('data-pkc-bar-menu-align', 'start');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', label);
  list.append(...items);
  d.append(sum, list);
  const keep = new Set(opts.keepOpenActions ?? []);
  d.addEventListener('click', (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest('button') : null;
    if (btn === null) return;
    // 🔴 形の一覧を開く項目は、メニューを開いたままにする(一覧はこの項目を錨に開き、閉じると錨が消える)
    if (keep.has(btn.getAttribute('data-pkc-action') ?? '')) return;
    // ⚠ 次のイベントで閉じる(同じ押しで開く物が、押した項目の位置を読むため)
    setTimeout(() => {
      d.open = false;
    }, 0);
  });
  d.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && d.open) {
      ev.stopPropagation();
      d.open = false;
      sum.focus();
    }
  });
  ensureOutsideListener(doc);
  return d;
}

/**
 * 帯の右端へ寄せる詰め物(左 = 常用の操作 / 右 = 書き出す・その他)。
 * ⚠ 並びは固定(モードで変えない)。見た目の規則は `app.css` の `data-pkc-field='bar-spacer'`。
 */
export function makeBarSpacer(field = 'bar-spacer'): HTMLSpanElement {
  const s = document.createElement('span');
  s.setAttribute('data-pkc-field', field);
  s.setAttribute('aria-hidden', 'true');
  return s;
}
