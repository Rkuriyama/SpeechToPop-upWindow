#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"
source_dir="${project_dir}/sherpa-onnx"
output_dir="${project_dir}/sherpa-wasm"
build_output_dir="${source_dir}/build-wasm-simd-vad-asr/install/bin/wasm/vad-asr"
repository_url="https://github.com/k2-fsa/sherpa-onnx.git"
revision="${SHERPA_ONNX_REVISION:-34eba5a27220026b5981b633981c53205515067d}"
model_name="sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"
release_base_url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
temp_dir="$(mktemp -d)"

runtime_files=(
    sherpa-onnx-asr.js
    sherpa-onnx-vad.js
    sherpa-onnx-wasm-main-vad-asr.js
    sherpa-onnx-wasm-main-vad-asr.wasm
    sherpa-onnx-wasm-main-vad-asr.data
)

cleanup() {
    rm -rf "${temp_dir}"
}
trap cleanup EXIT

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Required command not found: $1" >&2
        exit 1
    fi
}

download() {
    local url="$1"
    local destination="$2"
    rm -f "${destination}"
    if ! curl --fail --location --retry 3 --output "${destination}" "${url}"; then
        rm -f "${destination}"
        echo "Download failed: ${url}" >&2
        exit 1
    fi
}

runtime_is_complete() {
    local directory="$1"
    local file_name
    for file_name in "${runtime_files[@]}"; do
        if [[ ! -s "${directory}/${file_name}" ]]; then
            return 1
        fi
    done
}

install_runtime() {
    local file_name
    mkdir -p "${output_dir}"
    for file_name in "${runtime_files[@]}"; do
        install -m 0644 "${build_output_dir}/${file_name}" "${output_dir}/${file_name}"
    done
}

require_command git
require_command curl
require_command tar

if [[ ! -d "${source_dir}/.git" ]]; then
    if [[ -e "${source_dir}" ]]; then
        echo "${source_dir} exists but is not a Git repository." >&2
        exit 1
    fi
    echo "Cloning sherpa-onnx from GitHub"
    git clone --depth 1 "${repository_url}" "${source_dir}"
fi

actual_origin="$(git -C "${source_dir}" remote get-url origin)"
if [[ "${actual_origin}" != "${repository_url}" ]]; then
    echo "Unexpected sherpa-onnx origin: ${actual_origin}" >&2
    echo "Expected: ${repository_url}" >&2
    exit 1
fi

current_revision="$(git -C "${source_dir}" rev-parse HEAD)"
if [[ "${current_revision}" != "${revision}" ]]; then
    if ! git -C "${source_dir}" diff --quiet || ! git -C "${source_dir}" diff --cached --quiet; then
        echo "The cloned sherpa-onnx repository has local tracked changes." >&2
        echo "Commit or restore them before switching revisions." >&2
        exit 1
    fi
    echo "Checking out sherpa-onnx revision ${revision}"
    git -C "${source_dir}" fetch --depth 1 origin "${revision}"
    git -C "${source_dir}" checkout --detach FETCH_HEAD
fi

if runtime_is_complete "${build_output_dir}"; then
    install_runtime
    echo "Installed existing sherpa-onnx WebAssembly build in ${output_dir}"
    exit 0
fi

if ! command -v emcc >/dev/null 2>&1; then
    if [[ -n "${EMSDK:-}" && -f "${EMSDK}/emsdk_env.sh" ]]; then
        # shellcheck disable=SC1091
        source "${EMSDK}/emsdk_env.sh"
    fi
fi

if ! command -v emcc >/dev/null 2>&1; then
    cat >&2 <<'MESSAGE'
Emscripten (emcc) is required to build sherpa-onnx WebAssembly.

Install the version recommended by sherpa-onnx, then run this script again:

  git clone https://github.com/emscripten-core/emsdk.git ../emsdk
  cd ../emsdk
  ./emsdk install 4.0.23
  ./emsdk activate 4.0.23
  source ./emsdk_env.sh

The sherpa-onnx repository has already been cloned, so it will be reused.
MESSAGE
    exit 1
fi

require_command cmake
require_command make

assets_dir="${source_dir}/wasm/vad-asr/assets"
mkdir -p "${assets_dir}"

if [[ ! -s "${assets_dir}/silero_vad.onnx" ]]; then
    echo "Downloading Silero VAD from GitHub Releases"
    download \
        "${release_base_url}/silero_vad.onnx" \
        "${assets_dir}/silero_vad.onnx"
fi

model_assets=(
    transducer-encoder.onnx
    transducer-decoder.onnx
    transducer-joiner.onnx
    tokens.txt
)
model_complete=true
for file_name in "${model_assets[@]}"; do
    if [[ ! -s "${assets_dir}/${file_name}" ]]; then
        model_complete=false
        break
    fi
done

if [[ "${model_complete}" != true ]]; then
    model_archive="${temp_dir}/${model_name}.tar.bz2"
    echo "Downloading Japanese Zipformer model from GitHub Releases"
    download "${release_base_url}/${model_name}.tar.bz2" "${model_archive}"
    tar -xjf "${model_archive}" -C "${temp_dir}"
    model_dir="${temp_dir}/${model_name}"

    install -m 0644 \
        "${model_dir}/encoder-epoch-99-avg-1.int8.onnx" \
        "${assets_dir}/transducer-encoder.onnx"
    install -m 0644 \
        "${model_dir}/decoder-epoch-99-avg-1.onnx" \
        "${assets_dir}/transducer-decoder.onnx"
    install -m 0644 \
        "${model_dir}/joiner-epoch-99-avg-1.int8.onnx" \
        "${assets_dir}/transducer-joiner.onnx"
    install -m 0644 "${model_dir}/tokens.txt" "${assets_dir}/tokens.txt"
fi

echo "Building sherpa-onnx WebAssembly"
(
    cd "${source_dir}"
    ./build-wasm-simd-vad-asr.sh
)

if ! runtime_is_complete "${build_output_dir}"; then
    echo "The sherpa-onnx build completed without all required runtime files." >&2
    exit 1
fi

install_runtime

echo
echo "Installed sherpa-onnx Japanese WebAssembly assets in ${output_dir}"
echo "Start an HTTP server and open sherpa-onnx.html."
