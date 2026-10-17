/**
 * ページの編集(並べ替え・回す・外す)の**計画**(#275 段②-1b)── 画面の操作を「作り方」に直す純粋な判断。
 *
 * 画面(`reader.js`)は 1 ページごとに `{ page, rot }` を持つ並びを握る。`page` は**元の PDF の何ページ目か**、
 * `rot` は**そのページを右へ何度回したか**(0 / 90 / 180 / 270)。ここは並びを作り替える関数と、
 * worker へ渡す依頼(`{ order, rotate }`)への変換だけで、DOM にも pdf-lib にも触らない
 * (取り出して test できる形にしてある)。
 *
 * 🔑 worker へ渡すのは**ページ番号の並びと回す角度だけ**(設計 doc §3.1)。bytes は別に transfer する。
 * ⚠ 並びは**書き換えない**(毎回新しい配列を返す)── 画面は返った並びを丸ごと取り替える。
 * ⚠ 素の JS(classic script)で書く ── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-page-edit.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /** 元のとおりの並び(1 ページ目から `total` ページ目まで、回していない)。 */
  function fresh(total) {
    var out = [];
    for (var i = 1; i <= total; i += 1) out.push({ page: i, rot: 0 });
    return out;
  }

  /** `at` 番目(0 始まり)を右へ 90° 回す。範囲の外なら同じ並びを返す。回すたびに足し、360° で 0 に戻る。 */
  function rotateAt(items, at) {
    if (!(at >= 0 && at < items.length)) return items.slice();
    return items.map(function (it, i) {
      return i === at ? { page: it.page, rot: (it.rot + 90) % 360 } : it;
    });
  }

  /** `at` 番目を外す。範囲の外なら同じ並びを返す。 */
  function removeAt(items, at) {
    if (!(at >= 0 && at < items.length)) return items.slice();
    return items.filter(function (_, i) {
      return i !== at;
    });
  }

  /**
   * 外したページ `page` を戻す(#1663)。元の並びで一つ前にあたるページ(番号が小さいほうで、いまの並びに残っている
   * いちばん大きい番号)の後ろへ入れる。どれも残っていなければ先頭。向きは戻した後は回していない状態。
   * 既に並びにあるなら同じ並びを返す。
   */
  function restorePage(items, page) {
    var has = items.some(function (it) {
      return it.page === page;
    });
    if (has) return items.slice();
    var at = -1;
    var best = 0;
    items.forEach(function (it, i) {
      if (it.page < page && it.page > best) {
        best = it.page;
        at = i;
      }
    });
    var out = items.slice();
    out.splice(at + 1, 0, { page: page, rot: 0 });
    return out;
  }

  /**
   * 外してあるページ(通し番号の昇順)。`live(page)` が偽のページ(足したのを取り消した PDF のページなど、
   * 戻せない物)は数えない。
   */
  function removedPages(items, grand, live) {
    var here = {};
    items.forEach(function (it) {
      here[it.page] = true;
    });
    var out = [];
    for (var p = 1; p <= grand; p += 1) {
      if (here[p]) continue;
      if (typeof live === 'function' && !live(p)) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * 一覧の絵の下の番号の字(#1663)。並べ替えてあって元のページ番号と違うときは「1(元の 5)」と、
   * 新しい位置と元の番号の両方を言う(中央のページと上の「5 / 12」は元の番号のままなので、突き合わせられる)。
   * 足したページ(`page` > `total`)は元の番号を言わない(通し番号は画面の番号ではない)。
   */
  function thumbNoText(page, pos, total) {
    if (page === pos || page > total) return String(pos);
    return String(pos) + '(元の ' + String(page) + ')';
  }

  /**
   * `from` 番目を取り出して、**取り出した後の並びの** `to` 番目へ入れる(ドラッグでもキーでも、これ 1 本)。
   * 範囲の外は端に丸める。動かないなら同じ並びを返す。
   */
  function moveTo(items, from, to) {
    if (!(from >= 0 && from < items.length)) return items.slice();
    var dest = Math.max(0, Math.min(items.length - 1, to));
    if (dest === from) return items.slice();
    var out = items.slice();
    var one = out.splice(from, 1)[0];
    out.splice(dest, 0, one);
    return out;
  }

  /** 元のままか(同じページが同じ順で、回していない)。 */
  function isChanged(items, total) {
    if (items.length !== total) return true;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].page !== i + 1 || items[i].rot !== 0) return true;
    }
    return false;
  }

  /**
   * worker へ渡す依頼。`order` = 残すページ(元の番号)を出力の順に / `rotate` = 回すページ(元の番号)→ 右へ回す角度。
   * 回していないページは `rotate` に載せない。
   */
  function toJob(items) {
    var order = [];
    var rotate = {};
    items.forEach(function (it) {
      order.push(it.page);
      if (it.rot !== 0) rotate[it.page] = it.rot;
    });
    return { order: order, rotate: rotate };
  }

  // ───────── 別の PDF を足す(#275 結合)
  //
  // 足した PDF のページには**通し番号**を付ける: 元の PDF が 1〜total、足した 1 つ目がその次から、2 つ目がさらにその次から。
  // 並べ替え・回す・外す・選ぶは、通し番号の `page` でそのまま動く(どの PDF のページかは `edit-core.js` の `sources` が引く)。

  /** 足したページ(通し番号 `first` から `count` 枚、回していない)を並びの最後に付けた新しい並び。 */
  function appendPages(items, first, count) {
    var out = items.slice();
    for (var i = 0; i < count; i += 1) out.push({ page: first + i, rot: 0 });
    return out;
  }

  /**
   * 依頼に付ける `sources` と、実際に送る足した PDF。足した PDF の一覧 `added`(`{ first, count }` の並び)のうち、
   * `list` にページが 1 枚でも残っている物だけ ── 使わない PDF の bytes は worker へ渡さない。
   * @returns {{ sources: {first:number,count:number}[], used: number[] }}  `used` = `added` の何番目か
   */
  function sourcesFor(list, added) {
    var sources = [];
    var used = [];
    added.forEach(function (a, k) {
      var hit = list.some(function (it) {
        return it.page >= a.first && it.page < a.first + a.count;
      });
      if (!hit) return;
      sources.push({ first: a.first, count: a.count });
      used.push(k);
    });
    return { sources: sources, used: used };
  }

  /**
   * 足した PDF `added[k]` のページを、並びから**全部**外す(別の場所へ動かしたページも)。`added` からも `k` 番目を落とす
   * (使わない PDF の bytes は worker へ渡さない)。範囲の外の `k` なら、どちらも同じ内容の写しを返す。
   * @returns {{ items: {page:number,rot:number}[], added: {first:number,count:number}[] }}
   */
  function removeSource(items, added, k) {
    if (!(k >= 0 && k < added.length)) return { items: items.slice(), added: added.slice() };
    var a = added[k];
    return {
      items: items.filter(function (it) {
        return !(it.page >= a.first && it.page < a.first + a.count);
      }),
      added: added.filter(function (_, i) {
        return i !== k;
      }),
    };
  }

  /**
   * 並びの中で、足した PDF ごとの**見出しを置く位置**。各 PDF の**並びの中で最初に出てくるページ**の前(並べ替えた後は、
   * いまの並びで先に出る側)。ページが 1 枚も残っていない PDF は出さない。
   * @returns {{ page: number, k: number }[]}  `page` = 見出しの直後に来るページ(通し番号)/ `k` = `added` の何番目か
   */
  function sourceHeadings(items, added) {
    var out = [];
    var seen = {};
    items.forEach(function (it) {
      for (var k = 0; k < added.length; k += 1) {
        var a = added[k];
        if (it.page >= a.first && it.page < a.first + a.count) {
          if (!seen[k]) {
            seen[k] = true;
            out.push({ page: it.page, k: k });
          }
          return;
        }
      }
    });
    return out;
  }

  /** 見出しの字。例: `会議B.pdf(3 ページ)`。 */
  function headingText(name, count) {
    return String(name) + '(' + String(count) + ' ページ)';
  }

  /** 足した PDF の断り(窓の下に出す一行)。`code` は `edit-core.js` の断りの種類。 */
  function appendRefusal(code) {
    if (code === 'encrypted') return 'パスワードで守られた PDF は足せません。何も変えていません';
    if (code === 'unreadable') return 'PDF として読めないため足せません。何も変えていません';
    return 'PDF を足せませんでした。もう一度試してください。何も変えていません';
  }

  /** 「添付から選ぶ」の断り(窓の下に出す一行、または一覧の代わりに出す一行)。 */
  function attachRefusal(code) {
    if (code === 'empty') return 'このコレクションに、PDF の添付はありません';
    if (code === 'no-reply') return '添付の PDF を取得できませんでした。PKC3 のウィンドウから、もう一度開いてください';
    return '添付の PDF を読み込めませんでした。もう一度試してください。何も変えていません';
  }

  /** 「添付から選ぶ」の一覧の 1 行。大きさが分かれば後ろに添える(例: `会議B.pdf(1.2 MB)`)。 */
  function attachLabel(name, size) {
    if (typeof size !== 'number' || !(size >= 0)) return String(name);
    var text;
    if (size < 1024) text = String(size) + ' B';
    else if (size < 1024 * 1024) text = String(Math.round(size / 1024)) + ' KB';
    else text = (Math.round((size / (1024 * 1024)) * 10) / 10).toFixed(1) + ' MB';
    return String(name) + '(' + text + ')';
  }

  /** 足せた知らせ。 */
  function appendedNote(name, count) {
    return '「' + String(name) + '」の ' + String(count) + ' ページを後ろに足しました。「別の PDF として保存」で新しい添付になります';
  }

  /** 保存できるか(0 ページの PDF は作らない)。 */
  function canSave(items) {
    return items.length >= 1;
  }

  /**
   * 保存した PDF の名前。`元の名前.pdf` → `元の名前 (編集).pdf`(拡張子は大文字小文字を問わず取り、
   * 無ければ付け足す)。既に ` (編集)` で終わっていれば重ねない。
   */
  function outputName(name) {
    var base = String(name || '').replace(/\.pdf$/i, '');
    if (base === '') base = 'document';
    if (!/ \(編集\)$/.test(base)) base += ' (編集)';
    return base + '.pdf';
  }

  /** 2 つの並びが同じか(同じページが同じ順で、同じ向き)。保存した並びを基準にして「まだ保存していない変更」を見る。 */
  function sameArrangement(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a[i].page !== b[i].page || a[i].rot !== b[i].rot) return false;
    }
    return true;
  }

  /**
   * 編集中の案内の 1 行(ページ数と、保存するとどうなるか)。引き継がれない物は別の行(`warnLine`)。
   * @returns {string}
   */
  function noteLine(kept, total) {
    var line = '編集中(' + String(kept) + ' / ' + String(total) + ' ページ)。';
    if (kept < 1) return line + 'すべてのページを外したので、保存できません。';
    return line + '保存すると新しい PDF として添付に加わります(元の PDF は変わりません)。';
  }

  /**
   * 引き継がれない物の 1 行。**元にあるものだけ**言う。1 つも無ければ空(行ごと出さない)。
   * @param {{ outlines: boolean, form: boolean, signature: boolean }} info  元の PDF にあるもの
   * @returns {string}
   */
  function warnLine(info) {
    var line = '';
    if (info.outlines) line += 'しおりは引き継がれません。';
    if (info.form) line += '入力欄は引き継がれません。';
    if (info.signature) line += '電子署名は無効になります。';
    return line;
  }

  // ───────── ページを選ぶ・抜き出す(#275 段②-1c)── 選んだページだけの新しい PDF
  //
  // 選びは**元のページ番号**の集まり(`Set<number>`)。並べ替えても回しても選びは動かない。
  // 抜き出す PDF の並びと向きは、いまの一覧(`items`)のとおり ── 並べ替え・回転を済ませた後に抜き出せば、その状態が反映される。

  /** `page` の選びを入れ替えた新しい集まり(元の集まりは変えない)。 */
  function toggleSel(sel, page) {
    var out = new Set(sel);
    if (out.has(page)) out.delete(page);
    else out.add(page);
    return out;
  }

  /** 一覧の並びで `a` と `b`(ページ番号)の間(両端を含む)のページ。どちらかが一覧に無ければ空。 */
  function rangeSel(items, a, b) {
    var ia = -1;
    var ib = -1;
    items.forEach(function (it, i) {
      if (it.page === a) ia = i;
      if (it.page === b) ib = i;
    });
    var out = new Set();
    if (ia < 0 || ib < 0) return out;
    for (var i = Math.min(ia, ib); i <= Math.max(ia, ib); i += 1) out.add(items[i].page);
    return out;
  }

  /** 一覧に残っているページだけの選び(外したページは選びから落ちる)。 */
  function pruneSel(sel, items) {
    var here = {};
    items.forEach(function (it) {
      here[it.page] = true;
    });
    var out = new Set();
    sel.forEach(function (p) {
      if (here[p]) out.add(p);
    });
    return out;
  }

  /** 選んだページだけ、一覧の並びのまま(向きもそのまま)。抜き出す PDF の元。 */
  function pickSelected(items, sel) {
    return items.filter(function (it) {
      return sel.has(it.page);
    });
  }

  /** 抜き出せるか(選んだページが 1 つ以上。0 件では作らない)。 */
  function canExtract(items, sel) {
    return pickSelected(items, sel).length >= 1;
  }

  /** 抜き出した PDF の名前。`元の名前.pdf` → `元の名前 (抜き出し).pdf`。既に ` (抜き出し)` で終わっていれば重ねない。 */
  function extractName(name) {
    var base = String(name || '').replace(/\.pdf$/i, '');
    if (base === '') base = 'document';
    if (!/ \(抜き出し\)$/.test(base)) base += ' (抜き出し)';
    return base + '.pdf';
  }

  /** 選んでいるときの案内の 1 行(何ページ選んでいて、押すとどうなるか)。 */
  function pickNote(count) {
    return String(count) + ' ページを選んでいます。「選んだページを別の PDF にする」で新しい PDF として添付に加わります(元の PDF は変わりません)。';
  }

  /**
   * 本体の返事(`edit-result`)が、いま待っている依頼の返事か。🔴 鍵(棚に置いた物の鍵)が合うときだけ真。
   * 時間切れの後に遅れて届いた**前の依頼**の返事を、今の依頼の返事として扱わない(保存と抜き出しの取り違え)。
   * @param {{ key: string } | null} pending  送った依頼の控え
   */
  function replyMatches(pending, payload) {
    return pending !== null && !!payload && typeof payload.key === 'string' && payload.key === pending.key;
  }

  root.PkcPdfPageEdit = {
    fresh: fresh,
    rotateAt: rotateAt,
    removeAt: removeAt,
    moveTo: moveTo,
    restorePage: restorePage,
    removedPages: removedPages,
    thumbNoText: thumbNoText,
    isChanged: isChanged,
    toJob: toJob,
    appendPages: appendPages,
    sourcesFor: sourcesFor,
    removeSource: removeSource,
    sourceHeadings: sourceHeadings,
    headingText: headingText,
    attachRefusal: attachRefusal,
    attachLabel: attachLabel,
    appendRefusal: appendRefusal,
    appendedNote: appendedNote,
    canSave: canSave,
    outputName: outputName,
    sameArrangement: sameArrangement,
    noteLine: noteLine,
    warnLine: warnLine,
    toggleSel: toggleSel,
    rangeSel: rangeSel,
    pruneSel: pruneSel,
    pickSelected: pickSelected,
    canExtract: canExtract,
    extractName: extractName,
    pickNote: pickNote,
    replyMatches: replyMatches,
  };
})(typeof self !== 'undefined' ? self : this);
