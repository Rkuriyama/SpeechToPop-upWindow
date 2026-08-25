# SpeechToPop-upWindow
音声認識によって入力された文章から、事前に登録した単語を検索し、合致したものとその説明を表示する。
スポーツ実況解説とかの専門用語を認識し、その説明を表示させる"あれ"を目標に作成中。

## 用語集JSON

起動時に `data/glossary.json` を読み込む。画面の「JSONを読み込む」から、同じ形式の別ファイルを選んで即時反映することもできる。

サンプルとして `data/league-of-legends.json`、`data/ffxiv.json`、`data/valorant.json` も用意している。

表示時間、イン／アウトのアニメーション時間、キューの表示間隔と最大件数、1文当たりの検知上限、再表示までのクールダウン時間は用語ごとではなく、`settings` で全体共通に指定する。`displaySeconds` は1〜10秒、`enterSeconds` と `exitSeconds` は0.1〜2秒、`queueIntervalSeconds` は0〜5秒の範囲で、いずれも0.1秒刻みに設定できる。`queueMaxItems` は表示中と待機中を合わせた最大件数、`maxMatchesPerTranscript` は1つの認識文から処理する異なる用語の最大数で、どちらも1〜5件の範囲とする。表示設定カードでは `cooldownSeconds` を0〜180秒の範囲で1秒単位に変更できる。

```json
{
  "schemaVersion": 3,
  "title": "用語集フォーマット例",
  "contextBiasTerms": [
    "サモナーズリフト",
    "アーリ",
    "ヤスオ",
    "ジンクス",
    "ラックス"
  ],
  "settings": {
    "displaySeconds": 5,
    "enterSeconds": 0.5,
    "exitSeconds": 0.5,
    "queueIntervalSeconds": 0,
    "queueMaxItems": 3,
    "maxMatchesPerTranscript": 3,
    "cooldownSeconds": 60,
    "appearance": {
      "width": 560,
      "height": 190,
      "titleFontSize": 34,
      "descriptionFontSize": 20,
      "borderRadius": 20,
      "fontFamily": "sans",
      "textAlign": "left",
      "accentColor": "#59d8ff",
      "backgroundColor": "#101827",
      "textColor": "#f5f8fc"
    }
  },
  "terms": [
    {
      "id": "cs",
      "title": "CS (クリープスコア)",
      "aliases": ["CS", "シーエス", "クリープスコア"],
      "description": "ミニオンや中立モンスターへのラストヒット数を示す指標。獲得ゴールド量の目安になる。",
      "enabled": true
    }
  ]
}
```

`schemaVersion: 3` で `appearance` を省略したJSONも読み込める。その場合は標準デザインが補完される。画面で変更したデザインと表示設定はブラウザに保存される。

`appearance.fontFamily` は `sans`、`yugothic`、`meiryo`、`bizud`、`rounded`、`serif`、`monospace` から選択できる。フォントはOBSで扱いやすいよう端末内のフォントを使用し、利用できない場合は近い日本語フォントへフォールバックする。

`title` はポップアップ表示専用で、音声認識の照合には使用しない。単独で通用し、展開形より使用頻度が高い完全な略語は `CS (クリープスコア)` や `MT (メインタンク)` のように表示する。同じ対象を指す同格の呼称が複数ある場合は `視界/ビジョン` や `プラント/スパイク設置` のようにスラッシュで併記する。

`aliases` には音声認識で検出したいすべての呼称を登録する。表示タイトルが `CS (クリープスコア)` なら `CS`、`シーエス`、`クリープスコア`、`視界/ビジョン` なら `視界`と`ビジョン`を個別に指定する。一般語や、関連はあるものの別の対象を指す語は登録しない。登録済みのaliasをそのまま含むだけの派生表現も不要で、たとえば `視界` があれば `視界管理` は追加しない。ただし `カイト` と `カイティング` のように文字列が異なる活用語は残す。1文で異なる複数用語に一致した場合は登場順にキューへ追加し、`maxMatchesPerTranscript` 件まで処理する。同じ位置で複数の用語に一致した場合は、より長い語句だけを採用する。照合には `Intl.Segmenter` の日本語単語境界を使用し、aliasの開始・終了がともに単語境界にある場合だけ一致とするため、`スピール` 内の `ピール` のような別単語内部の部分一致ではポップアップを表示しない。

`contextBiasTerms` は、キャラクター名、マップ名、武器名など認識精度向上だけに使うゲーム内用語の配列。ここに登録した語は音声認識の文脈ヒントには使われるが、認識されてもポップアップは表示されない。`schemaVersion: 3`では必須で、登録語がない場合も空配列を指定する。

対応ブラウザでは、有効な用語の `aliases` と `contextBiasTerms` を音声認識の文脈ヒント（phrases）へ `boost: 5` で登録する。正規化後に重複する語は1件にまとめ、JSONの読み込み・切り替え時にも登録内容を更新する。ブラウザにphrases APIがない場合や、認識モデルから `phrases-not-supported` が返された場合は、そのページを閉じるまでphrasesを無効化し、通常の音声認識と文字列照合へ自動的にフォールバックする。

現行より古い`schemaVersion`のJSONは読み込まない。インポート時にエラーダイアログが開き、ChatGPTなどのLLMへそのまま貼り付けられる現行形式への変換指示文をコピーできる。

通常画面のQUEUE下には認識デバッグ欄を表示する。途中・確定の認識文、一致したすべてのalias、表示・キュー追加・未追加の結果を確認でき、＋／−ボタンで開閉できる。

## sherpa-onnx WebAssembly版

Google Web Speech APIを使用せず、マイク音声をブラウザ内の
[`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) WebAssemblyで処理する版を用意している。
Silero VADで発話区間を切り出し、ReazonSpeechで学習された日本語Zipformerで認識する。発話中は現在までの音声を定期的に再認識するOffline疑似ストリーミングで途中文を更新し、VADが発話終了を検出した時点で確定文を生成する。認識器へ渡す各波形の先頭には500msの無音を付加し、発話が入力境界に近い場合の冒頭欠落を抑制する。音声データは外部の音声認識サービスへ送信しない。

初回セットアップでは、公式GitHubリポジトリをプロジェクト直下の `sherpa-onnx/` へクローンし、
Silero VADと日本語ZipformerをGitHub Releasesから取得して、公式スクリプトでWebAssemblyをビルドする。
`sherpa-onnx/` と生成物はGitの管理対象外になる。

ビルドには `git`、`curl`、`tar`、`cmake`、`make` とEmscriptenが必要になる。
sherpa-onnxが推奨するEmscripten 4.0.23は、次のように準備できる。

```bash
git clone https://github.com/emscripten-core/emsdk.git ../emsdk
cd ../emsdk
./emsdk install 4.0.23
./emsdk activate 4.0.23
source ./emsdk_env.sh
cd -
```

準備後、プロジェクトルートでセットアップスクリプトを実行する。

```bash
./scripts/fetch-sherpa-onnx-wasm.sh
python3 -m http.server 8000
```

その後、次のURLを開く。

```text
http://localhost:8000/sherpa-onnx.html
```

スクリプトはクローン、モデル取得、ビルドを再利用するため、途中でEmscripten不足になった場合も準備後に再実行できる。
初回は大容量モデルの取得・ビルドと、ブラウザでの`.data`読み込みに時間がかかる。ブラウザキャッシュ後は短縮される。`file://`で直接開かず、必ずHTTPサーバー経由で使用する。

この版ではWeb Speech APIの`phrases`/`boost`の代わりに、JSON内の有効な用語の`aliases`と`contextBiasTerms`を重複除去してsherpa-onnxのhotwordsへ登録する。hotwords使用時は`modified_beam_search`と既定のscore 1.5を使い、JSONの読み込み・切り替え時にも登録内容を更新する。疑似ストリーミングの途中文は認識デバッグ欄の`INTERIM`として更新し、ポップアップはVADが発話を確定した後の`FINAL`と用語集の`aliases`との文字列照合によってのみ発火する。

## OBS表示

通常画面の「OBS URLをコピー」または、URL末尾に `?overlay=1` を付けたページをOBS Browser Sourceへ登録する。

```text
http://localhost:8000/index.html?overlay=1
```

このモードでは設定画面を表示せず、背景透過でポップアップだけを右下に配置する。通常画面での手動表示・音声認識結果・デザイン変更は `BroadcastChannel` を使ってOBS表示へ同期する。

ローカルファイルとして直接開くと、初期JSONの取得や別タブとの同期がブラウザに拒否される場合がある。その場合も内蔵サンプルと画面からのJSONアップロードは利用できるが、OBS利用時はHTTPサーバー経由で開くことを推奨する。

例:

```bash
python3 -m http.server 8000
```
