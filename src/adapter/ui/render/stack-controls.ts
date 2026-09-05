/**
 * 🔴 **保存したスタックの中を、読む面から並べ替える**(#633 段④)── 各行に「上へ / 下へ」。
 *
 * ## なぜ読む面に置くか
 *
 * 入れ物(`stack` フレーバー)の本文は `- [題名](entry:<lid>)` の箇条書きで、並び = 上から順に
 * 載る順である。⚠ 段③ までは並びを直すのに**本文を開いて行を入れ替える**しか無かった ──
 * 「上に来てほしい」だけの人に原文を開かせるのは、面が映すだけで書けない形
 * (user 指示 2026-08-23「面は映すだけにしない」)。
 * 🔑 だからチェックの印(`toggle-task`)と同じ作法で、**読む面の行に押し所を置き、
 *   書換は `REQUEST_BODY_REWRITE` の 1 本**(`body-rewrite.ts` の `link-move`)を通す。
 *
 * ## ⚠ 生きているスタック(帯)には D&D を作らない
 *
 * 帯は「押して上げる」で足りる(設計 doc §2-5)。ここは**保存した入れ物**の並びだけである。
 *
 * ## 作り
 *
 * - 押し所は `applyHeadingFold` / `applyPlaceLayout` と同じく**描画のたびに当てる**(冪等)。
 *   `applyBlocks` は描画 HTML どうしを比べるので、ここで足すボタンは差分に影響しない。
 * - 行番号は **原文の行**で焼く(`data-pkc-line` = `data-pkc-source-line` + frontmatter の行数)
 *   ── 受け手(`body-rewrite.ts`)は原文を splice する(`toggle-task` の `taskLineOffset` と同じ)。
 * - 端では押せない(`disabled`)── 押しても何も起きない口を出さない(#513)。
 */

/** 押し所の器の印。⚠ test / CSS はこれを見る。 */
export const STACK_MOVE_FIELD = 'stack-link-move';

/**
 * 入れ物の本文(描いた DOM)に「上へ / 下へ」を当てる。
 *
 * @param host 本文の器(`detail-body`)
 * @param lineOffset frontmatter の行数(描画の行番号 → 原文の行番号)
 * @returns 押し所を当てた行の数(test の空振り防止)
 */
export function applyStackControls(host: HTMLElement, lineOffset: number): number {
  const items = [...host.querySelectorAll<HTMLElement>('li[data-pkc-source-line]')].filter(
    (li) => li.querySelector('a[href^="entry:"]') !== null,
  );
  const doc = host.ownerDocument;
  items.forEach((li, i) => {
    // ⚠ 既に当ててあれば触らない(描き直しで押し所が飛ばない)
    // ⚠ `:scope >` を使わない ── happy-dom が解かないことがある。直下の子を自分で探す
    let box =
      [...li.children].find(
        (c): c is HTMLElement =>
          c instanceof HTMLElement && c.getAttribute('data-pkc-field') === STACK_MOVE_FIELD,
      ) ?? null;
    if (box === null) {
      box = doc.createElement('span');
      box.setAttribute('data-pkc-field', STACK_MOVE_FIELD);
      const up = doc.createElement('button');
      up.type = 'button';
      up.setAttribute('data-pkc-action', 'stack-link-up');
      up.textContent = '↑';
      up.title = '1 つ上へ(本文の行を入れ替えます)';
      const down = doc.createElement('button');
      down.type = 'button';
      down.setAttribute('data-pkc-action', 'stack-link-down');
      down.textContent = '↓';
      down.title = '1 つ下へ(本文の行を入れ替えます)';
      box.append(up, down);
      li.append(box);
    }
    const raw = Number(li.getAttribute('data-pkc-source-line'));
    const line = String(raw + lineOffset);
    const up = box.querySelector<HTMLButtonElement>('[data-pkc-action="stack-link-up"]');
    const down = box.querySelector<HTMLButtonElement>('[data-pkc-action="stack-link-down"]');
    if (up !== null) {
      up.setAttribute('data-pkc-line', line);
      up.disabled = i === 0;
    }
    if (down !== null) {
      down.setAttribute('data-pkc-line', line);
      down.disabled = i === items.length - 1;
    }
  });
  return items.length;
}
