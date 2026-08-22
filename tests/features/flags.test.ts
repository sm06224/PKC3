/** @vitest-environment happy-dom */
/**
 * 🔴 **フラグ機構**(P11。user 指示 2026-08-07)。
 *
 * > 「**設定はユーザーに開放されたもの、フラグは開発者とパワーユーザーに開放された
 * > もので予算は 15 個まで、それ以上は設定値で正式リリースさせる**」
 *
 * ## この test が守るもの
 *
 * `tests/flag-budget.test.ts` は「**予算と宣言の作法**」(15 個 / `foldWhen` 必須 /
 * 登記所の独占)を見張る。こちらは「**値がどう解けるか**」を見る ── 両方要る。
 *
 * ⚠ **登記所は module 全体で 1 つ**なので、test は**自分専用の名前**で宣言する
 * (`test.` 前置き)。`src` の宣言と混ざらないし、予算にも数えられない
 * (`flag-budget.test.ts:95` が読むのは `src` だけ)。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineFlag,
  findFlag,
  prunedForStorage,
  registeredFlags,
  resolveFlags,
} from '../../src/features/flags';
import { FlagStore, flagsFromUrl } from '../../src/adapter/platform/flag-store';

// ⚠ test 用の宣言(名前が衝突しないよう前置きを付ける)
const ON = defineFlag('test.defaultOn', {
  default: true,
  foldWhen: 'この test が消えるとき',
  summary: '既定 ON の見本',
});
const OFF = defineFlag('test.defaultOff', {
  default: false,
  foldWhen: 'この test が消えるとき',
  summary: '既定 OFF の見本',
});

describe('登記所(features/flags.ts)', () => {
  it('宣言したものが一覧に出る / 引ける', () => {
    const names = registeredFlags().map((f) => f.name);
    expect(names).toContain(ON.name);
    expect(names).toContain(OFF.name);
    expect(findFlag(OFF.name)?.default).toBe(false);
    expect(findFlag('存在しない')).toBeNull();
  });

  it('🔴 同じ名前を 2 度宣言したら、その場で落ちる', () => {
    // ⚠ 後勝ちで静かに上書きすると、どちらが効いているか誰にも分からなくなる
    expect(() =>
      defineFlag(ON.name, { default: false, foldWhen: 'x', summary: 'y' }),
    ).toThrow(/二重/);
  });

  it('🔴 すべての宣言が畳む条件(foldWhen)を持つ', () => {
    // ⚠ ここは「書けないものは flag にしない」の実体。空文字も許さない
    for (const f of registeredFlags()) {
      expect(f.foldWhen.length, `${f.name} に畳む条件が無い`).toBeGreaterThan(0);
    }
  });
});

describe('値の解決(URL > 保存 > 既定)', () => {
  it('何も無ければ既定', () => {
    const v = resolveFlags({});
    expect(v[ON.name]).toBe(true);
    expect(v[OFF.name]).toBe(false);
  });

  it('保存値が既定に勝つ', () => {
    const v = resolveFlags({ [ON.name]: false, [OFF.name]: true });
    expect(v[ON.name]).toBe(false);
    expect(v[OFF.name]).toBe(true);
  });

  /**
   * 🔴 **URL が保存値に勝つ。** ⚠ ここを逆にすると、**保存値が壊れた user が
   * 自分で素の状態へ戻せなくなる**(パワーユーザーの逃げ道が塞がる)。
   */
  it('🔴 URL が保存値に勝つ(壊れた保存から抜け出せる)', () => {
    const v = resolveFlags({ [ON.name]: false }, { [ON.name]: true });
    expect(v[ON.name]).toBe(true);
  });

  it('⚠ 知らない名前は解決結果に出ない(退役した flag の残骸を無視する)', () => {
    // ⚠ 実在した退役で検査する ── `editor.live` は 2026-08-14 に設定
    //   `pkc3.editor-mode` へ昇格して退役した(#104 第 2 弾)。ON を保存していた
    //   環境の残骸は黙殺され、新既定(live)= 本人が使っていた挙動と同値になる
    const v = resolveFlags({ 'editor.live': true });
    expect(Object.keys(v)).not.toContain('editor.live');
  });
});

describe('保存する値の間引き', () => {
  /**
   * 🔴 **既定と同じものは書かない。**
   * ⚠ 書くと、あとで既定を変えたときに**古い user だけ取り残される**。
   */
  it('🔴 既定と同じ値は保存に残さない', () => {
    const pruned = prunedForStorage({ [ON.name]: true, [OFF.name]: false });
    expect(pruned[ON.name]).toBeUndefined();
    expect(pruned[OFF.name]).toBeUndefined();
  });

  it('既定と違う値だけ残る', () => {
    const pruned = prunedForStorage({ [ON.name]: false, [OFF.name]: true });
    expect(pruned[ON.name]).toBe(false);
    expect(pruned[OFF.name]).toBe(true);
  });
});

describe('URL の読み取り', () => {
  it('?pkc-flag=name で ON、:off で OFF、カンマで複数', () => {
    expect(flagsFromUrl('?pkc-flag=a')).toEqual({ a: true });
    expect(flagsFromUrl('?pkc-flag=a:off')).toEqual({ a: false });
    expect(flagsFromUrl('?pkc-flag=a,b:off')).toEqual({ a: true, b: false });
    expect(flagsFromUrl('?pkc-flag=a&pkc-flag=b')).toEqual({ a: true, b: true });
  });

  it('⚠ 空・壊れた URL でも落ちない', () => {
    expect(flagsFromUrl('')).toEqual({});
    expect(flagsFromUrl('?pkc-flag=')).toEqual({});
    expect(flagsFromUrl('?other=1')).toEqual({});
  });
});

describe('保存(FlagStore)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('切り替えると保存され、次に読むと効いている', () => {
    const a = new FlagStore('');
    expect(a.isOn(OFF.name)).toBe(false);
    a.set(OFF.name, true);
    expect(new FlagStore('').isOn(OFF.name)).toBe(true);
  });

  /**
   * 🔴 **既定へ戻したら、鍵ごと消える。**
   * ⚠ 空 object を残すと「触った跡」だけが残り、既定を変えたときに効かなくなる。
   */
  it('🔴 既定へ戻すと保存の鍵ごと消える', () => {
    const s = new FlagStore('');
    s.set(OFF.name, true);
    expect(localStorage.getItem('pkc3.flags')).not.toBeNull();
    s.set(OFF.name, false); // 既定に戻す
    expect(localStorage.getItem('pkc3.flags')).toBeNull();
  });

  it('reset ですべて既定へ戻る', () => {
    const s = new FlagStore('');
    s.set(OFF.name, true);
    s.set(ON.name, false);
    expect(s.changedCount()).toBe(2);
    s.reset();
    expect(s.changedCount()).toBe(0);
    expect(localStorage.getItem('pkc3.flags')).toBeNull();
  });

  /**
   * 🔴 **URL 由来は保存に混ぜない。**
   * ⚠ 混ぜると URL を外しても残り、「試したつもりが居座る」になる。
   */
  it('🔴 URL で有効化しても保存されない(外せば戻る)', () => {
    const withUrl = new FlagStore(`?pkc-flag=${OFF.name}`);
    expect(withUrl.isOn(OFF.name)).toBe(true);
    expect(localStorage.getItem('pkc3.flags'), 'URL 由来が保存されている').toBeNull();
    // URL を外した別の起動では既定に戻っている
    expect(new FlagStore('').isOn(OFF.name)).toBe(false);
  });

  /**
   * 🔴 **URL 由来を「別の flag を保存する」ついでに焼き付けない**(2026-08-07 の
   * 変異試験で判明)。
   *
   * ⚠ 上の test は `set()` を**一度も通っていない**ので、
   *   「保存の中身に URL 由来を混ぜる」変異が**生き延びた**。
   *   保存が起きる経路で確かめないと、この不変条件は誰も守っていない
   *   (CLAUDE.md「SURVIVED の半分は『弱い』ではなく『通っていない』」)。
   */
  it('🔴 URL 上書き中に別の flag を保存しても、URL 由来は焼き付かない', () => {
    const s = new FlagStore(`?pkc-flag=${OFF.name}`); // OFF を URL で ON にしている
    s.set(ON.name, false); // 別の flag を保存する
    const raw = JSON.parse(localStorage.getItem('pkc3.flags') ?? '{}') as Record<string, unknown>;
    expect(raw[ON.name], '保存したい方が入っていない').toBe(false);
    expect(raw[OFF.name], 'URL 由来が保存に焼き付いた(URL を外しても残る)').toBeUndefined();
    // URL を外した起動では既定に戻っている
    expect(new FlagStore('').isOn(OFF.name)).toBe(false);
  });

  it('⚠ URL で上書き中かどうかを見分けられる(画面が「一時的」と出すため)', () => {
    const s = new FlagStore(`?pkc-flag=${OFF.name}`);
    expect(s.isFromUrl(OFF.name)).toBe(true);
    expect(s.isFromUrl(ON.name)).toBe(false);
  });

  it('⚠ 保存が壊れていても既定に戻るだけ(落ちない)', () => {
    localStorage.setItem('pkc3.flags', '{壊れた');
    expect(new FlagStore('').isOn(ON.name)).toBe(true);
    localStorage.setItem('pkc3.flags', '[]');
    expect(new FlagStore('').isOn(ON.name)).toBe(true);
  });
});

/**
 * 🔴 **クエリパラメータを抜け穴にしない**(user 指示 2026-08-07。不可侵)。
 *
 * > 「**URL クエリパラメータ切り替えはフラグ扱いである / クエリパラメータを
 * > 抜け穴にしてはいけない / 本来は PKC 内部のパーマネントリンクやディープリンク
 * > 以外にクエリパラメータを使用してはいけない**」
 *
 * ## なぜ機械で見張るのか
 *
 * 直す前、`?pkc-md-inline` / `?pkc-asset-inline` / `?pkc-live` の 3 つが
 * **宣言の外**に居た。理由は「計測用だから 15 枠を食わせない」と書かれていたが、
 * **それが抜け穴そのもの**だった ── 予算にも画面にも出てこない切替が 3 つあり、
 * user からは存在すら見えなかった。
 *
 * 🔑 **散文の規律は腐る。** だから「クエリパラメータを読んでよい場所」を
 * **全数で数え上げて**、許した 2 つ以外はここで落とす。
 */
describe('🔴 クエリパラメータの抜け穴を作らない', () => {
  /**
   * 読んでよい場所。⚠ **理由を書けないものは足さない** ──
   * ここが「例外を足せば通る」抜け道になると、この検査は何も守らなくなる。
   */
  const ALLOWED: Readonly<Record<string, string>> = {
    'src/adapter/platform/flag-store.ts': 'flag の解決(ここが唯一の入口)',
    'src/features/link/permalink.ts': 'パーマリンク / ディープリンク(user 指示の唯一の用途)',
    // 🔴 **ディープリンクを実際に読む側**(#300 段②、2026-08-22)。
    //   ⚠ `permalink.ts` は「pure: no DOM」を名乗っているので `location` を読めない
    //     ── **解くのが向こう、読むのがここ**、と分けてある。
    //   ⚠ 用途は user 指示が許した 2 つのうちの「ディープリンク」そのもので、
    //     **切替(flag)ではない** ── 面を選ぶだけで、挙動を変える枝を持たない。
    'src/adapter/platform/deep-link.ts': 'ディープリンクの解決(アドレスを読む唯一の入口)',
    // ⚠ 読むのではなく**組み立てる**側(再起動 URL)。`location.href` を触るので
    //   検出語に掛かるが、値の解決はしていない
    'src/adapter/ui/render/flags.ts': '再起動 URL の組み立て(フラグ画面から)',
  };

  /**
   * クエリを読む書き方の**全数**。⚠ 語を足すときは「読んでいるのに掛からない形」を
   * 1 つでも残さないこと ── 残った形がそのまま抜け穴になる。
   */
  const QUERY_READ = /location\.search|location\.href|location\.hash|URLSearchParams|searchParams/;

  /**
   * ⚠ **コメントを落とす。** 注記に書いた綴りで誤検知しない / **注記の綴りで
   * 「生きている」と誤読しない**(2026-08-22 に後者で踏んだ ── `deep-link.ts` は
   * 注記の 1 行だけで「読んでいる」を満たしていた)。
   * 🔑 落とす規則は**ここ 1 か所**(CLAUDE.md §7)。
   */
  const codeOnly = (text: string): string =>
    text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  it('🔴 クエリパラメータを読むのは flag の解決とパーマリンクだけ', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        // ⚠ **コメントを落としてから**見る ── 注記に書いた綴りで誤検知しない
        const code = codeOnly(readFileSync(full, 'utf-8'));
        /**
         * 🔴 **綴りの層で塞ぎ切る**(2026-08-08、レビュー指摘)。
         * ⚠ 直す前は `location.search` / `URLSearchParams` / `searchParams` の 3 語
         *   しか見ておらず、**`location.href.split('?')[1]` で読む形が素通り**した
         *   ── user 指示の当の抜け穴が、全数検査を通ったまま戻せる状態だった。
         */
        if (!QUERY_READ.test(code)) continue;
        if (ALLOWED[full] === undefined) offenders.push(full);
      }
    };
    walk('src');
    expect(
      offenders,
      'クエリパラメータを直に読んでいる ── 切替なら flag として宣言すること' +
        '(user 指示 2026-08-07「クエリパラメータを抜け穴にしてはいけない」)',
    ).toEqual([]);
  });

  /**
   * ⚠ **空振り防止**: 許可した 2 つが**実際に読んでいる**ことを確かめる。
   * 読まなくなったら許可の意味が消えているので、表から外す合図になる。
   */
  it('⚠ 許可した場所は実際にクエリパラメータを読んでいる(死んだ許可を残さない)', () => {
    for (const [file, why] of Object.entries(ALLOWED)) {
      // 🔴 **コメントを落としてから見る**(2026-08-22、着地前レビューが実測)。
      //   ⚠ 生の text で見ていたため、`deep-link.ts` は**注記の 1 行だけ**で
      //     満たされていた ── 実装を空にしても緑のままである。
      //   ⚠ 落とす側(`offenders`)は `codeOnly` を通しているのに、
      //     **主張を裏返したこちらだけ素通し**だった
      //     (CLAUDE.md「検査の向きを裏返したら、作法も裏返る」)。
      const text = codeOnly(readFileSync(file, 'utf-8'));
      expect(
        QUERY_READ.test(text),
        `${file} はもうクエリパラメータを読んでいない(${why} ── 表から外す)`,
      ).toBe(true);
    }
  });

  /**
   * 🔴 **アドレスを読む口は、key を自分で取り出さない**(#300 段②、2026-08-22)。
   *
   * ⚠ 許可は **file 単位**なので、許した file の中に切替を 1 行足すと
   *   全数検査を素通りする ── user が名指しで禁じた「**計測用だから枠を食わない**」を
   *   そのまま書けてしまう(着地前レビューが、貼れる diff 付きで指摘した)。
   * 🔑 だから `deep-link.ts` の**役目そのもの**を等値で pin する:
   *   断片から key を取り出すのは `permalink.ts` の仕事で、ここは渡すだけ。
   *   `location.search` は**断片を落とす 1 行にしか出てこない**。
   */
  it('🔴 ディープリンクの口は、断片から key を自前で取り出さない', () => {
    const code = codeOnly(readFileSync('src/adapter/platform/deep-link.ts', 'utf-8')).split('\n');
    expect(
      code.filter((l) => /URLSearchParams|searchParams/.test(l)),
      '断片から key を自前で取り出している(切替の抜け穴)',
    ).toEqual([]);
    expect(
      code.filter((l) => l.includes('location.search')).map((l) => l.trim()),
      'location.search が「断片を落とす」以外で使われている',
    ).toEqual([
      '`${location.pathname}${location.search}${dropViewFromHash(location.hash)}`,',
      // ⚠ 合図(`w`)だけを落とす口(#300 段③ の直し)── 同じ作法で `search` は残す
      '`${location.pathname}${location.search}${dropViewWindowToken(location.hash)}`,',
    ]);
  });

  /**
   * 🔴 **かつて抜け穴だった 3 つが、いま宣言されている**。
   * ⚠ 名前だけでなく **`foldWhen` を持つこと**まで見る(宣言の作法を満たすか)。
   */
  it('🔴 かつて URL だけだった切替が、flag として宣言されている', () => {
    for (const name of ['render.markdownInline', 'asset.inline']) {
      const f = findFlag(name);
      expect(f, `${name} が宣言されていない(抜け穴に戻った)`).not.toBeNull();
      expect(f!.foldWhen.length, `${name} に畳む条件が無い`).toBeGreaterThan(0);
    }
    // 🔴 `editor.live` は設定 `pkc3.editor-mode` へ**昇格済み**(#104 第 2 弾、
    //    foldWhen「既定 ON にできたら」の成就)── flag に戻さない(等値 pin)
    expect(findFlag('editor.live'), '設定へ昇格済み ── flag に戻さない').toBeNull();
  });

  /**
   * ⚠ **古い綴りを復活させない。** `?pkc-live=1` 等を直に読む実装へ戻ると、
   * 上の全数検査は通るのに(flag-store 経由に見えて)実は抜け穴、という形はないが、
   * 綴りが `src` に残っていたら読み手が混乱する。
   */
  it('⚠ 旧い URL の綴りが実装に残っていない', () => {
    const code = readFileSync('src/adapter/ui/render/detail.ts', 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code, '旧い綴りが実装に残っている').not.toContain("'pkc-live'");
  });

  /**
   * 🔴 **昇格の道連れを、機械で見つける**(2026-08-08 に実際に踏んだ)。
   *
   * `?pkc-live=1` を flag へ昇格させた commit は **unit 全緑**で着地したが、
   * `tests/smoke/live-editor.smoke.spec.ts` が旧い綴りで開いたままで、
   * **smoke が 12 件落ちた**。smoke は `dist/` を配信するので、source の綴りを
   * 変えても unit には**一切届かない**(CLAUDE.md「smoke に変異を当てるには
   * build が要る」の別の顔 ── 検査対象が生成物である)。
   *
   * ⚠ **flag を開く側**(smoke / bench)は `src` の外に居るので、上の検査は
   *   1 つも見ていなかった。⚠ **コメントは剥ぐ** ── 経緯を書いた行で落とさない。
   */
  it('🔴 flag を開く側(smoke / bench)も、旧い綴りで開いていない', () => {
    const files = [
      ...readdirSync('tests/smoke').map((f) => `tests/smoke/${f}`),
      ...readdirSync('tests/bench').map((f) => `tests/bench/${f}`),
    ].filter((f) => /\.(ts|mjs)$/.test(f));
    expect(files.length, '開く側を読めていない(空振り)').toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      // ⚠ **URL に書いている所**を見る(散文の中の語ではなく、`?…=` の形)
      /**
       * ⚠ **`=` を必須にしない**(2026-08-08、レビュー指摘)。昇格前の 3 つのうち
       * **2 つは値を取らない綴り**(`?pkc-asset-inline` を `has()` で判定)だった ──
       * `=` を要求すると、その 2 形を 1 件も拾わない。**この検査が防ごうとした事故
       * そのものの形**が素通りしていた。
       */
      for (const m of text.matchAll(/[?&](pkc-[a-z-]+)(?:[=&'"`\s)]|$)/g)) {
        const param = m[1]!;
        if (param !== 'pkc-flag') offenders.push(`${f}: ?${param}=`);
      }
    }
    expect(offenders, 'flag ではないクエリで開いている(昇格の道連れ)').toEqual([]);
  });
});
