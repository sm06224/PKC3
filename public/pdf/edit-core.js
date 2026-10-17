/**
 * ページの編集で PDF を**作る**所(#275 段②-1b)。pdf-lib を使う唯一の場所で、`edit-worker.js`(窓の中の使い捨ての
 * worker)から呼ばれる。pdf-lib 本体(`PDFLib`)は**引数で受ける**(worker では `importScripts` の global、test では node の
 * `require`)── この file は worker にも node にも置ける。
 *
 * ## 🔴 作り方は 1 本だけ ── 新しい文書へ、残すページだけを写す(設計 doc §2 の「B」)
 *
 * pdf-lib にはページを消す道が 2 つある。**開いた文書の中で `removePage` する道(A)は、外したページの中身
 * (文字の流れ)が file に残る**(2026-10-10 実測 ── 全 stream を展開すると外したページの字がそのまま在った)。
 * user は「外した」ページが消えたと思って人に渡すので、**A は使わない**。
 * 並べ替えと回すだけでも **B 1 本**にする(どちらの道を通ったかで引き継がれる物が変わると、規則が読めない)。
 * 🔑 足した PDF(#275 結合)も**同じ B**: 文書ごとに残すページだけを同じ新しい文書へ写す(通し番号は `checkSources`)。
 * ⚠ B は文書全体の設定(しおり・入力欄・電子署名)を引き継がない ── 画面が保存の前に 1 行で言う(`page-edit.js` の `noteLine`)。
 * 引き継ぐのは題名・作成者・件名・キーワード・作成日時(`copyInfo`)。
 *
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-edit-core.test.ts` が**この file の原文を読んで**、実物の pdf-lib で走らせる。
 */
(function (root) {
  'use strict';

  /** 断りの種類。窓が user の言葉に直す(`reader.js`)。 */
  var CODES = {
    encrypted: 'encrypted',
    unreadable: 'unreadable',
    badJob: 'bad-job',
    leaked: 'leaked',
    // 外すと言われたハイライトが、元の PDF のそのページに見つからない(#275 段②-2c)
    badHighlight: 'bad-highlight',
    // 付箋の字が、この窓で描ける書体では描けない(日本語など)── 潰して渡さず断る(「注釈をページに書き込んで保存」)
    font: 'font',
  };

  function fail(code) {
    var e = new Error('pdf-edit: ' + code);
    e.pkcCode = code;
    return e;
  }

  /**
   * 読み込みで落ちたのを、断りの種類へ。パスワード付き(暗号化)を見分ける。
   * 🔴 **`instanceof PDFLib.EncryptedPDFError` だけでは見分けられない**(pdf-lib 1.17.1 を実測: 投げられた error は
   * `EncryptedPDFError` の instance ではなく素の `Error` ── ES5 向けに書き出した `Error` の継承は instance を作り損なう)。
   * 見分けの手掛かりは**文言**(`Input document to \`PDFDocument.load\` is encrypted`)で、読み込みの前に断る 1 か所だけが言う。
   */
  function loadError(PDFLib, e) {
    if (e && e.pkcCode) return e;
    var byClass = typeof PDFLib.EncryptedPDFError === 'function' && e instanceof PDFLib.EncryptedPDFError;
    var byText = !!e && typeof e.message === 'string' && /document to .PDFDocument\.load. is encrypted/.test(e.message);
    return fail(byClass || byText ? CODES.encrypted : CODES.unreadable);
  }

  /** 元の PDF を開く。⚠ 暗号化の文書は `ignoreEncryption` を付けない(付けると壊れた出力になる)ので、ここで断る。 */
  async function loadSource(PDFLib, bytes) {
    try {
      return await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      throw loadError(PDFLib, e);
    }
  }

  /** ページを編集できる形か。@returns ページ数 / 編集できなければ `pkcCode` つきで投げる */
  async function check(PDFLib, bytes) {
    var src = await loadSource(PDFLib, bytes);
    return src.getPageCount();
  }

  /**
   * 依頼 `{ order, rotate, highlights?, removals? }` を確かめる。@returns 正規化した依頼 / 不正なら `bad-job` で投げる
   * - `order`: 1 以上のページ番号の並び(空でない・重ならない・文書のページ数以内)
   * - `rotate`: 元のページ番号 → 右へ回す角度(90 の倍数)。`order` に無いページは受けない
   * - `highlights`(#275 段②-2b): 付けるハイライト `{ page, rgb: [r,g,b](0〜1), quads: [[8 数]…] }`。
   *   `order` に無いページの物は**捨てる**(外したページには付けない)
   * - `removals`(#275 段②-2c): 外すハイライト `{ page, id: '14R' }`(pdf.js の注釈の id)。`order` に無いページの物は捨てる
   */
  function checkJob(job, pageCount) {
    if (!job || !Array.isArray(job.order) || job.order.length < 1) throw fail(CODES.badJob);
    var sources = checkSources(job.sources, pageCount);
    var seen = {};
    job.order.forEach(function (p) {
      if (!Number.isInteger(p) || p < 1 || seen[p]) throw fail(CODES.badJob);
      // 元の PDF のページ、または足した PDF のページ(`sources` が教える範囲)だけ
      if (p > pageCount && !sources.some(function (s) { return p >= s.first && p < s.first + s.count; })) throw fail(CODES.badJob);
      seen[p] = true;
    });
    var rotate = {};
    var src = job.rotate && typeof job.rotate === 'object' ? job.rotate : {};
    Object.keys(src).forEach(function (k) {
      var p = Number(k);
      var d = src[k];
      if (!seen[p] || !Number.isInteger(d) || d % 90 !== 0) throw fail(CODES.badJob);
      rotate[p] = ((d % 360) + 360) % 360;
    });
    var highlights = checkHighlights(job.highlights, seen);
    var removals = checkRemovals(job.removals, seen);
    var notes = checkNotes(job.notes, seen);
    var strokes = checkStrokes(job.strokes, seen);
    if (job.flatten !== undefined && typeof job.flatten !== 'boolean') throw fail(CODES.badJob);
    // ハイライトの付け外しは元の PDF のページだけ(足した PDF のページには付けも外しもしない)
    // 付箋・ペンも同じ(足したページには付けない)
    if (highlights.concat(removals, notes, strokes).some(function (x) { return x.page > pageCount; })) throw fail(CODES.badJob);
    return {
      order: job.order.slice(),
      rotate: rotate,
      highlights: highlights,
      removals: removals,
      notes: notes,
      strokes: strokes,
      sources: sources,
      flatten: job.flatten === true,
    };
  }

  /**
   * 足した PDF の範囲 `[{ first, count }]`(#275 結合)。ページ番号は**通し番号**: 元の PDF が 1〜`pageCount`、
   * 足した 1 つ目がその次から `count` ページ、2 つ目がさらにその次から ……。範囲は昇順・隙間なく、`pageCount` の次から始まる。
   */
  function checkSources(list, pageCount) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_SOURCES) throw fail(CODES.badJob);
    // ⚠ 範囲の間が空くのは正しい(足した PDF のページを全部外した / 「変更を元に戻す」の後に足し直した ── その PDF は送らない)。
    //   求めるのは「元の PDF の後ろ・前から順・重ならない」だけ(ページ番号から属する PDF を引くので、間は困らない)
    var next = pageCount + 1;
    return list.map(function (s) {
      if (!s || !Number.isInteger(s.first) || !Number.isInteger(s.count) || s.count < 1 || s.first < next) throw fail(CODES.badJob);
      next = s.first + s.count;
      return { first: s.first, count: s.count };
    });
  }

  /** 上限(1 つの依頼で付ける・外すハイライトの数、1 つが持つ行の数)。手違いの検出であって、使い方の上限ではない。 */
  var MAX_MARKS = 5000;
  var MAX_QUADS = 2000;
  /** 付箋の字の長さ / 1 本の線の数の数(x と y を並べた数)の上限(手違いの検出)。 */
  var MAX_NOTE_CHARS = 2000;
  var MAX_PATH_NUMS = 200000;
  /** 足せる PDF の数(手違いの検出)。 */
  var MAX_SOURCES = 200;

  function isNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /** 付けるハイライトを確かめる。不正なら `bad-job`。残すページに無い物は捨てる。 */
  function checkHighlights(list, kept) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_MARKS) throw fail(CODES.badJob);
    var out = [];
    list.forEach(function (h) {
      if (!h || !Number.isInteger(h.page) || h.page < 1) throw fail(CODES.badJob);
      if (!Array.isArray(h.rgb) || h.rgb.length !== 3 || !h.rgb.every(function (c) { return isNum(c) && c >= 0 && c <= 1; })) {
        throw fail(CODES.badJob);
      }
      if (!Array.isArray(h.quads) || h.quads.length < 1 || h.quads.length > MAX_QUADS) throw fail(CODES.badJob);
      h.quads.forEach(function (q) {
        if (!Array.isArray(q) || q.length !== 8 || !q.every(isNum)) throw fail(CODES.badJob);
      });
      if (kept[h.page]) out.push({ page: h.page, rgb: h.rgb.slice(), quads: h.quads.map(function (q) { return q.slice(); }) });
    });
    return out;
  }

  /** 外すハイライトを確かめる。不正なら `bad-job`。残すページに無い物は捨て、同じ注釈の重なりは 1 つにする。 */
  function checkRemovals(list, kept) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_MARKS) throw fail(CODES.badJob);
    var out = [];
    var seenId = {};
    list.forEach(function (r) {
      if (!r || !Number.isInteger(r.page) || r.page < 1 || !/^\d+R\d*$/.test(String(r.id))) throw fail(CODES.badJob);
      // 外す物の種類(省略はハイライト)。付箋(`/Text`)も外せる
      var kind = r.kind === undefined ? 'highlight' : r.kind;
      if (kind !== 'highlight' && kind !== 'note') throw fail(CODES.badJob);
      var key = r.page + ':' + r.id;
      if (!kept[r.page] || seenId[key]) return;
      seenId[key] = true;
      out.push({ page: r.page, id: String(r.id), kind: kind });
    });
    return out;
  }

  /** 付ける付箋 `{ page, rect: [x0,y0,x1,y1], text }` を確かめる。不正なら `bad-job`。残すページに無い物は捨てる。 */
  function checkNotes(list, kept) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_MARKS) throw fail(CODES.badJob);
    var out = [];
    list.forEach(function (n) {
      if (!n || !Number.isInteger(n.page) || n.page < 1) throw fail(CODES.badJob);
      if (!Array.isArray(n.rect) || n.rect.length !== 4 || !n.rect.every(isNum)) throw fail(CODES.badJob);
      if (typeof n.text !== 'string' || n.text === '' || n.text.length > MAX_NOTE_CHARS) throw fail(CODES.badJob);
      if (kept[n.page]) out.push({ page: n.page, rect: n.rect.slice(), text: n.text });
    });
    return out;
  }

  /** 付けるペンの線 `{ page, rgb, width, paths: [[x,y,x,y…]…] }` を確かめる。不正なら `bad-job`。残すページに無い物は捨てる。 */
  function checkStrokes(list, kept) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > MAX_MARKS) throw fail(CODES.badJob);
    var out = [];
    list.forEach(function (s) {
      if (!s || !Number.isInteger(s.page) || s.page < 1) throw fail(CODES.badJob);
      if (!Array.isArray(s.rgb) || s.rgb.length !== 3 || !s.rgb.every(function (c) { return isNum(c) && c >= 0 && c <= 1; })) {
        throw fail(CODES.badJob);
      }
      if (!isNum(s.width) || s.width <= 0 || s.width > 100) throw fail(CODES.badJob);
      if (!Array.isArray(s.paths) || s.paths.length < 1 || s.paths.length > MAX_QUADS) throw fail(CODES.badJob);
      s.paths.forEach(function (p) {
        if (!Array.isArray(p) || p.length < 4 || p.length % 2 !== 0 || p.length > MAX_PATH_NUMS || !p.every(isNum)) throw fail(CODES.badJob);
      });
      if (kept[s.page]) {
        out.push({ page: s.page, rgb: s.rgb.slice(), width: s.width, paths: s.paths.map(function (p) { return p.slice(); }) });
      }
    });
    return out;
  }

  /** 題名などを写す(`copyPages` は文書の情報を持たない)。無い物は触らない。 */
  function copyInfo(src, out) {
    var title = src.getTitle();
    if (title !== undefined) out.setTitle(title);
    var author = src.getAuthor();
    if (author !== undefined) out.setAuthor(author);
    var subject = src.getSubject();
    if (subject !== undefined) out.setSubject(subject);
    var keywords = src.getKeywords();
    if (keywords !== undefined) out.setKeywords([keywords]);
    var created = src.getCreationDate();
    if (created !== undefined) out.setCreationDate(created);
  }

  // ───────── 外したページへの「つながり」を切る(リンクの注釈)

  function refKey(r) {
    return r && typeof r.toString === 'function' ? r.toString() : '';
  }

  /** 名前つきの行き先(/Dests と /Names の /Dests の木)を引く関数。引けなければ `null` を返す。 */
  function namedDestResolver(PDFLib, src) {
    var N = PDFLib.PDFName;
    var cat = src.catalog;
    var D = PDFLib.PDFDict;
    var A = PDFLib.PDFArray;
    function unwrap(v) {
      // `/Dests` の値は配列、または `/D` に配列を持つ辞書
      if (v instanceof D) v = v.lookup(N.of('D'));
      return v instanceof A ? v : null;
    }
    function viaTree(node, key, depth) {
      if (!(node instanceof D) || depth > 12) return null;
      var names = node.lookup(N.of('Names'));
      if (names instanceof A) {
        for (var i = 0; i + 1 < names.size(); i += 2) {
          var k = names.lookup(i);
          if (k && typeof k.decodeText === 'function' && k.decodeText() === key) return unwrap(names.lookup(i + 1));
        }
      }
      var kids = node.lookup(N.of('Kids'));
      if (kids instanceof A) {
        for (var j = 0; j < kids.size(); j += 1) {
          var hit = viaTree(kids.lookup(j), key, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    }
    return function (nameObj) {
      if (!nameObj || typeof nameObj.decodeText !== 'function') return null;
      var key = nameObj.decodeText();
      var dests = cat.lookup(N.of('Dests'));
      if (dests instanceof D) {
        var v = unwrap(dests.lookup(N.of(key)));
        if (v) return v;
      }
      var names = cat.lookup(N.of('Names'));
      if (names instanceof D) return viaTree(names.lookup(N.of('Dests')), key, 0);
      return null;
    };
  }

  /**
   * 🔴 **リンクの注釈が持つ「ページへの参照」を、`copyPages` に辿らせない**(2026-10-11 の着地前レビューで実測 2 件)。
   *
   * `copyPages` は残すページから辿れる物を**全部**写す。リンクの注釈(`/Dest` と、`/A` の `/S /GoTo` の `/D`)が
   * ページの参照を持っていると、
   *  ① **外したページが孤立したページとして出力に入り、中身(文字)が残る**(道 B を選んだ理由が破れる)
   *  ② 残すページへのリンクでも、**行き先が孤立した複製のページ**になる(押しても別のページへ行く + 無駄な複製)。
   * だから:
   *  - 外すページを指す注釈は**落とす**
   *  - 残すページを指す注釈は、行き先を**いったん外して**写し、写した後に**出力のページ**へ付け直す(`restore`)
   * ⚠ 名前つきの行き先(名前 / 文字列)は /Dests と /Names の木を引いて、行き先のページで判断する(付け直すときは配列に直す)。
   *   引けない物はそのまま(出力のページ数の検めが最後の門)。
   * ⚠ 触るのは**使い捨ての元の文書**(出力でも元の file でもない)。
   * @returns `{ dropped, restore(out, outPages) }`
   */
  function prepareLinks(PDFLib, src, keptIdx) {
    var N = PDFLib.PDFName;
    var D = PDFLib.PDFDict;
    var A = PDFLib.PDFArray;
    var pages = src.getPages();
    var pos = {}; // 元のページの index → 出力の何番目か
    keptIdx.forEach(function (i, k) {
      pos[i] = k;
    });
    var idxOf = {}; // 参照 → 元のページの index
    pages.forEach(function (p, i) {
      idxOf[refKey(p.ref)] = i;
    });
    var named = namedDestResolver(PDFLib, src);
    /** 行き先 1 つ → `{ idx, rest }`(ページを指さない / 引けない物は `null`) */
    function classify(dest) {
      if (dest && !(dest instanceof A) && typeof dest.decodeText === 'function') dest = named(dest);
      if (!(dest instanceof A) || dest.size() < 1) return null;
      var idx = idxOf[refKey(dest.get(0))];
      if (idx === undefined) return null;
      return { idx: idx, rest: dest.asArray().slice(1) };
    }
    var dropped = 0;
    // ⚠ 1 つの注釈が複数ページの Annots に入っている形は、先に処理したページを指し直す(仕様上は 1 注釈 1 ページ)
    var owners = []; // 🔴 `/P`(注釈が属するページ)を外した注釈: { page(元の index), at(注釈の位置), popup(/Popup の側か) }
    var later = []; // 付け直す物: { page(元の index), at(注釈の位置), where: 'Dest' | 'A', to(行き先の元の index), rest }
    keptIdx.forEach(function (i) {
      var node = pages[i].node;
      var annots = node.lookup(N.of('Annots'));
      if (!(annots instanceof A)) return;
      var keep = [];
      var pending = [];
      for (var j = 0; j < annots.size(); j += 1) {
        var raw = annots.get(j);
        var dict = annots.lookup(j);
        var drop = false;
        var found = [];
        if (dict instanceof D) {
          var d1 = classify(dict.lookup(N.of('Dest')));
          if (d1) {
            if (pos[d1.idx] === undefined) drop = true;
            else found.push({ where: 'Dest', holder: dict, hit: d1 });
          }
          var act = dict.lookup(N.of('A'));
          if (!drop && act instanceof D && act.lookup(N.of('S')) === N.of('GoTo')) {
            var d2 = classify(act.lookup(N.of('D')));
            if (d2) {
              if (pos[d2.idx] === undefined) drop = true;
              else found.push({ where: 'A', holder: act, hit: d2 });
            }
          }
        }
        if (drop) {
          dropped += 1;
          continue;
        }
        // 🔴 `/P` は、ほかのアプリが注釈(ハイライトなど)を付けるときの標準の形。`copyPages` は `/P` を辿って
        //    元のページをもう 1 枚写す(孤立したページ = 門に断られる / 外すページなら中身も残る)。
        //    外して写し、写した後に**出力の自分のページ**を指し直す(`/P` の行き先は、属するページ以外にならない)
        if (dict instanceof D) {
          if (dict.has(N.of('P'))) {
            dict.delete(N.of('P'));
            owners.push({ page: i, at: keep.length, popup: false });
          }
          var pop = dict.lookup(N.of('Popup'));
          if (pop instanceof D && pop.has(N.of('P'))) {
            pop.delete(N.of('P'));
            owners.push({ page: i, at: keep.length, popup: true });
          }
        }
        found.forEach(function (f) {
          // 参照を外す(写すときに辿らせない)。付け直しは写した後
          f.holder.delete(N.of(f.where === 'Dest' ? 'Dest' : 'D'));
          pending.push({ at: keep.length, where: f.where, to: f.hit.idx, rest: f.hit.rest });
        });
        keep.push(raw);
      }
      if (keep.length !== annots.size()) node.set(N.of('Annots'), src.context.obj(keep));
      pending.forEach(function (q) {
        later.push({ page: i, at: q.at, where: q.where, to: q.to, rest: q.rest });
      });
    });
    return {
      dropped: dropped,
      /** 写した後: 残すページへのリンクの行き先を、出力のページへ付ける。 */
      restore: function (out, outPages) {
        owners.forEach(function (q) {
          var annots = outPages[pos[q.page]].node.lookup(N.of('Annots'));
          if (!(annots instanceof A)) return;
          var dict = annots.lookup(q.at);
          if (q.popup && dict instanceof D) dict = dict.lookup(N.of('Popup'));
          if (dict instanceof D) dict.set(N.of('P'), outPages[pos[q.page]].ref);
        });
        later.forEach(function (q) {
          var annots = outPages[pos[q.page]].node.lookup(N.of('Annots'));
          if (!(annots instanceof A)) return;
          var dict = annots.lookup(q.at);
          if (!(dict instanceof D)) return;
          var dest = out.context.obj([outPages[pos[q.to]].ref].concat(q.rest));
          if (q.where === 'Dest') dict.set(N.of('Dest'), dest);
          else {
            var act = dict.lookup(N.of('A'));
            if (act instanceof D) act.set(N.of('D'), dest);
          }
        });
      },
    };
  }

  // ───────── ハイライトを外す・付ける(#275 段②-2b/c)

  /**
   * 🔴 **外すと言われたハイライトを、残すページの注釈の並びから抜く**(元の文書の上で。`copyPages` の前)。
   * 新しい文書へ写す道(B)なので、並びから抜けば**注釈・外観・外観の中の stream は出力に入らない**
   * (設計 doc §2.3 の「抜くだけ」で門が断るのは、**開いた文書の中で保存する**道の話。ここは写す道)。
   * ⚠ 一緒に抜く物: そのハイライトの吹き出し(`/Popup`)。残すと `/Parent` をたどって `copyPages` が
   *   外したはずのハイライトをもう一度写す。⚠ ハイライトへの返信(`/IRT` が指している注釈)は**残す**(コメントには触らない)
   *   が、`/IRT` だけ外す(残すと同じ理由で外したハイライトが戻る)。
   * 🔑 外せるのは**ハイライトと付箋(`/Text`)**。`kind` が選ぶ(省略はハイライト)── 種類が違う注釈は外さず、断る。
   * ⚠ 見つからない(id が合わない / 種類が合わない)ときは**黙って通さず `bad-highlight` で断る**
   *   (外したつもりのハイライトが出力に残ると、user は消えたと思って人に渡す)。
   * @returns 抜いた数
   */
  function dropHighlights(PDFLib, src, removals) {
    if (removals.length === 0) return 0;
    var N = PDFLib.PDFName;
    var D = PDFLib.PDFDict;
    var A = PDFLib.PDFArray;
    var pages = src.getPages();
    var byPage = {};
    removals.forEach(function (r) {
      (byPage[r.page] = byPage[r.page] || []).push(r);
    });
    var done = 0;
    Object.keys(byPage).forEach(function (k) {
      var node = pages[Number(k) - 1].node;
      var annots = node.lookup(N.of('Annots'));
      if (!(annots instanceof A)) throw fail(CODES.badHighlight);
      var drop = {}; // 抜く参照(ハイライトと、その吹き出し)
      var gone = {}; // 抜いたハイライトの参照
      byPage[k].forEach(function (r) {
        var m = /^(\d+)R(\d*)$/.exec(r.id);
        var want = PDFLib.PDFRef.of(Number(m[1]), m[2] === '' ? 0 : Number(m[2])).toString();
        var hit = false;
        for (var j = 0; j < annots.size(); j += 1) {
          if (refKey(annots.get(j)) !== want) continue;
          var dict = annots.lookup(j);
          if (!(dict instanceof D) || dict.lookup(N.of('Subtype')) !== N.of(r.kind === 'note' ? 'Text' : 'Highlight')) break;
          hit = true;
          drop[want] = true;
          gone[want] = true;
          var pop = dict.get(N.of('Popup'));
          if (pop) drop[refKey(pop)] = true;
          break;
        }
        if (!hit) throw fail(CODES.badHighlight);
        done += 1;
      });
      var keep = [];
      for (var i = 0; i < annots.size(); i += 1) {
        var raw = annots.get(i);
        if (drop[refKey(raw)]) continue;
        var d = annots.lookup(i);
        if (d instanceof D) {
          var irt = d.get(N.of('IRT'));
          if (irt && gone[refKey(irt)]) d.delete(N.of('IRT'));
        }
        keep.push(raw);
      }
      node.set(N.of('Annots'), src.context.obj(keep));
    });
    return done;
  }

  function fmt(n) {
    return String(Math.round(n * 1000) / 1000);
  }

  /**
   * 🔴 **付けるハイライトを、出力のページに足す**(`copyPages` で写した後)。注釈 `/Highlight` + **外観(`/AP`)**。
   * 設計 doc §2.2/§2.4:外観が無いと描かないビューアが在ると知られている(測っていない)ので、**外観を必ず書く**。
   * `/P` は付けない(省略可。付けると 2.3 の問題に当たる)。`/F 4`(印刷する)、`/C` 色、`/CA` 1。
   * 外観は 1 つの Form XObject に行ごとの長方形を**乗算**(`/BM /Multiply`)で塗る ── 字は隠れない。
   */
  function addHighlights(PDFLib, out, pages, plan) {
    if (plan.highlights.length === 0) return;
    var ctx = out.context;
    var N = PDFLib.PDFName;
    var posOf = {};
    plan.order.forEach(function (p, i) {
      posOf[p] = i;
    });
    plan.highlights.forEach(function (h) {
      var page = pages[posOf[h.page]];
      var flat = [];
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      var path = [];
      h.quads.forEach(function (q) {
        for (var i = 0; i < 8; i += 2) {
          minX = Math.min(minX, q[i]);
          maxX = Math.max(maxX, q[i]);
          minY = Math.min(minY, q[i + 1]);
          maxY = Math.max(maxY, q[i + 1]);
        }
        Array.prototype.push.apply(flat, q);
        // 並びは 左上・右上・左下・右下 ── 塗る輪郭は 左上 → 右上 → 右下 → 左下
        path.push(
          fmt(q[0]) + ' ' + fmt(q[1]) + ' m ' + fmt(q[2]) + ' ' + fmt(q[3]) + ' l ' +
            fmt(q[6]) + ' ' + fmt(q[7]) + ' l ' + fmt(q[4]) + ' ' + fmt(q[5]) + ' l h f',
        );
      });
      var box = [minX, minY, maxX, maxY];
      var ap = ctx.register(
        ctx.stream('/GS0 gs ' + h.rgb.map(fmt).join(' ') + ' rg ' + path.join(' '), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: box,
          Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } },
        }),
      );
      var annot = ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: box,
          QuadPoints: flat,
          C: h.rgb,
          CA: 1,
          F: 4,
          AP: { N: ap },
        }),
      );
      var annots = page.node.lookup(N.of('Annots'));
      if (annots instanceof PDFLib.PDFArray) annots.push(annot);
      else page.node.set(N.of('Annots'), ctx.obj([annot]));
    });
  }

  /**
   * 🔴 **付ける付箋を、出力のページに足す**(`/Text` + 外観 `/AP`)。`/Contents` は UTF-16 の文字列(日本語が読める)。
   * `/Name /Comment`、`/F 4`(印刷する)。外観は小さな紙の絵(他のビューアが自前の絵を描かなくても見える)。
   * `/P` は付けない(ハイライトと同じ理由)。
   */
  function addNotes(PDFLib, out, pages, plan) {
    if (plan.notes.length === 0) return;
    var ctx = out.context;
    var N = PDFLib.PDFName;
    var posOf = {};
    plan.order.forEach(function (p, i) {
      posOf[p] = i;
    });
    plan.notes.forEach(function (n) {
      var page = pages[posOf[n.page]];
      var x0 = n.rect[0];
      var y0 = n.rect[1];
      var w = n.rect[2] - x0;
      var h = n.rect[3] - y0;
      // 外観は BBox = Rect の原点つきで、紙(薄い黄)+ 枠 + 3 本の線を描く
      var ap = ctx.register(
        ctx.stream(
          '1 0.96 0.62 rg ' + fmt(x0) + ' ' + fmt(y0) + ' ' + fmt(w) + ' ' + fmt(h) + ' re f ' +
            '0.35 0.3 0.1 RG 0.6 w ' + fmt(x0 + 0.3) + ' ' + fmt(y0 + 0.3) + ' ' + fmt(w - 0.6) + ' ' + fmt(h - 0.6) + ' re S ' +
            [0.3, 0.5, 0.7]
              .map(function (t) {
                return fmt(x0 + w * 0.2) + ' ' + fmt(y0 + h * t) + ' m ' + fmt(x0 + w * 0.8) + ' ' + fmt(y0 + h * t) + ' l S';
              })
              .join(' '),
          { Type: 'XObject', Subtype: 'Form', BBox: n.rect.slice() },
        ),
      );
      var annot = ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: n.rect.slice(),
          Contents: PDFLib.PDFHexString.fromText(n.text),
          Name: 'Comment',
          C: [1, 0.96, 0.62],
          F: 4,
          Open: false,
          AP: { N: ap },
        }),
      );
      var annots = page.node.lookup(N.of('Annots'));
      if (annots instanceof PDFLib.PDFArray) annots.push(annot);
      else page.node.set(N.of('Annots'), ctx.obj([annot]));
    });
  }

  /**
   * 🔴 **付けるペンの線を、出力のページに足す**(`/Ink` + 外観 `/AP`)。線は丸い端・丸い継ぎ目で、太さは `/BS /W`。
   * 外観の BBox は線を囲む長方形に太さの半分を足した物(`/Rect` と同じ)。
   */
  function addStrokes(PDFLib, out, pages, plan) {
    if (plan.strokes.length === 0) return;
    var ctx = out.context;
    var N = PDFLib.PDFName;
    var posOf = {};
    plan.order.forEach(function (p, i) {
      posOf[p] = i;
    });
    plan.strokes.forEach(function (s) {
      var page = pages[posOf[s.page]];
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      var draw = [];
      s.paths.forEach(function (p) {
        var cmd = [];
        for (var i = 0; i < p.length; i += 2) {
          minX = Math.min(minX, p[i]);
          maxX = Math.max(maxX, p[i]);
          minY = Math.min(minY, p[i + 1]);
          maxY = Math.max(maxY, p[i + 1]);
          cmd.push(fmt(p[i]) + ' ' + fmt(p[i + 1]) + (i === 0 ? ' m' : ' l'));
        }
        draw.push(cmd.join(' ') + ' S');
      });
      var pad = s.width / 2 + 0.5;
      var box = [minX - pad, minY - pad, maxX + pad, maxY + pad];
      var ap = ctx.register(
        ctx.stream('1 J 1 j ' + fmt(s.width) + ' w ' + s.rgb.map(fmt).join(' ') + ' RG ' + draw.join(' '), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: box,
        }),
      );
      var annot = ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Ink',
          Rect: box,
          InkList: s.paths.map(function (p) {
            return p.slice();
          }),
          C: s.rgb.slice(),
          BS: { Type: 'Border', W: s.width, S: 'S' },
          CA: 1,
          F: 4,
          AP: { N: ap },
        }),
      );
      var annots = page.node.lookup(N.of('Annots'));
      if (annots instanceof PDFLib.PDFArray) annots.push(annot);
      else page.node.set(N.of('Annots'), ctx.obj([annot]));
    });
  }

  // ───────── 注釈をページに書き込む(#275 / #1163 依頼 31)── ハイライト・ペン・付箋を、注釈ではなく**ページの描画**にする
  //
  // 他のビューアで消せず、注釈を表示しない設定でも見える形にする。ハイライト・ペンの線は図形として、付箋は小さな番号として
  // ページに描き、付箋の字は「番号. 字」でページの下の端に並べる(入りきらなければ、最後に足したページに並べる)。
  // 元の注釈(ハイライト・ペン・付箋とその吹き出し)は出力に入れない。リンクなど、ほかの種類の注釈は触らない。
  //
  // 🔴 **日本語の字は、書体ではなく画像で貼る**(2026-10-17 実測): pdf-lib が描ける書体は標準の 14 書体(Latin-1 の範囲)だけで、
  //   日本語の書体を埋め込むには別の package(fontkit)と書体の file が要るが、どちらもこの窓には配られていない。
  //   そこで標準の書体で描けない字が付箋にあるときは、字の帯(ページ下端の帯・足すページ)を **worker の OffscreenCanvas で
  //   端末のフォントを使って PNG に描き**、`embedPng` で貼る(字は選択も検索もできない画像になる ── 英数字だけなら、今までどおり字で書く)。
  //   OffscreenCanvas / 2d が無い環境では、字を `?` に潰さず **`font` で断る**(画像の大きさの上限を超えるときも断る)。

  var FLAT = {
    // 下の端に並べる帯(ページの見える範囲の下から)。字の大きさ・行の高さ・帯の高さ・端からの余白(pt)
    size: 7, lead: 8.5, bandH: 30, edge: 7, side: 18,
    // 足すページ(A4 縦)
    pageW: 595.28, pageH: 841.89, listSize: 10, listLead: 13, listMargin: 40,
  };

  function numList(PDFLib, v) {
    if (!(v instanceof PDFLib.PDFArray)) return null;
    var out = [];
    for (var i = 0; i < v.size(); i += 1) {
      var n = v.lookup(i);
      if (!(n instanceof PDFLib.PDFNumber)) return null;
      out.push(n.asNumber());
    }
    return out;
  }

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  /** 注釈の色 `/C`(1 / 3 / 4 個の数)を RGB に。読めなければ `def`。 */
  function annotRgb(PDFLib, dict, def) {
    var c = numList(PDFLib, dict.lookup(PDFLib.PDFName.of('C')));
    if (!c) return def;
    if (c.length === 1) return [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])];
    if (c.length === 3) return c.map(clamp01);
    if (c.length === 4) return [0, 1, 2].map(function (i) { return clamp01((1 - c[i]) * (1 - c[3])); });
    return def;
  }

  /** `/Rect` を [x0, y0, x1, y1](小さい順)に。読めなければ `null`。 */
  function annotRect(PDFLib, dict) {
    var r = numList(PDFLib, dict.lookup(PDFLib.PDFName.of('Rect')));
    if (!r || r.length !== 4) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }

  /** 4 点の囲み(外側の長方形)を、ハイライトを塗る並び(左上・右上・左下・右下)で。ほかのアプリの点の並びの違いに左右されない。 */
  function quadBox(q) {
    var xs = [q[0], q[2], q[4], q[6]];
    var ys = [q[1], q[3], q[5], q[7]];
    var x0 = Math.min.apply(null, xs);
    var x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys);
    var y1 = Math.max.apply(null, ys);
    return [x0, y1, x1, y1, x0, y0, x1, y0];
  }

  /**
   * 🔴 **元の PDF にある注釈(ハイライト・ペン・付箋)を、描く物として集めて、注釈の並びから抜く**(`copyPages` の前、`prepareLinks` の前)。
   * 抜いた注釈は出力に入らない(吹き出し `/Popup` も。返信の `/IRT` の指し先が消える分は外す)。隠してある注釈(`/F` の Hidden / NoView)は
   * 描かずに抜く(隠してあった物を見える形にしない)。
   * @returns `{ highlights, strokes, notes }`(`page` は通し番号。`checkJob` の物と同じ形)
   */
  function collectFlat(PDFLib, docs, keptBy) {
    var N = PDFLib.PDFName;
    var D = PDFLib.PDFDict;
    var A = PDFLib.PDFArray;
    var R = PDFLib.PDFRef;
    var res = { highlights: [], strokes: [], notes: [] };
    docs.forEach(function (e, d) {
      var pages = e.doc.getPages();
      keptBy[d].forEach(function (idx) {
        var node = pages[idx].node;
        var annots = node.lookup(N.of('Annots'));
        if (!(annots instanceof A)) return;
        var through = e.first + idx;
        var gone = {};
        var kept = [];
        var found = [];
        for (var j = 0; j < annots.size(); j += 1) {
          var raw = annots.get(j);
          var dict = annots.lookup(j);
          var sub = dict instanceof D ? dict.lookup(N.of('Subtype')) : null;
          if (sub === N.of('Highlight') || sub === N.of('Ink') || sub === N.of('Text')) {
            found.push({ dict: dict, sub: sub });
            if (raw instanceof R) gone[refKey(raw)] = true;
            var pop = dict.get(N.of('Popup'));
            if (pop instanceof R) gone[refKey(pop)] = true;
            continue;
          }
          kept.push(raw);
        }
        if (found.length === 0) return;
        // 抜いた注釈の吹き出しと、返信の指し先を外す
        var rest = [];
        kept.forEach(function (raw) {
          var dict = raw instanceof R ? e.doc.context.lookup(raw) : raw;
          if (dict instanceof D) {
            var par = dict.get(N.of('Parent'));
            if (raw instanceof R && gone[refKey(raw)]) return;
            if (dict.lookup(N.of('Subtype')) === N.of('Popup') && par instanceof R && gone[refKey(par)]) return;
            var irt = dict.get(N.of('IRT'));
            if (irt instanceof R && gone[refKey(irt)]) dict.delete(N.of('IRT'));
          }
          rest.push(raw);
        });
        node.set(N.of('Annots'), e.doc.context.obj(rest));
        found.forEach(function (f) {
          var flags = f.dict.lookup(N.of('F'));
          var f0 = flags instanceof PDFLib.PDFNumber ? flags.asNumber() : 0;
          if ((f0 & 2) !== 0 || (f0 & 32) !== 0) return;
          var rect = annotRect(PDFLib, f.dict);
          if (f.sub === N.of('Highlight')) {
            var qp = numList(PDFLib, f.dict.lookup(N.of('QuadPoints')));
            var quads = [];
            if (qp && qp.length >= 8 && qp.length % 8 === 0) {
              for (var i = 0; i < qp.length; i += 8) quads.push(quadBox(qp.slice(i, i + 8)));
            } else if (rect) {
              quads.push([rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]]);
            }
            if (quads.length > 0) res.highlights.push({ page: through, rgb: annotRgb(PDFLib, f.dict, [1, 1, 0]), quads: quads });
          } else if (f.sub === N.of('Ink')) {
            var il = f.dict.lookup(N.of('InkList'));
            var paths = [];
            if (il instanceof A) {
              for (var k = 0; k < il.size(); k += 1) {
                var p = numList(PDFLib, il.lookup(k));
                if (p && p.length >= 4 && p.length % 2 === 0) paths.push(p);
              }
            }
            var width = 1;
            var bs = f.dict.lookup(N.of('BS'));
            var w1 = bs instanceof D ? bs.lookup(N.of('W')) : null;
            var bd = numList(PDFLib, f.dict.lookup(N.of('Border')));
            if (w1 instanceof PDFLib.PDFNumber) width = w1.asNumber();
            else if (bd && bd.length >= 3) width = bd[2];
            if (!(width > 0 && width <= 100)) width = 1;
            if (paths.length > 0) res.strokes.push({ page: through, rgb: annotRgb(PDFLib, f.dict, [0, 0, 0]), width: width, paths: paths });
          } else if (rect) {
            var c = f.dict.lookup(N.of('Contents'));
            var text = c && typeof c.decodeText === 'function' ? c.decodeText() : '';
            res.notes.push({ page: through, rect: rect, text: text });
          }
        });
      });
    });
    return res;
  }

  /** 字を 1 行に(改行・タブ・続く空白は空白 1 つ)。 */
  function oneLine(s) {
    return String(s).replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  }

  /** 標準書体で描けない字(全部描けるなら空)。 */
  function undrawable(font, text) {
    var bad = [];
    Array.from(text).forEach(function (ch) {
      try {
        font.encodeText(ch);
      } catch (e) {
        bad.push(ch);
      }
    });
    return bad;
  }

  /** `width` に収まるように折り返す(空白で切れるときは空白で、無ければ字ごと)。 */
  function wrapText(measure, text, size, width) {
    var lines = [];
    var cur = '';
    Array.from(text).forEach(function (ch) {
      var next = cur + ch;
      if (cur !== '' && measure(next, size) > width) {
        var sp = cur.lastIndexOf(' ');
        if (sp > 0 && ch !== ' ') {
          lines.push(cur.slice(0, sp));
          cur = cur.slice(sp + 1) + ch;
        } else {
          lines.push(cur);
          cur = ch === ' ' ? '' : ch;
        }
      } else {
        cur = next;
      }
    });
    if (cur !== '') lines.push(cur);
    return lines;
  }

  /** 字の画像の倍率(画面の 1pt を何画素で描くか)と、画像の 1 辺の上限(画素)。手違いの検出であって、使い方の上限ではない。 */
  var RASTER_SCALE = 3;
  var RASTER_MAX_PX = 4096;

  /**
   * 字を画像に描く道具。`env.OffscreenCanvas`(省略は global)が使えて 2d の文脈を持つときだけ作る ── 使えなければ `null`。
   * @returns `{ measure(text, size): pt の幅, render(lines, size, lead): Promise<{ bytes, width, height }> }` / `null`
   */
  function makeRaster(env) {
    var C = env && env.OffscreenCanvas !== undefined ? env.OffscreenCanvas : typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
    if (typeof C !== 'function') return null;
    var m;
    try {
      m = new C(1, 1).getContext('2d');
    } catch (e) {
      return null;
    }
    if (!m || typeof m.measureText !== 'function' || typeof m.fillText !== 'function') return null;
    var S = RASTER_SCALE;
    return {
      measure: function (text, size) {
        m.font = String(size * S) + 'px sans-serif';
        return m.measureText(text).width / S;
      },
      render: async function (lines, size, lead) {
        var wPt = 1;
        lines.forEach(function (l) {
          m.font = String(size * S) + 'px sans-serif';
          wPt = Math.max(wPt, m.measureText(l).width / S + 1);
        });
        var wPx = Math.ceil(wPt * S);
        var hPx = Math.ceil(lines.length * lead * S);
        if (wPx > RASTER_MAX_PX || hPx > RASTER_MAX_PX) throw fail(CODES.font);
        var c = new C(wPx, hPx);
        var g = c.getContext('2d');
        if (!g || typeof c.convertToBlob !== 'function') throw fail(CODES.font);
        g.font = String(size * S) + 'px sans-serif';
        g.fillStyle = '#000000';
        g.textBaseline = 'alphabetic';
        lines.forEach(function (l, i) {
          g.fillText(l, 0.5 * S, (i * lead + lead * 0.8) * S);
        });
        var blob = await c.convertToBlob({ type: 'image/png' });
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: wPt, height: lines.length * lead };
      },
    };
  }

  /**
   * 長方形 `box`({ x, y, width, height })を、見たままの向き(`r` = 見るときの回転 0 / 90 / 180 / 270)で見るための軸。
   * @returns `{ e: 右へ読む向き, u: 上の向き, bl: 見たときの左下の角(ページの座標), angle, w: 見たときの幅 }`
   */
  function viewAxes(box, r) {
    var x0 = box.x;
    var y0 = box.y;
    var x1 = box.x + box.width;
    var y1 = box.y + box.height;
    if (r === 90) return { e: [0, 1], u: [-1, 0], bl: [x1, y0], angle: 90, w: box.height };
    if (r === 180) return { e: [-1, 0], u: [0, -1], bl: [x1, y1], angle: 180, w: box.width };
    if (r === 270) return { e: [0, -1], u: [1, 0], bl: [x0, y1], angle: 270, w: box.height };
    return { e: [1, 0], u: [0, 1], bl: [x0, y0], angle: 0, w: box.width };
  }

  /**
   * 🔴 **付けるハイライト・ペン・付箋を、出力のページに描く**(`addHighlights` / `addNotes` / `addStrokes` の代わり ── 注釈は作らない)。
   * ハイライトは乗算で塗る(字は隠れない)。ペンは丸い端・継ぎ目。付箋は紙の色の小さな四角に番号。
   * @returns 足したページ(付箋の字が下の端に入りきらなかったときだけ)
   */
  async function drawFlat(PDFLib, out, pages, plan, env) {
    var ctx = out.context;
    var posOf = {};
    plan.order.forEach(function (p, i) {
      posOf[p] = i;
    });
    var byPage = {};
    function slot(p) {
      return (byPage[p] = byPage[p] || { hl: [], st: [], nt: [] });
    }
    plan.highlights.forEach(function (h) { slot(h.page).hl.push(h); });
    plan.strokes.forEach(function (s) { slot(s.page).st.push(s); });
    plan.notes.forEach(function (n) { slot(n.page).nt.push(n); });

    // 付箋の字が描けるかを、何も描く前に確かめる。標準の書体で描ければ字で書く / 描けない字があれば画像で貼る(道具が無ければ断る)。
    // ⚠ 番号(数字)は、どちらの場合も標準の書体で書く
    var font = null;
    var raster = null;
    var useImg = false;
    var withText = plan.notes.map(function (n) { return oneLine(n.text); }).filter(function (t) { return t !== ''; });
    if (withText.length > 0) {
      font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
      useImg = withText.some(function (t) { return undrawable(font, t).length > 0; });
      if (useImg) {
        raster = makeRaster(env);
        if (raster === null) throw fail(CODES.font);
      }
    }
    var measure = useImg ? raster.measure : function (t, sz) { return font.widthOfTextAtSize(t, sz); };
    // 字の塊(上から下へ並ぶ行)を、`P`(塊の左下のページの座標)に `angle` 度回して置く
    async function putBlock(page, lines, size, lead, P, angle) {
      var a = (angle * Math.PI) / 180;
      var u = [-Math.sin(a), Math.cos(a)];
      var pad = lead * 0.2;
      if (!useImg) {
        lines.forEach(function (l, i) {
          var d = pad + (lines.length - 1 - i) * lead;
          page.drawText(l, {
            x: P[0] + u[0] * d, y: P[1] + u[1] * d, size: size, font: font, color: PDFLib.rgb(0, 0, 0), rotate: PDFLib.degrees(angle),
          });
        });
        return;
      }
      var img = await raster.render(lines, size, lead);
      var emb = await out.embedPng(img.bytes);
      page.drawImage(emb, { x: P[0], y: P[1], width: img.width, height: img.height, rotate: PDFLib.degrees(angle) });
    }

    // 図形(ハイライト・ペン)は、ページごとに 1 つの Form にして、ページの内容の後ろに重ねる
    plan.order.forEach(function (p) {
      var s = byPage[p];
      if (!s || (s.hl.length === 0 && s.st.length === 0)) return;
      var page = pages[posOf[p]];
      var parts = [];
      s.hl.forEach(function (h) {
        var path = h.quads.map(function (q) {
          return fmt(q[0]) + ' ' + fmt(q[1]) + ' m ' + fmt(q[2]) + ' ' + fmt(q[3]) + ' l ' +
            fmt(q[6]) + ' ' + fmt(q[7]) + ' l ' + fmt(q[4]) + ' ' + fmt(q[5]) + ' l h f';
        });
        parts.push('q /GS0 gs ' + h.rgb.map(fmt).join(' ') + ' rg ' + path.join(' ') + ' Q');
      });
      s.st.forEach(function (st) {
        var draw = st.paths.map(function (pa) {
          var cmd = [];
          for (var i = 0; i < pa.length; i += 2) cmd.push(fmt(pa[i]) + ' ' + fmt(pa[i + 1]) + (i === 0 ? ' m' : ' l'));
          return cmd.join(' ') + ' S';
        });
        parts.push('q 1 J 1 j ' + fmt(st.width) + ' w ' + st.rgb.map(fmt).join(' ') + ' RG ' + draw.join(' ') + ' Q');
      });
      var mb = page.getMediaBox();
      var form = ctx.register(
        ctx.stream(parts.join(' '), {
          Type: 'XObject',
          Subtype: 'Form',
          // 注釈の座標はページの外へはみ出しうる ── 余裕をもって広く取る
          BBox: [mb.x - 10000, mb.y - 10000, mb.x + mb.width + 10000, mb.y + mb.height + 10000],
          Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply' } } },
        }),
      );
      // 元の内容が q / Q の釣り合いを崩していても、重ねる物が影響を受けないように囲う
      page.node.wrapContentStreams(ctx.register(ctx.stream('q')), ctx.register(ctx.stream('Q')));
      var key = page.node.newXObject('PkcFlat', form);
      page.node.addContentStream(ctx.register(ctx.stream('q ' + key.toString() + ' Do Q')));
    });

    // 付箋: 番号は出力のページの順に通して振る。字のある物だけ番号を振る
    var overflow = {}; // 下の端に入りきらなかったページ(出力の何番目か)
    var counter = 0;
    for (var oi = 0; oi < plan.order.length; oi += 1) {
      var s = byPage[plan.order[oi]];
      if (!s || s.nt.length === 0) continue;
      var page = pages[oi];
      var ax = viewAxes(page.getCropBox(), ((page.getRotation().angle % 360) + 360) % 360);
      var lines = [];
      s.nt.forEach(function (n) {
        var t = oneLine(n.text);
        var label = '';
        if (t !== '') {
          counter += 1;
          label = String(counter);
          wrapText(measure, label + '. ' + t, FLAT.size, ax.w - FLAT.side * 2).forEach(function (l) { lines.push(l); });
        }
        // 付箋の位置の目印(紙の色の四角 + 番号)。番号の向きはページを見たままに合わせる
        var w = Math.max(n.rect[2] - n.rect[0], 8);
        var h = Math.max(n.rect[3] - n.rect[1], 8);
        page.drawRectangle({
          x: n.rect[0], y: n.rect[1], width: w, height: h,
          color: PDFLib.rgb(1, 0.96, 0.62), borderColor: PDFLib.rgb(0.35, 0.3, 0.1), borderWidth: 0.6,
        });
        if (label !== '') {
          var rb = viewAxes({ x: n.rect[0], y: n.rect[1], width: w, height: h }, ax.angle);
          page.drawText(label, {
            x: rb.bl[0] + rb.e[0] * 1.5 + rb.u[0] * 1.5, y: rb.bl[1] + rb.e[1] * 1.5 + rb.u[1] * 1.5,
            size: Math.max(4, Math.min(8, Math.min(w, h) * 0.7)), font: font, color: PDFLib.rgb(0, 0, 0),
            rotate: PDFLib.degrees(ax.angle),
          });
        }
      });
      if (lines.length === 0) continue;
      if (lines.length > Math.floor(FLAT.bandH / FLAT.lead)) {
        overflow[oi + 1] = true;
        continue;
      }
      await putBlock(
        page, lines, FLAT.size, FLAT.lead,
        [ax.bl[0] + ax.e[0] * FLAT.side + ax.u[0] * FLAT.edge, ax.bl[1] + ax.e[1] * FLAT.side + ax.u[1] * FLAT.edge],
        ax.angle,
      );
    }

    // 入りきらなかったページの字は、最後に足すページに(ページごとの見出し + 「番号. 字」。番号は上と通し)
    var added = [];
    if (Object.keys(overflow).length > 0) {
      var rows = [];
      var seen = 0;
      plan.order.forEach(function (p, outPos) {
        var s2 = byPage[p];
        if (!s2) return;
        var first = true;
        s2.nt.forEach(function (n) {
          var t = oneLine(n.text);
          if (t === '') return;
          seen += 1;
          if (!overflow[outPos + 1]) return;
          if (first) {
            rows.push(useImg ? String(outPos + 1) + ' ページ' : 'Page ' + String(outPos + 1));
            first = false;
          }
          wrapText(measure, String(seen) + '. ' + t, FLAT.listSize, FLAT.pageW - FLAT.listMargin * 2).forEach(function (l) {
            rows.push(l);
          });
        });
      });
      var per = Math.floor((FLAT.pageH - FLAT.listMargin * 2) / FLAT.listLead);
      for (var at = 0; at < rows.length; at += per) {
        var np = out.addPage([FLAT.pageW, FLAT.pageH]);
        var chunk = rows.slice(at, at + per);
        await putBlock(np, chunk, FLAT.listSize, FLAT.listLead, [FLAT.listMargin, FLAT.pageH - FLAT.listMargin - chunk.length * FLAT.listLead], 0);
        added.push(np);
      }
    }
    return added;
  }

  /** 出力の中の Page 辞書の数(孤立したものも含む。全部の間接物を数える)。 */
  function countPageDicts(PDFLib, doc) {
    var type = PDFLib.PDFName.of('Type');
    var page = PDFLib.PDFName.of('Page');
    var n = 0;
    doc.context.enumerateIndirectObjects().forEach(function (pair) {
      var obj = pair[1];
      if (obj instanceof PDFLib.PDFDict && obj.get(type) === page) n += 1;
    });
    return n;
  }

  // ───────── 🔴 共有された部品(Resources)から、選ばなかったページの部品を落とす
  //
  // `copyPages` は残すページの `/Resources` を**辞書ごと**写す。外したページと Resources を共有していると、
  // その中の XObject(図・画像・Form)も道連れに出力へ入り、**外したページだけが使っていた絵や字が file に残る**
  // (2026-10-11 の着地前レビューで実測: 共有 Resources の Form XObject に書いた字が、1 ページだけ残した出力に在った)。
  // 残すページの content stream が**実際に使う名前**だけを残した別の Resources を作って付け替え、
  // 付け替えて辿れなくなった物は出力から捨てる(`dropUnreachable`)。
  // ⚠ 保証するのは **XObject / Pattern / Shading / Font / ExtGState / ColorSpace / Properties**(ProcSet はそのまま ── 名前を持たない)。
  //   ColorSpace(ICC プロファイルを持ちうる)と Properties(BDC / DP の印の属性。名前・情報を持ちうる)は、外したページだけが
  //   使っていた物が共有 Resources に乗って来る(#275)。残すページの注釈の外観(`/AP`)の部品も同じ道で刈る。
  // ⚠ ColorSpace の `DefaultGray` / `DefaultRGB` / `DefaultCMYK` は content に名前が出ないまま効くので、**常に残す**。
  //   画像 XObject の `/ColorSpace /名前` と、残す ColorSpace の配列の中の名前も「使う」と数える(多めに残す側)。
  // ⚠ 名前の拾い方は**多めに残す側**(content 中の `/名前` を全部「使う」と数える)── 足りないと残すページが壊れる。
  // ⚠ content が読めない(未対応の圧縮)ときは刈らずに **leaked で断る**(漏れるより断る)。

  var PRUNED = ['XObject', 'Pattern', 'Shading', 'Font', 'ExtGState', 'ColorSpace', 'Properties'];
  /** content に名前が出ないまま効く部品(ColorSpace の既定)。 */
  var IMPLICIT = { ColorSpace: ['DefaultGray', 'DefaultRGB', 'DefaultCMYK'] };

  /** content の `/名前` を全部集める(生の綴りと、`#xx` を戻した綴りの両方)。 */
  function addNames(set, bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
    var re = /\/([^\x00\t\n\f\r \/\[\]()<>{}%]+)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      set.add(m[1]);
      set.add(
        m[1].replace(/#([0-9a-fA-F]{2})/g, function (_, h) {
          return String.fromCharCode(parseInt(h, 16));
        }),
      );
    }
  }

  function isUsed(set, nameObj) {
    var raw = nameObj.asString().slice(1);
    return set.has(raw) || (typeof nameObj.decodeText === 'function' && set.has(nameObj.decodeText()));
  }

  /** stream の展開した中身。読めなければ leaked で投げる。 */
  function streamBytes(PDFLib, st) {
    try {
      if (st instanceof PDFLib.PDFRawStream) return PDFLib.decodePDFRawStream(st).decode();
      if (typeof st.getUnencodedContents === 'function') return st.getUnencodedContents();
      if (!st.dict.has(PDFLib.PDFName.of('Filter'))) return st.getContents();
    } catch (e) {
      /* 下で断る */
    }
    throw fail(CODES.leaked);
  }

  function isStream(PDFLib, o) {
    return !!o && o.dict instanceof PDFLib.PDFDict && typeof o.getContents === 'function';
  }

  /** ページの content stream(1 本でも配列でも)。 */
  function pageStreams(PDFLib, node) {
    var c = node.lookup(PDFLib.PDFName.of('Contents'));
    var out = [];
    if (isStream(PDFLib, c)) out.push(c);
    else if (c instanceof PDFLib.PDFArray) {
      for (var i = 0; i < c.size(); i += 1) {
        var one = c.lookup(i);
        if (isStream(PDFLib, one)) out.push(one);
      }
    }
    return out;
  }

  /**
   * `res`(Resources)を、`used` の名前だけ残した別の辞書にして `assign` で付け替える。
   * 中で使う Form XObject は、自前の Resources があれば再帰で同じように刈り、無ければその中の名前も `used` に足す
   * (持たない Form は呼び元の Resources を使うため)。
   * @returns 落とした部品の数(出力の読み直しで 0 であることが、最後の門の一部)
   */
  function pruneResources(PDFLib, ctx, res, used, seenForms, assign) {
    var N = PDFLib.PDFName;
    var D = PDFLib.PDFDict;
    var xo = res.lookup(N.of('XObject'));
    var walked = {};
    var dropped = 0;
    var again = true;
    while (again) {
      again = false;
      if (xo instanceof D) {
        xo.entries().forEach(function (pair) {
          var id = pair[0].asString();
          if (walked[id] || !isUsed(used, pair[0])) return;
          walked[id] = true;
          var obj = xo.lookup(pair[0]);
          if (isStream(PDFLib, obj) && obj.dict.lookup(N.of('Subtype')) === N.of('Image')) {
            // 画像の `/ColorSpace /名前` は、呼び元の Resources の ColorSpace を引くことがある(多めに残す)
            var ics = obj.dict.lookup(N.of('ColorSpace'));
            if (ics instanceof PDFLib.PDFName) used.add(ics.asString().slice(1));
          }
          if (!isStream(PDFLib, obj) || obj.dict.lookup(N.of('Subtype')) !== N.of('Form')) return;
          var bytes = streamBytes(PDFLib, obj);
          var own = obj.dict.lookup(N.of('Resources'));
          if (own instanceof D) {
            if (seenForms.has(obj)) return;
            seenForms.add(obj);
            var inner = new Set();
            addNames(inner, bytes);
            dropped += pruneResources(PDFLib, ctx, own, inner, seenForms, function (r) {
              obj.dict.set(N.of('Resources'), r);
            });
          } else {
            addNames(used, bytes);
            again = true;
          }
        });
      }
    }
    // 残す ColorSpace の配列の中の名前(`[/Indexed /Cs2 ...]` など)も使う印に数える(固定点まで)
    var cs = res.lookup(N.of('ColorSpace'));
    if (cs instanceof D) {
      var grew = true;
      while (grew) {
        grew = false;
        cs.entries().forEach(function (e) {
          var nm = e[0].asString().slice(1);
          if (!isUsed(used, e[0]) && IMPLICIT.ColorSpace.indexOf(nm) === -1) return;
          var v = cs.lookup(e[0]);
          if (!(v instanceof PDFLib.PDFArray)) return;
          v.asArray().forEach(function (x) {
            if (x instanceof PDFLib.PDFName && !used.has(x.asString().slice(1))) {
              used.add(x.asString().slice(1));
              grew = true;
            }
          });
        });
      }
    }
    var fresh = ctx.obj({});
    res.entries().forEach(function (pair) {
      var key = pair[0];
      var kind = key.asString().slice(1);
      var sub = res.lookup(key);
      if (PRUNED.indexOf(kind) === -1 || !(sub instanceof D)) {
        fresh.set(key, pair[1]);
        return;
      }
      var kept = ctx.obj({});
      sub.entries().forEach(function (e) {
        var implicit = (IMPLICIT[kind] || []).indexOf(e[0].asString().slice(1)) !== -1;
        if (implicit || isUsed(used, e[0])) kept.set(e[0], e[1]);
        else dropped += 1;
      });
      fresh.set(key, kept);
    });
    assign(fresh);
    return dropped;
  }

  /** 注釈の外観(`/AP` の /N /R /D。状態ごとの辞書も)の Form stream。 */
  function annotAppearances(PDFLib, node) {
    var N = PDFLib.PDFName;
    var out = [];
    var annots = node.lookup(N.of('Annots'));
    if (!(annots instanceof PDFLib.PDFArray)) return out;
    for (var i = 0; i < annots.size(); i += 1) {
      var a = annots.lookup(i);
      if (!(a instanceof PDFLib.PDFDict)) continue;
      var ap = a.lookup(N.of('AP'));
      if (!(ap instanceof PDFLib.PDFDict)) continue;
      ['N', 'R', 'D'].forEach(function (k) {
        var v = ap.lookup(N.of(k));
        if (isStream(PDFLib, v)) out.push(v);
        else if (v instanceof PDFLib.PDFDict) {
          v.entries().forEach(function (p) {
            var one = v.lookup(p[0]);
            if (isStream(PDFLib, one)) out.push(one);
          });
        }
      });
    }
    return out;
  }

  /** @returns 落とした部品の数 */
  function pruneOutputPage(PDFLib, ctx, node, seenForms) {
    var N = PDFLib.PDFName;
    var used = new Set();
    var dropped = 0;
    pageStreams(PDFLib, node).forEach(function (st) {
      addNames(used, streamBytes(PDFLib, st));
    });
    // 残す注釈の外観: 自前の Resources があればそこを刈り、無ければページの Resources を使うので名前をページへ足す
    annotAppearances(PDFLib, node).forEach(function (ap) {
      var bytes = streamBytes(PDFLib, ap);
      var own = ap.dict.lookup(N.of('Resources'));
      if (own instanceof PDFLib.PDFDict) {
        if (seenForms.has(ap)) return;
        seenForms.add(ap);
        var inner = new Set();
        addNames(inner, bytes);
        dropped += pruneResources(PDFLib, ctx, own, inner, seenForms, function (r) {
          ap.dict.set(N.of('Resources'), r);
        });
      } else {
        addNames(used, bytes);
      }
    });
    var res = node.Resources();
    if (!(res instanceof PDFLib.PDFDict)) return dropped;
    dropped += pruneResources(PDFLib, ctx, res, used, seenForms, function (r) {
      node.set(N.of('Resources'), r);
    });
    return dropped;
  }

  /** 文書の入口(Root / Info)から辿れる間接オブジェクトの参照の集まり。 */
  function reachableRefs(PDFLib, ctx) {
    var seen = new Set();
    var stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
    while (stack.length > 0) {
      var o = stack.pop();
      if (!o) continue;
      if (o instanceof PDFLib.PDFRef) {
        var k = o.toString();
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(ctx.lookup(o));
      } else if (o instanceof PDFLib.PDFDict) {
        o.entries().forEach(function (p) {
          stack.push(p[1]);
        });
      } else if (o instanceof PDFLib.PDFArray) {
        o.asArray().forEach(function (v) {
          stack.push(v);
        });
      } else if (o.dict instanceof PDFLib.PDFDict) {
        stack.push(o.dict);
      }
    }
    return seen;
  }

  /** 辿れない間接オブジェクトの参照(読み直した文書の物は、保存の仕組みが作る ObjStm / XRef を除く)。 */
  function unreachableRefs(PDFLib, ctx) {
    var seen = reachableRefs(PDFLib, ctx);
    var type = PDFLib.PDFName.of('Type');
    var out = [];
    ctx.enumerateIndirectObjects().forEach(function (pair) {
      if (seen.has(pair[0].toString())) return;
      var obj = pair[1];
      if (obj && obj.dict instanceof PDFLib.PDFDict) {
        var t = obj.dict.get(type);
        if (t === PDFLib.PDFName.of('ObjStm') || t === PDFLib.PDFName.of('XRef')) return;
      }
      out.push(pair[0]);
    });
    return out;
  }

  /**
   * 🔴 最後の門: 出力を読み直し、①Page 辞書が**残すページの数ちょうど**(孤立したページ = 外したページの中身が混ざっていない)
   * ②文書の入口(Root / Info)から**辿れない間接オブジェクトが 1 つも無い**(どの道で入った物でも、残すページの持ち物でない物は渡さない)
   * ことを確かめる。満たさなければ **leaked で投げる**。
   */
  async function verify(PDFLib, saved, pageCount) {
    var again = await loadSource(PDFLib, saved);
    if (countPageDicts(PDFLib, again) !== pageCount) throw fail(CODES.leaked);
    if (unreachableRefs(PDFLib, again.context).length > 0) throw fail(CODES.leaked);
    // 部品の表(Resources)に、使われない名前が残っていないこと(もう一度刈って 0 件。読み直した使い捨ての文書の上で)
    var seenForms = new Set();
    var left = 0;
    again.getPages().forEach(function (page) {
      left += pruneOutputPage(PDFLib, again.context, page.node, seenForms);
    });
    if (left > 0) throw fail(CODES.leaked);
  }

  /**
   * 新しい PDF を作る。@param bytes 元の PDF @param job `{ order, rotate, sources?, highlights?, removals?, notes?, strokes? }`
   * @param extras 足した PDF の bytes(`job.sources` と同じ数・同じ順 ── 各 PDF のページ数は `count` と一致すること)
   * @param env 省略可。`{ OffscreenCanvas }`(省略は global ── 注釈の書き込みで標準の書体では描けない字を画像にするのに使う。test が差し替える)
   * @returns `Uint8Array`(⚠ 呼び側が transfer する。大きさぴったりの buffer)
   *
   * 🔴 **足した PDF も、元の PDF と同じ道**(新しい文書へ、残すページだけを `copyPages` で写す)を通る ── 文書ごとに
   * リンクの付け替えを済ませて写し、最後に `order` の順に並べる。外したページの中身・辿れない物は、
   * 全部の文書をまとめた出力に対して最後の門(`verify`)が断る。
   */
  async function build(PDFLib, bytes, job, extras, env) {
    var src = await loadSource(PDFLib, bytes);
    var plan = checkJob(job, src.getPageCount());
    var more = Array.isArray(extras) ? extras : [];
    if (more.length !== plan.sources.length) throw fail(CODES.badJob);
    // 文書 0 = 元の PDF / 文書 1〜 = 足した PDF。`docs[d].first` = 通し番号の先頭
    var docs = [{ doc: src, first: 1, count: src.getPageCount() }];
    for (var d = 0; d < more.length; d += 1) {
      var one = await loadSource(PDFLib, more[d]);
      if (one.getPageCount() !== plan.sources[d].count) throw fail(CODES.badJob);
      docs.push({ doc: one, first: plan.sources[d].first, count: plan.sources[d].count });
    }
    function where(p) {
      for (var k = docs.length - 1; k >= 0; k -= 1) if (p >= docs[k].first) return { d: k, idx: p - docs[k].first };
      return { d: 0, idx: p - 1 };
    }
    // 🔴 外すと言われたハイライトを、先に残すページの並びから抜く(`prepareLinks` が注釈の位置を数える前に。元の PDF だけ)
    dropHighlights(PDFLib, src, plan.removals);
    // 文書ごとに、残すページ(出力の順)
    var keptBy = docs.map(function () {
      return [];
    });
    plan.order.forEach(function (p) {
      var w = where(p);
      keptBy[w.d].push(w.idx);
    });
    // 🔴 注釈をページに書き込むなら、元の PDF の注釈(ハイライト・ペン・付箋)も描く物として集め、並びから抜く
    //    (`prepareLinks` が注釈の位置を数える前に)
    if (plan.flatten) {
      var flat = collectFlat(PDFLib, docs, keptBy);
      plan.highlights = flat.highlights.concat(plan.highlights);
      plan.strokes = flat.strokes.concat(plan.strokes);
      plan.notes = flat.notes.concat(plan.notes);
    }
    // 🔴 `copyPages` の前に、リンクの注釈が持つページの参照を扱う(でないと外したページが孤立して出力に入る)
    var links = docs.map(function (e, k) {
      return keptBy[k].length === 0 ? null : prepareLinks(PDFLib, e.doc, keptBy[k]);
    });
    var out = await PDFLib.PDFDocument.create();
    copyInfo(src, out);
    var copied = [];
    for (var c = 0; c < docs.length; c += 1) {
      copied.push(keptBy[c].length === 0 ? [] : await out.copyPages(docs[c].doc, keptBy[c]));
    }
    var cursor = docs.map(function () {
      return 0;
    });
    var pages = plan.order.map(function (p) {
      var w = where(p);
      var page = copied[w.d][cursor[w.d]];
      cursor[w.d] += 1;
      var turn = plan.rotate[p] || 0;
      if (turn !== 0) {
        var now = page.getRotation().angle;
        page.setRotation(PDFLib.degrees((((now + turn) % 360) + 360) % 360));
      }
      out.addPage(page);
      return page;
    });
    links.forEach(function (l, k) {
      if (l !== null) l.restore(out, copied[k]);
    });
    // 付けるハイライトは、写した後の出力のページへ(`restore` が注釈の位置を使い終えた後)
    // 🔴 「注釈をページに書き込んで保存」なら、注釈は作らずページに描く(付箋の字が入りきらないときは、最後にページを足す)
    var addedPages = [];
    if (plan.flatten) {
      addedPages = await drawFlat(PDFLib, out, pages, plan, env);
    } else {
      addHighlights(PDFLib, out, pages, plan);
      addNotes(PDFLib, out, pages, plan);
      addStrokes(PDFLib, out, pages, plan);
    }
    // 🔴 共有された Resources に乗って来た、選ばなかったページの部品を落とす(上の注釈)
    var seenForms = new Set();
    pages.concat(addedPages).forEach(function (page) {
      pruneOutputPage(PDFLib, out.context, page.node, seenForms);
    });
    unreachableRefs(PDFLib, out.context).forEach(function (ref) {
      out.context.delete(ref);
    });
    var saved = await out.save();
    // 🔴 最後の門(`verify`)── 出力を読み直して確かめる
    await verify(PDFLib, saved, plan.order.length + addedPages.length);
    // 🔑 transfer するので、buffer が大きさぴったりであること(余りを付けて渡さない)
    if (saved.byteOffset === 0 && saved.byteLength === saved.buffer.byteLength) return saved;
    return saved.slice();
  }

  root.PkcPdfEditCore = { CODES: CODES, check: check, checkJob: checkJob, build: build, verify: verify };
})(typeof self !== 'undefined' ? self : this);
