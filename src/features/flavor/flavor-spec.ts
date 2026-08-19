/**
 * フレーバー仕様(P3 設計メモ §3)。
 *
 * PKC3 では**全 body が PKC-Markdown**であり、アーキタイプは body の別形式ではなく
 * 「見せ方・編集の仕方のフレーバー」である(founding 裁定 2026-07-30)。
 * フレーバー固有の機械可読データは frontmatter(+ fence)の規約で表現する。
 *
 * P3-4 はこの pure 部分(extract / fromPkc2)のみ。表示・編集面
 * (renderBody / renderEditorBody / collectBody)は adapter/ui 側の
 * presenter として P3-5 以降で実装する(features 層に DOM を持ち込まない)。
 */

/** entries 表の抽出列のうち、**フレーバーが決める**分(status / date / archived)。 */
export interface FlavorExtract {
  status: string | null;
  date: string | null;
  archived: boolean;
}


export interface FlavorSpec {
  archetype: string;
  /**
   * body(frontmatter)→ 抽出列。**保存経路の唯一の抽出関数**であり、
   * worker には抽出済みの値だけが渡る(抽出列と body の乖離 = PKC2 #1022 型の
   * 二重表現事故を、書込点の一元化で構造的に防ぐ)。
   */
  extract(body: string): FlavorExtract;
  /**
   * PKC2 形式の body(多くは JSON 文字列)→ PKC-Markdown。P6 import が使う。
   * PKC2 の寛容 parse の意味論(不正 JSON を落とさない)を引き継ぐこと。
   */
  fromPkc2(body: string): string;
  /**
   * 新規作成時の初期 body(P3-7a)。省略時は ''(空 markdown)。
   * フレーバーの frontmatter / fence 規約を最初から見せる seed に留め、
   * テンプレート機能にしない(盛り込みすぎない)。
   */
  seed?(): string;
}

/** 抽出列を持たないフレーバーの返り値(共有・凍結)。 */
export const NO_EXTRACT: FlavorExtract = Object.freeze({
  status: null,
  date: null,
  archived: false,
});
