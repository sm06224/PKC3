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
 * ⚠ B は文書全体の設定(しおり・入力欄・電子署名)を引き継がない ── 画面が保存の前に 1 行で言う(`page-edit.js` の `noteLine`)。
 * 引き継ぐのは題名・作成者・件名・キーワード・作成日時(`copyInfo`)。
 *
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-edit-core.test.ts` が**この file の原文を読んで**、実物の pdf-lib で走らせる。
 */
(function (root) {
  'use strict';

  /** 断りの種類。窓が user の言葉に直す(`reader.js`)。 */
  var CODES = { encrypted: 'encrypted', unreadable: 'unreadable', badJob: 'bad-job', leaked: 'leaked' };

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
   * 依頼 `{ order, rotate }` を確かめる。@returns 正規化した依頼 / 不正なら `bad-job` で投げる
   * - `order`: 1 以上のページ番号の並び(空でない・重ならない・文書のページ数以内)
   * - `rotate`: 元のページ番号 → 右へ回す角度(90 の倍数)。`order` に無いページは受けない
   */
  function checkJob(job, pageCount) {
    if (!job || !Array.isArray(job.order) || job.order.length < 1) throw fail(CODES.badJob);
    var seen = {};
    job.order.forEach(function (p) {
      if (!Number.isInteger(p) || p < 1 || p > pageCount || seen[p]) throw fail(CODES.badJob);
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
    return { order: job.order.slice(), rotate: rotate };
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

  /**
   * 新しい PDF を作る。@param bytes 元の PDF @param job `{ order, rotate }`
   * @returns `Uint8Array`(⚠ 呼び側が transfer する。大きさぴったりの buffer)
   */
  async function build(PDFLib, bytes, job) {
    var src = await loadSource(PDFLib, bytes);
    var plan = checkJob(job, src.getPageCount());
    // 🔴 `copyPages` の前に、リンクの注釈が持つページの参照を扱う(でないと外したページが孤立して出力に入る)
    var links = prepareLinks(
      PDFLib,
      src,
      plan.order.map(function (p) {
        return p - 1;
      }),
    );
    var out = await PDFLib.PDFDocument.create();
    copyInfo(src, out);
    var pages = await out.copyPages(
      src,
      plan.order.map(function (p) {
        return p - 1;
      }),
    );
    pages.forEach(function (page, i) {
      var turn = plan.rotate[plan.order[i]] || 0;
      if (turn !== 0) {
        var now = page.getRotation().angle;
        page.setRotation(PDFLib.degrees((((now + turn) % 360) + 360) % 360));
      }
      out.addPage(page);
    });
    links.restore(out, pages);
    var saved = await out.save();
    // 🔴 最後の門: 出力を読み直し、Page 辞書が**残すページの数ちょうど**であること。孤立したページ(= 外したページの中身)が
    //    1 つでも混ざっていたら、**渡さずに断る**(上の注釈の切り落としが届かない形への備え)
    var again = await loadSource(PDFLib, saved);
    if (countPageDicts(PDFLib, again) !== plan.order.length) throw fail(CODES.leaked);
    // 🔑 transfer するので、buffer が大きさぴったりであること(余りを付けて渡さない)
    if (saved.byteOffset === 0 && saved.byteLength === saved.buffer.byteLength) return saved;
    return saved.slice();
  }

  root.PkcPdfEditCore = { CODES: CODES, check: check, checkJob: checkJob, build: build };
})(typeof self !== 'undefined' ? self : this);
