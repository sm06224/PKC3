/**
 * 🔴 **LO の保存を見つける判断**(#205 段 A / 方式監査 #209)。
 *
 * ⚠ `public/office/office-save-watch.js` は **bundle されない素の JS** である
 * (`host.html` が `<script src>` で読む)。だから **`readFileSync` + `new Function` で
 * 読み込んで**当てる ── これをやらないと、この判断は**どの test からも実行されない**
 * (`host.html` を読む test は repo に 0 件、という前例がまさにそれ)。
 *
 * 🔴 守る主張:
 * 1. **`rename` と `close` の両方**を拾う(実測で形が違う ── 既存は rename、新規は close)
 * 2. **temp とロック file を拾わない**(拾うと「保存」として親へ流れる)
 * 3. **監視は直下だけ**(`/` を舐めると 20〜27ms でメインが止まる)
 * 4. **静穏化して畳む**(同じ path に close が 3〜4 回来る ── 畳まないと 1 保存 4 通)
 * 5. **開いただけを保存にしない**(baseline)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

interface Stat {
  size: number;
  mtimeMs: number;
}
interface Watch {
  setBaseline(path: string, size: number, mtimeMs: number): void;
  note(kind: string, path: string, at?: number): boolean;
  due(stat: (p: string) => Stat | null, at?: number): { path: string; name: string; size: number }[];
  pendingCount(): number;
}
interface TokenTable {
  tokenFor(path: string): string;
  seed(path: string | undefined, token: string): void;
  remember(key: string, path: string): void;
  adopt(key: string, token: string): boolean;
  keyCount(): number;
}
interface Api {
  QUIET_MS: number;
  WATCH_DIRS: string[];
  KEY_MEMORY_MAX: number;
  newWindowId(): string;
  isIgnoredName(n: string): boolean;
  watchedDirOf(p: string): string | null;
  baseName(p: string): string;
  createSaveWatch(opts?: { now?: () => number }): Watch;
  createTokenTable(opts?: { max?: number }): TokenTable;
}

/** 素の JS を読み込む。⚠ **実 file を読む**(写経すると本物とずれる)。 */
function load(): Api {
  const src = readFileSync('public/office/office-save-watch.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', src)(scope);
  const api = scope.PKC3OfficeSaveWatch as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}

const api = load();

describe('保存の判断 ── 場所と名前', () => {
  it('🔴 監視するのは 2 つのディレクトリの直下だけ', () => {
    expect(api.WATCH_DIRS).toEqual(['/work', '/home/web_user']);
    expect(api.watchedDirOf('/work/x.odt')).toBe('/work');
    expect(api.watchedDirOf('/home/web_user/無題 1.odt')).toBe('/home/web_user');
    // ⚠ 入れ子は見ない(`/tmp/luXXXX.tmp/` は LO の持ち物)
    expect(api.watchedDirOf('/work/sub/x.odt'), '入れ子を拾っている').toBeNull();
    expect(api.watchedDirOf('/tmp/lu42.tmp/y.odt')).toBeNull();
    expect(api.watchedDirOf('/instdir/user/registrymodifications.xcu')).toBeNull();
    // ⚠ 前方一致で `/workspace` のような別ディレクトリを拾わない
    expect(api.watchedDirOf('/workspace/x.odt')).toBeNull();
    expect(api.watchedDirOf('/work')).toBeNull(); // ディレクトリ自身
  });

  it('🔴 temp とロック file を拾わない(拾うと保存として親へ流れる)', () => {
    expect(api.isIgnoredName('lu42v7msuf.tmp'), 'LO の temp を拾っている').toBe(true);
    expect(api.isIgnoredName('.~lock.x.odt#'), 'ロック file を拾っている').toBe(true);
    expect(api.isIgnoredName('.hidden')).toBe(true);
    // 拾うもの ⚠ 日本語と空白を含む(実測: `--language=ja` で `無題 1.odt`)
    expect(api.isIgnoredName('無題 1.odt')).toBe(false);
    expect(api.isIgnoredName('x.odt')).toBe(false);
    expect(api.isIgnoredName('見積.docx')).toBe(false);
  });

  it('名前は path の末尾(日本語・空白を保つ)', () => {
    expect(api.baseName('/home/web_user/無題 1.odt')).toBe('無題 1.odt');
    expect(api.baseName('x.odt')).toBe('x.odt');
  });
});

describe('保存の判断 ── 静穏化と baseline', () => {
  const mkStat =
    (table: Record<string, Stat>) =>
    (p: string): Stat | null =>
      table[p] ?? null;

  /**
   * 🔴 **temp を「保存」として受けない**(変異試験で生き残って判明)。
   * ⚠ `isIgnoredName` を**直接**当てる test は在ったが、`note()` が実際に
   * それを使っているかは誰も見ていなかった ── 判定を外す変異が生き延びた。
   * 拾うと **LO の temp が添付ノートになる**(user から見て意味不明な file が増える)。
   */
  it('🔴 temp とロック file は note() が受け取らない(判定を通っている)', () => {
    const w = api.createSaveWatch();
    const stat = (): Stat => ({ size: 100, mtimeMs: 1 });
    expect(w.note('close', '/work/lu42v7msuf.tmp', 1000), 'temp を受けた').toBe(false);
    expect(w.note('rename', '/work/.~lock.x.odt#', 1000), 'ロック file を受けた').toBe(false);
    expect(w.pendingCount(), '受けないはずのものが積まれた').toBe(0);
    expect(w.due(stat, 9999), 'temp が保存として出てきた').toEqual([]);
    // 空振り防止 ── 同じ場所の普通の名前は受ける
    expect(w.note('close', '/work/x.odt', 1000)).toBe(true);
  });

  it('🔴 close と rename の両方を拾う(片方だけでは必ず穴が空く)', () => {
    const w = api.createSaveWatch();
    // 新規保存 = 最終 path へ直接 write + close(実測)
    expect(w.note('close', '/home/web_user/無題 1.odt', 1000), 'close を拾っていない').toBe(true);
    // 既存の上書き = temp → rename(実測)
    expect(w.note('rename', '/work/x.odt', 1000), 'rename を拾っていない').toBe(true);
    // ⚠ 知らない種別は受けない
    expect(w.note('write', '/work/x.odt', 1000)).toBe(false);
    expect(w.pendingCount()).toBe(2);
  });

  it('🔴 静穏を過ぎるまで返さない(1 保存が 4 通にならない)', () => {
    const w = api.createSaveWatch();
    const stat = mkStat({ '/work/x.odt': { size: 8568, mtimeMs: 2000 } });
    // 同じ path に close が 3〜4 回来る(自動回復の複製 ── 実測)
    for (const t of [1000, 1100, 1250, 1400]) w.note('close', '/work/x.odt', t);
    expect(w.pendingCount(), '畳んでいない').toBe(1);
    // まだ静穏でない
    expect(w.due(stat, 1400 + api.QUIET_MS - 1)).toEqual([]);
    // ⚠ 静穏は**最後の出来事から**数える(最初からではない)
    const out = w.due(stat, 1400 + api.QUIET_MS);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('x.odt');
    expect(out[0]!.size).toBe(8568);
    // 一度返したら消える(2 通目を出さない)
    expect(w.due(stat, 9999)).toEqual([]);
  });

  it('🔴 開いただけを保存にしない(baseline と同じなら落とす)', () => {
    const w = api.createSaveWatch();
    w.setBaseline('/work/x.odt', 1309, 500);
    const same = mkStat({ '/work/x.odt': { size: 1309, mtimeMs: 500 } });
    // boot 中に close が 3 回来る(実測)── どれも保存ではない
    for (const t of [10, 20, 30]) w.note('close', '/work/x.odt', t);
    expect(w.due(same, 30 + api.QUIET_MS), '開いただけを保存として返した').toEqual([]);

    // 本当に保存されたら返す
    w.note('rename', '/work/x.odt', 1000);
    const grown = mkStat({ '/work/x.odt': { size: 8568, mtimeMs: 2000 } });
    expect(w.due(grown, 1000 + api.QUIET_MS)).toHaveLength(1);
  });

  it('⚠ 同じ大きさでも mtime が動けば保存とみなす(上書きで長さが偶然一致する)', () => {
    const w = api.createSaveWatch();
    w.setBaseline('/work/x.odt', 8568, 500);
    w.note('rename', '/work/x.odt', 1000);
    const sameSize = mkStat({ '/work/x.odt': { size: 8568, mtimeMs: 2000 } });
    expect(w.due(sameSize, 1000 + api.QUIET_MS), 'mtime の変化を見ていない').toHaveLength(1);
  });

  it('消えた file / 空の file は返さない(temp を掴まない)', () => {
    const w = api.createSaveWatch();
    w.note('close', '/home/web_user/a.odt', 1000);
    w.note('close', '/home/web_user/b.odt', 1000);
    const stat = mkStat({ '/home/web_user/b.odt': { size: 0, mtimeMs: 1 } });
    expect(w.due(stat, 1000 + api.QUIET_MS)).toEqual([]);
  });

  it('⚠ stat が投げても落ちない(消える途中を掴むことがある)', () => {
    const w = api.createSaveWatch();
    w.note('close', '/work/x.odt', 1000);
    const boom = (): Stat | null => {
      throw new Error('ENOENT');
    };
    expect(() => w.due(boom, 1000 + api.QUIET_MS)).not.toThrow();
  });

  /**
   * 🔴 **返したら baseline を更新する**(変異試験で生き残って判明)。
   * ⚠ 更新しないと、LO の自動回復の複製が同じ file を閉じ直したときに
   * **同じ内容の保存が 2 通**出る(実測: 保存 1 回につき同じ path へ close が 3〜4 回)。
   * 🔑 「2 回目の保存が返る」だけでは殺せない ── **中身が変わっていない 2 回目**を見る。
   */
  it('🔴 同じ内容で閉じ直しても、2 通目は出ない', () => {
    const w = api.createSaveWatch();
    const stat = mkStat({ '/work/x.odt': { size: 8568, mtimeMs: 2000 } });
    w.note('rename', '/work/x.odt', 1000);
    expect(w.due(stat, 1000 + api.QUIET_MS)).toHaveLength(1);
    // 自動回復の複製が同じ file を閉じ直す(中身は変わっていない)
    w.note('close', '/work/x.odt', 5000);
    expect(w.due(stat, 5000 + api.QUIET_MS), '同じ内容で 2 通目が出た').toEqual([]);
  });

  it('🔑 2 回目の保存も返る(baseline を更新している)', () => {
    const w = api.createSaveWatch();
    w.note('rename', '/work/x.odt', 1000);
    expect(w.due(mkStat({ '/work/x.odt': { size: 100, mtimeMs: 1 } }), 1000 + api.QUIET_MS)).toHaveLength(1);
    w.note('rename', '/work/x.odt', 5000);
    expect(
      w.due(mkStat({ '/work/x.odt': { size: 200, mtimeMs: 2 } }), 5000 + api.QUIET_MS),
      '2 回目の保存が落ちている',
    ).toHaveLength(1);
  });
});

/**
 * 🔴 **UNO の listener を製品コードに書かない**(#209 の probe で確定)。
 * ⚠ この結論をコードに残さないと、次に読む人が「UNO のほうが判定 0 個で綺麗」を
 * 根拠に戻す ── 戻すと**保存のたびに窓が死ぬ**。
 */
/**
 * 🔴 **窓の id**(#220-4)。引き取る側が「同じ文書」を束ねる鍵の片方なので、
 * ここが弁別しなければ**別の窓の同名文書が 1 つのノートへ潰れる**。
 *
 * ⚠ 直す前は生成が `host.html` に直書きで、**どの unit も届かなかった** ──
 * `var winId = 'w-1'` という変異が全緑で通る状態だった(CLAUDE.md §2)。
 */
describe('窓の id(#220-4)', () => {
  it('🔴 呼ぶたびに違う値を返す(固定値だと別の窓の文書を潰す)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(api.newWindowId());
    expect(seen.size, '同じ値が返っている ── 窓を弁別できない').toBe(200);
  });

  it('🔴 空でなく、`|` を含まない(束ねる鍵の区切りと衝突しない)', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = api.newWindowId();
      expect(id.length).toBeGreaterThan(0);
      // ⚠ 引き取る側は `win|path` で 1 本にする(`office-save-back.ts` の `sameDoc`)
      expect(id, '区切りと同じ文字が入っている').not.toContain('|');
    }
  });

  it('🔴 窓(host.html)は生成をここへ委ねている(直書きへ戻していない)', () => {
    // ⚠ **実行行だけ**を見る(コメントに満たされない ── CLAUDE.md §1 で 5 回踏んだ型)
    const code = readFileSync('public/office/host.html', 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l))
      .join('\n');
    expect(code.length, '抜き出せていない ── 検査が空振りしている').toBeGreaterThan(1000);
    expect(code, '窓の id を host.html に直書きしている').toContain('W.newWindowId()');
    expect(code, '古い直書きが残っている').not.toContain('crypto.randomUUID()\n');
  });
});

describe('UNO の listener を登録しない(#209)', () => {
  it('🔴 host.html と保存の判断に UNO の登録が現れない', () => {
    for (const f of ['public/office/host.html', 'public/office/office-save-watch.js']) {
      const src = readFileSync(f, 'utf-8');
      // ⚠ コメントで言及するのは許す ── **実行する行**に現れないことを見たいので、
      //    行頭が `*` や `//` の行を落としてから探す
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|<!--)/.test(l))
        .join('\n');
      expect(code, `${f}: UNO の listener を登録している(保存のたびに窓が死ぬ)`).not.toContain(
        'addDocumentEventListener',
      );
      expect(code, `${f}: 旧 broadcaster に登録している`).not.toContain('theGlobalEventBroadcaster');
    }
  });
});

/**
 * 🔴 **path → 合言葉の表**(#217)。窓の中で新規に作った文書は合言葉を持たないので、
 * 本体が「その保存はこのノートになった」と返してこない限り、**保存のたびにノートが増える**
 * (cowork 実機 2026-08-16 で 1/1 再現)。
 *
 * ⚠ **判断がここに在る理由**:元は `host.html` に直書きしていたが、あの file は
 * bundle されず **unit が 1 件も届かない**(CLAUDE.md「どの test からも実行されない
 * file に、判断を書かない」)。上限の効きなど、smoke では現実的に測れないものがある。
 */
describe('合言葉の表(#217)', () => {
  it('🔴 返事が来るまでは合言葉なし、来たら以後は付く', () => {
    const t = api.createTokenTable();
    t.remember('k1', '/home/web_user/無題 1.odt');
    expect(t.tokenFor('/home/web_user/無題 1.odt'), '名乗られる前から合言葉がある').toBe('');
    expect(t.adopt('k1', 'lid-9')).toBe(true);
    expect(
      t.tokenFor('/home/web_user/無題 1.odt'),
      '返事を受けていない ── 2 回目の保存でノートが増える',
    ).toBe('lid-9');
  });

  it('🔴 自分が渡していない鍵の返事は無視する(放送は全窓に届く)', () => {
    const t = api.createTokenTable();
    t.remember('k1', '/work/あ.odt');
    expect(t.adopt('k-OTHER', 'lid-OTHER'), '身に覚えのない鍵を受け入れた').toBe(false);
    expect(t.tokenFor('/work/あ.odt'), '別窓あての返事で合言葉が付いた').toBe('');
  });

  it('🔴 返事は、その鍵の path にだけ効く(隣へ漏れない)', () => {
    const t = api.createTokenTable();
    t.remember('kA', '/work/あ.odt');
    t.remember('kB', '/work/い.odt');
    t.adopt('kA', 'lid-A');
    expect(t.tokenFor('/work/あ.odt')).toBe('lid-A');
    expect(t.tokenFor('/work/い.odt'), '隣の文書へ漏れた').toBe('');
  });

  it('空の鍵・空の合言葉は受けない(表を壊さない)', () => {
    const t = api.createTokenTable();
    t.remember('k1', '/work/あ.odt');
    expect(t.adopt('', 'lid-1')).toBe(false);
    expect(t.adopt('k1', '')).toBe(false);
    expect(t.tokenFor('/work/あ.odt')).toBe('');
  });

  it('PKC が渡した添付は、はじめから合言葉を持つ', () => {
    const t = api.createTokenTable();
    t.seed('/work/報告書.odt', 'lid-SEED');
    expect(t.tokenFor('/work/報告書.odt')).toBe('lid-SEED');
    // ⚠ 空を渡しても表を汚さない(文書を渡さずに開いた窓)
    t.seed(undefined, '');
    expect(t.tokenFor('')).toBe('');
  });

  it('🔴 古い鍵の返事も受ける(編集中に溜まった 1 件目にしか返事が来ないことがある)', () => {
    const t = api.createTokenTable();
    t.remember('k1', '/work/あ.odt');
    t.remember('k2', '/work/あ.odt');   // 返事が来る前に 2 回目を保存した
    expect(t.adopt('k1', 'lid-A'), '古い鍵を落としている ── 返事がどこにも着かない')
      .toBe(true);
    expect(t.tokenFor('/work/あ.odt')).toBe('lid-A');
  });

  it('🔴 覚える鍵に上限がある(差し替えの定常では返事が来ないので、無いと積み続ける)', () => {
    const t = api.createTokenTable({ max: 3 });
    for (let i = 0; i < 10; i += 1) t.remember(`k${i}`, '/work/あ.odt');
    expect(t.keyCount(), '上限が効いていない ── 保存のたびに永久に積む').toBe(3);
    // ⚠ 落ちるのは**古いほうから**(返事が来る見込みが薄い順)
    expect(t.adopt('k0', 'lid-OLD')).toBe(false);
    expect(t.adopt('k9', 'lid-NEW')).toBe(true);
  });

  /**
   * 🔴 **返事が着いた鍵は枠を食わない**(#220-5、2026-08-17)。
   *
   * ⚠ 直す前は `adopt` が `paths` からしか消さず、`order` に死んだ鍵が残っていた
   * ── 死鍵が上限の枠を食い、次の `remember` で **生きている古い鍵が押し出される**。
   * その鍵に返事が来ると `adopt` が false = **どこにも着かない**(= 保存のたびに
   * ノートが増える #217 の形)。観測点は「数」ではなく**生きた鍵の返事が着くか**。
   */
  it('🔴 返事が着いた鍵が枠を食わない(生きた古い鍵を押し出さない)', () => {
    const t = api.createTokenTable({ max: 3 });
    t.remember('old1', '/work/あ.odt');
    t.remember('old2', '/work/い.odt');
    t.remember('new3', '/work/う.odt');
    expect(t.adopt('new3', 'lid-U')).toBe(true);
    // 死んだ鍵が枠を食っていれば、ここで old1 が押し出される
    t.remember('new4', '/work/え.odt');
    expect(t.adopt('old1', 'lid-A'), '生きた古い鍵を押し出した ── 返事が着かない').toBe(
      true,
    );
    expect(t.tokenFor('/work/あ.odt')).toBe('lid-A');
  });

  it('返事が着いた鍵は数えない(上限の観測点が死鍵で埋まらない)', () => {
    const t = api.createTokenTable({ max: 3 });
    t.remember('k1', '/work/あ.odt');
    t.remember('k2', '/work/い.odt');
    expect(t.keyCount()).toBe(2);
    expect(t.adopt('k1', 'lid-A')).toBe(true);
    expect(t.keyCount(), '返事が着いた鍵を数え続けている').toBe(1);
    // ⚠ 空振り防止 ── 受け入れなかったときは減らない
    expect(t.adopt('nope', 'lid-X')).toBe(false);
    expect(t.keyCount()).toBe(1);
  });

  it('既定の上限が宣言されている(値を散らさない)', () => {
    expect(api.KEY_MEMORY_MAX).toBeGreaterThan(8);
    const t = api.createTokenTable();
    for (let i = 0; i < api.KEY_MEMORY_MAX + 5; i += 1) t.remember(`k${i}`, `/work/${i}.odt`);
    expect(t.keyCount()).toBe(api.KEY_MEMORY_MAX);
  });
});
