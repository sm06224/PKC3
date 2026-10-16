/** @vitest-environment happy-dom */
/**
 * メッセージの直し(#1087 M6 / M7 / M10)── 集積地へ積む字が壊れない。
 *
 * 守るもの:①お知らせの題名がメッセージに原文のまま残る(「…」の中が潰れない)②アプリが書いた断り文の
 * ボタン名が残る ③ワーカーの記録の lane 名が英語のまま出ない ④80 字の切りが代用対を割らない。
 * 守っていないもの:実ブラウザの画面(ここは字の組み立てまで)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnounce } from '../src/adapter/ui/render/announce';
import { appMessagePost } from '../src/adapter/platform/message-post';
import { NoticeStore, type NoticeStorage } from '../src/adapter/platform/notice-store';
import { NOTICES } from '../src/features/notice/notice-log';
import {
  formatMessageSection,
  messageSourceLabel,
  sanitizeMessageText,
} from '../src/features/message/message-log';
import {
  APP_REFUSAL_LITERALS,
  fixedHeadOfOpError,
  messageTextOfOpError,
} from '../src/features/message/caution-events';

function memory(): NoticeStorage {
  const data: Record<string, string> = {};
  return {
    get: (k) => data[k] ?? null,
    set: (k, v) => {
      data[k] = v;
    },
    remove: (k) => {
      delete data[k];
    },
  };
}

describe('M6 お知らせの題名', () => {
  beforeEach(() => localStorage.clear());

  it('🔴 登記表の全題名が、メッセージの字として原文のまま残る', () => {
    const spy = vi.spyOn(appMessagePost, 'post').mockImplementation(() => {});
    let withBrackets = 0;
    for (const n of NOTICES) {
      localStorage.clear();
      const region = document.createElement('section');
      document.body.append(region);
      createAnnounce(region, new NoticeStore(memory()), [n]).present();
      const call = spy.mock.calls.find((c) => c[0].text === n.title);
      expect(call, `${n.id} が配信されていない`).toBeDefined();
      const input = call![0];
      expect(sanitizeMessageText(input.text, input.fixedHead), n.id).toBe(n.title.replace(/\r?\n/g, ' '));
      if (/[「『]/.test(n.title)) withBrackets += 1;
      region.remove();
    }
    // 空振り防止:括弧入りの題名が実在する(無ければ上の等値は括弧の潰しを 1 度も通らない)
    expect(withBrackets, '括弧入りの題名が 0 件(前提が崩れている)').toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('対照群:利用者の字(fixedHead なし)の括弧は今までどおり潰れる', () => {
    expect(sanitizeMessageText('「秘密の題名」について')).toBe('「…」について');
  });
});

describe('M6 アプリが書いた断り文', () => {
  it('🔴 3 つの断り文は、ボタン名の「…」が残る', () => {
    expect(APP_REFUSAL_LITERALS).toHaveLength(3);
    for (const e of APP_REFUSAL_LITERALS) {
      expect(sanitizeMessageText(messageTextOfOpError(e), fixedHeadOfOpError(e)), e).toBe(e);
    }
  });

  it('正本の字と一致している(各 file の中に同じ字が在る)', () => {
    const files = ['src/adapter/ui/actions/binder.ts', 'src/adapter/state/app-state.ts', 'src/main.ts'].map((p) =>
      readFileSync(p, 'utf8'),
    );
    for (const e of APP_REFUSAL_LITERALS) {
      expect(
        files.some((f) => f.includes(`'${e}'`)),
        `${e} がどの file にも無い`,
      ).toBe(true);
    }
  });

  it('利用者の字が続く文は、続きの側が潰れる(素通りしない)', () => {
    const e = `${APP_REFUSAL_LITERALS[0]}「ひみつ」`;
    expect(sanitizeMessageText(e, fixedHeadOfOpError(e))).toBe(`${APP_REFUSAL_LITERALS[0]}「…」`);
  });
});

describe('M7 ワーカーの記録の lane 名', () => {
  it('🔴 WorkerLease の name 全部に画面の字が在る', () => {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8');
          for (const m of src.matchAll(/new WorkerLease\(\{[\s\S]{0,200}?\bname:\s*'([a-z]+)'/g)) names.add(m[1]!);
        }
      }
    };
    walk('src');
    // 空振り防止:9 本(math / chart / asr / asset / wave / audio / ooxml / markdown / video)
    expect(names.size, '数えた lane が少ない').toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const label = messageSourceLabel(name);
      expect(label, `${name} が英語のまま`).not.toBe(name);
      expect(label, name).toMatch(/[^\u0020-\u007e]/);
    }
  });
});

describe('M10 80 字の切り', () => {
  it('🔴 代用対の途中で切らない', () => {
    const out = sanitizeMessageText('a'.repeat(79) + '😀' + 'b'.repeat(20));
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(Array.from(out).length).toBe(81); // 80 字 + 「…」
    expect(out.startsWith('a'.repeat(79) + '😀')).toBe(true);
    // 節に組んでも孤立した半分が無い
    expect(
      formatMessageSection({ at: '2026-10-16T01:00:00.000Z', kind: 'problem', source: 'storage', text: out }),
    ).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('80 字ちょうど・以下は切らない(対照群)', () => {
    const t = '😀'.repeat(80);
    expect(sanitizeMessageText(t)).toBe(t);
  });
});
