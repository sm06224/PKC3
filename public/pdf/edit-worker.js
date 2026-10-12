/**
 * ページの編集の worker(#275 段②-1b)── 窓の中で動く**使い捨て**の worker。
 *
 * 🔴 不可侵指示(重い処理はワーカーへ・使い捨て)に沿って、pdf-lib を動かす重い処理はメインスレッドの外へ置く。
 * 起動・依頼のバッファ・アイドルで畳む・畳むときに待っている依頼を reject する、は窓の側
 * (`reader.js` が `doc-lease.js` を使って握る)。ここは**言われた依頼を 1 件ずつ処理して返すだけ**。
 *
 * 封筒: `{ id, op: 'check' | 'build', bytes: ArrayBuffer, job?, extras?: ArrayBuffer[] }`(`extras` = 後ろに足す PDF。`job.sources` と同じ数・順) → `{ id, ok: true, pages? | bytes }` /
 * `{ id, ok: false, code }`。bytes は**窓から transfer で来て、結果も transfer で返す**(ゼロコピー)。
 * 作り方は `edit-core.js`(読み込む pdf-lib は `./lib/pdf-lib.min.js` ── ビルド時に `node_modules` から写される)。
 *
 * ⚠ 素の JS(classic worker)。`importScripts` は worker を作った時点で pdf-lib の読み込みまで済ませる
 *   (取れなければ worker ごと error になり、窓が「編集できない」と言う)。
 */
/* global importScripts, PDFLib */
importScripts('./edit-core.js', './lib/pdf-lib.min.js');

self.onmessage = async function (ev) {
  var m = ev.data;
  try {
    var core = self.PkcPdfEditCore;
    var bytes = new Uint8Array(m.bytes);
    if (m.op === 'check') {
      var pages = await core.check(PDFLib, bytes);
      self.postMessage({ id: m.id, ok: true, pages: pages });
    } else if (m.op === 'build') {
      var extras = Array.isArray(m.extras)
        ? m.extras.map(function (b) {
            return new Uint8Array(b);
          })
        : [];
      var out = await core.build(PDFLib, bytes, m.job, extras);
      self.postMessage({ id: m.id, ok: true, bytes: out.buffer }, [out.buffer]);
    } else {
      self.postMessage({ id: m.id, ok: false, code: core.CODES.badJob });
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, code: e && e.pkcCode ? e.pkcCode : 'unreadable' });
  }
};
