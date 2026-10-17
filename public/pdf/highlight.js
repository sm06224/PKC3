/**
 * ハイライトの**計画**(#275 段②-2b/c)── 選んだ字の位置から注釈の座標を作る純粋な判断。
 *
 * 画面(`reader.js`)は、字の層で選んだ範囲の長方形(`Range.getClientRects`)を窓の座標で受け取り、
 * ここで ①重なりを除く ②PDF の座標(`viewport.convertToPdfPoint`)へ直す ③`QuadPoints`(1 行 1 組)と `Rect` にする。
 * 設計 doc `docs/development/pdf-annotation-design-2026-10.md` §2.1/§2.4:材料は textContent の座標ではなく
 * **字の層で選んだ範囲の長方形**(ページの向き `/Rotate` も、字が回っている並びも、PDF の座標へ直せば同じ式で足りる)。
 *
 * 🔑 worker へ渡すのは**ページ番号・色・QuadPoints・外す注釈の id だけ**(`toJob`)。DOM にも pdf-lib にも触らない
 * (取り出して test できる形にしてある)。
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-highlight.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /** 4 色(黄・緑・青・ピンク)。`rgb` は PDF の `/C`(0〜1)。既定は黄。 */
  var COLORS = [
    { id: 'yellow', label: '黄', rgb: [1, 0.92, 0.2] },
    { id: 'green', label: '緑', rgb: [0.45, 0.9, 0.45] },
    { id: 'blue', label: '青', rgb: [0.5, 0.78, 1] },
    { id: 'pink', label: 'ピンク', rgb: [1, 0.55, 0.78] },
  ];
  var DEFAULT_COLOR = 'yellow';
  /**
   * ペンの既定の色(濃い青)。丸いボタンの 4 色には載せない(薄い色はハイライト向き)── ペンの既定だけ濃くする。
   * `colorOf` は知っている(線の色を引くため)。
   */
  var PEN_DEFAULT_COLOR = 'ink';
  var INK_COLOR = { id: PEN_DEFAULT_COLOR, label: '濃い青', rgb: [0.05, 0.15, 0.45] };

  /** 色の id から色(知らない id は黄)。 */
  function colorOf(id) {
    for (var i = 0; i < COLORS.length; i += 1) if (COLORS[i].id === id) return COLORS[i];
    if (id === INK_COLOR.id) return INK_COLOR;
    return COLORS[0];
  }

  function area(r) {
    return Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  }

  function overlap(a, b) {
    var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /**
   * 重なる長方形を除く。🔴 字の層で選んだ範囲は、**行ごとの長方形のほかに span 全体の長方形も重なって出る**
   * (設計 doc §2.1 の実測 ── 1 行ごとに同じ範囲が 2 つ)。重ねて塗ると乗算で色が濃くなるので、1 行 1 つにする。
   * 大きさのない長方形(幅か高さが `minSize` 未満)は捨てる。ほとんど(85%)覆われている長方形は、
   * 覆っている側が**大きい**か、**同じ大きさで先にある**ときだけ捨てる(同じ物が 2 つ → 先の 1 つを残す)。
   * @param {{left:number,top:number,right:number,bottom:number}[]} rects
   * @param {number} [minSize]
   */
  function dedupeRects(rects, minSize) {
    var min = minSize === undefined ? 0.5 : minSize;
    var live = rects.filter(function (r) {
      return r.right - r.left >= min && r.bottom - r.top >= min;
    });
    return live.filter(function (r, i) {
      var a = area(r);
      for (var j = 0; j < live.length; j += 1) {
        if (j === i) continue;
        var o = live[j];
        var b = area(o);
        if (overlap(r, o) < a * 0.85) continue;
        // 同じ大きさ(1% 以内)なら先にあるほうを残す / そうでなければ大きいほうを残す
        var same = Math.abs(a - b) <= a * 0.01;
        if (same ? j < i : b > a) return false;
      }
      return true;
    });
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  /**
   * 窓の座標(ページの箱の左上が原点・倍率ごとの px)の長方形を、`QuadPoints` と `Rect` にする。
   * `QuadPoints` は 1 行 1 組の 8 数(**左上・右上・左下・右下**の順 = Adobe 系の並び。見えている向きでの左上など)。
   * `toPdf(x, y)` = `viewport.convertToPdfPoint`(ページの向きと原点のずれをここで吸収する)。
   * @param {{left:number,top:number,right:number,bottom:number}[]} vpRects
   * @param {(x:number,y:number)=>number[]} toPdf
   * @returns {{ quads: number[][], rect: number[] }}
   */
  function quadsFromViewportRects(vpRects, toPdf) {
    var quads = [];
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    vpRects.forEach(function (r) {
      var q = [];
      [
        [r.left, r.top],
        [r.right, r.top],
        [r.left, r.bottom],
        [r.right, r.bottom],
      ].forEach(function (c) {
        var p = toPdf(c[0], c[1]);
        var x = round(p[0]);
        var y = round(p[1]);
        q.push(x, y);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      });
      quads.push(q);
    });
    return { quads: quads, rect: quads.length === 0 ? [0, 0, 0, 0] : [minX, minY, maxX, maxY] };
  }

  /**
   * ページの箱の中での、選んだ範囲の長方形(窓の座標)を、そのページの PDF の座標の `QuadPoints` にする。
   * @param {{left:number,top:number,right:number,bottom:number}[]} clientRects  選んだ範囲の長方形(画面の座標)
   * @param {{left:number,top:number,width:number,height:number}} box  ページの箱(画面の座標)
   * @param {{width:number,height:number}} vpSize  そのページを描いたときの viewport の大きさ
   * @param {(x:number,y:number)=>number[]} toPdf  `viewport.convertToPdfPoint`
   * @returns {{ quads: number[][], rect: number[] } | null}  このページに入る長方形が無ければ `null`
   */
  function quadsOnPage(clientRects, box, vpSize, toPdf) {
    // 長方形の中心がこのページの箱の中にある物だけ(ページにまたがる選びは、ページごとに分ける)
    var mine = clientRects.filter(function (r) {
      var cx = (r.left + r.right) / 2;
      var cy = (r.top + r.bottom) / 2;
      return cx >= box.left && cx <= box.left + box.width && cy >= box.top && cy <= box.top + box.height;
    });
    var kept = dedupeRects(mine);
    if (kept.length === 0) return null;
    var kx = vpSize.width / box.width;
    var ky = vpSize.height / box.height;
    var vp = kept.map(function (r) {
      return {
        left: (r.left - box.left) * kx,
        top: (r.top - box.top) * ky,
        right: (r.right - box.left) * kx,
        bottom: (r.bottom - box.top) * ky,
      };
    });
    return quadsFromViewportRects(vp, toPdf);
  }

  /** 注釈の `id`(`14R` / `14R2` = 14 番・世代 2)を番号と世代へ。読めなければ `null`。 */
  function parseAnnotId(id) {
    var m = /^(\d+)R(\d*)$/.exec(String(id));
    if (m === null) return null;
    return { num: Number(m[1]), gen: m[2] === '' ? 0 : Number(m[2]) };
  }

  /** 同じ範囲か(どの角も 0.5pt 以内)。同じ範囲に重ねて付けると色が濃くなるので、色を取り替える判定に使う。 */
  function sameQuads(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a[i].length !== b[i].length) return false;
      for (var k = 0; k < a[i].length; k += 1) {
        if (Math.abs(a[i][k] - b[i][k]) > 0.5) return false;
      }
    }
    return true;
  }

  /** 付けたハイライトの並びが同じか(`uid` の集まり)。保存した状態を基準にして「まだ保存していない変更」を見る。 */
  function sameMarks(a, b) {
    if (a.length !== b.length) return false;
    var ids = {};
    a.forEach(function (m) {
      ids[m.uid + ':' + m.color] = true;
    });
    return b.every(function (m) {
      return ids[m.uid + ':' + m.color] === true;
    });
  }

  /** 外す注釈の集まり(`Map<id, {page,id}>`)が同じか。 */
  function sameRemovals(a, b) {
    if (a.size !== b.size) return false;
    var same = true;
    a.forEach(function (_v, k) {
      if (!b.has(k)) same = false;
    });
    return same;
  }

  /**
   * worker へ渡す依頼の、ハイライトの部分。**残すページ**(`order` = 元のページ番号)に属する物だけ。
   * @param {{page:number,color:string,quads:number[][]}[]} marks  付けたハイライト
   * @param {Map<string,{page:number,id:string}>} removals  外す既存のハイライト
   * @param {number[]} order  残すページ(元の番号)
   */
  function toJob(marks, removals, order) {
    var kept = {};
    order.forEach(function (p) {
      kept[p] = true;
    });
    var highlights = marks
      .filter(function (m) {
        return kept[m.page] === true;
      })
      .map(function (m) {
        return { page: m.page, rgb: colorOf(m.color).rgb.slice(), quads: m.quads.map(function (q) { return q.slice(); }) };
      });
    var out = [];
    removals.forEach(function (r) {
      if (kept[r.page] === true) out.push({ page: r.page, id: r.id });
    });
    return { highlights: highlights, removals: out };
  }

  /**
   * 編集中の案内の、ハイライトの部分。`added` = 保存した状態に無いのに付いている数 / `removed` = 保存した状態から外した数。
   * どちらも 0 なら空。@param {boolean} withSave  ページの編集が無く、ハイライトだけのとき true(保存するとどうなるかも言う)
   */
  function note(added, removed, withSave) {
    var line = '';
    if (added > 0 && removed > 0) line = 'ハイライトを ' + String(added) + ' 件付け、' + String(removed) + ' 件外しています。';
    else if (added > 0) line = 'ハイライトを ' + String(added) + ' 件付けています。';
    else if (removed > 0) line = 'ハイライトを ' + String(removed) + ' 件外しています。';
    else return '';
    if (withSave) line += '保存すると新しい PDF として添付に加わります(元の PDF は変わりません)。';
    return line;
  }

  root.PkcPdfHighlight = {
    COLORS: COLORS,
    DEFAULT_COLOR: DEFAULT_COLOR,
    colorOf: colorOf,
    PEN_DEFAULT_COLOR: PEN_DEFAULT_COLOR,
    dedupeRects: dedupeRects,
    quadsFromViewportRects: quadsFromViewportRects,
    quadsOnPage: quadsOnPage,
    parseAnnotId: parseAnnotId,
    sameQuads: sameQuads,
    sameMarks: sameMarks,
    sameRemovals: sameRemovals,
    toJob: toJob,
    note: note,
  };
})(typeof self !== 'undefined' ? self : this);
