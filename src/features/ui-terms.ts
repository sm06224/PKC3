/**
 * 名前の正本(#1017 段⑤-1、設計 `docs/development/ui-total-design-2026-09.md` §6)。
 *
 * 🔑 **画面の見出し・ボタン・メッセージの名前は、ここから引く。** 3 つの表を持つ:
 * ① `TYPE_TERMS` ── §1.3 の 15 の型の名前(見出しになる)
 * ② `STANDARD_TERMS` ── §6.1 規則 2「技術の標準語・形式名は英語かカタカナのまま」
 * ③ `BANNED_TERMS` ── §6.1 規則 4(造語)・規則 6(評価語・脅し語)の「使わない語」
 *
 * ⚠ **この file はデータだけを持つ**(`core` に置けないのは DOM を触るからではなく、
 *   `features` の他の module や manual の生成が読む「正本」として `adapter` の外に
 *   置きたいため)。走査(file を読む・comment を剥ぐ)は `tests/features/ui-terms.test.ts`
 *   の側が持つ ── ここは `Node.js` の `fs` にも依存しない純粋なデータ + 判定関数。
 */

export interface UiTerm {
  /** 画面に出る字そのもの */
  readonly term: string;
  /** user の言葉で 1 文(なぜこの名前か・何を指すか) */
  readonly meaning: string;
}

/**
 * 型の名前(§1.3 の 15 の型、そのままの語順)。
 *
 * ⚠ **依頼文に載っていた例示(ノート / 添付 / フォルダ / … / システム)は使わない** ──
 *   「フォルダ」「システム」「メッセージ」「タグ」「フラグ」は §6.1 規則 2 の
 *   `STANDARD_TERMS`(技術の標準語)の側であり、§1.3 が定義する「型」ではない
 *   (フォルダはノートのフレーバーの 1 つ、システムは system 領域の呼び名であって
 *   型そのものではない)。**正本は §1.3 の型の表**であり、そちらを採った。
 */
export const TYPE_TERMS: readonly UiTerm[] = [
  { term: 'コレクション', meaning: 'user の資産の全部(ノート × 添付 × つながり × 履歴)' },
  { term: 'ノート', meaning: '題名 × フレーバー × 本文(PKC-Markdown) × 領域' },
  { term: '添付', meaning: 'ノートに付く file の実体' },
  { term: 'つながり', meaning: 'ノート間の関係(from / to / kind)' },
  { term: '履歴', meaning: 'ノートの過去の版' },
  { term: 'タグ', meaning: '本文から導かれる語(独立の値ではない)' },
  { term: '保存領域', meaning: 'コレクションを置いているこの端末の入れ物' },
  { term: '設定', meaning: 'この端末での好み(見た目 / 編集の仕方 / 通知 / 開き方)' },
  {
    term: '許可',
    meaning:
      'この端末で user が許した事実(外部の画像 / ノートを渡すアプリ / 目次を見せるアプリ / 埋め込み元)',
  },
  {
    term: '記録',
    meaning: 'この端末での行動の事実(最近開いた・コピーの履歴・お知らせの既読・狭い画面の了承)',
  },
  { term: 'メッセージ', meaning: 'アプリが user に言うこと(結果 / 注意 / 問題 / 配信 / 処理)' },
  { term: 'お知らせ', meaning: '開発側からの配信(版に同梱)' },
  { term: '一式', meaning: '端末に置く大きな部品(Office の wasm / DuckDB の wasm)' },
  { term: 'フラグ', meaning: '開発者向けの切替(最大 15・foldWhen 必須)' },
  { term: 'アプリ', meaning: '版 / マニュアル / ショートカットの表' },
] as const;

/**
 * 技術の標準語・形式名(§6.1 規則 2 の一覧、そのままの語順)。
 * 英語かカタカナのまま使い、日本語へ言い換えない。
 */
export const STANDARD_TERMS: readonly UiTerm[] = [
  { term: 'Markdown', meaning: '本文の記法の名前' },
  { term: 'HTML', meaning: '書き出し・埋め込みで使う形式' },
  { term: 'PDF', meaning: '印刷・書き出しで使う形式' },
  { term: 'Word', meaning: 'Office のノート編集アプリの名前' },
  { term: 'PowerPoint', meaning: 'Office のスライドアプリの名前' },
  { term: 'zip', meaning: 'バックアップ・書き出しの圧縮形式' },
  { term: 'CSV', meaning: '表のセルに書ける形式の 1 つ' },
  { term: 'SQL', meaning: '保存領域を直接調べる問い合わせの言葉' },
  { term: 'JSON', meaning: '設定の書き出し・フラグの中身の形式' },
  { term: 'URL', meaning: 'アドレス(リンク先を指す文字列)' },
  { term: 'バックアップ', meaning: 'コレクションを丸ごと持ち出す操作・file' },
  { term: 'メッセージ', meaning: 'アプリが user に言うこと(型としては上の表を見よ)' },
  { term: 'ステータスバー', meaning: '画面の下に出る、いま何が起きているかの 1 行' },
  { term: 'パネル', meaning: '中央に出る画面 1 枚' },
  { term: 'タブ', meaning: '左の列で切り替える見出し' },
  { term: 'メニュー', meaning: '右クリック等で開く選択肢の一覧' },
  { term: 'ボタン', meaning: '押すと操作が起きる部品' },
  { term: 'ショートカット', meaning: 'キーボードの近道' },
  { term: 'テンプレート', meaning: 'よく打つ型を入れておく物' },
  { term: 'フォルダ', meaning: 'ノートを入れる場所' },
  { term: 'タグ', meaning: '本文から導かれる語(型としては上の表を見よ)' },
  { term: 'リンク', meaning: '他のノート・外部を指す参照' },
  { term: 'システム', meaning: 'system 領域(user のディレクトリと分かれた場所)の入り口の名前' },
  { term: 'フラグ', meaning: '開発者向けの切替(型としては上の表を見よ)' },
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `banned` を含むが、実在する別の複合語(誤検知)から `banned` を守るための
 * 正規表現を組む。
 *
 * ⚠ **`excludes` が唯一の正本**である ── 除外の理屈をコメントで別に書かない
 * (書くと、`excludes` を直しても理屈のコメントだけ古くなる)。
 * `excludes` の各語は「`banned` の前後にちょうど 1 語分の文字が付いた実在語」を書く
 * (`画面` なら `banned='面'` の前に `画` が付く形)。
 */
function bannedPattern(banned: string, excludes: readonly string[]): RegExp {
  const prefixes = new Set<string>();
  const suffixes = new Set<string>();
  for (const ex of excludes) {
    if (ex.endsWith(banned) && ex.length > banned.length) {
      prefixes.add(ex.slice(0, ex.length - banned.length));
    } else if (ex.startsWith(banned) && ex.length > banned.length) {
      suffixes.add(ex.slice(banned.length));
    } else {
      throw new Error(`bannedPattern: '${ex}' は '${banned}' の前後どちらにも付いていない`);
    }
  }
  const before =
    prefixes.size > 0 ? `(?<!(?:${[...prefixes].map(escapeRegExp).join('|')}))` : '';
  const after = suffixes.size > 0 ? `(?!(?:${[...suffixes].map(escapeRegExp).join('|')}))` : '';
  return new RegExp(`${before}${escapeRegExp(banned)}${after}`, 'g');
}

export interface BannedTerm {
  readonly banned: string;
  readonly instead: string;
  readonly reason: '造語' | '評価語・脅し語';
  /** `banned` を含むが除外する実在の複合語(0 件なら除外なし) */
  readonly excludes: readonly string[];
  /** `excludes` を素通りさせつつ `banned` を数える正規表現(毎回 new した物を返す) */
  readonly pattern: () => RegExp;
}

function banned(
  word: string,
  instead: string,
  reason: BannedTerm['reason'],
  excludes: readonly string[] = [],
): BannedTerm {
  return { banned: word, instead, reason, excludes, pattern: () => bannedPattern(word, excludes) };
}

/**
 * 使わない語(§6.1 規則 4「造語」+ 規則 6「評価語・脅し語」)。
 *
 * ⚠ **画面の字はこの PR では 1 文字も変えていない**(#1017 段⑤-1)。ここは
 * ①正本を置く ②いまの残りを `tests/features/ui-terms.test.ts` の `KNOWN_BANNED` で
 * 等値 pin する(burn-down)、までである。実際に言い換えるのは次の段(§9 段⑤の続き)。
 */
export const BANNED_TERMS: readonly BannedTerm[] = [
  banned('面', 'パネル / 画面', '造語', ['画面', '紙面']),
  banned('口', '使わない', '造語', ['入口', '出口', '窓口', '口座']),
  banned('器', '使わない', '造語'),
  banned('印', '使わない', '造語', ['印刷', '目印', '矢印', '封印']),
  banned('札', '使わない', '造語', ['札幌']),
  banned('検め', '使わない', '造語'),
  banned('区画', '読み込めなかった箇所', '造語'),
  banned('小窓', '別ウィンドウ', '造語'),
  banned('雛形', 'テンプレート', '造語'),
  banned('紙面', 'ページ設定', '造語'),
  banned('居場所', 'フォルダ', '造語'),
  banned('解放', '編集を終える', '造語'),
  banned('壊れ', '事実を述べる(例:読めない・開けない)', '評価語・脅し語'),
  banned('破損', '事実を述べる', '評価語・脅し語'),
  banned('最後の手', '事実を述べる', '評価語・脅し語'),
  banned('拾う', '事実を述べる(例:取り出す)', '評価語・脅し語'),
  banned('捨てる', '事実を述べる(例:含めない)', '評価語・脅し語'),
  banned('危険', '事実を述べる', '評価語・脅し語'),
  banned('救出', '事実を述べる', '評価語・脅し語'),
  banned('復旧', '事実を述べる', '評価語・脅し語'),
] as const;
