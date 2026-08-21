/**
 * リポジトリ衛生 ── **人の注意力に頼らない**ための機械的な歯止め。
 *
 * 🔴 「制御文字を正規表現に直書きしない」と注意書きしている当の file で、
 * 生バイトの DEL を 3 回埋めた(その都度 grep では見えず、書いた本人も
 * 気づかなかった)。注意書きは 3 回とも効かなかったので、test にする。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 追跡対象のテキスト file を集める(生成物・依存は見ない)。
 *
 * ⚠ **追跡されない使い捨て(`zz` 始まり)は見ない** ── `.gitignore` が
 * それを無視すると決めているのに、この検査だけが拾っていた。
 * 計測用の probe(乱数 fixture を持つ)を置いた瞬間に**無関係な赤**が出て、
 * 「衛生の赤」が日常になると本物の赤が埋もれる。⚠ 無視の綴りは 1 か所に寄せる
 * ことができない(`.gitignore` は機械可読でない)ので、**同じ綴り**を使う
 */
function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    if (name.startsWith('zz') || name.startsWith('tmp-review-')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) textFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|json|md|css|html|yml|yaml)$/.test(name)) out.push(full);
  }
  return out;
}

describe('Office の起動引数', () => {
  /**
   * 🔴 **LO を起こす面は 1 つではない**(#158)。翻訳を一式へ詰めても、
   * `--language=ja` を渡す面が 1 つでも欠けると、そこだけ英語で開く。
   *
   * ⚠ **既知の 5 面を列挙する形にしない。** 6 つめが足された瞬間に、
   * 「主要な経路で効いているから大丈夫」で出荷される ── CLAUDE.md §7
   * 「同じ値を複数の経路へ渡すものは、経路ごとに pin する」の実体。
   * 🔑 **`callMain` を原文から数え上げ、数えた数だけ見る。**
   */
  it('🔴 callMain を呼ぶ面は、全部 --language=ja を渡している(#158)', () => {
    const sites: { file: string; line: number; text: string }[] = [];
    for (const f of [...textFiles('src'), ...textFiles('build'), ...textFiles('public')]) {
      const lines = readFileSync(f, 'utf-8').split('\n');
      lines.forEach((text, i) => {
        if (/\.callMain\(/.test(text)) sites.push({ file: f, line: i + 1, text });
      });
    }
    // ⚠ 空振り防止 ── 0 件なら「全部通っている」ではなく「1 つも見ていない」
    expect(sites.length, 'callMain が 1 件も見つからない = 何も検めていない').toBeGreaterThanOrEqual(
      5,
    );

    const bad: string[] = [];
    for (const s of sites) {
      // 引数がその行に在る形(`callMain(['…'])`)と、変数越しの形の両方を許す。
      // 🔴 変数越しは「file のどこかに ja」では**緩すぎる**(レビュー指摘 E)──
      //    コメントに書いてあるだけでも通り、args を組み直す refactor が生き延びる。
      //    見るのは **args の代入行そのもの**(コメント行は先に落とす)。
      const inline = /--language=ja/.test(s.text);
      const code = readFileSync(s.file, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      // ⚠ 宣言が ja でも、callMain までに**再代入**されたら意味が無い(変異試験で
      //    実際に生き延びた形)── 素の `args = …` を ja 以外へ張る行が無いことまで見る
      const decl = /(?:var|const|let)\s+args\s*=\s*\[\s*'--language=ja'/.test(code);
      const reassigned = /^\s*args\s*=\s*(?!\[\s*'--language=ja')/m.test(code);
      const viaVar = /callMain\(\s*args\s*\)/.test(s.text) ? decl && !reassigned : false;
      if (!inline && !viaVar) bad.push(`${s.file}:${s.line}`);
    }
    expect(bad, `--language=ja を渡していない面が在る:\n${bad.join('\n')}`).toEqual([]);
  });

  /**
   * ⚠ **LO を起こす面は callMain だけではない**(レビュー指摘 F)── probe 群は
   * `qt_soffice.html`(上流の素の page)を直接開くので、上の数え上げに入らない。
   * それらは**英語 UI で起動する**。I/O の機構(crash / focus / 当たり判定)を測る
   * 面なので言語非依存として許すが、🔑 **既知リストの等値 pin** にする ──
   * 新しい面が増えたら、ここで「ja を渡すか、理由を書いてこの表に載せるか」を
   * 選ばせる(黙って英語の面が増えない)。
   */
  it('⚠ qt_soffice.html を直接開く面は、既知リストと一致する(#158)', () => {
    const KNOWN_ENGLISH_BOOT = [
      'build/office-wasm/boot-probe.mjs', // 起動可否だけを見る(言語非依存)
      'build/office-wasm/dialog-crash-probe.mjs', // ダイアログの停止を測る(同上)
      'build/office-wasm/ime-probe.mjs', // IME の配管の有無を測る(同上)
      'build/office-wasm/io-layer-probe.mjs', // event 登録の層を解剖する(同上)
      'build/office-wasm/office-real-path-probe.mjs', // 実 user 経路(host 経由 = ja 済み)+ 対照で直も開く
      'src/adapter/platform/office/office-pack-acquire.ts', // 一式の file 名として言及するだけ(起動しない)
    ].sort();
    const found: string[] = [];
    for (const f of [...textFiles('src'), ...textFiles('build'), ...textFiles('public')]) {
      if (readFileSync(f, 'utf-8').includes('qt_soffice.html')) found.push(f);
    }
    // office-real-path-probe は io-layer 経由なので qt_soffice.html の字面を持つ場合のみ載る
    expect(found.sort(), 'qt_soffice.html を開く面が増減した ── ja を渡すか、理由つきで表へ').toEqual(
      KNOWN_ENGLISH_BOOT,
    );
  });
});

describe('リポジトリ衛生', () => {
  it('🔴 ソースに制御文字の生バイトが無い(タブ・改行を除く)', () => {
    const offenders: string[] = [];
    for (const f of [
      ...textFiles('src'),
      ...textFiles('tests'),
      ...textFiles('docs'),
      ...textFiles('scripts'), // CI の検品 script も同じ規律で縛る(P7 段①)
      ...textFiles('build'), // ビルド script も同じ規律で縛る(P7 段④)
      'CLAUDE.md',
      'README.md',
    ]) {
      let text: string;
      try {
        text = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        // \n(0x0a) / \t(0x09) だけ許す。\r は CRLF fixture が持つので許す
        if ((c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) || c === 0x7f) {
          offenders.push(`${f}:${i} = U+${c.toString(16).padStart(4, '0')}`);
          break;
        }
      }
    }
    // ⚠ 期待は**空配列**。file 名まで出す(「どこか」では直せない)
    expect(offenders).toEqual([]);
  });

  /**
   * 🔴 **`data-pkc-action` を書いたのに受け手が無い = 無言の dead click**
   * (2026-08-08、P11 で 3 つ足したときに機械化した)。
   *
   * binder は `ACTIONS[action]` が無ければ**黙って return する** ── 押しても
   * 何も起きず、エラーも出ない。この repo が繰り返し踏んできた形
   * (2026-08-07「保存直後の編集が無言の dead click になっていた」)なので、
   * 人の注意力ではなく機械で止める。
   *
   * ⚠ 逆向き(受け手は在るが誰も書かない)は**見ない** ── 面を作る前に受け手を
   *   置く順序(「実体を作ってから導線を書く」)を禁じてしまう。
   */
  it('🔴 画面に書いた data-pkc-action に、受け手が全部いる', () => {
    const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    /**
     * ⚠ **`ACTIONS` の表だけを見る**(file 全体を `includes` で見ない)── 説明文や
     *   `BODY_WRITE_ACTIONS` の一覧に名前が在るだけで満たされてしまう
     *   (CLAUDE.md「ガードは代替物で満たせない条件にする」)。
     */
    const table = binder.slice(binder.indexOf('const ACTIONS: Record<string, ActionHandler> = {'));
    const handlers = new Set([...table.matchAll(/^\s{2}'([a-z0-9-]+)':/gm)].map((m) => m[1]!));
    expect(handlers.size, '受け手の表を読めていない(空振り)').toBeGreaterThan(20);

    /**
     * ⚠ **書き方は 2 通りある**(`setAttribute` と HTML 属性)。
     * 🔴 **形ごとに guard を持つ**(2026-08-08、変異試験の指摘)── 合算の
     * 「20 件以上」だけだと、**HTML 属性形の正規表現が壊れても気づかない**
     * (合算は `setAttribute` 形だけで満たされる)。実際、その変異は
     * `KNOWN_DEAD` の等値 pin に**たまたま**救われていただけで、3 件を直した
     * 瞬間に守り手を失うところだった。
     */
    const bySetAttr = new Set<string>();
    const byHtmlAttr = new Set<string>();
    for (const f of textFiles('src')) {
      const text = readFileSync(f, 'utf-8');
      // ⚠ **属性を実際に付けている所**を拾う(散文の中の語を拾わない)
      for (const m of text.matchAll(/'data-pkc-action',\s*'([a-z0-9-]+)'/g)) bySetAttr.add(m[1]!);
      for (const m of text.matchAll(/data-pkc-action="([a-z0-9-]+)"/g)) byHtmlAttr.add(m[1]!);
    }
    expect(bySetAttr.size, 'setAttribute 形を読めていない(空振り)').toBeGreaterThan(20);
    expect(byHtmlAttr.size, 'HTML 属性形を読めていない(空振り)').toBeGreaterThan(0);
    const written = new Set([...bySetAttr, ...byHtmlAttr]);

    /**
     * 🔴 **見つかった実害**(2026-08-08、この検査を書いた初回)。
     *
     * markdown が `[題名](entry:<lid>)` / `pkc://…/asset/<key>` / `@card:` に
     * `data-pkc-action` を焼いているのに、**PKC3 の binder に受け手が無かった** ──
     * つまり本文のリンクを押しても**無言で何も起きない**。焼く側のコメントは
     * PKC2 の `action-binder` を指しており、記法だけ移植して受け手を置き忘れた形。
     *
     * ✅ **`navigate-entry-ref` と `navigate-card-ref` は戻した**(2026-08-08)。
     *
     * 🔴 **`navigate-asset-ref` は「焼かない」ことで解いた**(2026-08-08、Issue #100 段①)。
     *
     * 段①で cid が届くようになり、条件だけ見れば `pkc://<自分>/asset/<key>` は
     * この action で焼ける。⚠ **だが受け手は無い**(② key→lid の逆引きが未着手)ので、
     * 焼くと `<a href>` の既定を止める #97 の配線に当たり、**押しても黙る** ──
     * #98 で 4 面ぶん潰したばかりの**無言の dead click を新設する**ことになる。
     * 🔑 だから `markdown-render.ts` の同一コンテナ枝を **`kind === 'entry'` に限った**。
     *   添付の携帯参照は今までどおり札(`pkc-portable-reference-placeholder`)で出る ──
     *   container / target が title に読めるので、**黙るリンクより情報が多い**。
     * ⚠ **これは「直した」ではなく「退行させなかった」である。** 段②(逆引きの口)が
     *   入ったら枝を戻し、この配列に戻す必要は無い(受け手ができるので dead でなくなる)。
     * ⚠ 逆引きに `scanAssetRefs` を流用しない(判定の向きが逆 ── 別ノートへ飛ぶ)。
     *
     * ⚠ **等値で pin する**(「既知は無視」の可変リストにしない)── 直したら
     *   ここから消さないと落ちるし、新しい dead click が増えても落ちる。
     */
    const KNOWN_DEAD: string[] = [];
    const dead = [...written].filter((a) => !handlers.has(a)).sort();
    expect(dead, `受け手のいない action がある(押しても無言で何も起きない)`).toEqual(KNOWN_DEAD);
  });
});

/**
 * 🔴 **閲覧 HTML のテンプレート文字列にバッククォートを書かない**(2026-08-15)。
 *
 * `pkc3-html.ts` の `viewer()` は**巨大な template literal 1 本**で、そこに
 * バッククォートを 1 つ書くと**その場で閉じて**、遠くの行が構文エラーになる。
 * ⚠ file の中に注意書きが在るのに **6 度踏んだ**(直近は 2026-08-15、注記に
 * 書いた `calc(...)` の囲みで)。tsc は止めてくれるが、出るのは
 * 「This expression is not callable」という**原因と無関係な message** で、
 * 毎回 1〜2 往復を捨てる。
 * 🔑 **文言を 7 か所目にせず、機械に名指しさせる**(CLAUDE.md の型)。
 */
describe('閲覧 HTML のテンプレート文字列', () => {
  it('🔴 viewer() の template literal の中にバッククォートが無い', () => {
    const src = readFileSync('src/features/export/pkc3-html.ts', 'utf-8').split('\n');
    const start = src.findIndex((l) => l.trimEnd().endsWith('return `'));
    expect(start, '前提: viewer() の template literal を見つけられていない').toBeGreaterThan(0);
    // 閉じは行頭が `</script>`; の行(この 1 本しか無い)
    const end = src.findIndex((l, i) => i > start && l.includes('</script>`;'));
    expect(end, '前提: template literal の閉じを見つけられていない').toBeGreaterThan(start);
    const bad = src
      .slice(start + 1, end)
      .map((l, i) => ({ line: start + 2 + i, l }))
      .filter((x) => x.l.includes('`'));
    expect(
      bad.map((x) => `${x.line}: ${x.l.trim().slice(0, 60)}`),
      'template literal の中にバッククォートがある(その場で閉じて build が壊れる)',
    ).toEqual([]);
  });
});

/**
 * 🔒 **文書を受け取る probe は、撮影の口を「渡さない」形にする**(#220-2)。
 *
 * user 指示(機密資料の取り扱い 6、2026-08-15。不可侵):
 * 「**スクショを撮ってよいのは自作の file を開いたときだけ。** 同じハーネスで機密資料を
 * 扱う日は、撮影の口を**呼ばない**のではなく**渡さない**(引数を与えなければ撮れない
 * 形にする)」。
 *
 * ⚠ **消すのではなく門にした**理由: 版面の絵は、この harness で唯一生きている
 * 「一手が届いたか」の観測点である(題名は死んでいる / 打っても FS は動かない /
 * 窓の枚数も動かない)。消すと 2026-08-13 の失敗 ──「差が無い」を「actuate して
 * いない」と区別できず、**存在しない結論**を書きかけた ── へ戻る。
 * 🔑 だから既定 OFF の env 門にし、**それが在ることを機械で守る**。
 */
describe('🔒 文書を扱う probe の撮影の口', () => {
  /**
   * **等値 pin の既知リスト**(CLAUDE.md「等値 pin の既知リストは良く効く ──
   * 直したら消さないと落ちるので忘れられない」)。文書を引数に取る probe を足したら、
   * ここへ足す。⚠ 足さないと下の「全数」検査が落ちる。
   */
  const DOC_PROBES = [
    'build/office-wasm/open-doc-probe.mjs',
    'build/office-wasm/save-existing-probe.mjs',
  ];

  /** コメント行を落とした「実行する行」だけ返す(§1 で 5 回踏んだ型)。 */
  const codeLines = (rel: string): string[] =>
    readFileSync(rel, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));

  it('🔴 一覧が全数である(user の文書を読む probe を取りこぼしていない)', () => {
    /**
     * 判定は「**引数から来た path の bytes を読んでいるか**」で採る。
     * ⚠ `process.argv[3]` だけを見ると、出力先(`OUT`)に使っている probe が
     * 12 件並んで全数検査にならない ── **user の文書に触るか**が争点である。
     */
    const found = readdirSync('build/office-wasm')
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => {
        const lines = codeLines(join('build/office-wasm', f));
        const fromArgv = new Set(
          lines
            .flatMap((l) => [...l.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*process\.argv\[3\]/g)])
            .map((m) => m[1]!),
        );
        return lines.some((l) => [...fromArgv].some((n) => new RegExp(`readFile\\(\\s*${n}\\b`).test(l)));
      })
      .map((f) => join('build/office-wasm', f))
      .sort();
    // 空振り防止 ── 1 件も見つからない形で「全部見た」と言わない
    expect(found.length, 'user の文書を読む probe を 1 つも見つけられていない').toBeGreaterThan(0);
    expect(found).toEqual(DOC_PROBES);
  });

  it('🔴 撮影は env の門の下にある(引数を与えなければ撮れない)', () => {
    let shots = 0;
    for (const rel of DOC_PROBES) {
      const lines = codeLines(rel);
      // その file の中で **env から作った名前**(門になりうるもの)
      const gates = new Set(
        lines
          .flatMap((l) => [...l.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*process\.env\./g)])
          .map((m) => m[1]!),
      );
      const shotLines = lines.filter((l) => l.includes('page.screenshot'));
      for (const l of shotLines) {
        shots += 1;
        const gated = l.includes('process.env.') || [...gates].some((g) => l.includes(g));
        expect(gated, `${rel}: 門の無い撮影がある ── ${l.trim().slice(0, 80)}`).toBe(true);
      }
    }
    // 空振り防止 ── 撮影の行が 1 つも無いなら、この検査は何も守っていない
    expect(shots, '撮影の行が 1 つも無い ── 検査が空振りしている').toBeGreaterThan(0);
  });

  it('🔴 使い終わった profile を消している(痕跡を残さない)', () => {
    for (const rel of DOC_PROBES) {
      const code = codeLines(rel).join('\n');
      expect(code, `${rel}: persistent profile を作っているのに消していない`).toMatch(
        /rm\(\s*(PROFILE|profile)\s*,/,
      );
    }
  });
});

/**
 * 🔴 **計器が「全文 textarea」を掴むなら、腕を宣言してから掴む**(#223)。
 *
 * #172(2026-08-14)で**既定の編集面がライブ 1 面**になり、`editor-body` は設定
 * `split` のときしか出ない。⚠ bench 4 本はそれを知らずに掴み続け、**既定では
 * timeout / `null` で死ぬ**状態が 3 日間気づかれなかった(CI で走らないので、
 * こちらの計器は 1 つも鳴らない)。
 *
 * 🔑 だから「`editor-body` を掴む file は、**腕の切替**(`pkc3.editor-mode` /
 * `editor-arm.mjs`)も持っている」ことを機械で守る。⚠ 掴むこと自体は禁じない ──
 * split を測る計器は正しく掴む(禁じると `--arm=split` が書けなくなる)。
 */
describe('計器の編集面(#223)', () => {
  const FIELD = 'data-pkc-field="editor-body"';
  /** 腕を宣言していると認める印(どれか 1 つで足りる)。 */
  const ARM_MARKS = ['pkc3.editor-mode', 'editor-arm.mjs', 'useSplitEditor'];

  it('🔴 全文 textarea を掴む計器は、腕の切替も持っている', () => {
    const files = [
      ...readdirSync('tests/bench').map((f) => join('tests/bench', f)),
      ...readdirSync('tests/probe').map((f) => join('tests/probe', f)),
    ].filter((f) => /\.(mjs|ts)$/.test(f));
    // 空振り防止 ── 走査できていない形で「全部見た」と言わない
    expect(files.length, '計器を 1 つも見つけられていない').toBeGreaterThan(5);
    const grabbers = files.filter((f) => readFileSync(f, 'utf-8').includes(FIELD));
    // 空振り防止 ── 掴む file が 0 件なら、この検査は何も守っていない
    expect(grabbers.length, `${FIELD} を掴む計器が 1 つも無い`).toBeGreaterThan(0);
    const offenders = grabbers.filter((f) => {
      const text = readFileSync(f, 'utf-8');
      return !ARM_MARKS.some((m) => text.includes(m));
    });
    expect(offenders, '腕を宣言せずに全文 textarea を掴んでいる(既定 live では無い)').toEqual(
      [],
    );
  });
});

/**
 * 🔴 **画面に出す文字列に markdown の記法を書かない**(2026-08-18 に実際に踏んだ)。
 *
 * 設定の説明文を `textContent` に代入しているのに `**読む**` と書いたので、
 * **アスタリスクがそのまま画面に出ていた**。⚠ PKC2 が同じ失敗をしており、
 * `src/features/notice/notice-log.ts` の冒頭が「`textContent` で描くのに本文が
 * `**強調**` で書かれ、アスタリスクが見えていた」と**戒めている当のもの**である
 * (お知らせ側には既に検査が在り、設定側に無かった)。
 *
 * ⚠ **範囲を絞る** ── src 全体で `**` を禁じると、コメントの強調が全部落ちる。
 * 見るのは「**`textContent` に代入している文字列リテラル**」だけ。
 */
describe('画面の文字列に記法を書かない(2026-08-18)', () => {
  const UI_FILES = readdirSync('src/adapter/ui/render')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join('src/adapter/ui/render', f));

  it('🔴 textContent に代入する文字列に markdown の強調が無い', () => {
    // 空振り防止 ── 走査対象が 0 件 / 代入が 1 件も見つからない形で緑にしない
    expect(UI_FILES.length, '面の file を 1 つも見ていない').toBeGreaterThan(10);
    const offenders: string[] = [];
    let assignments = 0;
    for (const file of UI_FILES) {
      const text = readFileSync(file, 'utf8');
      // `x.textContent = …;` の右辺(複数行の連結も拾う)
      for (const m of text.matchAll(/\.textContent\s*=\s*([\s\S]*?);\n/g)) {
        assignments += 1;
        const rhs = m[1] ?? '';
        // 文字列リテラルの中だけを見る(識別子や式は対象外)
        for (const lit of rhs.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)) {
          const body = lit[1] ?? '';
          if (/\*\*[^*]+\*\*/.test(body) || /`[^`]+`/.test(body)) {
            offenders.push(`${file}: ${body.slice(0, 40)}`);
          }
        }
      }
    }
    expect(assignments, 'textContent への代入を 1 件も拾えていない(走査が壊れている)').toBeGreaterThan(
      20,
    );
    expect(offenders, '画面に出る文字列に記法が書かれている(そのまま記号が見える)').toEqual([]);
  });
});

/**
 * 🔴 **本文を書く action は、忙しい間の門(`BODY_WRITE_ACTIONS`)に必ず載る**
 * (2026-08-19 のレビュー W-4)。
 *
 * ⚠ `toggle-task`(#287)と `calendar-set-date`(#276)は、`toggle-todo` と
 *   **同じ `REQUEST_BODY_REWRITE` を撃つ**のに門から漏れていた ── PKC3 の
 *   `AppPhase` に `'exporting'` は無く、取り込み・書き出し中も `phase` は
 *   `'ready'` のままなので、reducer の門は効かない。止められるのは
 *   `services.busy()` だけであり、その入口がこの配列である。
 * 🔑 **散文では守れない**(2 回とも足し忘れた)ので、
 *   「reducer が本文の書込へ変える action 型」→「それを撃つ binder の action 名」を
 *   **機械で数え上げて**突き合わせる。
 */
describe('本文を書く導線は、忙しい間の門に載っている', () => {
  const STATE = readFileSync('src/adapter/state/app-state.ts', 'utf-8');
  const BINDER = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');

  /** reducer の `case 'X':` を境に切って、本文の書込を出す型を拾う。 */
  const writingActionTypes = (): Set<string> => {
    const out = new Set<string>();
    const parts = STATE.split(/\n {4}case '/);
    for (const part of parts.slice(1)) {
      const name = /^([A-Z_]+)'/.exec(part)?.[1];
      if (name === undefined) continue;
      // ⚠ 次の case までを見る(case を跨いで拾わない)
      const body = part.split(/\n {4}case '/)[0]!;
      if (/type: 'REQUEST_BODY_REWRITE'|type: 'PERSIST_ENTRY'/.test(body)) out.add(name);
    }
    return out;
  };

  /**
   * binder の ACTIONS 表を、handler ごとに切る。
   * ⚠ **表の終わりで切る**(2026-08-19 に自分で踏んだ)── file 末尾まで取ると、
   *   最後の handler の本文が**表の外のコード**(別の対応表など)を飲み込み、
   *   無関係な `type: '...'` に満たされて**偽の漏れ**が出る(§1「範囲が広すぎる」)。
   */
  const handlerBodies = (): Map<string, string> => {
    const from = BINDER.indexOf('const ACTIONS: Record<string, ActionHandler> = {');
    // 表は行頭の `};` で閉じる ── そこまでを表と見なす
    const rel = BINDER.slice(from).search(/\n\};\n/);
    expect(rel, 'ACTIONS 表の終わりを読めていない').toBeGreaterThan(0);
    const table = BINDER.slice(from, from + rel);
    const out = new Map<string, string>();
    const marks = [...table.matchAll(/^ {2}'([a-z0-9-]+)':/gm)];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i]!.index!;
      const end = i + 1 < marks.length ? marks[i + 1]!.index! : table.length;
      out.set(marks[i]![1]!, table.slice(start, end));
    }
    return out;
  };

  it('⚠ 数え上げが空振りしていない(表を読めている)', () => {
    const types = writingActionTypes();
    expect(types.size, 'reducer から本文の書込を出す型を 1 つも読めていない').toBeGreaterThan(2);
    expect(types, 'よく知られた書込の型が拾えていない').toContain('TOGGLE_TASK');
    expect(handlerBodies().size, 'binder の表を読めていない').toBeGreaterThan(20);
  });

  it('🔴 本文を書く action が門から漏れていない', () => {
    const types = writingActionTypes();
    const gate = new Set(
      [...(/const BODY_WRITE_ACTIONS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/
        .exec(BINDER)?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!),
    );
    expect(gate.size, '門の一覧を読めていない(空振り)').toBeGreaterThan(5);
    const missing: string[] = [];
    for (const [action, body] of handlerBodies()) {
      const dispatched = [...body.matchAll(/type: '([A-Z_]+)'/g)].map((m) => m[1]!);
      if (dispatched.some((t) => types.has(t)) && !gate.has(action)) missing.push(action);
    }
    expect(missing, '本文を書くのに BODY_WRITE_ACTIONS に無い action がある').toEqual([]);
  });
});

/**
 * 🔴 **新しい本文が state に入る所は、全部 `refreshTaskCards` を通る**
 * (2026-08-20。#277 段②-b の宣言が**数を間違えていた**ので、機械で数える形へ変えた)。
 *
 * ## なぜ機械で数えるか
 *
 * `refreshTaskCards` の docstring には「`buildPersist` と `BODY_REWRITTEN` の
 * **2 か所だけ**を通す(数えた数だけ通す ── §7)」と書いてあったが、
 * **`ENTRY_APPENDED` が 3 か所目**として漏れていた。
 * ⚠ 宣言が在るぶん、次に読む人は**数え直さない** ── 誤った安心が配られる。
 *
 * 🔑 板の札は**原文の行番号**を指すので、本文が変わったのに組み直さないと
 *   **押したとき別の行が黙って完了になる**(#277 段②-b で実際に踏んだ形)。
 *
 * ⚠ この検査は**漏れを名指しする**だけで、中身の正しさは見ない
 *   (`refreshTaskCards` を呼んでいれば通る)── 弱いと自覚して使う。
 *   行番号の追従そのものは `tests/adapter/state.test.ts` の変異試験が守る。
 */
describe('新しい本文が state に入る所は、札の組み直しを通る', () => {
  /**
   * 🔴 **コメントを落としてから見る**(2026-08-20、着地前の変異試験が突いた)。
   *
   * ⚠ ここは「**在る**」ことを主張する検査なので、注釈が検査を満たす ──
   *   1 稿目は原文のまま見ていたので、実装から `refreshTaskCards(...)` の**呼び出しを
   *   消しても**、同じ case に書いた解説コメントの中の `refreshTaskCards` の 5 文字に
   *   満たされて**緑のまま**だった(変異 R1 が生き延びて判明)。
   * ⚠ この罠は `tests/docs-parity.test.ts` の `codeOnly` が名指しで戒めているのに、
   *   **同じセッションでそれを引用しておきながら踏んだ**。
   */
  const STATE = readFileSync('src/adapter/state/app-state.ts', 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  /**
   * reducer の `case 'X':` を境に切り、**`openBody` に新しい本文を入れる** case を拾う。
   * ⚠ 「`openBody` の語が在る」では拾いすぎる(読むだけの case も当たる)ので、
   *   **`body:` を持つ object を組んでいる**ことを条件にする。
   */
  const bodyIntoStateCases = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const part of STATE.split(/\n {4}case '/).slice(1)) {
      const name = /^([A-Z_]+)'/.exec(part)?.[1];
      if (name === undefined) continue;
      const body = part.split(/\n {4}case '/)[0]!;
      /**
       * 🔴 **距離で拾わない**(2026-08-20 に自分で踏んだ)。1 稿目は
       *   `openBody …{0,400}… body: action.body` と**文字数の窓**で書いていたので、
       *   実装に**コメントを 1 つ足しただけで拾う集合が変わった**
       *   (窓の外へ押し出された case が静かに消える)。
       * 🔑 距離を使わず「その case が `openBody` を組み立てていて、かつ
       *   `body: action.<何か>` を書いている」で見る。
       */
      if (/\bopenBody\b/.test(body) && /\bbody:\s*action\.\w+/.test(body))
        out.set(name, body);
    }
    return out;
  };

  /**
   * 🔴 **通さなくてよい case は、理由つきで名指しする**(黙って除外しない)。
   *
   * ⚠ 一覧に足すのは「**板が見ていない本文**」だけである。増やすときは、
   *   その本文が板に届く筋が無いことを**書いてから**足すこと。
   */
  const EXEMPT: Readonly<Record<string, string>> = {
    /**
     * 打鍵ごとの draft。⚠ 板は**保存された本文**を映すので、draft を追う必要が無い
     * ── そして編集中は `SET_VIEW_MODE` が板を開かせない(reducer が捨てる)ので、
     * draft が板に届く筋がそもそも存在しない。⚠ 追ったら 1 打鍵ごとに札を組み直す。
     */
    UPDATE_OPEN_BODY: '打鍵ごとの draft(編集中は板を開けないので届かない)',
  };

  it('⚠ 前提: そういう case が実在する(空振り防止)', () => {
    const found = bodyIntoStateCases();
    expect(found.size, '1 件も拾えていない ── 拾い方が壊れている').toBeGreaterThan(0);
    /**
     * ⚠ **既知の顔ぶれを等値で pin する** ── 「件数が N 以上」だと、足した人が
     *   通し忘れても既存の件数で満たされる(§1 の空振り)。
     * 🔴 この一覧は 2026-08-20 に **4 件増えた** ── 実装の docstring は
     *   「2 か所だけ」と宣言していたが、実際は 6 か所(うち 5 か所が要追従)だった。
     */
    expect([...found.keys()].sort()).toEqual([
      'BODY_LOADED',
      'BODY_REWRITTEN',
      'ENTRY_APPENDED',
      'ENTRY_BODY_REFRESHED',
      'ENTRY_RESTORED',
      'UPDATE_OPEN_BODY',
    ]);
  });

  /**
   * 🔴 **除外の一覧そのものを等値で pin する**(2026-08-20、変異 R8 が突いた)。
   *
   * ⚠ 除外は**自分で書ける逃げ道**である ── 検査が落ちたときに名前を 1 つ足せば
   *   黙る。実際、`ENTRY_RESTORED` / `BODY_LOADED` を除外へ足す変異は**生き延びた**。
   * 🔑 等値で pin してあれば、除外を増やすには**ここも書き換える**しかない ──
   *   そのとき「本当に板へ届かないのか」を書く場所が目の前に出る。
   */
  it('🔴 除外してよいのは、板へ届かない本文だけ(逃げ道を増やせない)', () => {
    expect(Object.keys(EXEMPT).sort()).toEqual(['UPDATE_OPEN_BODY']);
  });

  it('🔴 拾った case が全部 refreshTaskCards を通っている', () => {
    const missing = [...bodyIntoStateCases()]
      .filter(([name]) => EXEMPT[name] === undefined)
      .filter(([, body]) => !body.includes('refreshTaskCards'))
      .map(([name]) => name);
    expect(
      missing,
      `新しい本文を state へ入れているのに札を組み直していない case がある(押すと別の行が完了になる): ${missing.join(' / ')}`,
    ).toEqual([]);
  });

  /**
   * ⚠ `COMMIT_EDIT` / `RETRY_PERSIST` は `buildPersist` 経由なので上の拾い方には
   *   出てこない。**そちらも通っていること**を別に見る(経路ごとに pin ── §7)。
   */
  it('🔴 buildPersist も札を組み直す', () => {
    const from = STATE.indexOf('function buildPersist(');
    expect(from, 'buildPersist を読めていない').toBeGreaterThan(0);
    const fn = STATE.slice(from, STATE.indexOf('\n}\n', from));
    expect(fn, 'buildPersist が札を組み直していない').toContain('refreshTaskCards');
  });
});

/**
 * 🔴 **native のダイアログは、もう使わない**(#299 段④、user 裁定 2026-08-21)。
 *
 * > 「**ブラウザの方のアラートはマウスの動線が多くてウザいから、自前の方が嬉しい**」
 *
 * ⚠ **戻ってこないことの見張り**である。`window.confirm` / `window.alert` は
 *   1 行足すだけで戻せるうえ、戻しても**ほとんどの test は緑のまま**通る
 *   (happy-dom に両方とも無いので、確認の枝が素通りする)── だから
 *   **機械で塞ぐ**しかない。
 *
 * 🔑 捨てた理由を 3 つとも思い出せるように書いておく:
 * ① native のモーダルは**レンダラを止める**ので、CDP から見ると
 *    「画面が固まった」と区別が付かない(2026-08-21 に**存在しない P0** を 1 件
 *    追わせた)② Chromium の「このページにこれ以上ダイアログを表示させない」は
 *    **解除できない**(確認つき操作が全部 dead click になる)
 * ③ 確認の枝が **unit からも smoke からも一度も実行されなかった**
 */
describe('🔴 native のダイアログを使わない(#299)', () => {
  /**
   * ⚠ **コメントを落としてから見る。** この file の中だけでも、上の docstring に
   *   `window.confirm` と書いてある ── 落とさないと**自分の解説文に満たされて**
   *   必ず落ちる(CLAUDE.md §1 で 5 回踏んだ形)。
   * ⚠ 逆に「**在る**」ことの主張ではないので、拾い漏らすほうが危険 ──
   *   だから**呼び出しの形**(`(`)まで含めて狭く当てる。
   */
  const stripComments = (src: string): string =>
    src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  const tsFiles = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) tsFiles(full, out);
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  it('🔴 src に window.confirm / window.alert の呼び出しが 1 つも無い', () => {
    const files = tsFiles('src');
    // ⚠ 空振り防止 ── そもそも file を読めていないなら、この検査は何も言っていない
    expect(files.length, 'src の TS を 1 つも読めていない').toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf-8'));
      for (const m of code.matchAll(/window\.(confirm|alert)\s*\(/g)) hits.push(`${f}: ${m[0]}`);
    }
    expect(
      hits,
      `native のダイアログが戻っている(自前の app-dialog.ts を使うこと): ${hits.join(' / ')}`,
    ).toEqual([]);
  });

  /**
   * ⚠ **この検査自身が空振りしていないか**を見る ── 上の正規表現が
   *   「そもそも何にも当たらない書き方」になっていたら、戻されても気づけない。
   * 🔑 **当たるはずの文字列を自分で作って当てる**(製品を汚さずに感度を測る)。
   */
  it('検査そのものが空振りしていない(当たる形なら当たる)', () => {
    const sample = 'const ok = window.confirm("x");\n// window.alert("y") はコメント\n';
    const code = stripComments(sample);
    expect([...code.matchAll(/window\.(confirm|alert)\s*\(/g)].length, '呼び出しを拾えない').toBe(
      1,
    );
    expect(code, 'コメントを落とせていない').not.toContain('window.alert');
  });

  /** ⚠ 自前の器が**実在する**こと(消してから検査だけ残さない)。 */
  it('自前の確認ダイアログが在る', () => {
    const dialog = readFileSync('src/adapter/ui/render/app-dialog.ts', 'utf-8');
    expect(dialog, '器が showModal を使っていない').toContain('showModal()');
    expect(dialog, '器が confirm を出す口を持っていない').toContain('export function confirmInApp');
    expect(dialog, '器が知らせる口を持っていない').toContain('export function alertInApp');
  });
});
