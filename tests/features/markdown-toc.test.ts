import { describe, expect, it } from 'vitest';
import {
  extractHeadingsFromMarkdown,
  extractTocFromEntry,
  renderStaticTocHtml,
  makeLogLabel,
  slugifyHeading,
} from '../../src/features/markdown/markdown-toc';

describe('markdown-toc', () => {
  describe('slugifyHeading', () => {
    it('creates URL-friendly slugs', () => {
      expect(slugifyHeading('Hello World!')).toBe('hello-world');
      expect(slugifyHeading('見出し 123')).toBe('見出し-123');
      expect(slugifyHeading('---leading & trailing---')).toBe('leading-trailing');
    });
  });

  describe('extractHeadingsFromMarkdown', () => {
    it('extracts h1, h2, h3 headings and ignores h4+', () => {
      const md = [
        '# Heading 1',
        'Some text',
        '## Heading 2',
        '### Heading 3',
        '#### Heading 4 (ignored)',
      ].join('\n');

      const headings = extractHeadingsFromMarkdown(md);
      expect(headings).toEqual([
        { level: 1, text: 'Heading 1', slug: 'heading-1' },
        { level: 2, text: 'Heading 2', slug: 'heading-2' },
        { level: 3, text: 'Heading 3', slug: 'heading-3' },
      ]);
    });

    it('ignores headings inside fenced code blocks', () => {
      const md = [
        '# Real Heading',
        '```markdown',
        '# Fake Heading',
        '```',
        '## Another Real Heading',
      ].join('\n');

      const headings = extractHeadingsFromMarkdown(md);
      expect(headings).toHaveLength(2);
      expect(headings[0]!.text).toBe('Real Heading');
      expect(headings[1]!.text).toBe('Another Real Heading');
    });

    it('handles frontmatter and vars correctly', () => {
      const md = [
        '---',
        'title: Note Title',
        'vars:',
        '  project: PKC3',
        '---',
        '# Project: {{vars.project}}',
      ].join('\n');

      const headings = extractHeadingsFromMarkdown(md);
      expect(headings).toHaveLength(1);
      expect(headings[0]!.text).toBe('Project: PKC3');
    });

    it('filters out mismatched :::if blocks and keeps matching ones', () => {
      const md = [
        '# Common Heading',
        ':::if{format=pdf}',
        '## PDF Only Heading',
        ':::',
        ':::if{format=html}',
        '## HTML Only Heading',
        ':::',
        '# End Heading',
      ].join('\n');

      const headings = extractHeadingsFromMarkdown(md);
      expect(headings.map((h) => h.text)).toEqual([
        'Common Heading',
        'HTML Only Heading',
        'End Heading',
      ]);
    });

    it('handles CRLF line endings properly', () => {
      const md = '# CRLF Heading 1\r\n\r\n:::if{format=pdf}\r\n## Hidden\r\n:::\r\n:::if{format=html}\r\n## Visible\r\n:::\r\n';
      const headings = extractHeadingsFromMarkdown(md);
      expect(headings.map((h) => h.text)).toEqual(['CRLF Heading 1', 'Visible']);
    });
  });

  describe('extractTocFromEntry', () => {
    it('returns empty array for non-markdown archetype', () => {
      const entry = {
        lid: '1',
        title: 'Canvas',
        archetype: 'canvas',
        body: '# Heading',
      };
      expect(extractTocFromEntry(entry)).toEqual([]);
    });

    it('extracts headings for text archetype', () => {
      const entry = {
        lid: '2',
        title: 'Text',
        archetype: 'text',
        body: '# Intro\n## Details',
      };
      const toc = extractTocFromEntry(entry);
      expect(toc).toEqual([
        { kind: 'heading', level: 1, text: 'Intro', slug: 'intro' },
        { kind: 'heading', level: 2, text: 'Details', slug: 'details' },
      ]);
    });
  });

  describe('renderStaticTocHtml', () => {
    it('renders empty string for empty nodes', () => {
      expect(renderStaticTocHtml([])).toBe('');
    });

    it('renders nav markup for heading nodes', () => {
      const html = renderStaticTocHtml([
        { kind: 'heading', level: 1, text: 'Title <Tag>', slug: 'title-tag' },
      ]);
      expect(html).toContain('class="pkc-toc pkc-toc-preview"');
      expect(html).toContain('href="#title-tag"');
      expect(html).toContain('Title &lt;Tag&gt;');
    });
  });

  describe('makeLogLabel', () => {
    it('formats local time and preview line', () => {
      const iso = '2026-09-28T10:00:00Z';
      const body = 'First line preview\nSecond line';
      const label = makeLogLabel(iso, body);
      expect(label).toContain('First line preview');
    });

    it('skips ATX headings in firstNonEmptyLine', () => {
      const iso = '2026-09-28T10:00:00Z';
      const body = '# Heading to skip\nActual preview line';
      const label = makeLogLabel(iso, body);
      expect(label).toContain('Actual preview line');
      expect(label).not.toContain('Heading to skip');
    });
  });
});
