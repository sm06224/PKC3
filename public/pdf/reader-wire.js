/**
 * 窓 ⇄ 本体の**封筒**(#275 段①)── 窓の側の綴り。
 *
 * 🔴 **本体側の綴りは `src/adapter/platform/pdf/pdf-window.ts`**。同じ値を 2 か所に持つので、
 * `tests/adapter/pdf-window.test.ts` が**この file を実物として走らせ**、本体の実物と
 * 繋いで突き合わせる(両側が自分の literal を pin しているだけでは、一貫して改名したとき
 * 緑のまま本番だけ壊れる ── CLAUDE.md §7)。
 *
 * ⚠ 封筒を**組む口はここの `envelope` 1 つ**(窓 → 本体)。reader.js が直に組まない。
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 */
(function (root) {
  'use strict';

  /** 放送の名前。⚠ 本体の `PDF_CHANNEL` と同じ綴り。 */
  var CHANNEL = 'pkc3-pdf';
  /** 種別を載せる鍵。⚠ 本体の `PDF_TAG` と同じ綴り。 */
  var TAG = 'pkc3Pdf';
  /** 1 回に引ける字の上限(UTF-8 byte)。⚠ 本体の `PDF_QUOTE_MAX_BYTES` と同じ値。 */
  var QUOTE_MAX_BYTES = 64 * 1024;
  /** 超過の断り。⚠ 本体の `PDF_QUOTE_TOO_LONG` と同じ字。 */
  var QUOTE_TOO_LONG = '選んだ字が長すぎます(64KB まで)。短く選び直してください';

  /** 窓 → 本体の封筒を組む(唯一の口)。 */
  function envelope(kind, token, payload) {
    var m = {};
    m[TAG] = kind;
    m.token = token;
    m.payload = payload || {};
    return m;
  }

  /**
   * 本体 → 窓の封筒を読む。⚠ **自分の token のものだけ**返す(他の窓宛ては捨てる)。
   * @returns {{kind: string, payload: object} | null}
   */
  function parse(data, token) {
    if (typeof data !== 'object' || data === null) return null;
    var kind = data[TAG];
    if (typeof kind !== 'string' || data.token !== token) return null;
    var payload = typeof data.payload === 'object' && data.payload !== null ? data.payload : {};
    return { kind: kind, payload: payload };
  }

  /** UTF-8 での長さ(上位・下位サロゲートの対は 4 byte)。 */
  function utf8Length(text) {
    var n = 0;
    for (var i = 0; i < text.length; i += 1) {
      var c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        var d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          n += 4;
          i += 1;
        } else n += 3;
      } else n += 3;
    }
    return n;
  }

  /** 引く前の検め(親切。最後の門は本体側)。@returns 断りの字 / 通すなら `null` */
  function checkQuote(text) {
    return utf8Length(text) > QUOTE_MAX_BYTES ? QUOTE_TOO_LONG : null;
  }

  root.PkcPdfWire = {
    CHANNEL: CHANNEL,
    TAG: TAG,
    QUOTE_MAX_BYTES: QUOTE_MAX_BYTES,
    QUOTE_TOO_LONG: QUOTE_TOO_LONG,
    envelope: envelope,
    parse: parse,
    utf8Length: utf8Length,
    checkQuote: checkQuote,
  };
})(typeof self !== 'undefined' ? self : this);
