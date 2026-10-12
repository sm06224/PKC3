/**
 * 付箋とペンの**計画**(#275)── 押した位置・なぞった線から、PDF の注釈(`/Text` と `/Ink`)の座標を作る純粋な判断。
 *
 * ハイライト(`highlight.js`)と**同じ作り**: 画面(`reader.js`)は窓の座標(ページの箱の左上が原点・倍率ごとの px)で受け取り、
 * ここで PDF の座標(`viewport.convertToPdfPoint`)へ直す。ページの向き(`/Rotate`)も倍率も、PDF の座標へ直せば同じ式で足りる。
 * 付けた物は保存まで窓の中の計画(`notes` / `strokes`)だけで、保存は**ページの編集と同じ 1 本**(`edit-core.js` が新しい PDF に書く)。
 *
 * 🔑 worker へ渡すのは**ページ番号・座標・字・色・太さだけ**(`toJob`)。DOM にも pdf-lib にも触らない(取り出して test できる形)。
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-notes.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /** 付箋の印の大きさ(窓の px。ページを描いた倍率のまま)と、字の長さの上限(手違いの検出であって使い方の上限ではない)。 */
  var NOTE_SIZE = 18;
  var NOTE_MAX_CHARS = 1000;
  /** ペンの太さ(PDF の単位 pt)と、線を簡単にするときの許容(窓の px)。 */
  var PEN_WIDTH = 2;
  var SIMPLIFY_TOLERANCE = 0.8;

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  /** 付箋に書いた字を整える。前後の空白を除き、空なら `null`(付けない)。長すぎる分は切る。 */
  function cleanText(s) {
    var t = String(s === undefined || s === null ? '' : s).trim();
    if (t === '') return null;
    return t.length > NOTE_MAX_CHARS ? t.slice(0, NOTE_MAX_CHARS) : t;
  }

  /**
   * 画面の座標(押した位置)を、ページの箱の中の窓の座標にする。
   * @param {number} cx @param {number} cy 画面の座標
   * @param {{left:number,top:number,width:number,height:number}} box ページの箱(画面の座標)
   * @param {{width:number,height:number}} vpSize そのページを描いたときの viewport の大きさ
   */
  function clientToViewport(cx, cy, box, vpSize) {
    return [(cx - box.left) * (vpSize.width / box.width), (cy - box.top) * (vpSize.height / box.height)];
  }

  /** 4 点(PDF の座標)を囲む長方形 `[minX, minY, maxX, maxY]`。 */
  function boundsOf(points) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    points.forEach(function (p) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    });
    return [minX, minY, maxX, maxY];
  }

  /**
   * 付箋の印の場所(PDF の `Rect`)。押した位置(窓の座標)を左上にした `NOTE_SIZE` 四方を、PDF の座標へ直して囲む。
   * ページが回っていても、見えている向きで「押した位置から右下へ」の四角になる。
   * @param {(x:number,y:number)=>number[]} toPdf `viewport.convertToPdfPoint`
   */
  function noteRect(x, y, toPdf, size) {
    var s = size === undefined ? NOTE_SIZE : size;
    var corners = [
      toPdf(x, y),
      toPdf(x + s, y),
      toPdf(x, y + s),
      toPdf(x + s, y + s),
    ];
    return boundsOf(corners).map(round);
  }

  /**
   * PDF の長方形を、窓の座標の箱 `{left, top, width, height}` にする(印を置く場所)。印が小さくなりすぎる倍率でも `min` 以上にする。
   * @param {(x:number,y:number)=>number[]} toVp `viewport.convertToViewportPoint`
   */
  function viewportBox(rect, toVp, min) {
    var m = min === undefined ? 14 : min;
    var pts = [toVp(rect[0], rect[1]), toVp(rect[2], rect[1]), toVp(rect[0], rect[3]), toVp(rect[2], rect[3])];
    var b = boundsOf(pts);
    return { left: b[0], top: b[1], width: Math.max(m, b[2] - b[0]), height: Math.max(m, b[3] - b[1]) };
  }

  // ───────── 付箋の並び(`notes` = [{ uid, page, rect, text }])。どれも新しい並びを返す(元は変えない)

  function addNote(list, note) {
    return list.concat([note]);
  }

  /** 字を直す。新しい `uid` にして「保存した状態との違い」として数える(ハイライトの色の取り替えと同じ作り)。 */
  function editNote(list, uid, text, nextUid) {
    return list.map(function (n) {
      return n.uid === uid ? { uid: nextUid, page: n.page, rect: n.rect, text: text } : n;
    });
  }

  function removeNote(list, uid) {
    return list.filter(function (n) {
      return n.uid !== uid;
    });
  }

  /** 付けた付箋の並びが同じか(`uid` の集まり)。保存した状態を基準にして「まだ保存していない変更」を見る。 */
  function sameUids(a, b) {
    if (a.length !== b.length) return false;
    var ids = {};
    a.forEach(function (n) {
      ids[n.uid] = true;
    });
    return b.every(function (n) {
      return ids[n.uid] === true;
    });
  }

  /** 保存した状態に無い数 / 保存した状態から無くなった数。 */
  function diffCount(list, base) {
    var has = {};
    var baseHas = {};
    list.forEach(function (n) {
      has[n.uid] = true;
    });
    base.forEach(function (n) {
      baseHas[n.uid] = true;
    });
    return {
      added: list.filter(function (n) {
        return baseHas[n.uid] !== true;
      }).length,
      removed: base.filter(function (n) {
        return has[n.uid] !== true;
      }).length,
    };
  }

  // ───────── ペン(`strokes` = [{ uid, page, color, pts: [[x, y]…](PDF の座標) }])

  function sqDist(p, a, b) {
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    var ex = a[0] + t * dx - p[0];
    var ey = a[1] + t * dy - p[1];
    return ex * ex + ey * ey;
  }

  /** 線を簡単にする(Douglas–Peucker)。端は必ず残す。窓の座標で、`tol` px より外れない点だけ落とす。 */
  function simplify(points, tol) {
    var t = tol === undefined ? SIMPLIFY_TOLERANCE : tol;
    if (points.length <= 2) return points.slice();
    var keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    var stack = [[0, points.length - 1]];
    while (stack.length > 0) {
      var seg = stack.pop();
      var far = -1;
      var farD = t * t;
      for (var i = seg[0] + 1; i < seg[1]; i += 1) {
        var d = sqDist(points[i], points[seg[0]], points[seg[1]]);
        if (d > farD) {
          farD = d;
          far = i;
        }
      }
      if (far !== -1) {
        keep[far] = true;
        stack.push([seg[0], far], [far, seg[1]]);
      }
    }
    return points.filter(function (_p, i) {
      return keep[i];
    });
  }

  /**
   * なぞった線(窓の座標の点の並び)を、簡単にして PDF の座標の点の並びにする。点が 1 つ(押しただけ)なら同じ点を 2 つ並べる
   * (丸い線の端で点になる)。
   */
  function strokeToPdf(vpPoints, toPdf) {
    var pts = simplify(vpPoints);
    if (pts.length === 1) pts = [pts[0], pts[0]];
    return pts.map(function (p) {
      var q = toPdf(p[0], p[1]);
      return [round(q[0]), round(q[1])];
    });
  }

  /** 線の上(`tol` px 以内)を押したか。@param vpPoints 窓の座標の点の並び */
  function strokeHit(vpPoints, x, y, tol) {
    var t2 = tol * tol;
    if (vpPoints.length === 1) return sqDist([x, y], vpPoints[0], vpPoints[0]) <= t2;
    for (var i = 1; i < vpPoints.length; i += 1) {
      if (sqDist([x, y], vpPoints[i - 1], vpPoints[i]) <= t2) return true;
    }
    return false;
  }

  /** 付けた線の並びが同じか(`uid` の集まり)。 */
  function sameStrokes(a, b) {
    return sameUids(a, b);
  }

  // ───────── 保存の依頼・案内

  /**
   * worker へ渡す依頼の、付箋とペンの部分。**残すページ**(`order` = 元のページ番号)に属する物だけ。
   * @param {{page:number,rect:number[],text:string}[]} notes
   * @param {{page:number,color:string,pts:number[][]}[]} strokes
   * @param {(id:string)=>number[]} rgbOf 色の id → 0〜1 の 3 数(`highlight.js` の色の表)
   * @param {number[]} order
   */
  function toJob(notes, strokes, rgbOf, order) {
    var kept = {};
    order.forEach(function (p) {
      kept[p] = true;
    });
    return {
      notes: notes
        .filter(function (n) {
          return kept[n.page] === true;
        })
        .map(function (n) {
          return { page: n.page, rect: n.rect.slice(), text: n.text };
        }),
      strokes: strokes
        .filter(function (s) {
          return kept[s.page] === true;
        })
        .map(function (s) {
          return {
            page: s.page,
            rgb: rgbOf(s.color).slice(),
            width: PEN_WIDTH,
            paths: [
              s.pts.reduce(function (flat, p) {
                flat.push(p[0], p[1]);
                return flat;
              }, []),
            ],
          };
        }),
    };
  }

  /**
   * 外す付箋(元の PDF に付いていた物)の依頼。`edit-core.js` はハイライトの外しと同じ列で受け、`kind: 'note'` の物は付箋(`/Text`)だけを外す。
   * @param {Map<string,{page:number,id:string}>} removals  @param {number[]} order 残すページ(元の番号)
   */
  function removalsJob(removals, order) {
    var kept = {};
    order.forEach(function (p) {
      kept[p] = true;
    });
    var out = [];
    removals.forEach(function (r) {
      if (kept[r.page] === true) out.push({ page: r.page, id: r.id, kind: 'note' });
    });
    return out;
  }

  /**
   * 編集中の案内の、付箋とペンの部分。0 件なら空。
   * @param {{added:number,removed:number}} n 付箋  @param {{added:number,removed:number}} s 線
   */
  function note(n, s, withSave) {
    var parts = [];
    if (n.added > 0) parts.push('付箋を ' + String(n.added) + ' 件付け');
    if (n.removed > 0) parts.push('付箋を ' + String(n.removed) + ' 件外し');
    if (s.added > 0) parts.push('ペンの線を ' + String(s.added) + ' 本書い');
    if (s.removed > 0) parts.push('ペンの線を ' + String(s.removed) + ' 本外し');
    if (parts.length === 0) return '';
    var line = parts.join('、') + 'ています。';
    if (withSave) line += '保存すると新しい PDF として添付に加わります(元の PDF は変わりません)。';
    return line;
  }

  root.PkcPdfNotes = {
    NOTE_SIZE: NOTE_SIZE,
    NOTE_MAX_CHARS: NOTE_MAX_CHARS,
    PEN_WIDTH: PEN_WIDTH,
    cleanText: cleanText,
    clientToViewport: clientToViewport,
    noteRect: noteRect,
    viewportBox: viewportBox,
    addNote: addNote,
    editNote: editNote,
    removeNote: removeNote,
    sameUids: sameUids,
    diffCount: diffCount,
    simplify: simplify,
    strokeToPdf: strokeToPdf,
    strokeHit: strokeHit,
    sameStrokes: sameStrokes,
    toJob: toJob,
    removalsJob: removalsJob,
    note: note,
  };
})(typeof self !== 'undefined' ? self : this);
