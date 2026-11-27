/**
 * 🔴 v4.0 仕上げ PR-D ── 「テンプレートから作る…」の v4.0 実践サンプル 5 種(`kind: 'note'`)。
 *
 * 守る主張:
 * 1. 5 種がこの順で並び、`kind: 'note'` はアプリの一覧の「新しい記録」(`recordTemplates`)に混ざらない
 * 2. 作った本文は `${date}` が残らず、使う記法(前書きのページ設定・`+++`・`.pkc-line`・` ```3d `・` ```html id= `)が正しく読める
 * 3. 画面の字に使わない語(`BANNED_TERMS`)が 0 件
 */
import { describe, expect, it } from 'vitest';
import { SAMPLE_TEMPLATES, sampleById } from '../../src/features/snippet/sample-templates';
import { insertSnippet } from '../../src/features/snippet/snippet-expand';
import { hasFormFence, stampTemplateOrigin } from '../../src/features/snippet/template-origin';
import { recordTemplates } from '../../src/features/launcher/record-tiles';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { allFences, fenceInfo, splitLines } from '../../src/features/markdown/source-blocks';
import { widgetFenceId } from '../../src/features/markdown/widget-state-block';
import { parse3dSceneSpec } from '../../src/features/viewer3d/scene-spec';
import { placeLineAnchorOf, placeLineTargetId } from '../../src/features/markdown/place-line';
import { BANNED_TERMS } from '../../src/features/ui-terms';

const NOW = new Date(2026, 10, 27, 9, 0);
const make = (body: string): string => insertSnippet({ text: '', start: 0, end: 0 }, body, NOW).text;
const NOTES = SAMPLE_TEMPLATES.filter((s) => s.kind === 'note');
const madeOf = (id: string): string => make(sampleById(id)!.body);

/** 囲みの中身(開き行の info → 中身)。 */
function fences(body: string): Array<{ info: string; inner: string }> {
  const lines = splitLines(body);
  return allFences(body).map((f) => ({
    info: fenceInfo(lines[f.start] ?? '') ?? '',
    inner: lines.slice(f.start + 1, f.end).join('\n'),
  }));
}

describe('v4.0 実践サンプル 5 種', () => {
  it('🔴 5 種がこの順で並び、どれも kind: note(記録 3 本は record のまま)', () => {
    expect(NOTES.map((s) => s.id)).toEqual([
      'a4-report',
      'two-column-handout',
      'idea-canvas-board',
      'table-widget-note',
      'scene-3d-layout',
    ]);
    expect(NOTES.map((s) => s.summary)).toEqual([
      'A4 縦・改ページ入りの業務報告書',
      'A4 横・2 段組みの案内資料',
      '付箋と接続線ですぐ始められるボード',
      'Markdown の表をツールで自動集計',
      '立体で配置や構成をメモする',
    ]);
    expect(SAMPLE_TEMPLATES.filter((s) => s.kind === 'record').map((s) => s.id)).toEqual([
      'qa-regression',
      'ops-handoff',
      'product-discovery',
    ]);
    expect(new Set(SAMPLE_TEMPLATES.map((s) => s.id)).size).toBe(SAMPLE_TEMPLATES.length);
  });

  it('🔴 文書の見本はアプリの一覧の「新しい記録」に混ざらない(記録 3 本だけ)', () => {
    const keys = recordTemplates(null).map((r) => r.key);
    expect(keys).toEqual(['qa-regression', 'ops-handoff', 'product-discovery']);
    for (const n of NOTES) expect(keys).not.toContain(n.id);
  });

  for (const s of NOTES) {
    describe(s.title, () => {
      const made = make(s.body);
      it('作ると日付が入り、${date} が残らない。入力欄の囲みは持たない(template: の行も足さない)', () => {
        expect(made).not.toContain('${date}');
        expect(made).toContain('2026-11-27');
        expect(hasFormFence(s.body)).toBe(false);
        expect(stampTemplateOrigin(made, s.title)).toBe(made);
      });
      it('🔴 画面の字に使わない語が 0 件', () => {
        const hits = BANNED_TERMS.filter((t) => t.pattern().test(s.body + s.title + s.summary)).map((t) => t.banned);
        expect(hits).toEqual([]);
      });
      it('描くと中身が出る(空にならない)', () => {
        const html = renderMarkdown(parseFrontmatter(made).body, { liveWidgets: true });
        expect(html.length).toBeGreaterThan(500);
      });
    });
  }
});

describe('A4 報告書・2 段組み配布資料', () => {
  it('🔴 A4 報告書: A4 縦・標準の余白・+++ の改ページで 2 ページになる', () => {
    const made = madeOf('a4-report');
    const { meta, body } = parseFrontmatter(made);
    expect(meta.page_format).toBe('a4-portrait');
    expect(meta.page_margin).toBe('normal');
    expect(body.split('\n').filter((l) => l === '+++')).toHaveLength(1);
    const html = renderMarkdown(body, {});
    expect(html).toContain('pkc-section-break');
    expect(html).toContain('<table');
    expect(html).toContain('pkc-section-summary');
  });

  it('🔴 2 段組み配布資料: A4 横・狭い余白・2 段', () => {
    const { meta, body } = parseFrontmatter(madeOf('two-column-handout'));
    expect(meta.page_format).toBe('a4-landscape');
    expect(meta.page_margin).toBe('narrow');
    expect(String(meta.page_columns)).toBe('2');
    const html = renderMarkdown(body, {});
    expect(html).toContain('<table');
    expect(html).toMatch(/type="checkbox"/);
    expect(html).toContain('<strong>');
  });
});

describe('アイデア整理ボード', () => {
  const made = madeOf('idea-canvas-board');
  const lines = made.split('\n');
  const placeIds = lines
    .filter((l) => /^:::format\{#\S+ \.pkc-place /.test(l))
    .map((l) => /^:::format\{#(\S+) /.exec(l)![1]!);
  const lineOpens = lines.filter((l) => l.startsWith(':::format{.pkc-line '));
  const attr = (l: string, k: string): string | null => new RegExp(`\\b${k}=(\\S+?)[ }]`).exec(l)?.[1] ?? null;

  it('🔴 前書きは layout: canvas。付箋 4 枚(課題・アイデア・優先度・次の一手)', () => {
    expect(made.startsWith('---\nlayout: canvas\n---\n')).toBe(true);
    expect(placeIds).toEqual(['課題', 'アイデア', '優先度', '次の一手']);
  });

  it('🔴 線 3 本の from= / to= は # なしで、どれも在る付箋を指す(線のエラー 0 件)', () => {
    expect(lineOpens).toHaveLength(3);
    for (const l of lineOpens) {
      for (const k of ['from', 'to']) {
        const raw = attr(l, k);
        expect(raw, `${k}= が無い: ${l}`).not.toBeNull();
        expect(raw!.startsWith('#'), `${k}= に # が付いている`).toBe(false);
        expect(placeIds).toContain(placeLineTargetId(raw));
        expect(placeLineAnchorOf(raw).kind, `${k}= の辺が読めない`).toBe('ok');
      }
    }
  });

  it('付箋どうしは重ならない', () => {
    const rects = lines
      .filter((l) => l.includes('.pkc-place '))
      .map((l) => ({ x: Number(attr(l, 'x')), y: Number(attr(l, 'y')), w: Number(attr(l, 'w')), h: Number(attr(l, 'h')) }));
    expect(rects).toHaveLength(4);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${String(i)} と ${String(j)} が重なる`).toBe(false);
      }
  });
});

describe('表＋集計 HTML ツールノート', () => {
  const made = madeOf('table-widget-note');
  const html = fences(made).find((f) => f.info.startsWith('html'))!;

  it('🔴 ```html id="summary-1" の囲みが 1 つ在り、保存つきのツールとして描かれる', () => {
    expect(widgetFenceId(html.info)).toBe('summary-1');
    const out = renderMarkdown(made, { liveWidgets: true });
    expect(out).toContain('data-pkc-widget-id="summary-1"');
    expect(out).toContain('<table');
  });

  it('🔴 外部 CDN ゼロ・テーマの変数・readTables で同じノートの表を読む・台本が構文として読める', () => {
    expect(html.inner).not.toMatch(/https?:\/\/|<script[^>]*\bsrc=|<link\b|\bfetch\(/i);
    expect(html.inner).toContain('var(--pkc-fg');
    expect(html.inner).toContain('var(--pkc-accent');
    expect(html.inner).toContain('window.pkcWidget.readTables()');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html.inner)![1]!;
    expect(() => new Function(script)).not.toThrow();
    // ⚠ 正規表現の \s が字のまま残る(化けると「s」を消してしまう)
    expect(script).toContain('/[,\\s円]/g');
  });
});

describe('3D 配置メモ', () => {
  it('🔴 ```3d の中身は誤り 0 件で、ラベル付きの立体が 7 個(直方体・円柱・球を使う)', () => {
    const f = fences(madeOf('scene-3d-layout')).find((x) => x.info === '3d')!;
    const r = parse3dSceneSpec(f.inner);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    const objects = r.spec.objects;
    expect(objects).toHaveLength(7);
    expect(new Set(objects.map((o) => o.type))).toEqual(new Set(['box', 'cylinder', 'sphere']));
    expect(objects.every((o) => typeof o.label === 'string' && o.label !== '')).toBe(true);
  });
});
