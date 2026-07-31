import { describe, expect, it } from 'vitest';
import { extractMeta, getFlavor, NO_EXTRACT } from '../../src/features/flavor';
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

  it('text fallback: fromPkc2 is identity, extract has no columns', () => {
    const body = '---\nstatus: done\ndate: 2026-08-01\n---\n# 見出し';
    expect(getFlavor('text').fromPkc2(body)).toBe(body);
    // text 系は frontmatter に status 等が書かれていても列に写さない
    // (kanban / calendar は todo だけを引く ── PKC2 と同じ意味論)
    expect(extractMeta('text', body)).toEqual(NO_EXTRACT);
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
