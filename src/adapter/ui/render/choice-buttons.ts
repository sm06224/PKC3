/**
 * 🔴 **選ばれている物が濃く表示されるボタンの列(共通の描き手)**
 * (#1038 段J、C18 / Q7 の裁定 A)。
 *
 * ## なぜ 1 か所へ寄せたか
 *
 * `kind-bar.ts` の `kindChip`(一覧の種類で絞る札。#411)と、`settings.ts` の
 * プルダウン置き換え(選択肢 4 つ以下)は、**同じ形**(単発ボタン + `aria-pressed`
 * で濃さを出す)を 2 つの綴りで描いていた。CLAUDE.md §7「同じ問いに答える口が
 * 2 つあると、片方だけ壊れる」── ボタン 1 個の作り手をここへ寄せ、両方から呼ぶ。
 *
 * ⚠ **選ぶ意味論は共通化しない**(kindChip は複数選べる絞り込み、設定は
 *   ラジオのように 1 つだけ選ぶ)。共通なのは「1 個のボタンをどう描くか」だけ。
 */

/** 1 個のボタンの見かけと押し先。 */
export interface PressedButtonSpec {
  /** `data-pkc-action`(binder が受ける口)。 */
  readonly action: string;
  /** 値を運ぶ属性の名前(例 `data-pkc-editor-mode-value`)。binder は
   *  `<select>` でもボタンでも同じ値を読めるよう、この属性を見る。 */
  readonly dataAttr: string;
  readonly value: string;
  readonly label: string;
  /** 選ばれているか(`aria-pressed` と見かけの濃さに出す)。 */
  readonly pressed: boolean;
  /** マウスを乗せたときの字。 */
  readonly title?: string;
}

export function buildPressedButton(spec: PressedButtonSpec): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', spec.action);
  btn.setAttribute(spec.dataAttr, spec.value);
  /**
   * 🔴 **濃さの規則を CSS 側でも 1 か所に寄せる**(#1038 段J-2。着地前レビューで
   *   「実ブラウザでは選んでいるボタンが他と見分けが付かない」が判明)。
   *
   * ⚠ 直す前は `app.css` の `[data-pkc-region='kind-bar'] button[aria-pressed='true']`
   *   にだけ濃さの規則があり、`kind-bar.ts` はこの region の下に描かれるので効いたが、
   *   `settings.ts` の列(`buildChoiceRow`)はどの region にも属さない ── だから
   *   `aria-pressed` は正しく付いていても**色は 1 つも変わっていなかった**。
   * 🔑 region 名で選ぶのをやめ、ここで立てる**この属性**で選ぶ(CLAUDE.md §7
   *   「同じ問いに答える口が 2 つあると、片方だけ壊れる」の CSS 版)。
   *   これで kind-bar / 設定の列の**両方**が `app.css` の同じ 1 本を読む。
   */
  btn.setAttribute('data-pkc-choice-btn', '');
  /**
   * 🔴 **押されているかを読み上げにも出す**(`aria-pressed`)── 色だけで
   *   表すと、色を見分けられない人には**どれが選ばれているか分からない**
   *   (`kind-bar.ts` の同注記そのまま)。
   */
  btn.setAttribute('aria-pressed', spec.pressed ? 'true' : 'false');
  btn.textContent = spec.label;
  if (spec.title !== undefined) btn.title = spec.title;
  return btn;
}

/** 選択肢 1 つ。プルダウンの `<option>` に対応する。 */
export interface ChoiceSpec {
  readonly id: string;
  readonly label: string;
}

/**
 * 選択肢がちょうど 1 つだけ選ばれる列(設定のプルダウン置き換え)。
 * ⚠ `field` は既存の `<select>` と**同じ field 名を引き継ぐ**
 *   (`tests/adapter/system-sections.test.ts` の対応表・各設定の test を
 *   壊さないため。器の形は変わったが field は「その設定の値を持つ場所」を
 *   指す名前のままでよい)。
 */
export function buildChoiceRow(opts: {
  readonly field: string;
  readonly ariaLabel: string;
  readonly action: string;
  readonly dataAttr: string;
  readonly choices: readonly ChoiceSpec[];
  readonly currentId: string;
}): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-pkc-field', opts.field);
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', opts.ariaLabel);
  for (const c of opts.choices) {
    row.append(
      buildPressedButton({
        action: opts.action,
        dataAttr: opts.dataAttr,
        value: c.id,
        label: c.label,
        pressed: c.id === opts.currentId,
      }),
    );
  }
  /**
   * 🔴 **押した瞬間に濃さも移す**(2026-09-26、実ブラウザ smoke 3 本が落ちて判明)。
   *
   * ⚠ これらの設定は `AppState` を経由しない(正本は `localStorage` / DOM の属性
   *   ── `syncChoiceRow` の docstring のとおり)。`<select>` の頃はブラウザの
   *   ネイティブ挙動が「選ばれた option」を自動で映していたので気づかなかったが、
   *   ボタンに替えると**押しても濃さが動かない**(action の店(binder)は値を
   *   保存するだけで、この列を描き直さない)。
   * 🔑 だからこの列自身が、押された瞬間に**自分で**映す(`binder` の
   *   `data-pkc-action` 委任より先に走る捕捉フェーズ ── 保存の成否には関わらない、
   *   見かけだけの即時反映)。次に `render()` が呼ばれれば `syncChoiceRow` が
   *   正本(DOM 属性 / 保存)で上書きするので、食い違ったままにはならない。
   */
  row.addEventListener(
    'click',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest<HTMLButtonElement>('button');
      if (btn === null || !row.contains(btn)) return;
      for (const b of row.querySelectorAll<HTMLButtonElement>('button')) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      }
    },
    true,
  );
  return row;
}

/**
 * ⚠ 画面の値を**いまの設定に合わせる**(器は 1 度しか組まない ── 映さないと
 * 古い値が見える。CLAUDE.md §7「設定画面の値の同期」)。`<select>` 版の
 * `select.value = cur` に対応する、ボタン列版。
 */
export function syncChoiceRow(region: ParentNode, field: string, dataAttr: string, currentId: string): void {
  const row = region.querySelector(`[data-pkc-field="${field}"]`);
  if (!row) return;
  for (const btn of row.querySelectorAll<HTMLButtonElement>('button')) {
    const pressed = btn.getAttribute(dataAttr) === currentId;
    const want = pressed ? 'true' : 'false';
    if (btn.getAttribute('aria-pressed') !== want) btn.setAttribute('aria-pressed', want);
  }
}
