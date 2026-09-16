/**
 * 🔴 **表のつながり図(ER)を描く**(#918 段⑤b/⑤c/⑤d-1)。
 *
 * > user 要望 2026-09-14:「**er でグラフィカルに取得する方法も欲しいな**」
 * > 置き場の裁定 2026-09-15:**SQL の窓の中に、畳める欄として出す**
 * > user 報告 2026-09-16:「**er のキー同士の掛け合わせとかちゃんと描きたいのに
 * > できないんだが**」── 線は宣言された外部キーからしか作られず、csv 取込や
 * > 外部キー無しの `.sqlite` では線が必ず 0 本だった(段⑤d-1 で「繋ぐ」を足す)。
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
 *
 * ## 🔴 「繋ぐ」モード(#918 段⑤d-1)
 *
 * ⚠ 「繋ぐ」が入のとき、列を押す意味が変わる ── `sql-er-column` の**受け手**
 *   (`binder.ts`)が `er.connecting` を見て `SQL_ER_PICK` へ回す。ここでは
 *   **見た目だけ**を変える(押し所の名前は変えない ── データ属性は同じまま)。
 * 🔑 案内の字(「繋ぎたい列を 2 つ押してください」等)は**state に置かない**。
 *   `connecting` / `pendingFrom` から**その場で**組む ── 保存すべきは
 *   「どこから繋いでいるか」だけで、字はいつでも導ける。
 */

import type { SqlPageState } from '@adapter/state/app-state';
import { erZeroLinesWhy } from '@features/query/er-connect';
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
 * 🔴 **「繋ぐ」モードの案内文**(#918 段⑤d-1)。⚠ **state には置かない** ──
 *   `connecting` / `pendingFrom` から毎回組み直せるので、控える理由が無い。
 */
function connectHintOf(er: SqlPageState['er']): string {
  if (!er.connecting) return '';
  if (er.pendingFrom === null) return '繋ぎたい列を 2 つ押してください';
  return `「${er.pendingFrom.table}.${er.pendingFrom.column}」から繋ぎます。相手の列を押してください`;
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

  const d = erLayout(er.model, er.mine);
  if (d.boxes.length === 0) {
    line(host, 'sql-er-note', '表もビューも 1 つもありません。');
    return;
  }

  /**
   * 🔴 **「繋ぐ」の帯**(#918 段⑤d-1)。⚠ **図の帯**に置く ── 図が無いのに
   *   出しても押す意味が無い(だから上の「表もビューも無い」より後)。
   */
  const connectBtn = doc.createElement('button');
  connectBtn.type = 'button';
  connectBtn.setAttribute('data-pkc-action', 'sql-er-connect-toggle');
  connectBtn.setAttribute('data-pkc-field', 'sql-er-connect');
  connectBtn.setAttribute('aria-pressed', er.connecting ? 'true' : 'false');
  connectBtn.textContent = '繋ぐ';
  connectBtn.title = er.connecting
    ? '繋ぐのをやめます(いつもどおり、押した列が取り出す列に足されます)'
    : '列どうしを自分で繋ぎます(外部キーが宣言されていない表でも繋げます)';
  host.append(connectBtn);

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
  for (const { line: l, mine } of d.lines) {
    const el = doc.createElementNS(SVG_NS, 'line');
    el.setAttribute('x1', String(l.x1));
    el.setAttribute('y1', String(l.y1));
    el.setAttribute('x2', String(l.x2));
    el.setAttribute('y2', String(l.y2));
    // 🔑 見分けは色だけに頼らない(CSS 側は破線にする)。#918 段⑤d-1
    el.setAttribute('data-pkc-mine', mine ? 'true' : 'false');
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
      /**
       * 🔴 **「繋ぐ」モード中は、押す意味が変わる**(#918 段⑤d-1)。
       * ⚠ 押し所の名前(`data-pkc-action`)は変えない ── 変えるのは `binder.ts` の
       *   受け手の中身だけ(`er.connecting` を見て振り分ける)。ここは**見た目だけ**。
       */
      if (er.connecting) {
        const isFrom = er.pendingFrom?.table === box.table.name && er.pendingFrom.column === c.name;
        b.setAttribute('aria-pressed', isFrom ? 'true' : 'false');
        b.title = isFrom
          ? 'ここから繋ぐのをやめます'
          : er.pendingFrom === null
            ? 'ここから繋ぎます'
            : 'ここへ繋ぎます';
      } else {
        b.title = `「${c.name}」を取り出す列に足します`;
      }
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

  for (const { link: k, line: l, mine } of d.lines) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.setAttribute('data-pkc-field', 'sql-er-link');
    // 🔑 見分けは色だけに頼らない(下でバッジの字も足す)。#918 段⑤d-1
    chip.setAttribute('data-pkc-mine', mine ? 'true' : 'false');
    chip.setAttribute('data-pkc-from', k.from);
    chip.setAttribute('data-pkc-fromcol', k.fromColumn);
    chip.setAttribute('data-pkc-to', k.to);
    chip.setAttribute('data-pkc-tocol', k.toColumn);
    chip.style.left = `${String((l.x1 + l.x2) / 2)}px`;
    chip.style.top = `${String((l.y1 + l.y2) / 2)}px`;
    if (mine) {
      /**
       * 🔴 **自分で引いた線は消せる**(#918 段⑤d-1)。⚠ **片道の操作を作らない** ──
       *   宣言された外部キー(下の else)はこちらが作った物ではないので、
       *   消す口をそもそも出さない。
       */
      chip.setAttribute('data-pkc-action', 'sql-er-unlink');
      const badge = doc.createElement('span');
      badge.setAttribute('data-pkc-field', 'sql-er-mine-badge');
      badge.textContent = '自分';
      chip.append(badge, doc.createTextNode(`${k.from}.${k.fromColumn} → ${k.to}.${k.toColumn}`));
      chip.title = `「${k.from}」と「${k.to}」の繋がりを消します`;
    } else {
      chip.setAttribute('data-pkc-action', 'sql-er-link');
      chip.textContent = `${k.from}.${k.fromColumn} → ${k.to}.${k.toColumn}`;
      chip.title = `「${k.from}」と「${k.to}」を繋ぎます`;
    }
    canvas.append(chip);
  }

  scroll.append(canvas);
  host.append(scroll);
  /**
   * 🔴 **線が 1 本も無いなら、理由と次の一手を言う**(#918 段⑤d-3)。
   * ⚠ **図のすぐ下**に置く ── 「繋ぐ」の案内より先に読ませたい
   *   (なぜ 0 本なのかが分からないまま案内だけ読んでも、何も繋がらない)。
   */
  if (d.lines.length === 0) {
    line(
      host,
      'sql-er-zero',
      erZeroLinesWhy({
        boxes: d.boxes.length,
        declared: er.model.links.length,
        mine: er.mine.length,
        dropped: d.dropped.length,
        connecting: er.connecting,
      }),
    );
  }
  // 🔴 「繋ぐ」の案内(#918 段⑤d-1)。⚠ **図の下**(user 指定の言葉どおり)。
  line(host, 'sql-er-connect-hint', connectHintOf(er));
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
