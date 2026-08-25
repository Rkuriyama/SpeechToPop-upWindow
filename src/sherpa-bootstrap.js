/*
 * sherpa-onnx WebAssembly bridge for Speech Popup Studio.
 *
 * The bridge exposes a small Web Speech API-compatible facade so the popup,
 * glossary, queue, and OBS synchronization code can stay shared with the
 * original version. Audio and recognition remain inside the browser.
 */

var Module = window.Module || {};
window.Module = Module;

(function() {
    'use strict';

    const ENGINE_QUERY_VALUE = 'sherpa';
    const ENGINE_NAME = 'sherpa-onnx';
    const SAMPLE_RATE = 16000;
    const BUFFER_SECONDS = 30;
    const HOTWORDS_FILE_NAME = 'speech-popup-hotwords.txt';
    const HOTWORDS_FILE_PATH = '/' + HOTWORDS_FILE_NAME;
    const HOTWORDS_SCORE = 1.5;
    const RECOGNITION_LEADING_SILENCE_MS = 500;
    const RECOGNITION_LEADING_SILENCE_SAMPLES = Math.round(
        SAMPLE_RATE * RECOGNITION_LEADING_SILENCE_MS / 1000
    );
    const INTERIM_DECODE_INTERVAL_MS = 800;
    const INTERIM_MIN_SAMPLES = Math.round(SAMPLE_RATE * 0.5);
    const INTERIM_PREROLL_WINDOWS = 10;
    const WASM_DIRECTORY = './sherpa-wasm/';
    const REQUIRED_ASSETS = [
        'sherpa-onnx-asr.js',
        'sherpa-onnx-vad.js',
        'sherpa-onnx-wasm-main-vad-asr.js',
        'sherpa-onnx-wasm-main-vad-asr.wasm',
        'sherpa-onnx-wasm-main-vad-asr.data'
    ];

    const query = new URLSearchParams(window.location.search);
    const enabled = query.get('engine') === ENGINE_QUERY_VALUE;
    window.SPEECH_POPUP_RECOGNITION_ENGINE = enabled ? ENGINE_NAME : 'web-speech';

    if (!enabled) return;

    function createStatus(phase, message, options) {
        return Object.assign({
            engine: ENGINE_NAME,
            phase: phase,
            message: message,
            progress: null,
            ready: false,
            local: true
        }, options || {});
    }

    function createDomException(message, name) {
        if (typeof DOMException === 'function') return new DOMException(message, name);
        const error = new Error(message);
        error.name = name;
        return error;
    }

    function loadScript(source) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = source;
            script.async = false;
            script.onload = resolve;
            script.onerror = () => reject(new Error(source + ' を読み込めませんでした。'));
            document.head.appendChild(script);
        });
    }

    function downsampleBuffer(samples, sourceSampleRate, targetSampleRate) {
        if (sourceSampleRate === targetSampleRate) return new Float32Array(samples);
        if (targetSampleRate > sourceSampleRate) {
            throw new Error('入力サンプルレートより高いレートへ変換できません。');
        }

        const ratio = sourceSampleRate / targetSampleRate;
        const outputLength = Math.round(samples.length / ratio);
        const output = new Float32Array(outputLength);
        let inputOffset = 0;

        for (let outputOffset = 0; outputOffset < outputLength; outputOffset++) {
            const nextInputOffset = Math.round((outputOffset + 1) * ratio);
            let total = 0;
            let count = 0;
            for (
                let index = inputOffset;
                index < nextInputOffset && index < samples.length;
                index++
            ) {
                total += samples[index];
                count++;
            }
            output[outputOffset] = count > 0 ? total / count : 0;
            inputOffset = nextInputOffset;
        }

        return output;
    }

    function joinSampleChunks(chunks, totalLength) {
        const samples = new Float32Array(totalLength);
        let offset = 0;
        chunks.forEach(chunk => {
            samples.set(chunk, offset);
            offset += chunk.length;
        });
        return samples;
    }

    const runtime = {
        status: createStatus('checking', 'sherpa-onnx のファイルを確認しています。'),
        module: null,
        vad: null,
        circularBuffer: null,
        recognizer: null,
        owner: null,
        audioContext: null,
        mediaStream: null,
        mediaSource: null,
        processor: null,
        silentGain: null,
        recordSampleRate: SAMPLE_RATE,
        recording: false,
        speechDetected: false,
        hotwords: [],
        hotwordsScore: HOTWORDS_SCORE,
        hotwordsPending: false,
        startSequence: 0,
        bootPromise: null,
        preSpeechChunks: [],
        preSpeechSampleCount: 0,
        utteranceChunks: [],
        utteranceSampleCount: 0,
        utteranceSequence: 0,
        interimDecodeTimer: null,
        interimDecodeRunning: false,
        interimLastDecodeAt: 0,
        interimLastDecodedSampleCount: 0,
        lastInterimText: '',
        interimResultEmitted: false,

        setStatus: function(phase, message, options) {
            this.status = createStatus(phase, message, Object.assign({
                hotwordsCount: this.hotwords.length,
                hotwordsScore: this.hotwordsScore,
                hotwordsPending: this.hotwordsPending
            }, options || {}));
            window.dispatchEvent(new CustomEvent('speech-popup-engine-status', {
                detail: Object.assign({}, this.status)
            }));
        },

        readyMessage: function() {
            if (this.hotwords.length === 0) {
                return '日本語モデルの準備ができました。音声は端末内で処理されます。';
            }
            return '日本語モデルの準備ができました。用語ヒント' +
                this.hotwords.length + '語を登録しています。';
        },

        cancelInterimDecode: function() {
            if (this.interimDecodeTimer !== null) {
                clearTimeout(this.interimDecodeTimer);
                this.interimDecodeTimer = null;
            }
        },

        resetUtteranceState: function() {
            this.cancelInterimDecode();
            this.preSpeechChunks = [];
            this.preSpeechSampleCount = 0;
            this.utteranceChunks = [];
            this.utteranceSampleCount = 0;
            this.utteranceSequence += 1;
            this.interimDecodeRunning = false;
            this.interimLastDecodeAt = 0;
            this.interimLastDecodedSampleCount = 0;
            this.lastInterimText = '';
            this.interimResultEmitted = false;
        },

        rememberPreSpeech: function(samples) {
            this.preSpeechChunks.push(samples);
            this.preSpeechSampleCount += samples.length;
            while (this.preSpeechChunks.length > INTERIM_PREROLL_WINDOWS) {
                this.preSpeechSampleCount -= this.preSpeechChunks.shift().length;
            }
        },

        beginUtterance: function() {
            this.cancelInterimDecode();
            this.utteranceSequence += 1;
            this.utteranceChunks = this.preSpeechChunks.slice();
            this.utteranceSampleCount = this.preSpeechSampleCount;
            this.preSpeechChunks = [];
            this.preSpeechSampleCount = 0;
            this.interimLastDecodeAt = Date.now();
            this.interimLastDecodedSampleCount = 0;
            this.lastInterimText = '';
            this.interimResultEmitted = false;
            this.scheduleInterimDecode();
        },

        appendUtteranceSamples: function(samples) {
            this.utteranceChunks.push(samples);
            this.utteranceSampleCount += samples.length;
        },

        scheduleInterimDecode: function() {
            if (
                !this.recording ||
                !this.speechDetected ||
                this.interimDecodeTimer !== null ||
                this.interimDecodeRunning ||
                this.utteranceSampleCount < INTERIM_MIN_SAMPLES ||
                this.utteranceSampleCount === this.interimLastDecodedSampleCount
            ) {
                return;
            }

            const elapsed = Date.now() - this.interimLastDecodeAt;
            const delay = Math.max(0, INTERIM_DECODE_INTERVAL_MS - elapsed);
            const sequence = this.utteranceSequence;
            this.interimDecodeTimer = setTimeout(() => {
                this.interimDecodeTimer = null;
                if (sequence !== this.utteranceSequence) return;
                this.decodeInterim();
            }, delay);
        },

        recognizeSamples: function(samples) {
            const stream = this.recognizer.createStream();
            try {
                // This offline Japanese model can discard initial tokens when
                // speech starts too close to the recognizer input boundary.
                const recognitionSamples = new Float32Array(
                    RECOGNITION_LEADING_SILENCE_SAMPLES + samples.length
                );
                recognitionSamples.set(samples, RECOGNITION_LEADING_SILENCE_SAMPLES);
                stream.acceptWaveform(SAMPLE_RATE, recognitionSamples);
                this.recognizer.decode(stream);
                const result = this.recognizer.getResult(stream);
                return result && typeof result.text === 'string' ? result.text.trim() : '';
            } finally {
                stream.free();
            }
        },

        decodeInterim: function() {
            if (
                !this.recording ||
                !this.speechDetected ||
                this.interimDecodeRunning ||
                this.utteranceSampleCount < INTERIM_MIN_SAMPLES ||
                this.utteranceSampleCount === this.interimLastDecodedSampleCount
            ) {
                return;
            }

            const sequence = this.utteranceSequence;
            const sampleCount = this.utteranceSampleCount;
            const samples = joinSampleChunks(this.utteranceChunks, sampleCount);
            let failed = false;

            this.interimDecodeRunning = true;
            this.interimLastDecodedSampleCount = sampleCount;
            this.setStatus('decoding-interim', '発話中の途中結果を更新しています。', { ready: true });

            try {
                const text = this.recognizeSamples(samples);
                if (
                    sequence === this.utteranceSequence &&
                    this.recording &&
                    this.speechDetected &&
                    text !== this.lastInterimText
                ) {
                    this.lastInterimText = text;
                    if (this.owner) {
                        this.interimResultEmitted = true;
                        this.owner.handleResult(text, false);
                    }
                }
            } catch (error) {
                failed = true;
                this.fail(error);
            } finally {
                this.interimDecodeRunning = false;
                this.interimLastDecodeAt = Date.now();
                if (!failed && this.recording) {
                    this.setStatus('recording', 'マイク音声を端末内で認識しています。', { ready: true });
                }
            }

            if (!failed && sequence === this.utteranceSequence) {
                this.scheduleInterimDecode();
            }
        },

        discardUtterance: function() {
            const hadInterim = this.interimResultEmitted;
            const owner = this.owner;
            this.resetUtteranceState();
            if (hadInterim && owner) owner.handleResult('', true);
        },

        normalizeHotwords: function(aliases) {
            const seen = new Set();
            const hotwords = [];
            (Array.isArray(aliases) ? aliases : []).forEach(alias => {
                const value = String(alias)
                    .normalize('NFKC')
                    .replace(/[\r\n]+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                const key = value.toLocaleLowerCase('ja-JP').replace(/\s+/g, '');
                if (!value || value.startsWith(':') || seen.has(key)) return;
                seen.add(key);
                hotwords.push(value);
            });
            return hotwords;
        },

        writeHotwordsFile: function() {
            try {
                this.module.FS_unlink(HOTWORDS_FILE_PATH);
            } catch (error) {
                // The first registration has no previous hotwords file.
            }

            if (this.hotwords.length === 0) return '';

            const contents = new TextEncoder().encode(this.hotwords.join('\n') + '\n');
            this.module.FS_createDataFile(
                '/',
                HOTWORDS_FILE_NAME,
                contents,
                true,
                false,
                true
            );
            return HOTWORDS_FILE_PATH;
        },

        createRecognizerConfig: function(hotwordsFile) {
            return {
                featConfig: {
                    sampleRate: SAMPLE_RATE,
                    featureDim: 80
                },
                modelConfig: {
                    transducer: {
                        encoder: './transducer-encoder.onnx',
                        decoder: './transducer-decoder.onnx',
                        joiner: './transducer-joiner.onnx'
                    },
                    tokens: './tokens.txt',
                    numThreads: 1,
                    provider: 'cpu',
                    debug: 0,
                    modelType: 'transducer',
                    modelingUnit: 'cjkchar',
                    bpeVocab: ''
                },
                decodingMethod: hotwordsFile ? 'modified_beam_search' : 'greedy_search',
                maxActivePaths: 4,
                hotwordsFile: hotwordsFile,
                hotwordsScore: this.hotwordsScore
            };
        },

        rebuildRecognizer: function() {
            if (!this.module || this.recording) {
                this.hotwordsPending = true;
                return {
                    supported: true,
                    applied: false,
                    pending: true,
                    count: this.hotwords.length,
                    score: this.hotwordsScore
                };
            }

            const hotwordsFile = this.writeHotwordsFile();
            if (this.recognizer) {
                this.recognizer.free();
                this.recognizer = null;
            }
            this.recognizer = new OfflineRecognizer(
                this.createRecognizerConfig(hotwordsFile),
                this.module
            );
            this.hotwordsPending = false;
            return {
                supported: true,
                applied: true,
                pending: false,
                count: this.hotwords.length,
                score: this.hotwordsScore
            };
        },

        setHotwords: function(aliases) {
            this.hotwords = this.normalizeHotwords(aliases);
            try {
                const result = this.rebuildRecognizer();
                if (result.applied) {
                    this.setStatus('ready', this.readyMessage(), {
                        ready: true,
                        progress: 100
                    });
                } else {
                    this.setStatus(this.status.phase, this.status.message, {
                        ready: this.status.ready,
                        progress: this.status.progress
                    });
                }
                return result;
            } catch (error) {
                this.hotwordsPending = false;
                this.setStatus('error', '用語ヒントの登録に失敗しました: ' + error.message);
                return {
                    supported: false,
                    applied: false,
                    pending: false,
                    count: 0,
                    score: this.hotwordsScore,
                    error: error && error.message ? error.message : String(error)
                };
            }
        },

        fileExists: function(fileName) {
            const nameLength = this.module.lengthBytesUTF8(fileName) + 1;
            const pointer = this.module._malloc(nameLength);
            this.module.stringToUTF8(fileName, pointer, nameLength);
            const exists = this.module._SherpaOnnxFileExists(pointer) === 1;
            this.module._free(pointer);
            return exists;
        },

        initialize: function(moduleObject) {
            try {
                this.module = moduleObject;
                this.vad = createVad(moduleObject, {
                    sileroVad: {
                        model: './silero_vad.onnx',
                        threshold: 0.5,
                        minSilenceDuration: 0.2,
                        minSpeechDuration: 0.25,
                        maxSpeechDuration: 5,
                        windowSize: 512
                    },
                    tenVad: {
                        model: '',
                        threshold: 0.5,
                        minSilenceDuration: 0.2,
                        minSpeechDuration: 0.25,
                        maxSpeechDuration: 5,
                        windowSize: 256
                    },
                    sampleRate: SAMPLE_RATE,
                    numThreads: 1,
                    provider: 'cpu',
                    debug: 0,
                    bufferSizeInSeconds: BUFFER_SECONDS
                });
                this.circularBuffer = new CircularBuffer(BUFFER_SECONDS * SAMPLE_RATE, moduleObject);

                if (!this.fileExists('transducer-encoder.onnx')) {
                    throw new Error('日本語 Zipformer モデルがデータファイル内に見つかりません。');
                }

                this.rebuildRecognizer();

                this.setStatus(
                    'ready',
                    this.readyMessage(),
                    { ready: true, progress: 100 }
                );
            } catch (error) {
                this.setStatus('error', '認識モデルの初期化に失敗しました: ' + error.message);
            }
        },

        start: async function(owner) {
            if (!this.recognizer || !this.vad || !this.circularBuffer) {
                throw createDomException(
                    this.status.message || '認識モデルはまだ準備できていません。',
                    'InvalidStateError'
                );
            }
            if (this.recording) {
                throw createDomException('音声認識はすでに実行中です。', 'InvalidStateError');
            }
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw createDomException('このブラウザはマイク入力に対応していません。', 'NotSupportedError');
            }

            this.owner = owner;
            const sequence = ++this.startSequence;
            this.setStatus('starting', 'マイクの使用許可を待っています。', { ready: true });

            try {
                const mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    }
                });
                if (sequence !== this.startSequence || this.owner !== owner) {
                    mediaStream.getTracks().forEach(track => track.stop());
                    return;
                }
                this.mediaStream = mediaStream;

                const AudioContextApi = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextApi) {
                    throw createDomException('Web Audio API を利用できません。', 'NotSupportedError');
                }

                this.audioContext = new AudioContextApi({ sampleRate: SAMPLE_RATE });
                await this.audioContext.resume();
                this.recordSampleRate = this.audioContext.sampleRate;
                this.mediaSource = this.audioContext.createMediaStreamSource(this.mediaStream);
                this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
                this.silentGain = this.audioContext.createGain();
                this.silentGain.gain.value = 0;
                this.processor.onaudioprocess = event => this.processAudio(event);
                this.mediaSource.connect(this.processor);
                this.processor.connect(this.silentGain);
                this.silentGain.connect(this.audioContext.destination);

                this.recording = true;
                this.speechDetected = false;
                this.circularBuffer.reset();
                this.vad.reset();
                this.resetUtteranceState();
                this.setStatus('recording', 'マイク音声を端末内で認識しています。', { ready: true });
                owner.handleStart();
            } catch (error) {
                await this.releaseAudio();
                this.owner = null;
                this.setStatus('ready', this.readyMessage(), { ready: true });
                throw error;
            }
        },

        processAudio: function(event) {
            if (!this.recording) return;

            try {
                const input = event.inputBuffer.getChannelData(0);
                const samples = downsampleBuffer(input, this.recordSampleRate, SAMPLE_RATE);
                this.circularBuffer.push(samples);
                this.processBufferedAudio();
            } catch (error) {
                this.fail(error);
            }
        },

        processBufferedAudio: function() {
            const windowSize = this.vad.config.sileroVad.windowSize;
            while (this.circularBuffer.size() >= windowSize) {
                const samples = this.circularBuffer.get(this.circularBuffer.head(), windowSize);
                this.circularBuffer.pop(windowSize);
                const wasDetected = this.speechDetected;

                if (wasDetected) {
                    this.appendUtteranceSamples(samples);
                } else {
                    this.rememberPreSpeech(samples);
                }

                this.vad.acceptWaveform(samples);

                const detected = this.vad.isDetected();
                if (detected !== wasDetected) {
                    this.speechDetected = detected;
                    if (detected) {
                        this.beginUtterance();
                    } else {
                        this.cancelInterimDecode();
                    }
                    if (this.owner) this.owner.handleSpeechState(detected);
                }

                if (detected) this.scheduleInterimDecode();
                const decodedSegments = this.drainSegments();
                if (wasDetected && !detected && decodedSegments === 0) {
                    this.discardUtterance();
                }
            }
        },

        drainSegments: function() {
            let count = 0;
            while (!this.vad.isEmpty()) {
                const segment = this.vad.front();
                this.vad.pop();
                this.decodeSegment(segment.samples);
                count += 1;
            }
            return count;
        },

        decodeSegment: function(samples) {
            if (!samples || samples.length === 0) return;

            this.cancelInterimDecode();
            const hadInterim = this.interimResultEmitted;
            this.setStatus('decoding', '発話を認識しています。', { ready: true });
            try {
                const text = this.recognizeSamples(samples);
                if ((text || hadInterim) && this.owner) this.owner.handleResult(text, true);
            } finally {
                this.resetUtteranceState();
                if (this.recording) {
                    this.setStatus('recording', 'マイク音声を端末内で認識しています。', { ready: true });
                }
            }
        },

        stop: async function(owner) {
            if (owner && this.owner && owner !== this.owner) return;
            const activeOwner = this.owner || owner;
            this.startSequence += 1;
            this.recording = false;
            this.cancelInterimDecode();

            try {
                if (this.vad) {
                    this.processBufferedAudio();
                    this.vad.flush();
                    this.drainSegments();
                    this.vad.reset();
                }
                if (this.circularBuffer) this.circularBuffer.reset();
                this.resetUtteranceState();
            } catch (error) {
                if (activeOwner) activeOwner.handleError(error);
            }

            await this.releaseAudio();
            this.speechDetected = false;
            this.owner = null;
            if (this.hotwordsPending) {
                try {
                    this.rebuildRecognizer();
                } catch (error) {
                    this.setStatus('error', '用語ヒントの登録に失敗しました: ' + error.message);
                    if (activeOwner) activeOwner.handleEnd();
                    return;
                }
            }
            this.setStatus('ready', this.readyMessage(), { ready: true, progress: 100 });
            if (activeOwner) activeOwner.handleEnd();
        },

        releaseAudio: async function() {
            this.cancelInterimDecode();
            if (this.processor) {
                this.processor.onaudioprocess = null;
                try { this.processor.disconnect(); } catch (error) { /* already disconnected */ }
            }
            if (this.mediaSource) {
                try { this.mediaSource.disconnect(); } catch (error) { /* already disconnected */ }
            }
            if (this.silentGain) {
                try { this.silentGain.disconnect(); } catch (error) { /* already disconnected */ }
            }
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(track => track.stop());
            }
            if (this.audioContext && this.audioContext.state !== 'closed') {
                try { await this.audioContext.close(); } catch (error) { /* cleanup only */ }
            }

            this.processor = null;
            this.mediaSource = null;
            this.silentGain = null;
            this.mediaStream = null;
            this.audioContext = null;
        },

        fail: function(error) {
            const owner = this.owner;
            this.recording = false;
            this.setStatus('error', '音声認識でエラーが発生しました: ' + error.message, {
                ready: Boolean(this.recognizer)
            });
            if (owner) owner.handleError(error);
            this.releaseAudio().finally(() => {
                this.owner = null;
                if (owner) owner.handleEnd();
            });
        },

        boot: async function() {
            if (this.bootPromise) return this.bootPromise;
            this.bootPromise = (async () => {
                if (query.get('overlay') === '1') {
                    this.setStatus('overlay', 'OBS表示では認識モデルを読み込みません。');
                    return;
                }

                try {
                    const checks = await Promise.all(REQUIRED_ASSETS.map(async fileName => {
                        const response = await fetch(WASM_DIRECTORY + fileName, {
                            method: 'HEAD',
                            cache: 'no-store'
                        });
                        return { fileName: fileName, available: response.ok };
                    }));
                    const missing = checks.filter(item => !item.available).map(item => item.fileName);
                    if (missing.length > 0) {
                        this.setStatus(
                            'missing',
                            'WASMモデルが未配置です。scripts/fetch-sherpa-onnx-wasm.sh を実行してください。'
                        );
                        return;
                    }

                    this.setStatus('loading', 'sherpa-onnx と日本語モデルを読み込んでいます。');
                    await loadScript(WASM_DIRECTORY + 'sherpa-onnx-asr.js');
                    await loadScript(WASM_DIRECTORY + 'sherpa-onnx-vad.js');
                    configureModule(this);
                    await loadScript(WASM_DIRECTORY + 'sherpa-onnx-wasm-main-vad-asr.js');
                } catch (error) {
                    this.setStatus('error', 'sherpa-onnx の読み込みに失敗しました: ' + error.message);
                }
            })();
            return this.bootPromise;
        }
    };

    function configureModule(engineRuntime) {
        Module.locateFile = function(path) {
            return new URL(WASM_DIRECTORY + path.split('/').pop(), document.baseURI).href;
        };
        Module.setStatus = function(statusText) {
            if (!statusText) return;
            const match = statusText.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
            if (!match) {
                engineRuntime.setStatus('loading', statusText);
                return;
            }

            const downloaded = Number(match[1]);
            const total = Number(match[2]);
            const progress = total > 0 ? Math.min(100, downloaded / total * 100) : 0;
            engineRuntime.setStatus(
                'loading',
                '日本語モデルを読み込んでいます（' + progress.toFixed(1) + '%）。',
                { progress: progress }
            );
        };
        Module.onRuntimeInitialized = function() {
            engineRuntime.initialize(Module);
        };
        Module.onAbort = function(reason) {
            engineRuntime.setStatus('error', 'WebAssembly が停止しました: ' + String(reason));
        };
    }

    class SherpaSpeechRecognition {
        constructor() {
            this.lang = 'ja-JP';
            this.continuous = true;
            this.interimResults = true;
            this.maxAlternatives = 1;
            this.onstart = null;
            this.onend = null;
            this.onerror = null;
            this.onresult = null;
            this.onspeechstart = null;
            this.onspeechend = null;
            this._starting = false;
            this._active = false;
            this._results = [];
            this._interimResultIndex = null;
        }

        start() {
            if (this._starting || this._active) {
                throw createDomException('音声認識はすでに開始されています。', 'InvalidStateError');
            }
            this._starting = true;
            this._results = [];
            this._interimResultIndex = null;
            runtime.start(this).catch(error => {
                this._starting = false;
                this.handleError(error);
                this.handleEnd();
            });
        }

        stop() {
            if (!this._starting && !this._active) return;
            runtime.stop(this);
        }

        abort() {
            this.stop();
        }

        handleStart() {
            this._starting = false;
            this._active = true;
            if (typeof this.onstart === 'function') this.onstart({ type: 'start' });
        }

        handleEnd() {
            const wasActive = this._starting || this._active;
            this._starting = false;
            this._active = false;
            if (wasActive && typeof this.onend === 'function') this.onend({ type: 'end' });
        }

        handleSpeechState(detected) {
            const callback = detected ? this.onspeechstart : this.onspeechend;
            if (typeof callback === 'function') {
                callback.call(this, { type: detected ? 'speechstart' : 'speechend' });
            }
        }

        handleResult(transcript, isFinal) {
            const finalResult = isFinal !== false;
            const alternative = { transcript: transcript, confidence: 1 };
            const result = [alternative];
            result.isFinal = finalResult;
            result.length = 1;
            let resultIndex = this._interimResultIndex;

            if (resultIndex === null) {
                resultIndex = this._results.length;
            }
            this._results[resultIndex] = result;
            this._interimResultIndex = finalResult ? null : resultIndex;

            if (typeof this.onresult === 'function') {
                this.onresult({
                    type: 'result',
                    resultIndex: resultIndex,
                    results: this._results
                });
            }
        }

        handleError(error) {
            if (typeof this.onerror !== 'function') return;
            const name = error && error.name ? error.name : 'Error';
            const errorCodes = {
                NotAllowedError: 'not-allowed',
                NotFoundError: 'audio-capture',
                NotReadableError: 'audio-capture',
                NotSupportedError: 'service-not-allowed',
                InvalidStateError: 'engine-unavailable'
            };
            this.onerror({
                type: 'error',
                error: errorCodes[name] || 'engine-error',
                message: error && error.message ? error.message : String(error)
            });
        }
    }

    window.SpeechPopupRecognitionRuntime = runtime;
    window.SpeechRecognition = SherpaSpeechRecognition;
    window.webkitSpeechRecognition = SherpaSpeechRecognition;

    runtime.boot();
})();
