/**
 * 左の列の「探す」欄に `>` を打ったときの、**操作の一覧**を描く(#274 段①。姿 = D)。
 *
 * ## 🔴 描くだけ。行を決めるのは `paletteRows` 1 本
 *
 * ⚠ 絞り込みの規則をここに書かない(`palette-rows.ts` が持つ ── 2 本目を作ると、
 *   パレットと左の列で**同じ語が別の答え**になる)。ここは渡された行を並べるだけで、
 *   押したときの実行も `binder.ts`(`runGlobalCommand` と同じ道)が持つ。
 * ⚠ 形は操作のパレット(`app-dialog.ts` の `pickCommandInApp`)の行と**同じ**にする
 *   (名前 / 割当 / 押せない理由)── user に 2 通りの見え方を覚えさせない。
 *
 * ## 🔴 器は 1 度だけ。指紋が同じなら触らない
 *
 * 状態が動くたびに呼ばれる(「いま押せるか」が画面で決まるため)。⚠ 毎回組み直すと、
 * 矢印で動かしている最中の焦点が行ごと消える ── **並び・押せるか・理由**が同じなら何もしない。
 */
import type { PaletteRow } from '@features/palette/palette-rows';

/** 0 件のときの字。⚠ 空を黙って出さない(打ち間違いか、無いのかが分かる字にする)。 */
export const COMMAND_LIST_EMPTY = 'その名前の操作はありません。別の言い方で探してみてください。';

/** 描いた物の指紋。⚠ 並び・押せるか・理由・割当を全部含める(1 つ落とすと、変わっても描き直さない)。 */
function shapeOf(rows: readonly PaletteRow[]): string {
  return JSON.stringify(rows.map((r) => [r.id, r.label, r.keys, r.ready, r.why]));
}

const SHAPE = 'data-pkc-shape';

/**
 * 一覧を描く。
 * @returns 組み直したか(指紋が同じなら `false` ── test が「触らない」を見る)
 */
export function paintCommandList(host: HTMLElement, rows: readonly PaletteRow[]): boolean {
  const shape = shapeOf(rows);
  if (host.getAttribute(SHAPE) === shape) return false;
  host.setAttribute(SHAPE, shape);
  host.textContent = '';
  if (rows.length === 0) {
    const none = document.createElement('p');
    none.setAttribute('data-pkc-field', 'command-empty');
    none.textContent = COMMAND_LIST_EMPTY;
    host.append(none);
    return true;
  }
  for (const r of rows) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-field', 'command-row');
    btn.setAttribute('data-pkc-action', 'run-command-row');
    btn.setAttribute('data-pkc-command', r.id);
    const name = document.createElement('span');
    name.setAttribute('data-pkc-field', 'command-label');
    name.textContent = r.label;
    btn.append(name);
    if (r.keys.length > 0) {
      const keys = document.createElement('span');
      keys.setAttribute('data-pkc-field', 'command-keys');
      keys.textContent = r.keys.join(' / ');
      btn.append(keys);
    }
    if (r.why !== '') {
      const why = document.createElement('span');
      why.setAttribute('data-pkc-field', 'command-why');
      why.textContent = r.why;
      btn.append(why);
    }
    // ⚠ 押せないことを**器に言わせる** ── 見た目だけ薄くすると押せてしまう(パレットと同じ)
    if (!r.ready) btn.disabled = true;
    host.append(btn);
  }
  return true;
}
