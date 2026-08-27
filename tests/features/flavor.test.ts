import { describe, expect, it } from 'vitest';
import {
  extractMeta,
  getFlavor,
  NO_EXTRACT,
  registeredArchetypes,
} from '../../src/features/flavor';
import { todoFlavor } from '../../src/features/flavor/todo-flavor';
import { textlogFlavor } from '../../src/features/flavor/textlog-flavor';
import { formFlavor, readFormFields } from '../../src/features/flavor/form-flavor';
import { attachmentFlavor } from '../../src/features/flavor/attachment-flavor';
import { spreadsheetFlavor } from '../../src/features/flavor/spreadsheet-flavor';
import {
  parseFrontmatter,
  serializeFrontmatter,
} from '../../src/features/markdown/frontmatter';

describe('flavor registry', () => {
  it('maps archetypes and falls back to text for folder/generic/opaque/unknown', () => {
    expect(getFlavor('todo').archetype).toBe('todo');
    expect(getFlavor('spreadsheet').archetype).toBe('spreadsheet');
    for (const a of ['folder', 'generic', 'opaque', 'unknown-future']) {
      expect(getFlavor(a).archetype).toBe('text');
    }
  });

  /**
   * 🔴 **普通のノートも `date` / `status` を列に写す**(#276 / #277。
   * user 指示 2026-08-19「frontmatter でのカレンダー情報付与」)。
   *
   * ⚠ 2026-08-19 に**主張を裏返した**。以前は「text 系は列に写さない
   *   (kanban / calendar は todo だけを引く ── PKC2 と同じ意味論)」だったが、
   *   **todo は封印中**(`features/sealed.ts`)なので、その意味論では
   *   **カレンダーに何も出せる人が居ない**。
   * ⚠ 主張を裏返したときは前提も見直す(CLAUDE.md §1)── だから
   *   `archived` を写さない側は**据え置き**である(下の it が守る)。
   */
  it('🔴 text fallback: fromPkc2 は恒等 / date と status は列に写す', () => {
    const body = '---\nstatus: done\ndate: 2026-08-01\n---\n# 見出し';
    expect(getFlavor('text').fromPkc2(body)).toBe(body);
    expect(extractMeta('text', body)).toEqual({
      status: 'done',
      date: '2026-08-01',
      archived: false,
    });
    // フォルダなど fallback に落ちるものも同じ(面ごとに規則を変えない)
    expect(extractMeta('folder', body).date).toBe('2026-08-01');
  });

  it('書いていなければ列は空(既定値を作らない)', () => {
    expect(extractMeta('text', '# ただの見出し\n')).toEqual(NO_EXTRACT);
    // ⚠ 読めない日付は列に入らない(本文には残る)
    expect(extractMeta('text', '---\ndate: 2026-8-1\n---\n').date).toBeNull();
  });

  /**
   * 🔴 **`archived` は普通のノートでは写さない**(#276)。
   * ⚠ 写すと、`archived: true` と書いただけでノートが一覧から消える ──
   *   書いた本人にも消えた理由が分からない(いちばん気づけない形)。
   */
  it('🔴 archived は普通のノートでは写さない(黙って消えない)', () => {
    expect(extractMeta('text', '---\narchived: true\n---\n').archived).toBe(false);
    // ⚠ 対照群 ── todo では今までどおり写る(そちらの意味論は変えていない)
    expect(extractMeta('todo', '---\nstatus: open\narchived: true\n---\n').archived).toBe(true);
  });
});

describe('todo flavor', () => {
  it('fromPkc2 converts JSON body to frontmatter + markdown description', () => {
    const md = todoFlavor.fromPkc2(
      JSON.stringify({
        status: 'done',
        description: '買い物\n- 牛乳',
        date: '2026-08-01',
        archived: true,
      }),
    );
    const fm = parseFrontmatter(md);
    expect(fm.found).toBe(true);
    expect(fm.meta).toEqual({ status: 'done', date: '2026-08-01', archived: true });
    expect(fm.body).toBe('買い物\n- 牛乳');
  });

  it('roundtrip pin: extract(fromPkc2(x)) reproduces the PKC2 fields', () => {
    const src = { status: 'done', description: 'x', date: '2026-08-01', archived: true };
    expect(todoFlavor.extract(todoFlavor.fromPkc2(JSON.stringify(src)))).toEqual({
      status: 'done',
      date: '2026-08-01',
      archived: true,
    });
    const open = { status: 'open', description: 'y' };
    expect(todoFlavor.extract(todoFlavor.fromPkc2(JSON.stringify(open)))).toEqual({
      status: 'open',
      date: null,
      archived: false,
    });
  });

  it('tolerant parse: non-JSON body becomes an open todo with the text preserved', () => {
    const md = todoFlavor.fromPkc2('ただのメモ');
    const fm = parseFrontmatter(md);
    expect(fm.meta['status']).toBe('open');
    expect(fm.body).toBe('ただのメモ');
  });

  it('description starting with --- survives (frontmatter is prepended, not merged)', () => {
    const desc = '---\nkey: value\n---\n本文';
    const md = todoFlavor.fromPkc2(
      JSON.stringify({ status: 'open', description: desc }),
    );
    const fm = parseFrontmatter(md);
    expect(fm.meta).toEqual({ status: 'open' }); // 先頭 block だけが frontmatter
    expect(fm.body).toBe(desc); // description は無傷
  });

  it('extract normalizes: non-done status → open, malformed date → null column', () => {
    expect(todoFlavor.extract('---\nstatus: waiting\ndate: 8/1\n---\nx')).toEqual({
      status: 'open',
      date: null,
      archived: false,
    });
    // frontmatter 不在の todo も常に status を持つ(kanban が SQL だけで引ける)
    expect(todoFlavor.extract('素の本文')).toEqual({
      status: 'open',
      date: null,
      archived: false,
    });
  });
});

describe('textlog flavor', () => {
  it('fromPkc2 emits dated heading sections (local time, seconds, ★ = important)', () => {
    const body = JSON.stringify({
      entries: [
        {
          id: 'x1',
          text: '一行目\n二行目',
          createdAt: new Date(2026, 6, 30, 14, 3, 22).toISOString(),
          flags: [],
        },
        {
          id: 'x2',
          text: '重要ログ',
          createdAt: new Date(2026, 6, 30, 14, 5, 1).toISOString(),
          flags: ['important'],
        },
      ],
    });
    expect(textlogFlavor.fromPkc2(body)).toBe(
      '## 2026-07-30 14:03:22\n\n一行目\n二行目\n\n' +
        '## 2026-07-30 14:05:01 ★\n\n重要ログ',
    );
  });

  it('keeps an unparseable timestamp string verbatim in the heading (no data loss)', () => {
    const body = JSON.stringify({
      entries: [{ id: 'x', text: 't', createdAt: 'garbage', flags: [] }],
    });
    expect(textlogFlavor.fromPkc2(body)).toBe('## garbage\n\nt');
  });

  it('empty / invalid log converts to empty markdown; no extracted columns', () => {
    expect(textlogFlavor.fromPkc2('')).toBe('');
    expect(textlogFlavor.fromPkc2('not json')).toBe('');
    expect(textlogFlavor.extract('## 2026-07-30 14:03:22\n\nx')).toEqual(NO_EXTRACT);
  });
});

describe('form flavor', () => {
  it('fromPkc2 puts fields into frontmatter (machine-readable) and note into body', () => {
    const md = formFlavor.fromPkc2(
      JSON.stringify({ name: '申請A', note: '備考です', checked: true }),
    );
    expect(readFormFields(md)).toEqual({ name: '申請A', checked: true });
    expect(parseFrontmatter(md).body).toBe('備考です');
  });

  it('field values needing YAML quoting round-trip (colon, quotes)', () => {
    const name = 'A: "B" #C';
    const md = formFlavor.fromPkc2(JSON.stringify({ name, note: '', checked: false }));
    expect(readFormFields(md)).toEqual({ name, checked: false });
  });

  it('tolerant parse: invalid JSON becomes an empty form (PKC2 semantics)', () => {
    expect(readFormFields(formFlavor.fromPkc2('oops'))).toEqual({
      name: '',
      checked: false,
    });
  });
});

describe('attachment flavor', () => {
  it('fromPkc2 maps all PKC2 fields to frontmatter without loss', () => {
    const src = {
      name: 'app.html',
      mime: 'text/html',
      size: 1234,
      asset_key: 'ak-1',
      sandbox_allow: ['allow-scripts', 'allow-forms'],
      registered_as_app: true,
      app_icon: '🌐',
      app_icon_asset_key: 'ak-icon',
      pkc_extension: true,
      startup: false,
      extension_manifest: { tier: 'sandboxed', capabilities: ['graph'] },
      launcher_url: 'https://example.com',
      app_group: 'ツール',
      app_order: 3,
    };
    const md = attachmentFlavor.fromPkc2(JSON.stringify(src));
    const { meta, body } = parseFrontmatter(md);
    expect(body).toBe(''); // 説明 markdown 領域は空で始まる
    expect(meta['attachment.name']).toBe('app.html');
    expect(meta['attachment.mime']).toBe('text/html');
    expect(meta['attachment.size']).toBe(1234);
    expect(meta['attachment.asset_key']).toBe('ak-1');
    expect(meta['attachment.sandbox_allow']).toEqual(['allow-scripts', 'allow-forms']);
    expect(meta['attachment.registered_as_app']).toBe(true);
    expect(meta['attachment.app_icon']).toBe('🌐');
    expect(meta['attachment.app_icon_asset_key']).toBe('ak-icon');
    expect(meta['attachment.pkc_extension']).toBe(true);
    expect(meta['attachment.startup']).toBe(false);
    expect(meta['attachment.launcher_url']).toBe('https://example.com');
    expect(meta['attachment.app_group']).toBe('ツール');
    expect(meta['attachment.app_order']).toBe(3);
    // ネスト構造は JSON scalar で round-trip
    expect(JSON.parse(String(meta['attachment.extension_manifest']))).toEqual(
      src.extension_manifest,
    );
  });

  it('sandbox_allow tokens containing a comma survive the inline-array round-trip (review #1)', () => {
    const md = attachmentFlavor.fromPkc2(
      JSON.stringify({ name: 'x', mime: 'text/html', sandbox_allow: ['a,b', 'c'] }),
    );
    expect(parseFrontmatter(md).meta['attachment.sandbox_allow']).toEqual(['a,b', 'c']);
  });

  it('unknown / future fields are preserved in attachment.extra (review #3 — PKC2 の whitelist copy 事故の型)', () => {
    const md = attachmentFlavor.fromPkc2(
      JSON.stringify({
        name: 'x',
        mime: 'text/html',
        future_field: { nested: [1, 2] },
        another: 'v',
      }),
    );
    const { meta } = parseFrontmatter(md);
    expect(JSON.parse(String(meta['attachment.extra']))).toEqual({
      future_field: { nested: [1, 2] },
      another: 'v',
    });
    // 既知 field だけなら extra は書かれない
    const clean = attachmentFlavor.fromPkc2(
      JSON.stringify({ name: 'y', mime: 'image/png' }),
    );
    expect(parseFrontmatter(clean).meta['attachment.extra']).toBeUndefined();
  });

  it('refuses legacy inline data (bytes must be externalized first — no silent loss)', () => {
    const legacy = JSON.stringify({ name: 'f.png', mime: 'image/png', data: 'aGVsbG8=' });
    expect(() => attachmentFlavor.fromPkc2(legacy)).toThrow(/externalize/);
  });

  it('minimal / invalid bodies convert tolerantly', () => {
    const md = attachmentFlavor.fromPkc2('broken');
    const { meta } = parseFrontmatter(md);
    expect(meta['attachment.name']).toBe('');
    expect(meta['attachment.mime']).toBe('application/octet-stream');
    expect(attachmentFlavor.extract(md)).toEqual(NO_EXTRACT);
  });
});

describe('spreadsheet flavor', () => {
  it('fromPkc2 emits a csv-render fence with CSV escaping', () => {
    const md = spreadsheetFlavor.fromPkc2(
      JSON.stringify({ rows: [['a', 'b,c'], ['d"e', 'f\ng']] }),
    );
    expect(md).toBe('```csv-render\na,"b,c"\n"d""e","f\ng"\n```');
  });

  it('noHeader maps to the csv fence noheader option', () => {
    const md = spreadsheetFlavor.fromPkc2(
      JSON.stringify({ rows: [['1', '2']], noHeader: true }),
    );
    expect(md).toBe('```csv-render noheader\n1,2\n```');
  });

  it('layout / chart / format definitions go to frontmatter and round-trip', () => {
    const charts = [
      { id: 'c1', kind: 'bar', title: 'T', xCol: 0, yCols: [1], startRow: 1 },
    ];
    const columnFormats = [{ col: 1, type: 'currency', currency: 'JPY' }];
    const md = spreadsheetFlavor.fromPkc2(
      JSON.stringify({
        rows: [['x', '1']],
        colWidths: [80, 120],
        rowHeights: [24],
        charts,
        columnFormats,
      }),
    );
    const { meta, body } = parseFrontmatter(md);
    expect(meta['sheet.colWidths']).toEqual([80, 120]);
    expect(meta['sheet.rowHeights']).toEqual([24]);
    expect(JSON.parse(String(meta['sheet.charts']))).toEqual(charts);
    expect(JSON.parse(String(meta['sheet.columnFormats']))).toEqual(columnFormats);
    expect(body).toBe('```csv-render\nx,1\n```');
  });

  it('tolerant parse: invalid JSON becomes an empty sheet', () => {
    expect(spreadsheetFlavor.fromPkc2('nope')).toBe('```csv-render\n```');
    expect(spreadsheetFlavor.extract('```csv-render\n```')).toEqual(NO_EXTRACT);
  });

  it('cells containing backtick runs cannot break out of the fence (review #2)', () => {
    const md = spreadsheetFlavor.fromPkc2(
      JSON.stringify({ rows: [['```'], ['secret-data']] }),
    );
    // fence は内容の最長 backtick run より長い ── データが fence 外に漏れない
    expect(md).toBe('````csv-render\n```\nsecret-data\n````');
  });
});

describe('frontmatter round-trip hardening (P3-4 review)', () => {
  it("plain scalar keeps YAML comment semantics: apostrophe doesn't open a quote (review #4)", () => {
    const { meta } = parseFrontmatter("---\ntitle: it's a test # comment\n---\nx");
    expect(meta['title']).toBe("it's a test");
  });

  it('quoted scalar / inline-array elements keep # and , intact (reviews #1/#4)', () => {
    const src = { note: 'a #b', tags: ['x,y', 'z #w'] };
    const body = `${serializeFrontmatter(src)}\nx`;
    expect(parseFrontmatter(body).meta).toEqual(src);
  });
});

/**
 * 🔴 **frontmatter の `date` / `status` は、アーキタイプによらず効く**
 * (2026-08-20。user 指示「カレンダーを利用するための導線が不足している」の調査で判明)。
 *
 * ⚠ **代表 1 つで試さない。** #276 で `text` だけを直したとき、同型の 4 つ
 *   (textlog / spreadsheet / attachment / form)が取り残された ── そして
 *   **全 3943 tests 緑のまま**だった。代表を選ぶ検査は、選ばれなかったものを守らない。
 * 🔑 だから **registry を全数走査**する ── フレーバーを足した人が
 *   `NO_EXTRACT` を返したら、その場で落ちる。
 * 🔴 症状の重さ:列に入らないと、カレンダーの日を押したとき
 *   ①本文には入る ②面には出ない ③2 回目に**嘘の理由**が出る ④外せない、になる。
 */
describe('frontmatter の日付は、アーキタイプによらず効く(2026-08-20)', () => {
  /**
   * 🔴 **本当に registry から引く**(2026-08-27 に直した)。
   *
   * ⚠ ここは「一覧を直書きしない ── registry から引く」と**書いてあった**のに、
   *   実際は `['text','todo','textlog','spreadsheet','attachment','form']` という
   *   **手書きの 6 件**だった ── だから後から足した 2 つ(`snippet` / `smart`)は
   *   **この検査を 1 度も通っておらず**、2 つとも `NO_EXTRACT` を返していた
   *   (= `date:` と書いても予定の面に出ない)。
   * 🔑 宣言ではなく**数え上げ**にする(CLAUDE.md「宣言が在るぶん、次に読む人は
   *   数え直さない」)── フレーバーを足した瞬間に母集団へ入る。
   */
  const ARCHETYPES = registeredArchetypes();

  it('⚠ 前提: 数え上げが空振りしていない(registry を読めている)', () => {
    // ⚠ 下限を置く ── `registeredArchetypes` が空を返す変異を止める
    expect(ARCHETYPES.length, 'registry を読めていない').toBeGreaterThanOrEqual(8);
    for (const a of ARCHETYPES) {
      expect(getFlavor(a).archetype, `${a} が registry に無い(fallback へ落ちている)`).toBe(a);
    }
    // ⚠ **後から足した 2 つ**が母集団に居ることを名指しで見る(手書きへ戻したら落ちる)
    for (const late of ['snippet', 'smart']) {
      expect(ARCHETYPES, `${late} が母集団に居ない`).toContain(late);
    }
  });

  /**
   * 🔴 **例外は 1 つだけ ── `snippet`(雛形)**。
   *
   * ⚠ **免除ではなく「別の場所が持っている決定」**である ──
   *   `tests/features/snippet-table.test.ts` が**対照群つきで**
   *   「抽出列を 1 つも書かない(予定の面に湧かない)」を pin している。
   * ⚠ ここに名前を書くのは、**例外が 1 つであることを目に見えるようにする**ため。
   *   増やすときは、増やした理由を**その場に書く**(黙って足せる一覧にしない)。
   * 🔑 `smart`(スマートフォルダ)は 2026-08-27 に**例外から外した** ──
   *   #283「エントリやエントリグループをタスクとして扱えるようにするんです」
   *   (user 指示 2026-08-19)が根拠である。
   */
  const NO_SCHEDULE = ['snippet'];
  const SCHEDULED = ARCHETYPES.filter((a) => !NO_SCHEDULE.includes(a));

  it('⚠ 前提: 例外を除いても母集団が残っている(空振り防止)', () => {
    expect(SCHEDULED.length, '例外で母集団を空にしている').toBeGreaterThanOrEqual(7);
    expect(SCHEDULED, 'スマートフォルダが例外に落ちている(#283)').toContain('smart');
  });

  it('🔴 全フレーバーが frontmatter の date を列へ写す', () => {
    const body = '---\ndate: 2026-08-20\n---\n本文\n';
    for (const a of SCHEDULED) {
      expect(extractMeta(a, body).date, `${a} が date を落としている`).toBe('2026-08-20');
    }
    // ⚠ **例外の側も見る** ── 例外が「いつのまにか全部」にならないように
    for (const a of NO_SCHEDULE) {
      expect(extractMeta(a, body).date, `${a} は写さない約束が変わった`).toBeNull();
    }
  });

  it('🔴 全フレーバーが frontmatter の status を列へ写す', () => {
    const body = '---\nstatus: done\n---\n本文\n';
    for (const a of SCHEDULED) {
      expect(extractMeta(a, body).status, `${a} が status を落としている`).toBe('done');
    }
    for (const a of NO_SCHEDULE) {
      expect(extractMeta(a, body).status, `${a} は写さない約束が変わった`).toBeNull();
    }
  });

  /**
   * ⚠ **書いていないときは `null`**(既定値を作らない)。作ると、日付を書いていない
   *   全ノートがどこかの日に並ぶ。
   */
  it('書いていなければ null(既定値を作らない)', () => {
    for (const a of ARCHETYPES) {
      const e = extractMeta(a, '本文だけ\n');
      expect(e.date, `${a} が既定の日付を作っている`).toBeNull();
      /**
       * ⚠ **`todo` だけは既定を持つ**(`'open'`)── カンバンが「全 todo」を
       *   SQL だけで引けるようにするための意図的な設計である
       *   (`src/features/flavor/todo-flavor.ts` の docstring)。
       * 🔑 1 稿目はここを「全部 null」と書いて落ちた ── **実装ではなく期待の側が
       *   誤り**だった(CLAUDE.md「未確認は assert ではなく診断で出す」の逆向きの例:
       *   確かめずに後条件を固めると、落ちたときに実装を疑ってしまう)。
       */
      expect(e.status, `${a} の既定の状態が変わった`).toBe(a === 'todo' ? 'open' : null);
    }
  });

  /**
   * ⚠ `archived` は写さない ── 写すと「`archived: true` と書いただけでノートが
   *   一覧から消える」(理由が書いた本人にも分からない)。todo だけが例外である。
   */
  it('archived は todo だけが写す(普通のノートは消えない)', () => {
    const body = '---\narchived: true\n---\n本文\n';
    for (const a of ARCHETYPES) {
      expect(extractMeta(a, body).archived, `${a} の archived の扱いが違う`).toBe(a === 'todo');
    }
  });
});
