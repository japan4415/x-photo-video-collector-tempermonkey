# x-photo-video-collector-tempermonkey

Tampermonkey 向けに開発された、X（旧 Twitter）のプロフィール「メディア」タブで画像・動画を収集してダウンロードするためのユーザースクリプトです。

## 概要

- 対象ページ: `https://x.com/<screenName>/media`
- 主な機能:
  - プロフィールの「メディア」タブを末尾まで自動スクロール
  - 表示中の画像（`pbs.twimg.com`）と MP4 直リンク動画（`video.twimg.com`、m3u8 は除外）を収集
  - 収集したメディアのファイル名を生成し、UI 上にリンク付き一覧として表示
- 今後の拡張: ZIP 形式での一括ダウンロードを予定

## 実装全体構成

- Tampermonkey ユーザースクリプトとして実装
- 主要コンポーネント:
  - URL 監視（SPA でのページ遷移に対応）
  - 右上固定の UI パネル（収集／ダウンロードボタン、ステータス表示、リスト表示）
  - scrollHeight の変化を監視する自動スクロール処理（`scrollIntoView` 併用）
  - DOM 要素を起点としたメディア収集 (`sweepAllMedia`)
  - tweetId・photoIndex・拡張子に基づくファイル名生成

## UI 仕様

- 表示条件: `/media` ページを検知した場合のみ UI を表示
- UI 構成:
  - ヘッダ: 「Media Tools」表記とドラッグ移動用ハンドル
  - コントロールボタン: 「収集」「ダウンロード（未実装）」「停止」
  - ステータス欄: 処理状況および件数を表示
  - リスト欄: `[IMG] filename.jpg` / `[MP4] filename.mp4` 形式でリンク付き一覧を表示（クリックで新規タブを開く）

## 自動スクロール仕様

- 対象コンテナ検出: `document.scrollingElement`・`main`・`primaryColumn` などから最もスクロール可能な要素を選択
- 終了条件:
  - `scrollHeight` の増加が 3 回連続で停止
  - または安全タイムアウト（90〜120 秒）に達した場合
- 実装ポイント:
  - `scrollTop = scrollHeight` を連続実行し、最下段画像を `scrollIntoView` でフォロー
  - ステータス欄に高さの変化量や件数の増加量を表示

## 画像収集（`sweepAllMedia`）

従来の `img[src*="pbs.twimg.com/media/"]` 依存による漏れを解消するため、カード要素を起点とした抽出に変更しました。

### 処理フロー

1. カード列挙
   - セレクタ例: `li[role="listitem"] a[href*="/photo/"]`, `[data-testid="cellInnerDiv"] a[href*="/photo/"]`, `[aria-label^="タイムライン"] a[href*="/photo/"]`
   - `href` の重複を排除
2. 画像 URL 取得
   - `<img>` の `src` を優先し、存在しない場合は `style="background-image: url(...)"` から抽出
3. URL 正規化
   - `?name=orig` に統一し、`format=jpg/png` を補完
4. 重複排除
   - `/media/<ID>` をキーにユニーク化
5. メタ情報付与
   - `href` から `screenName`・`tweetId`・`photoIndex` を抽出

## ファイル名生成仕様

- フォーマット: `<screenName>_<tweetId>_<photoIndex or serial>.<ext>`
- `photoIndex` が取得できる場合はそれを使用し、無ければ同一 `tweetId` 内で連番を採番
- 拡張子判定:
  - 動画: `mp4`
  - 画像: URL の `format`、パスの拡張子、または既定値 `jpg`

## ステータス表示

収集中はデバッグ容易化のため、以下の情報を表示します。

- カード検出数
- 画像抽出の成功数／スキップ数
- 自動スクロール中の高さ変化量、件数増加量、アイドル回数

## 制約・注意事項

- m3u8 形式の動画は対象外（将来的に対応予定）
- 表示件数が多い場合は処理時間が長くなるため、強制停止ボタンを用意
- DOM 構造が変更された際はセレクタの見直しが必要
- 利用にあたっては Twitter (X) の利用規約および著作権を順守すること
