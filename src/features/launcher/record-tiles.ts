/**
 * 🔴 **アプリの一覧の「記録」の節に並べるテンプレート**(#2002 段 5)。
 *
 * > user の物語:回帰テストの記録・当番の引き継ぎ ── 毎回同じ項目を打つ定型のノートを、アプリの一覧から 1 クリックで始めたい。
 *
 * 🔑 並べるのは**入力欄の定義(` ```yaml form `)の囲みを持つテンプレート**だけ(自分のテンプレートのノート → 組み込みのサンプルの順)。
 *   テンプレートの一覧(`snippetScan`)を**そのまま使う** ── 本文を新しく読み直さない(走査はテンプレートのノートだけで、普通のノートは読まない)。
 * ⚠ 判定は `hasFormFence`(描画と同じ `isFormInfo`)1 本。自分で ` ```yaml form ` を grep しない。
 * pure。
 */
import { hasFormFence } from '../snippet/template-origin';
import { SAMPLE_TEMPLATES } from '../snippet/sample-templates';
import type { SnippetScan } from '../snippet/snippet-table';

export interface RecordTemplate {
  /** 自分のテンプレートなら lid、サンプルなら id。 */
  readonly key: string;
  readonly sample: boolean;
  readonly title: string;
}

export function recordTemplates(scan: SnippetScan | null): RecordTemplate[] {
  const own = (scan?.items ?? [])
    .filter((i) => hasFormFence(i.body))
    .map((i) => ({ key: i.lid, sample: false, title: i.title }));
  const samples = SAMPLE_TEMPLATES.map((s) => ({ key: s.id, sample: true, title: s.title }));
  return [...own, ...samples];
}
