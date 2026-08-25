# sherpa-onnx WebAssembly assets

このディレクトリには、ローカルでビルドしたsherpa-onnxの日本語VAD + ASR WebAssembly成果物を配置します。
モデルを含む大容量の生成物は、このリポジトリには含めません。

セットアップには `git`、`curl`、`tar`、`cmake`、`make` とEmscripten 4.0.23が必要です。
プロジェクトルートで次を実行すると、公式リポジトリを `./sherpa-onnx` へクローンし、
モデルをGitHub Releasesから取得して、公式スクリプトでビルドします。

```bash
./scripts/fetch-sherpa-onnx-wasm.sh
```

Emscriptenが未導入の場合、初回実行はリポジトリをクローンした後に導入手順を表示して終了します。
Emscriptenを有効化して同じコマンドを再実行してください。クローンと既存のビルド結果は再利用されます。

生成元リビジョンを変更する場合は、環境変数を指定できます。

```bash
SHERPA_ONNX_REVISION=<commit-sha> ./scripts/fetch-sherpa-onnx-wasm.sh
```

配置されるファイルは次の5点です。

- `sherpa-onnx-asr.js`
- `sherpa-onnx-vad.js`
- `sherpa-onnx-wasm-main-vad-asr.js`
- `sherpa-onnx-wasm-main-vad-asr.wasm`
- `sherpa-onnx-wasm-main-vad-asr.data`

ソースとモデルの配布元はk2-fsaの
[`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx)です。
モデルはReazonSpeechで学習された日本語Zipformer、発話区間検出はSilero VADです。
