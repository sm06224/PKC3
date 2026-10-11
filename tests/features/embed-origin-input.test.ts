/**
 * 「埋め込み先のページの AI」を許すページのアドレスの入力(#1407)。
 *
 * 守る主張:
 * 1. 🔴 path / query / hash 付きは **origin に落ちる**(貯めると突合が永久に外れる)。落としたときだけ `trimmed`
 * 2. 🔴 https 以外は断る。http は localhost / 127.0.0.1 だけ(port つきも)。`*` / `null` / 空 / 形違いも断る
 * 3. 断るときは**理由の 1 行**を返す(押しても何も起きない、を作らない)
 */
import { describe, expect, it } from 'vitest';
import {
  EMBED_ORIGIN_REASON,
  embedOriginAddedText,
  parseEmbedOriginInput,
} from '@features/agent/embed-origin-input';

describe('parseEmbedOriginInput', () => {
  it('origin はそのまま通り、後ろの字は無いので trimmed=false(末尾の / も後ろに数えない)', () => {
    expect(parseEmbedOriginInput('https://example.com')).toEqual({
      ok: true,
      origin: 'https://example.com',
      trimmed: false,
    });
    expect(parseEmbedOriginInput('  https://example.com/ ')).toEqual({
      ok: true,
      origin: 'https://example.com',
      trimmed: false,
    });
  });

  it.each([
    'https://example.com/a/b',
    'https://example.com/a?q=1',
    'https://example.com#top',
    'https://example.com:8443/x',
  ])('🔴 後ろの付いたアドレスは origin に落ちる: %s', (raw) => {
    const r = parseEmbedOriginInput(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.origin).toBe(new URL(raw).origin);
    expect(r.trimmed).toBe(true);
  });

  it('大文字・既定の port は URL の正規形に揃う', () => {
    expect(parseEmbedOriginInput('HTTPS://Example.COM:443/x')).toMatchObject({
      ok: true,
      origin: 'https://example.com',
    });
  });

  it.each(['http://localhost', 'http://localhost:5173/x', 'http://127.0.0.1:8080'])(
    '手元の http は通る: %s',
    (raw) => {
      expect(parseEmbedOriginInput(raw).ok).toBe(true);
    },
  );

  it.each([
    ['http://example.com', EMBED_ORIGIN_REASON.scheme],
    ['http://localhost.example.com', EMBED_ORIGIN_REASON.scheme],
    ['http://192.168.0.1', EMBED_ORIGIN_REASON.scheme],
    ['ftp://example.com', EMBED_ORIGIN_REASON.scheme],
    ['data:text/html,x', EMBED_ORIGIN_REASON.scheme],
    ['https://user@example.com', EMBED_ORIGIN_REASON.userinfo],
    ['https://user:pw@example.com', EMBED_ORIGIN_REASON.userinfo],
    ['*', EMBED_ORIGIN_REASON.malformed],
    ['null', EMBED_ORIGIN_REASON.malformed],
    ['example.com', EMBED_ORIGIN_REASON.malformed],
    ['not a url', EMBED_ORIGIN_REASON.malformed],
    ['', EMBED_ORIGIN_REASON.empty],
    ['   ', EMBED_ORIGIN_REASON.empty],
  ])('🔴 断る: %j → 理由の 1 行', (raw, reason) => {
    expect(parseEmbedOriginInput(raw)).toEqual({ ok: false, reason });
  });

  it('追加の知らせ: 同じ字なら「を」、違う origin に落ちたら必ず「として」(後ろを落としたときだけ括弧)', () => {
    const o = 'https://example.com';
    expect(embedOriginAddedText(o, false, o)).toBe(`${o} を追加しました`);
    expect(embedOriginAddedText(o, false, `${o}/`)).toBe(`${o} として追加しました`);
    expect(embedOriginAddedText(o, false, 'HTTPS://Example.COM')).toBe(`${o} として追加しました`);
    expect(embedOriginAddedText(o, true, `${o}/a/b`)).toBe(`${o} として追加しました(アドレスの後ろは使いません)`);
  });
});
