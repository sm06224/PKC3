/** @vitest-environment happy-dom */
/**
 * P7 段⑥: **マニュアルが実装から遅れたら落とす**。
 *
 * 🔴 doc は「書いた時」ではなく「**次に読む時**」に正しくないと意味がない。
 * マニュアルは実装への主張の束であり、主張は黙って腐る ── PKC2 は
 * 「廃止済み flag への言及」「変わった手順」で実際に腐らせた。
 *
 * ⚠ **全部は縛れない**(散文は機械では読めない)。ここが縛るのは
 * **一覧・数・語彙**という、ずれたら user が確実に困るものだけである。
 * 縛っていない主張が嘘になる可能性は残る ── だから doc 側にも
 * 「いま動くものだけを書く」と明記してある。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildShell } from '../src/adapter/ui/render/shell';
import { RENDERABLE_FENCE_LANGS } from '../src/features/markdown/markdown-render';
import { MARKDOWN_EXTENSIONS } from '../src/features/import/plain-markdown';
import { REVISION_KEEP_LATEST } from '../src/adapter/platform/storage/store-port';

const MANUAL = readFileSync('docs/manual.md', 'utf-8');
const MIGRATION = readFileSync('docs/migration-from-pkc2.md', 'utf-8');

/** shell が実際に描いたボタンの文言(`data-pkc-action` で引く)。 */
function buttonLabels(action: string): string[] {
  const root = document.createElement('div');
  buildShell(root);
  return [...root.querySelectorAll(`[data-pkc-action="${action}"]`)].map(
    (b) => b.textContent ?? '',
  );
}

/**
 * 🔴 **文言そのものを pin する**。「マニュアルに `**<文言>**` が在るか」だけでは
 * 足りない ── `バックアップ` を `保存` に改名する変異が**生き残った**。
 * マニュアル §2 の「書く → **保存**」(編集ボタンの話)に**たまたま救われて**いた。
 * 散文は何にでも当たるので、**期待する一覧を literal で持つ**しかない。
 * 改名したらここが落ちる = マニュアルも直せ、という合図になる。
 */
const EXPECTED_LABELS = {
  'create-entry': ['+ノート', '+Todo', '+ログ', '+シート', '+フォルダ'],
  'set-view': ['詳細', 'かんばん', 'カレンダー', 'ファイラ'],
  'export-archive': ['バックアップ'],
  'export-html': ['閲覧用 HTML'],
  'export-markdown': ['Markdown'],
  'import-file': ['取込'],
  'purge-orphan-assets': ['添付の整理'],
  'attach-file': ['+添付'],
} as const;

describe('マニュアルと実装の突合', () => {
  it.each(Object.entries(EXPECTED_LABELS))(
    '🔴 %s のボタン文言が pin と一致し、マニュアルにも在る',
    (action, expected) => {
      const labels = buttonLabels(action);
      // ⚠ **等値**で見る(包含だと足したものが素通りする)
      expect(labels).toEqual([...expected]);
      for (const label of labels) {
        expect(MANUAL, `マニュアルに「${label}」の説明が無い`).toContain(`**${label}**`);
      }
    },
  );

  it('🔴 描画できる fence 言語が一致する', () => {
    expect(RENDERABLE_FENCE_LANGS.size).toBeGreaterThan(0);
    for (const lang of RENDERABLE_FENCE_LANGS) {
      expect(MANUAL, `マニュアルに fence \`${lang}\` の説明が無い`).toContain(`\`${lang}\``);
    }
  });

  it('受け取れる markdown の拡張子が一致する', () => {
    for (const ext of MARKDOWN_EXTENSIONS) {
      expect(MANUAL).toContain(`\`${ext}\``);
    }
  });

  it('履歴の保持件数が一致する(数字は真っ先に腐る)', () => {
    expect(MANUAL).toContain(`最新 ${REVISION_KEEP_LATEST} 件`);
  });

  it('🔴 書き出すファイルの拡張子が一致する', () => {
    // ⚠ 「どれがバックアップか」を取り違えると、**戻せない形を保存し続ける**
    const src = readFileSync('src/adapter/ui/actions/export-archive.ts', 'utf-8');
    for (const ext of ['.pkc3.zip', '.md.zip', '.html']) {
      expect(src, `実装が ${ext} を作らない`).toContain(`}${ext}\``);
      expect(MANUAL, `マニュアルに ${ext} が無い`).toContain(ext);
    }
  });

  it('🔴 ドラッグ&ドロップを受けないという記述が実態と合う', () => {
    // ⚠ これは「無い」ことの主張なので、**足した瞬間に嘘になる**。
    // 実装したらこの test が落ちる ── そのとき doc を直す
    const hasDrop = ['drop', 'dragover'].some((ev) =>
      readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8').includes(`'${ev}'`),
    );
    expect(hasDrop, 'drop を受けるようになった ── マニュアルの記述を直すこと').toBe(false);
    expect(MANUAL).toContain('ドラッグ&ドロップは受けません');
  });
});

describe('移行ガイドと実装の突合', () => {
  it('🔴 受理する PKC2 形式が一致する(読めると書いて読めない、を落とす)', () => {
    const src = readFileSync('src/features/import/detect-format.ts', 'utf-8');
    const formats = [...src.matchAll(/'pkc2-([a-z-]+)':/g)].map((m) => m[1]!);
    expect(formats.length).toBe(8); // ⚠ 件数も縛る(減ったのに 8 と書き続けない)
    expect(MIGRATION).toContain('全 8 形式');
  });

  it('🔴 relation の kind が一致する', () => {
    const src = readFileSync('src/features/import/pkc2-convert.ts', 'utf-8');
    const block = /const KNOWN_RELATION_KINDS = new Set\(\[([^\]]+)\]/.exec(src)?.[1] ?? '';
    const kinds = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(MIGRATION, `移行ガイドに kind \`${kind}\` が無い`).toContain(`\`${kind}\``);
    }
    expect(MIGRATION).toContain(`${kinds.length} 種`);
  });

  it('🔴 一方通行であることが両方に書いてある', () => {
    // user 裁定 2026-07-30。⚠ ここが曖昧だと user は PKC2 を消す
    expect(MIGRATION).toContain('片道');
    expect(MIGRATION).toContain('pkc3-archive');
  });
});
