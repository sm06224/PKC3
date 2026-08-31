/** @vitest-environment happy-dom */
/**
 * 🔴 **「開き直せば反映される」を、こちらから言えるか**(#160)。
 *
 * UI 言語を変えると LO は再起動ダイアログを出すが、`すぐに再起動` は **wasm では
 * 何も起こさない**(実機レポート #8、1/1)。死んでいるのは LO の canvas の中の
 * ボタンなので書き換えられない ── だから**こちら側に効く道**を出す。
 *
 * ⚠ `public/office/office-restart-watch.js` は **bundle されない素の JS** である
 * (`host.html` が `<script src>` で読む)。`readFileSync` + `new Function` で読み込んで
 * 当てる ── これをやらないと、この判断は**どの test からも実行されない**。
 *
 * 🔴 守る主張:
 * 1. 見るのは **`/org.openoffice.Office.Linguistic/General` の `UILocale`**
 *    (⚠ もっともらしい `ooLocale` では**ない** ── 上流を読んで確かめた)
 * 2. **path も name も**一致した prop だけを採る(散文や別 path に満たされない)
 * 3. 「読めなかった」と「書かれていない」を混ぜない
 * 4. 最初の 1 回は**基準を採るだけ**。変化は **1 度だけ**言う(掛け金)
 * 5. `host.html` は判断をここへ委ねている(直書きへ戻していない)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

interface Watch {
  note(text: unknown): boolean;
  baseline(): string | null;
  latched(): boolean;
}
interface Api {
  UI_LOCALE_PATH: string;
  UI_LOCALE_KEY: string;
  readUiLocale(text: unknown): string | null;
  createRestartWatch(): Watch;
}

function load(): Api {
  const src = readFileSync('public/office/office-restart-watch.js', 'utf-8');
  // ⚠ **`DOMParser` を渡す。** この素の JS は `root.DOMParser` を使うので、
  //    空の scope で読むと `readUiLocale` が**常に null** を返し、
  //    以下の検査が全部「読めなかった」で素通りする(空振り)。
  const scope: Record<string, unknown> = { DOMParser: globalThis.DOMParser };
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeRestartWatch as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const api = load();

/** `registrymodifications.xcu` の骨組み(実物と同じ名前空間)。 */
const xcu = (items: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<oor:items xmlns:oor="http://openoffice.org/2001/registry"'
  + ' xmlns:xs="http://www.w3.org/2001/XMLSchema"'
  + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + items + '</oor:items>';

/** UI 言語の item(実物の形)。 */
const uiLocale = (v: string): string =>
  '<item oor:path="/org.openoffice.Office.Linguistic/General">'
  + '<prop oor:name="UILocale" oor:op="fuse">'
  + (v === '' ? '<value/>' : '<value>' + v + '</value>')
  + '</prop></item>';

/** 無関係だが**よく似た**item(ここに満たされてはいけない)。 */
const NOISE =
  '<item oor:path="/org.openoffice.Setup/L10N">'
  + '<prop oor:name="ooLocale" oor:op="fuse"><value>de-DE</value></prop>'
  + '<prop oor:name="ooSetupSystemLocale" oor:op="fuse"><value>de-DE</value></prop></item>'
  // ⚠ **同じ key を別の path の下に置く** ── path を見ていなければここに当たる
  + '<item oor:path="/org.openoffice.Office.Common/Misc">'
  + '<prop oor:name="UILocale" oor:op="fuse"><value>zz-ZZ</value></prop></item>';

describe('UI 言語の値を読む', () => {
  it('🔴 見るのは Linguistic/General の UILocale である(ooLocale ではない)', () => {
    // ⚠ ここは**上流を読んで確かめた事実**の pin である
    //    (cui/source/options/optgdlg.cxx:885-886 → :1153 → executeRestartDialog)。
    //    ⚠ 名前を書き換える変異は、この 2 行で殺す
    expect(api.UI_LOCALE_PATH).toBe('/org.openoffice.Office.Linguistic/General');
    expect(api.UI_LOCALE_KEY).toBe('UILocale');
  });

  it('書かれている値を採る', () => {
    expect(api.readUiLocale(xcu(uiLocale('en-US')))).toBe('en-US');
  });

  it('🔴 別の path の同名 prop / 別 key の locale に満たされない', () => {
    // 雑音だけ ── UI 言語は「書かれていない」= 空文字
    expect(api.readUiLocale(xcu(NOISE))).toBe('');
    // 雑音と並んでいても、採るのは本物のほう
    expect(api.readUiLocale(xcu(NOISE + uiLocale('ja')))).toBe('ja');
  });

  it('🔴 「読めなかった(null)」と「書かれていない(空)」を混ぜない', () => {
    expect(api.readUiLocale(xcu(''))).toBe('');            // 書かれていない
    expect(api.readUiLocale(xcu(uiLocale('')))).toBe('');   // 既定へ戻した
    expect(api.readUiLocale('<oor:items>壊れ')).toBeNull(); // 読めない
    expect(api.readUiLocale('')).toBeNull();
    expect(api.readUiLocale(undefined)).toBeNull();
  });
});

describe('再起動が要ることに気づく', () => {
  it('🔴 最初の 1 回は基準を採るだけ(帯を出さない)', () => {
    const w = api.createRestartWatch();
    expect(w.note(xcu(uiLocale('ja')))).toBe(false);
    expect(w.baseline()).toBe('ja');
    // ⚠ 同じ値をいくら流しても言わない
    expect(w.note(xcu(uiLocale('ja')))).toBe(false);
  });

  it('🔴 値が変わったら 1 度だけ言う(帯は 1 枚)', () => {
    const w = api.createRestartWatch();
    w.note(xcu(uiLocale('ja')));
    expect(w.note(xcu(uiLocale('en-US')))).toBe(true);
    expect(w.latched()).toBe(true);
    // ⚠ 掛け金 ── 3 秒ごとに呼ばれるので、外すと帯を出し続けて操作を邪魔する
    expect(w.note(xcu(uiLocale('en-US')))).toBe(false);
    expect(w.note(xcu(uiLocale('de-DE')))).toBe(false);
  });

  it('🔴 起動時に「書かれていない」でも、後から書かれたら気づく', () => {
    // ⚠ これが実際の初回である ── 素のプロファイルに UILocale は無い
    const w = api.createRestartWatch();
    expect(w.note(xcu(NOISE))).toBe(false);
    expect(w.baseline()).toBe('');
    expect(w.note(xcu(NOISE + uiLocale('en-US')))).toBe(true);
  });

  it('🔴 読めなかった回は、基準を壊さないし変化にも数えない', () => {
    const w = api.createRestartWatch();
    w.note(xcu(uiLocale('ja')));
    expect(w.note('<oor:items>壊れ')).toBe(false);
    expect(w.baseline(), '壊れた 1 回で基準が消えている').toBe('ja');
    // 🔑 基準が生きているので、本物の変更はちゃんと拾える
    expect(w.note(xcu(uiLocale('en-US')))).toBe(true);
  });

  it('🔴 基準を採る前に壊れた回が来ても、次の正常な回が基準になる', () => {
    const w = api.createRestartWatch();
    expect(w.note('')).toBe(false);
    expect(w.baseline()).toBeNull();
    expect(w.note(xcu(uiLocale('ja')))).toBe(false);
    expect(w.baseline()).toBe('ja');
  });
});

/**
 * 🔴 **窓の側の配線**(#160)。
 *
 * ⚠ 判断が正しくても、`host.html` が呼んでいなければ **user には何も届かない**
 * ── そして `host.html` は bundle されないので、どの unit も届かない。
 * 🔑 だから**原文で pin する**(弱いと自覚して使う)。
 */
describe('窓(host.html)の配線', () => {
  const host = readFileSync('public/office/host.html', 'utf-8');

  it('🔴 判断を読み込んでいる(直書きへ戻していない)', () => {
    expect(host, 'script を読んでいない').toContain('src="office-restart-watch.js"');
    expect(host, '判断を委ねていない').toContain('PKC3OfficeRestartWatch');
    // ⚠ **在り処を host.html へ写していない**こと ── 写すと 2 か所になり、
    //    片方だけ直す事故が起きる(CLAUDE.md §7)
    expect(host, '設定の在り処が host.html にも書かれている')
      .not.toContain('org.openoffice.Office.Linguistic');
  });

  it('🔴 帯の器が在り、既定では出ていない', () => {
    expect(host).toContain('<div id="restart" hidden></div>');
  });

  /**
   * 🔴 **関数から入って切り出す**(#634 で踏んだ)。
   *
   * ⚠ 「開き直す」ボタンは **2 つ**になった(#160 の帯 / #634 の初期化の帯)。
   *   素の `indexOf("again.textContent = '開き直す'")` は**先に出てくるほう**を掴むので、
   *   関数を跨いで**別の帯を検めてしまう** ── 実際 CI がそれで落ちた
   *   (CLAUDE.md §1「範囲が広すぎて別物に満たされる」)。
   * 🔑 隣へ漏れないよう、**次の関数の手前**で切る。
   */
  const fnBlock = (name: string): string => {
    const at = host.indexOf(`function ${name}(`);
    expect(at, `${name} が無い`).toBeGreaterThan(-1);
    const next = host.indexOf('\n  function ', at + 1);
    return host.slice(at, next > -1 ? next : at + 2000);
  };

  it('🔴 開き直す前に設定を退避している(#160 の帯)', () => {
    // ⚠ 退避せずに reload すると、変えた設定ごと消えて
    //    「開き直したのに変わらない」という**いちばん悪い形**になる(#159 の逆流)。
    const block = fnBlock('showRestartBand');
    // ⚠ 空振り防止 ── 切り出しが壊れていたら、以降は何も測っていない
    expect(block, '切り出しが壊れている(開き直すボタンが入っていない)')
      .toContain("again.textContent = '開き直す'");
    const save = block.indexOf('saveProfile(FS)');
    const reload = block.indexOf('location.reload()');
    expect(save, '退避を呼んでいない').toBeGreaterThan(-1);
    expect(reload, '開き直していない').toBeGreaterThan(-1);
    expect(save, '退避より先に開き直している').toBeLessThan(reload);
  });

  /**
   * 🔴 **反対側**(#634)。⚠ こちらは**退避してはいけない** ──
   * 設定を捨てた直後なので、退避すると**消したばかりの設定が戻る**
   * (「消す」と「消えたままにする」は別物)。
   * 🔑 片側を直したら対称の反対側を疑う、の実体である。
   */
  it('🔴 設定を初期化した後の「開き直す」は、退避を呼ばない(#634)', () => {
    const block = fnBlock('resetProfileFromApp');
    expect(block, '切り出しが壊れている(開き直すボタンが入っていない)')
      .toContain("again.textContent = '開き直す'");
    expect(block, '開き直していない').toContain('location.reload()');
    expect(block, '🔴 退避を呼んでいる ── 消した設定が戻る').not.toContain('saveProfile(');
    // ⚠ 捨てる印を立てていること(`pagehide` の退避も止まる)
    expect(block, '退避を止める印を立てていない').toContain('dropProfile()');
  });

  it('🔴 事故の帯と重ねない', () => {
    const at = host.indexOf('function showRestartBand(');
    expect(at, '帯を出す関数が無い').toBeGreaterThan(-1);
    const block = host.slice(at, at + 400);
    expect(block, '`degraded` を見ていない').toContain('degraded');
  });
});
