/**
 * 🔴 **すぐ試せる HTML ツールのテンプレート**(v4.0 Phase 2 / PR-08、ビジョン 5-B)。
 *
 * 書式バー「その他 ▾ → HTML ツール」の一覧の中身(並び順もここが正本)。どれも
 * - **外部 CDN ゼロ**(`<script src>` / `<link>` / 外部の画像を持たない ── 箱の CSP でも塞がるが、そもそも書かない)
 * - **テーマに連動**(色・角丸・字体は `var(--pkc-*, 既定値)` だけで書く ── 親の配色の切替に追従する)
 * - **`id=` 付き**(状態を `localStorage` 互換の保存に残す。「ノートへ保存」で本文にも書き残せる)
 *
 * ⚠ 本文へ入るのは**ただの ` ```html id="…" ` の囲み**。入れた後は user の物 ── 自由に書き換えてよい。
 * 🔑 id は {@link nextWidgetId} で採番する(同じノートに 2 つ入れても保存が混ざらない)。
 */
import { allFences, fenceInfo, splitLines } from './source-blocks';
import { WIDGET_ID_RE } from './widget-bridge';
import { widgetFenceId, widgetStateBlockId } from './widget-state-block';

export type WidgetTemplateBaseId = 'tracker' | 'checklist' | 'calculator' | 'table-summary' | 'table-filter' | 'pomodoro';

export interface WidgetTemplate {
  readonly baseId: WidgetTemplateBaseId;
  /** 一覧の字(短い名前。12 字以内)。 */
  readonly label: string;
  /** 一覧の補足(何ができるかを 1 句で。22 字以内)。行の右に控えめに出す。 */
  readonly hint: string;
  /** 囲みの中身(HTML)。 */
  readonly html: string;
}

/** 共通の見た目(テーマの変数だけで書く)。 */
const BASE_CSS = `<style>
.pkc-tool{display:flex;flex-direction:column;gap:.5rem;font-size:.95rem}
.pkc-tool .row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.pkc-tool button{font:inherit;color:var(--pkc-fg,#222);background:var(--pkc-surface-2,#f1f1f1);border:1px solid var(--pkc-border,#ccc);border-radius:var(--pkc-radius,6px);padding:.2rem .7rem;cursor:pointer}
.pkc-tool button:hover{border-color:var(--pkc-accent,#2563eb)}
.pkc-tool input{font:inherit;color:var(--pkc-fg,#222);background:var(--pkc-surface,#fff);border:1px solid var(--pkc-border,#ccc);border-radius:var(--pkc-radius,6px);padding:.2rem .4rem}
.pkc-tool .muted{color:var(--pkc-muted,#666);font-size:.85rem}
.pkc-tool .bar{height:.6rem;background:var(--pkc-surface-2,#eee);border-radius:var(--pkc-radius,6px);overflow:hidden}
.pkc-tool .fill{height:100%;width:0;background:var(--pkc-accent,#2563eb);transition:width .2s}
.pkc-tool table{border-collapse:collapse}
.pkc-tool td,.pkc-tool th{border:1px solid var(--pkc-hairline,#ddd);padding:.15rem .5rem;text-align:right}
.pkc-tool th{text-align:left;font-weight:600}
</style>`;

const TRACKER_HTML = `<div class="pkc-tool" id="tool">
  <div class="row"><strong>進捗</strong><span id="pct" class="muted"></span></div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <div class="row">
    <button type="button" id="dec" aria-label="1 減らす">−</button>
    <output id="val">0</output>
    <button type="button" id="inc" aria-label="1 増やす">＋</button>
    <label class="muted">目標 <input type="number" id="goal" min="1" step="1" style="width:5rem"></label>
  </div>
</div>
${BASE_CSS}
<script>
(function () {
  var S = window.localStorage;
  var val = Number(S.getItem('value') || '0') || 0;
  var goal = Number(S.getItem('goal') || '10') || 10;
  var $ = function (id) { return document.getElementById(id); };
  function draw() {
    $('val').textContent = String(val);
    $('goal').value = String(goal);
    var p = goal > 0 ? Math.max(0, Math.min(100, Math.round(val / goal * 100))) : 0;
    $('pct').textContent = val + ' / ' + goal + '(' + p + '%)';
    $('fill').style.width = p + '%';
  }
  function save() { S.setItem('value', String(val)); S.setItem('goal', String(goal)); draw(); }
  $('inc').addEventListener('click', function () { val += 1; save(); });
  $('dec').addEventListener('click', function () { val = Math.max(0, val - 1); save(); });
  $('goal').addEventListener('change', function () { var g = Number($('goal').value); if (g > 0) goal = g; save(); });
  draw();
})();
</script>`;

const CHECKLIST_HTML = `<div class="pkc-tool" id="tool">
  <div class="row"><strong>チェックリスト</strong><span id="rate" class="muted"></span></div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <ul id="list" style="list-style:none;padding:0;margin:0"></ul>
  <div class="row">
    <input type="text" id="text" placeholder="項目を入力" style="flex:1">
    <button type="button" id="add">追加</button>
  </div>
</div>
${BASE_CSS}
<script>
(function () {
  var S = window.localStorage;
  var items = [];
  try { items = JSON.parse(S.getItem('items') || '[]') || []; } catch (e) { items = []; }
  var $ = function (id) { return document.getElementById(id); };
  function save() { S.setItem('items', JSON.stringify(items)); draw(); }
  function draw() {
    var list = $('list');
    list.textContent = '';
    items.forEach(function (it, i) {
      var li = document.createElement('li');
      li.className = 'row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!it.done;
      cb.addEventListener('change', function () { items[i].done = cb.checked; save(); });
      var label = document.createElement('span');
      label.textContent = it.text;
      if (it.done) label.style.textDecoration = 'line-through';
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = '削除';
      del.addEventListener('click', function () { items.splice(i, 1); save(); });
      li.append(cb, label, del);
      list.append(li);
    });
    var done = items.filter(function (it) { return it.done; }).length;
    var p = items.length > 0 ? Math.round(done / items.length * 100) : 0;
    $('rate').textContent = done + ' / ' + items.length + ' 完了(' + p + '%)';
    $('fill').style.width = p + '%';
  }
  // ⚠ フォームの送信は使わない(箱は allow-forms を持たないので、送信の合図そのものが来ない)
  function add() {
    var t = $('text').value.trim();
    if (t === '') return;
    items.push({ text: t, done: false });
    $('text').value = '';
    save();
  }
  $('add').addEventListener('click', add);
  $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) add(); });
  draw();
})();
</script>`;

const CALCULATOR_HTML = `<div class="pkc-tool" id="tool">
  <strong>試算</strong>
  <div class="row">
    <label>単価 <input type="number" id="price" min="0" step="1" style="width:7rem"></label>
    <label>数量 <input type="number" id="qty" min="0" step="1" style="width:5rem"></label>
    <label>税率(%) <input type="number" id="tax" min="0" step="0.1" style="width:5rem"></label>
    <label>人数 <input type="number" id="people" min="1" step="1" style="width:4rem"></label>
  </div>
  <table>
    <tr><th>小計</th><td id="sub"></td></tr>
    <tr><th>税額</th><td id="taxv"></td></tr>
    <tr><th>合計</th><td id="total"></td></tr>
    <tr><th>1 人あたり</th><td id="each"></td></tr>
  </table>
</div>
${BASE_CSS}
<script>
(function () {
  var S = window.localStorage;
  var keys = { price: '1000', qty: '1', tax: '10', people: '1' };
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return isFinite(n) ? Math.round(n).toLocaleString('ja-JP') : '-'; };
  function calc() {
    var price = Number($('price').value) || 0;
    var qty = Number($('qty').value) || 0;
    var tax = Number($('tax').value) || 0;
    var people = Math.max(1, Number($('people').value) || 1);
    var sub = price * qty;
    var t = sub * tax / 100;
    $('sub').textContent = fmt(sub);
    $('taxv').textContent = fmt(t);
    $('total').textContent = fmt(sub + t);
    $('each').textContent = fmt((sub + t) / people);
  }
  Object.keys(keys).forEach(function (k) {
    var el = $(k);
    el.value = S.getItem(k) || keys[k];
    el.addEventListener('input', function () { S.setItem(k, el.value); calc(); });
  });
  calc();
})();
</script>`;

const TABLE_SUMMARY_HTML = `<div class="pkc-tool" id="tool">
  <div class="row"><strong>このノートの表</strong><button type="button" id="reload">再読み込み</button></div>
  <div id="out" class="muted">読み込み中…</div>
</div>
${BASE_CSS}
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function num(s) {
    var t = String(s).replace(/[,，\\s¥￥$%円]/g, '');
    if (t === '' || !/^[-+]?\\d*\\.?\\d+(e[-+]?\\d+)?$/i.test(t)) return null;
    return Number(t);
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('ja-JP'); }
  function draw(tables) {
    var out = $('out');
    out.textContent = '';
    if (!tables || tables.length === 0) {
      out.textContent = 'このノートに表がありません。Markdown の表か csv / tsv / psv のコードブロックを書くと、行数と数値の列の合計・平均を表示します';
      return;
    }
    tables.forEach(function (t) {
      var box = document.createElement('div');
      box.setAttribute('data-table-index', String(t.index));
      var title = document.createElement('div');
      title.textContent = '表 ' + (t.index + 1) + '(' + t.kind + '):' + t.rows.length + ' 行' + (t.truncated ? '(一部のみ)' : '');
      box.append(title);
      var cols = t.headers.length > 0 ? t.headers.length : (t.rows[0] ? t.rows[0].length : 0);
      var tbl = document.createElement('table');
      var any = false;
      for (var c = 0; c < cols; c++) {
        var sum = 0, n = 0, bad = false;
        for (var r = 0; r < t.rows.length; r++) {
          var cell = t.rows[r][c];
          if (cell === undefined || String(cell).trim() === '') continue;
          var v = num(cell);
          if (v === null) { bad = true; break; }
          sum += v; n++;
        }
        if (bad || n === 0) continue;
        any = true;
        var tr = document.createElement('tr');
        var th = document.createElement('th');
        th.textContent = t.headers[c] || ('列 ' + (c + 1));
        var td1 = document.createElement('td');
        td1.textContent = '合計 ' + fmt(sum);
        td1.setAttribute('data-sum', String(sum));
        var td2 = document.createElement('td');
        td2.textContent = '平均 ' + fmt(sum / n);
        tr.append(th, td1, td2);
        tbl.append(tr);
      }
      if (any) box.append(tbl);
      out.append(box);
    });
  }
  function load() {
    if (!window.pkcWidget || typeof window.pkcWidget.readTables !== 'function') { draw([]); return; }
    window.pkcWidget.readTables().then(draw, function () { draw([]); });
  }
  $('reload').addEventListener('click', load);
  load();
})();
</script>`;

/**
 * 🔴 **表の検索・絞り込み**(v4.0 仕上げ PR-D)── 同じノートの表を `readTables()` で読み、キーワードで行を絞る。
 * ⚠ 絞り込みは表示だけ(本文の表は書き換えない)。打った語と選んだ表は `localStorage` に残す。
 */
const TABLE_FILTER_HTML = `<div class="pkc-tool" id="tool">
  <div class="row">
    <strong>表の検索</strong>
    <select id="pick" aria-label="表を選ぶ"></select>
    <button type="button" id="reload">再読み込み</button>
  </div>
  <div class="row">
    <input type="search" id="q" placeholder="キーワード(空白で区切ると全部を含む行)" style="flex:1">
    <span id="count" class="muted"></span>
  </div>
  <div id="out" class="muted">読み込み中…</div>
</div>
${BASE_CSS}
<style>
.pkc-tool select{font:inherit;color:var(--pkc-fg,#222);background:var(--pkc-surface,#fff);border:1px solid var(--pkc-border,#ccc);border-radius:var(--pkc-radius,6px);padding:.2rem .4rem}
.pkc-tool #out table td{text-align:left}
.pkc-tool mark{background:var(--pkc-surface-2,#eee);color:var(--pkc-fg,#222);box-shadow:inset 0 -2px 0 var(--pkc-accent,#2563eb);border-radius:2px}
</style>
<script>
(function () {
  var S = window.localStorage;
  var $ = function (id) { return document.getElementById(id); };
  var tables = [];
  var pick = Number(S.getItem('table') || '0') || 0;
  $('q').value = S.getItem('query') || '';
  function words() {
    return $('q').value.toLowerCase().split(/\\s+/).filter(function (w) { return w !== ''; });
  }
  function cellNode(text, ws) {
    var td = document.createElement('td');
    var s = String(text);
    var low = s.toLowerCase();
    var hit = -1, len = 0;
    for (var i = 0; i < ws.length; i++) { var at = low.indexOf(ws[i]); if (at >= 0 && (hit < 0 || at < hit)) { hit = at; len = ws[i].length; } }
    if (hit < 0) { td.textContent = s; return td; }
    var m = document.createElement('mark');
    m.textContent = s.slice(hit, hit + len);
    td.append(s.slice(0, hit), m, s.slice(hit + len));
    return td;
  }
  function draw() {
    var out = $('out');
    out.textContent = '';
    var sel = $('pick');
    sel.textContent = '';
    if (tables.length === 0) {
      $('count').textContent = '';
      out.textContent = 'このノートに表がありません。Markdown の表か csv / tsv / psv のコードブロックを書くと、ここで絞り込めます';
      return;
    }
    if (pick >= tables.length) pick = 0;
    tables.forEach(function (t, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = '表 ' + (t.index + 1) + '(' + t.rows.length + ' 行)';
      sel.append(o);
    });
    sel.value = String(pick);
    var t = tables[pick];
    var ws = words();
    var rows = t.rows.filter(function (r) {
      var line = r.join(' ').toLowerCase();
      return ws.every(function (w) { return line.indexOf(w) >= 0; });
    });
    $('count').textContent = rows.length + ' / ' + t.rows.length + ' 行';
    var tbl = document.createElement('table');
    if (t.headers.length > 0) {
      var hr = document.createElement('tr');
      t.headers.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; hr.append(th); });
      tbl.append(hr);
    }
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      r.forEach(function (c) { tr.append(cellNode(c, ws)); });
      tbl.append(tr);
    });
    out.append(tbl);
    if (rows.length === 0) {
      var none = document.createElement('div');
      none.textContent = '当てはまる行がありません';
      out.append(none);
    }
  }
  function load() {
    if (!window.pkcWidget || typeof window.pkcWidget.readTables !== 'function') { tables = []; draw(); return; }
    window.pkcWidget.readTables().then(function (ts) { tables = ts || []; draw(); }, function () { tables = []; draw(); });
  }
  $('q').addEventListener('input', function () { S.setItem('query', $('q').value); draw(); });
  $('pick').addEventListener('change', function () { pick = Number($('pick').value) || 0; S.setItem('table', String(pick)); draw(); });
  $('reload').addEventListener('click', load);
  load();
})();
</script>`;

/**
 * 🔴 **作業タイマー**(v4.0 仕上げ PR-D)── 25 分作業 / 5 分休憩。完了した作業の回数を `localStorage` に残す。
 * ⚠ 止めている間は `setInterval` を必ず解く(定常のコスト 0)。残り時間は終わる時刻から毎回計算する(タブが裏で間引かれてもずれない)。
 */
const POMODORO_HTML = `<div class="pkc-tool" id="tool">
  <div class="row"><strong id="mode">作業</strong><span id="sets" class="muted"></span></div>
  <div class="row"><output id="clock" style="font-size:2rem;font-variant-numeric:tabular-nums">25:00</output></div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <div class="row">
    <button type="button" id="start">開始</button>
    <button type="button" id="reset">リセット</button>
    <button type="button" id="switch">作業と休憩を切り替え</button>
  </div>
  <div class="row">
    <label class="muted">作業(分) <input type="number" id="work" min="1" max="120" step="1" style="width:4rem"></label>
    <label class="muted">休憩(分) <input type="number" id="rest" min="1" max="60" step="1" style="width:4rem"></label>
    <button type="button" id="clear">回数を 0 に戻す</button>
  </div>
</div>
${BASE_CSS}
<script>
(function () {
  var S = window.localStorage;
  var $ = function (id) { return document.getElementById(id); };
  var work = Number(S.getItem('work') || '25') || 25;
  var rest = Number(S.getItem('rest') || '5') || 5;
  var sets = Number(S.getItem('sets') || '0') || 0;
  var mode = S.getItem('mode') === 'rest' ? 'rest' : 'work';
  var timer = null;
  var endAt = 0;
  var left = total();
  function total() { return (mode === 'work' ? work : rest) * 60000; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function draw() {
    var sec = Math.max(0, Math.ceil(left / 1000));
    $('clock').textContent = pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
    $('mode').textContent = mode === 'work' ? '作業' : '休憩';
    $('sets').textContent = '完了 ' + sets + ' 回';
    $('start').textContent = timer === null ? '開始' : '一時停止';
    var all = total();
    $('fill').style.width = (all > 0 ? Math.round((1 - left / all) * 100) : 0) + '%';
    $('work').value = String(work);
    $('rest').value = String(rest);
  }
  function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }
  function tick() {
    left = Math.max(0, endAt - Date.now());
    if (left === 0) {
      stop();
      if (mode === 'work') { sets += 1; S.setItem('sets', String(sets)); }
      mode = mode === 'work' ? 'rest' : 'work';
      S.setItem('mode', mode);
      left = total();
    }
    draw();
  }
  $('start').addEventListener('click', function () {
    if (timer !== null) { tick(); stop(); draw(); return; }
    endAt = Date.now() + left;
    timer = setInterval(tick, 250);
    draw();
  });
  $('reset').addEventListener('click', function () { stop(); left = total(); draw(); });
  $('switch').addEventListener('click', function () { stop(); mode = mode === 'work' ? 'rest' : 'work'; S.setItem('mode', mode); left = total(); draw(); });
  $('clear').addEventListener('click', function () { sets = 0; S.setItem('sets', '0'); draw(); });
  $('work').addEventListener('change', function () { var v = Number($('work').value); if (v >= 1) { work = v; S.setItem('work', String(v)); if (timer === null && mode === 'work') left = total(); } draw(); });
  $('rest').addEventListener('change', function () { var v = Number($('rest').value); if (v >= 1) { rest = v; S.setItem('rest', String(v)); if (timer === null && mode === 'rest') left = total(); } draw(); });
  draw();
})();
</script>`;

/** 一覧(並び順の正本)。 */
export const WIDGET_TEMPLATES: readonly WidgetTemplate[] = [
  {
    baseId: 'tracker',
    label: '進捗カウンター',
    hint: '増減と目標達成バー',
    html: TRACKER_HTML,
  },
  {
    baseId: 'checklist',
    label: 'チェックリスト',
    hint: '項目の追加と完了率',
    html: CHECKLIST_HTML,
  },
  {
    baseId: 'calculator',
    label: '簡易電卓',
    hint: '単価・数量・税率・人数計算',
    html: CALCULATOR_HTML,
  },
  {
    baseId: 'table-summary',
    label: '表の集計',
    hint: 'ノートの表の行数・合計・平均',
    html: TABLE_SUMMARY_HTML,
  },
  {
    baseId: 'table-filter',
    label: '表の絞り込み',
    hint: 'ノートの表をキーワード検索',
    html: TABLE_FILTER_HTML,
  },
  {
    baseId: 'pomodoro',
    label: '作業タイマー',
    hint: '25 分作業 / 5 分休憩の計測',
    html: POMODORO_HTML,
  },
];

/** 本文の中で使われているウィジェットの id(本体の囲みと、状態ブロックの両方)。 */
export function usedWidgetIds(body: string): ReadonlySet<string> {
  const out = new Set<string>();
  const lines = splitLines(body);
  for (const span of allFences(body)) {
    const raw = lines[span.start] ?? '';
    const info = fenceInfo(raw.replace(/^(\s*>\s?)+/, ''));
    const a = widgetFenceId(info);
    if (a !== null) out.add(a);
    const b = widgetStateBlockId(info);
    if (b !== null) out.add(b);
  }
  return out;
}

/**
 * 🔴 **同じノートで使われていない id を採る**(`tracker` → `tracker-2` → `tracker-3` …)。
 * ⚠ 本体の囲みと状態ブロックの両方を見る(消した本体の状態ブロックが残っていても、別のツールに拾わせない)。
 */
export function nextWidgetId(body: string, baseId: string): string {
  const used = usedWidgetIds(body);
  if (!used.has(baseId) && WIDGET_ID_RE.test(baseId)) return baseId;
  for (let n = 2; n < 10000; n += 1) {
    const id = `${baseId}-${String(n)}`;
    if (!used.has(id)) return id;
  }
  return `${baseId}-${String(Date.now())}`;
}

/** 本文へ入れる字(` ```html id="…" ` の囲み一式。末尾は改行)。 */
export function widgetTemplateBlock(tpl: WidgetTemplate, widgetId: string): string {
  return '```html id="' + widgetId + '"\n' + tpl.html + '\n```\n';
}
