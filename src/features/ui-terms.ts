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
  { term: '履歴', meaning: 'ノートの過去の版(1 件ずつを「版」と呼ぶ)' },
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
  { term: 'お知らせ', meaning: '開発側からの配信(バージョンに同梱)' },
  { term: '一式', meaning: '端末に置く大きな部品(Office の wasm / DuckDB の wasm)' },
  { term: 'フラグ', meaning: '開発者向けの切替(最大 15・foldWhen 必須)' },
  { term: 'アプリ', meaning: 'バージョン / マニュアル / ショートカットの表' },
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
  { term: 'ショートカットキー', meaning: '操作を呼び出すキーの組み合わせ(短くは「ショートカット」)' },
  { term: 'ショートカット', meaning: 'ショートカットキーを短く言う語' },
  { term: 'ウィンドウ', meaning: '画面に別に開く枠(アプリ本体とは別のもの)' },
  { term: '別ウィンドウ', meaning: 'いま見ている画面とは別に開くウィンドウ' },
  { term: 'バー', meaning: '細長い操作や表示の領域(書式バー・操作バー・ステータスバー)' },
  { term: 'ブックマーク', meaning: 'よく開く場所を入れておく一覧' },
  { term: 'ピン留め', meaning: '横に並べて表示しておくこと' },
  { term: 'ビルド', meaning: 'アプリを組み立てて配布の形にすること(ビルド日時など)' },
  { term: 'バージョン', meaning: 'アプリの版の番号(ノートの履歴の「版」とは別)' },
  { term: 'コピー', meaning: '元を残したまま、同じ中身を別の場所に作ること' },
  { term: '再読み込み', meaning: 'ブラウザのページを読み込み直すこと' },
  { term: 'フォーカス', meaning: '入力が向いている場所(押したキーが届く所)' },
  { term: 'ペイン', meaning: '画面を縦に分けた領域(左・中央・右)' },
  { term: '構成ファイル', meaning: '一式に何が入っているかを書いたファイル(pack.json)' },
  { term: 'ブロック', meaning: '本文の 1 まとまり(段落・表・囲みなど)' },
  { term: 'ファイル', meaning: '端末に保存する 1 つの書類やデータ' },
  { term: 'ID', meaning: 'ノートや添付を見分ける番号' },
  { term: 'アドレス', meaning: 'ブラウザに打つ URL(連絡先の住所は「住所」のまま)' },
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
  readonly reason: '造語' | '評価語・脅し語' | '英語の素通し' | '飾り記号';
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
 * 🔴 **画面の字・お知らせの字は、ここの言い換えに従う**(user 指示 2026-10-06:
 *   英語を直訳した造語・内部の言葉が混ざった気持ちの悪い字を、一般的な用語へ直す)。
 *   残りは `tests/features/ui-terms.test.ts` の `KNOWN_BANNED`(**0 件を保つ**)で見る。
 * ⚠ 一覧の 1 行は `banned('語', '言い換え', '種類', [除外の複合語])` の 1 行にする
 *   (`.claude/skills/notice-writing/notice_check.py` が行の形で読む)。
 */
export const BANNED_TERMS: readonly BannedTerm[] = [
  banned('面', 'パネル / 画面', '造語', ['画面', '紙面']),
  banned('口', '使わない', '造語', ['入口', '出口', '窓口', '口座']),
  banned('札', '使わない', '造語', ['札幌']),
  banned('検め', '使わない', '造語'),
  banned('区画', '読み込めなかった箇所', '造語'),
  banned('小窓', '別ウィンドウ', '造語'),
  banned('近道', 'ショートカットキー / ショートカット', '造語'),
  banned('鍵', 'キー', '造語', ['鍵盤']),
  banned('窓', 'ウィンドウ', '造語', ['窓口']),
  banned('帯', 'バー(書式バー・操作バー・ステータスバー)', '造語', ['時間帯', '帯域', '地帯', '携帯', '連帯']),
  banned('焼', 'ビルド / 埋め込む / 描く', '造語'),
  banned('栞', 'ブックマーク', '造語'),
  banned('留め', 'ブックマークに入れる / ピン留め', '造語', ['ピン留め']),
  banned('写し', 'コピー', '造語'),
  banned('写す', 'コピーする', '造語'),
  banned('写せ', 'コピーできる', '造語'),
  banned('写ら', 'コピーされる', '造語'),
  banned('影', '控え', '造語', ['影響', '撮影', '陰影', '投影']),
  banned('目録', '構成ファイル', '造語'),
  banned('ひとそろい', '一式', '造語'),
  banned('持ち歩', '1 ファイルの HTML', '造語'),
  banned('可搬', '1 ファイルの HTML', '造語'),
  banned('持ち出し', '書き出し', '造語'),
  banned('読み直', '再読み込み', '造語'),
  banned('畳', '折りたたむ', '造語'),
  banned('取っ手', 'つまみ', '造語'),
  banned('焦点', 'フォーカス', '造語'),
  banned('状態の行', 'ステータスバー', '造語'),
  banned('状態の帯', 'ステータスバー', '造語'),
  banned('左の列', '左のペイン', '造語'),
  banned('右の列', '右のペイン', '造語'),
  banned('この版では', 'このバージョンでは', '造語'),
  banned('新しい版に切り替', '新しいバージョンに切り替える', '造語'),
  banned('新しい版が', '新しいバージョンが', '造語'),
  banned('古い版のタブ', '古いバージョンのタブ', '造語'),
  banned('別の版が', '別のバージョンが', '造語'),
  banned('別の版で', '別のバージョンで', '造語'),
  banned('塊', 'ブロック', '造語'),
  banned('取り直', '取得し直す', '造語'),
  banned('取ってこ', '取得でき', '造語'),
  banned('配っ', '配布する', '造語'),
  banned('配る', '配布する', '造語'),
  banned('配り方', '配布の形', '造語'),
  banned('在る', 'ある(ひらがな)', '造語'),
  banned('居る', 'いる(ひらがな)', '造語'),
  banned('居ない', 'いない(ひらがな)', '造語'),
  banned('在り', 'あり(ひらがな)', '造語'),
  banned('在っ', 'あっ(ひらがな)', '造語'),
  banned('繋が', 'つながり(型名と揃える)', '造語'),
  banned('ごみ箱', 'ゴミ箱', '造語'),
  banned('file', 'ファイル', '英語の素通し', ['profile', 'filename', 'fileName']),
  banned('lid', 'ID', '英語の素通し', ['invalid', 'valid', '_lid', 'solid']),
  banned('asset key', '添付の ID', '英語の素通し'),
  banned('添付 key', '添付の ID', '英語の素通し'),
  banned('添付の key', '添付の ID', '英語の素通し'),
  banned('🔴', '付けない(説明文の飾りは要らない)', '飾り記号'),
  banned('🔑', '付けない(説明文の飾りは要らない)', '飾り記号'),
  banned('──', '。か、か括弧で文を切る', '飾り記号'),
  banned('引く', '実行する(SQL)/ 引用する(PDF)', '造語', ['線を引く', '差し引く']),
  banned('引け', '実行できる(SQL)/ 引用できる(PDF)', '造語', ['線が引け', '差し引け']),
  banned('引いて', '実行して(SQL)', '造語', ['線を引いて', '差し引いて']),
  banned('引きま', '実行します(SQL)/ 引用しました(PDF)', '造語', ['線を引きま']),
  banned('当たり', '一致', '造語'),
  banned('当たる', '一致する', '造語'),
  banned('当てて', '適用して', '造語', ['割り当てて']),
  banned('当てる', '適用する', '造語', ['割り当てる']),
  banned('落と', 'ドロップする / ダウンロードする', '造語', ['段落と']),
  banned('組む', '作る', '造語'),
  banned('組んで', '作って', '造語'),
  banned('組んだ', '作った', '造語'),
  banned('組め', '作れ', '造語'),
  banned('組み立て', '作る', '造語'),
  banned('組み直', '作り直', '造語'),
  banned('添付の控え', '添付の過去の版', '造語'),
  banned('器', '保存データ / 枠', '造語', ['容器', '機器', '楽器', '器具']),
  banned('印', '目印 / 既読', '造語', ['印刷', '目印', '矢印', '封印', '印字']),
  banned('住所', 'アドレス(連絡先の住所だけは普通の語)', '造語'),
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
