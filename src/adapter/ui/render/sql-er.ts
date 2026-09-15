/**
 * 🔴 **表のつながり図(ER)を描く**(#918 段⑤b/⑤c)。
 *
 * > user 要望 2026-09-14:「**er でグラフィカルに取得する方法も欲しいな**」
 * > 置き場の裁定 2026-09-15:**SQL の窓の中に、畳める欄として出す**
 *
 * ## 🔴 器は mermaid ではない
 *
 * ⚠ 不可侵指示(2026-08-03「図は描いたら焼く」)により mermaid は **PNG の `<img>` 1 枚**で
 *   出るので、**押せない**。user が欲しいのは「見る」ではなく「**取得する**」なので、
 *   眺めて終わる図では要望を満たさない。
 * 🔑 だから **`<button>` + 1 枚の `<svg>`** で組む(前例 `relation-map.ts` と同じ理由)。
 *
 * ## ⚠ 線は「押せる札」で押す
 *
 * 🔴 `<line>` は**太さ 1px の当たり判定**しか無いので、指でも鍵盤でも押せない。
 * 🔑 線は `<svg>`(押しを通さない)で引き、**真ん中に札の `<button>`** を置く ──
 *   札には「どの列どうしを繋ぐか」が書いてあるので、押す前に何が起きるか読める。
 */

import type { SqlPageState } from '@adapter/state/app-state';
import { erColumnLabel, erHeadLabel, erLayout } from '@features/query/er-layout';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 1 段落を足す。⚠ 字が空なら**足さない**(空の行で場所を取らない)。 */
function line(host: HTMLElement, field: string, text: string): void {
  if (text === '') return;
  const p = host.ownerDocument.createElement('p');
  p.setAttribute('data-pkc-field', field);
  p.textContent = text;
  host.append(p);
}

/**
 * 図を描き直す。⚠ **呼ぶ側が「変わったときだけ」呼ぶ**(ここでは判定しない)。
 *
 * ⚠ 閉じているときは**何も組まない** ── 畳んだ図の DOM を持ち続けると、
 *   表が何百件ある DB で常駐が無駄に増える(2026-07-27 の不可侵指示と同じ向き)。
 */
export function paintSqlEr(host: HTMLElement, er: SqlPageState['er']): void {
  const doc = host.ownerDocument;
  host.replaceChildren();
  host.hidden = !er.open;
  if (!er.open) return;

  if (er.loading) {
    line(host, 'sql-er-note', '構造を採っています…');
    return;
  }
  if (er.model === null) {
    // ⚠ 採れなかった回に**空の図**を出さない(理由を字で言う)
    line(host, 'sql-er-note', er.note === '' ? '構造を採れませんでした' : er.note);
    return;
  }

  const d = erLayout(er.model);
  if (d.boxes.length === 0) {
    line(host, 'sql-er-note', '表もビューも 1 つもありません。');
    return;
  }

  const scroll = doc.createElement('div');
  scroll.setAttribute('data-pkc-field', 'sql-er-scroll');
  const canvas = doc.createElement('div');
  canvas.setAttribute('data-pkc-field', 'sql-er-canvas');
  canvas.style.width = `${String(d.width)}px`;
  canvas.style.height = `${String(d.height)}px`;

  /**
   * 🔴 **線は 1 枚の `<svg>` にまとめる**(線ごとに作らない ── 重ねると当たり判定が塞がる)。
   * ⚠ 押しは通す(`pointer-events: none` は CSS 側)── 当てないと四角を押せない。
   */
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('data-pkc-field', 'sql-er-lines');
  svg.setAttribute('width', String(d.width));
  svg.setAttribute('height', String(d.height));
  svg.setAttribute('aria-hidden', 'true');
  for (const { line: l } of d.lines) {
    const el = doc.createElementNS(SVG_NS, 'line');
    el.setAttribute('x1', String(l.x1));
    el.setAttribute('y1', String(l.y1));
    el.setAttribute('x2', String(l.x2));
    el.setAttribute('y2', String(l.y2));
    svg.append(el);
  }
  canvas.append(svg);

  for (const box of d.boxes) {
    const el = doc.createElement('div');
    el.setAttribute('data-pkc-field', 'sql-er-box');
    el.style.left = `${String(box.rect.x)}px`;
    el.style.top = `${String(box.rect.y)}px`;
    el.style.width = `${String(box.rect.w)}px`;

    const head = doc.createElement('button');
    head.type = 'button';
    head.setAttribute('data-pkc-action', 'sql-er-table');
    head.setAttribute('data-pkc-field', 'sql-er-table');
    head.setAttribute('data-pkc-name', box.table.name);
    head.textContent = erHeadLabel(box.table);
    head.title = `「${box.table.name}」から取り出します`;
    el.append(head);

    for (const c of box.columns) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('data-pkc-action', 'sql-er-column');
      b.setAttribute('data-pkc-field', 'sql-er-column');
      b.setAttribute('data-pkc-name', box.table.name);
      b.setAttribute('data-pkc-col', c.name);
      b.textContent = erColumnLabel(c);
      b.title = `「${c.name}」を取り出す列に足します`;
      el.append(b);
    }
    if (box.hidden > 0) {
      // ⚠ 畳んだことを**言う**(黙って隠すと「この表には 8 列しかない」と読まれる)
      const more = doc.createElement('span');
      more.setAttribute('data-pkc-field', 'sql-er-more');
      more.textContent = `ほか ${String(box.hidden)} 列(表の名前を押すと全部取れます)`;
      el.append(more);
    }
    canvas.append(el);
  }

  for (const { link: k, line: l } of d.lines) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.setAttribute('data-pkc-action', 'sql-er-link');
    chip.setAttribute('data-pkc-field', 'sql-er-link');
    chip.setAttribute('data-pkc-from', k.from);
    chip.setAttribute('data-pkc-fromcol', k.fromColumn);
    chip.setAttribute('data-pkc-to', k.to);
    chip.setAttribute('data-pkc-tocol', k.toColumn);
    chip.style.left = `${String((l.x1 + l.x2) / 2)}px`;
    chip.style.top = `${String((l.y1 + l.y2) / 2)}px`;
    chip.textContent = `${k.from}.${k.fromColumn} → ${k.to}.${k.toColumn}`;
    chip.title = `「${k.from}」と「${k.to}」を繋ぎます`;
    canvas.append(chip);
  }

  scroll.append(canvas);
  host.append(scroll);
  // 🔑 押した結果(足した / 足せなかった理由)は**図の外**に置く ── 図を転がしても見える
  line(host, 'sql-er-note', er.note);
  if (d.dropped.length > 0) {
    line(
      host,
      'sql-er-dropped',
      `線にできなかった繋がり: ${d.dropped.map((x) => x.why).join(' / ')}`,
    );
  }
}
