const DEFAULT_APPEARANCE = {
    width: 560,
    height: 190,
    titleFontSize: 34,
    descriptionFontSize: 20,
    borderRadius: 20,
    fontFamily: 'sans',
    textAlign: 'left',
    accentColor: '#59d8ff',
    backgroundColor: '#101827',
    textColor: '#f5f8fc'
};

const DEFAULT_GLOSSARY = {
    schemaVersion: 3,
    title: '用語集フォーマット例',
    contextBiasTerms: [
        'サモナーズリフト',
        'アーリ',
        'ヤスオ',
        'ジンクス',
        'ラックス',
        'リーシン',
        'ルル',
        'ティーモ',
        'バロンナッシャー',
        'ブルーセンチネル'
    ],
    settings: {
        displaySeconds: 5,
        enterSeconds: 0.5,
        exitSeconds: 0.5,
        queueIntervalSeconds: 0,
        queueMaxItems: 3,
        maxMatchesPerTranscript: 3,
        cooldownSeconds: 60,
        appearance: DEFAULT_APPEARANCE
    },
    terms: [
        {
            id: 'cs',
            title: 'CS (クリープスコア)',
            aliases: ['CS', 'シーエス', 'クリープスコア'],
            description: 'ミニオンや中立モンスターへのラストヒット数を示す指標。獲得ゴールド量の目安になる。',
            enabled: true
        },
        {
            id: 'vision',
            title: '視界/ビジョン',
            aliases: ['視界', 'ビジョン'],
            description: '敵の位置やマップ上の安全を把握できる情報。ワードの設置と破壊が視界管理の中心になる。',
            enabled: true
        }
    ]
};

const STORAGE_KEY = 'speech-popup-glossary-v1';
const CHANNEL_NAME = 'speech-popup-events-v1';
const CURRENT_SCHEMA_VERSION = 3;
const FONT_STACKS = {
    sans: 'Inter, "Noto Sans JP", "Yu Gothic UI", "Hiragino Kaku Gothic ProN", sans-serif',
    rounded: '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Yu Gothic UI", sans-serif',
    serif: '"Noto Serif JP", "Yu Mincho", "Hiragino Mincho ProN", serif',
    yugothic: '"Yu Gothic", "Yu Gothic UI", "Hiragino Kaku Gothic ProN", sans-serif',
    meiryo: 'Meiryo, "Yu Gothic UI", sans-serif',
    bizud: '"BIZ UDPGothic", "BIZ UDGothic", Meiryo, sans-serif',
    monospace: '"BIZ UDGothic", "MS Gothic", "Noto Sans Mono CJK JP", monospace'
};

const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
const SpeechRecognitionPhraseApi = window.SpeechRecognitionPhrase || window.webkitSpeechRecognitionPhrase;
const RECOGNITION_ENGINE = window.SPEECH_POPUP_RECOGNITION_ENGINE || 'web-speech';
const sherpaRecognitionRuntime = window.SpeechPopupRecognitionRuntime || null;
const SPEECH_PHRASE_BOOST = 5;
const JAPANESE_WORD_SEGMENTER = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('ja', { granularity: 'word' })
    : null;
const overlayMode = new URLSearchParams(window.location.search).get('overlay') === '1';
const popupChannel = typeof window.BroadcastChannel === 'function'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

if (overlayMode) document.documentElement.classList.add('overlay-mode');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createGlossaryError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details || {});
    return error;
}

function buildLegacyConversionPrompt(fileName, sourceText, schemaVersion) {
    return `次の用語集JSONを schemaVersion ${CURRENT_SCHEMA_VERSION} 形式へ変換してください。
対象ファイル: ${fileName}
現在の schemaVersion: ${schemaVersion}

必須要件:
1. schemaVersion を ${CURRENT_SCHEMA_VERSION} にする。settings.queueMaxItems と settings.maxMatchesPerTranscript がなければ3を追加する。
2. title はポップアップに表示する名称専用とし、ポップアップ検知に使う語句はすべて aliases に入れる。
3. キャラクター名など認識精度向上だけに使い、ポップアップを表示しないゲーム内用語はルート直下の contextBiasTerms 配列に入れる。該当語がなければ空配列にする。
4. 旧 title の呼称を aliases に追加する。aliases 内の重複は削除する。
5. 完全な略語が一般的な場合、title は「CS (クリープスコア)」のように「略語 (展開形)」とする。
6. 同一対象を指す同格の呼称は「視界/ビジョン」のようにスラッシュで併記し、各呼称を aliases に個別登録する。
7. 一般語、登録済みの alias をそのまま含むだけの派生表現、関連はあるが別対象を指す語は aliases から除外する。例えば「視界」があれば「視界管理」は追加しない。ただし「カイト」と「カイティング」のように文字列が異なる活用語は残す。
8. id、description、enabled、settings の意味と値は保つ。
9. 説明文やMarkdownコードフェンスを付けず、変換後の有効なJSONのみを出力する。

変換対象JSON:
${sourceText}`;
}

function copyTextToClipboard(value) {
    const fallbackCopy = () => {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.className = 'clipboard-helper';
        textarea.setAttribute('readonly', '');
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('copy command failed');
    };

    return navigator.clipboard && window.isSecureContext
        ? navigator.clipboard.writeText(value).catch(fallbackCopy)
        : Promise.resolve().then(fallbackCopy);
}

function assertNonEmptyString(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(path + ' は空でない文字列にしてください。');
    }
    return value.trim();
}

function assertNumberInRange(value, path, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(path + ' は ' + min + '〜' + max + ' の数値にしてください。');
    }
    return value;
}

function assertIntegerInRange(value, path, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(path + ' は ' + min + '〜' + max + ' の整数にしてください。');
    }
    return value;
}

function assertEnum(value, path, choices) {
    if (!choices.includes(value)) {
        throw new Error(path + ' は ' + choices.join(' / ') + ' のいずれかにしてください。');
    }
    return value;
}

function assertColor(value, path) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
        throw new Error(path + ' は #RRGGBB 形式にしてください。');
    }
    return value.toLowerCase();
}

function normalizeAppearance(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const fallback = DEFAULT_APPEARANCE;
    return {
        width: assertNumberInRange(source.width ?? fallback.width, 'settings.appearance.width', 320, 960),
        height: assertNumberInRange(source.height ?? fallback.height, 'settings.appearance.height', 120, 540),
        titleFontSize: assertNumberInRange(
            source.titleFontSize ?? fallback.titleFontSize,
            'settings.appearance.titleFontSize',
            16,
            72
        ),
        descriptionFontSize: assertNumberInRange(
            source.descriptionFontSize ?? fallback.descriptionFontSize,
            'settings.appearance.descriptionFontSize',
            12,
            48
        ),
        borderRadius: assertNumberInRange(
            source.borderRadius ?? fallback.borderRadius,
            'settings.appearance.borderRadius',
            0,
            48
        ),
        fontFamily: assertEnum(
            source.fontFamily ?? fallback.fontFamily,
            'settings.appearance.fontFamily',
            ['sans', 'rounded', 'serif', 'yugothic', 'meiryo', 'bizud', 'monospace']
        ),
        textAlign: assertEnum(
            source.textAlign ?? fallback.textAlign,
            'settings.appearance.textAlign',
            ['left', 'center']
        ),
        accentColor: assertColor(
            source.accentColor ?? fallback.accentColor,
            'settings.appearance.accentColor'
        ),
        backgroundColor: assertColor(
            source.backgroundColor ?? fallback.backgroundColor,
            'settings.appearance.backgroundColor'
        ),
        textColor: assertColor(
            source.textColor ?? fallback.textColor,
            'settings.appearance.textColor'
        )
    };
}

function normalizeGlossary(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('用語集のルートはオブジェクトにしてください。');
    }
    if (Number.isInteger(input.schemaVersion) && input.schemaVersion < CURRENT_SCHEMA_VERSION) {
        throw createGlossaryError(
            'LEGACY_SCHEMA_VERSION',
            '旧 schemaVersion ' + input.schemaVersion + ' の用語集は読み込めません。',
            { schemaVersion: input.schemaVersion }
        );
    }
    if (input.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        throw new Error('schemaVersion は ' + CURRENT_SCHEMA_VERSION + ' にしてください。');
    }
    if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
        throw new Error('settings が必要です。');
    }
    if (!Array.isArray(input.terms)) {
        throw new Error('terms は配列にしてください。');
    }
    if (!Array.isArray(input.contextBiasTerms)) {
        throw new Error('contextBiasTerms は配列として指定してください。');
    }

    const seenContextBiasTerms = new Set();
    const contextBiasTerms = input.contextBiasTerms
        .map((term, index) =>
            assertNonEmptyString(term, 'contextBiasTerms[' + index + ']')
        )
        .filter(term => {
            const key = normalizeMatchText(term);
            if (seenContextBiasTerms.has(key)) return false;
            seenContextBiasTerms.add(key);
            return true;
        });

    const ids = new Set();
    const terms = input.terms.map((term, index) => {
        const path = 'terms[' + index + ']';
        if (!term || typeof term !== 'object' || Array.isArray(term)) {
            throw new Error(path + ' はオブジェクトにしてください。');
        }

        const id = assertNonEmptyString(term.id, path + '.id');
        if (!/^[a-z0-9-]+$/.test(id)) {
            throw new Error(path + '.id は英小文字・数字・ハイフンのみ使用できます。');
        }
        if (ids.has(id)) {
            throw new Error('id "' + id + '" が重複しています。');
        }
        ids.add(id);

        if (term.aliases !== undefined && !Array.isArray(term.aliases)) {
            throw new Error(path + '.aliases は配列にしてください。');
        }
        if (term.enabled !== undefined && typeof term.enabled !== 'boolean') {
            throw new Error(path + '.enabled は真偽値にしてください。');
        }

        const title = assertNonEmptyString(term.title, path + '.title');
        const aliases = (term.aliases || []).map((alias, aliasIndex) =>
            assertNonEmptyString(alias, path + '.aliases[' + aliasIndex + ']')
        );

        const seenAliases = new Set();
        const uniqueAliases = aliases.filter(alias => {
            const key = normalizeMatchText(alias);
            if (seenAliases.has(key)) return false;
            seenAliases.add(key);
            return true;
        });

        return {
            id: id,
            title: title,
            aliases: uniqueAliases,
            description: assertNonEmptyString(term.description, path + '.description'),
            enabled: term.enabled !== false
        };
    });

    return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        title: assertNonEmptyString(input.title, 'title'),
        contextBiasTerms: contextBiasTerms,
        settings: {
            displaySeconds: assertNumberInRange(
                input.settings.displaySeconds,
                'settings.displaySeconds',
                1,
                10
            ),
            enterSeconds: assertNumberInRange(
                input.settings.enterSeconds ?? 0.5,
                'settings.enterSeconds',
                0.1,
                2
            ),
            exitSeconds: assertNumberInRange(
                input.settings.exitSeconds ?? 0.5,
                'settings.exitSeconds',
                0.1,
                2
            ),
            queueIntervalSeconds: assertNumberInRange(
                input.settings.queueIntervalSeconds ?? 0,
                'settings.queueIntervalSeconds',
                0,
                5
            ),
            queueMaxItems: assertIntegerInRange(
                input.settings.queueMaxItems ?? 3,
                'settings.queueMaxItems',
                1,
                5
            ),
            maxMatchesPerTranscript: assertIntegerInRange(
                input.settings.maxMatchesPerTranscript ?? 3,
                'settings.maxMatchesPerTranscript',
                1,
                5
            ),
            cooldownSeconds: assertNumberInRange(
                input.settings.cooldownSeconds,
                'settings.cooldownSeconds',
                0,
                3600
            ),
            appearance: normalizeAppearance(input.settings.appearance)
        },
        terms: terms
    };
}

function normalizeMatchText(value) {
    return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, '');
}

function collectEnabledAliases(terms) {
    const seen = new Set();
    const aliases = [];
    terms
        .filter(term => term.enabled)
        .forEach(term => {
            term.aliases.forEach(alias => {
                const normalizedAlias = normalizeMatchText(alias);
                if (!normalizedAlias || seen.has(normalizedAlias)) return;
                seen.add(normalizedAlias);
                aliases.push(alias);
            });
        });
    return aliases;
}

function collectRecognitionHints(terms, contextBiasTerms) {
    const hints = collectEnabledAliases(terms);
    const seen = new Set(hints.map(normalizeMatchText));

    contextBiasTerms.forEach(term => {
        const normalizedTerm = normalizeMatchText(term);
        if (!normalizedTerm || seen.has(normalizedTerm)) return;
        seen.add(normalizedTerm);
        hints.push(term);
    });

    return hints;
}

function createSearchText(value) {
    if (!JAPANESE_WORD_SEGMENTER) {
        throw new Error('このブラウザは Intl.Segmenter に対応していません。');
    }

    const normalized = value.normalize('NFKC').toLocaleLowerCase('ja-JP');
    let compact = '';
    const compactPositions = [];
    const normalizedToCompactBoundary = new Array(normalized.length + 1);
    normalizedToCompactBoundary[0] = 0;

    for (let index = 0; index < normalized.length; index++) {
        if (!/\s/.test(normalized[index])) {
            compact += normalized[index];
            compactPositions.push(index);
        }
        normalizedToCompactBoundary[index + 1] = compact.length;
    }

    const wordBoundaries = new Set([0, compact.length]);
    for (const segment of JAPANESE_WORD_SEGMENTER.segment(normalized)) {
        const segmentEnd = segment.index + segment.segment.length;
        wordBoundaries.add(normalizedToCompactBoundary[segment.index]);
        wordBoundaries.add(normalizedToCompactBoundary[segmentEnd]);
    }

    return {
        normalized: normalized,
        compact: compact,
        compactPositions: compactPositions,
        wordBoundaries: wordBoundaries
    };
}

function findAliasMatch(searchText, alias) {
    const normalizedAlias = normalizeMatchText(alias);
    let compactIndex = searchText.compact.indexOf(normalizedAlias);

    while (compactIndex >= 0) {
        const compactEnd = compactIndex + normalizedAlias.length;
        if (
            searchText.wordBoundaries.has(compactIndex) &&
            searchText.wordBoundaries.has(compactEnd)
        ) {
            return {
                index: searchText.compactPositions[compactIndex],
                length: normalizedAlias.length
            };
        }
        compactIndex = searchText.compact.indexOf(normalizedAlias, compactIndex + 1);
    }

    return { index: -1, length: normalizedAlias.length };
}

function searchWordDetails(script, wordList) {
    const searchText = createSearchText(script);
    return wordList
        .filter(term => term.enabled)
        .map(term => {
            const candidates = term.aliases
                .map(alias => Object.assign({ alias: alias }, findAliasMatch(searchText, alias)))
                .filter(candidate => candidate.index >= 0)
                .sort((a, b) => a.index - b.index || b.length - a.length);
            const bestMatch = candidates[0];
            return {
                term: term,
                index: bestMatch ? bestMatch.index : -1,
                matchLength: bestMatch ? bestMatch.length : 0,
                alias: bestMatch ? bestMatch.alias : null
            };
        })
        .filter(match => match.index >= 0)
        .sort((a, b) => a.index - b.index || b.matchLength - a.matchLength);
}

function selectDistinctMatches(matches) {
    const selected = [];
    matches.forEach(match => {
        const matchEnd = match.index + match.matchLength;
        const overlapsSelected = selected.some(selectedMatch => {
            const selectedEnd = selectedMatch.index + selectedMatch.matchLength;
            return match.index < selectedEnd && selectedMatch.index < matchEnd;
        });
        if (!overlapsSelected) selected.push(match);
    });
    return selected;
}

function searchWord(script, wordList) {
    return searchWordDetails(script, wordList).map(match => match.term);
}

function applyCssSettings(settings) {
    const appearance = settings.appearance;
    const style = document.documentElement.style;
    style.setProperty('--active-time', settings.displaySeconds + 's');
    style.setProperty('--popup-enter-time', settings.enterSeconds + 's');
    style.setProperty('--popup-exit-time', settings.exitSeconds + 's');
    style.setProperty('--popup-width', appearance.width + 'px');
    style.setProperty('--popup-height', appearance.height + 'px');
    style.setProperty('--popup-title-size', appearance.titleFontSize + 'px');
    style.setProperty('--popup-body-size', appearance.descriptionFontSize + 'px');
    style.setProperty('--popup-radius', appearance.borderRadius + 'px');
    style.setProperty('--popup-font', FONT_STACKS[appearance.fontFamily]);
    style.setProperty('--popup-align', appearance.textAlign);
    style.setProperty('--popup-justify', appearance.textAlign === 'center' ? 'center' : 'flex-start');
    style.setProperty('--popup-accent', appearance.accentColor);
    style.setProperty('--popup-bg', appearance.backgroundColor);
    style.setProperty('--popup-text', appearance.textColor);
}

function readStoredGlossary() {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : null;
    } catch (error) {
        return null;
    }
}

function writeStoredGlossary(value) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        return true;
    } catch (error) {
        return false;
    }
}

let glossary = normalizeGlossary(clone(DEFAULT_GLOSSARY));
applyCssSettings(glossary.settings);

const recogObj = {
    debug: false,
    state: {
        finalTranscript: '',
        interimTranscript: '',
        currentTerm: null,
        currentQueueId: null,
        queue: [],
        active: false,
        activationId: 0,
        done: -1,
        recording: false,
        debugEntries: []
    },
    control: SpeechRecognitionApi ? new SpeechRecognitionApi() : null,
    phraseBias: {
        supported: false,
        count: 0,
        boost: SPEECH_PHRASE_BOOST,
        error: null,
        disabledForSession: false,
        pending: false
    },
    recognitionStartPending: false,
    phraseFallbackPending: false,
    phraseRetryTimer: null,
    lastShownAt: new Map(),
    hideTimer: null,
    exitTimer: null,
    queueTimer: null,
    nextQueueId: 0,
    nextDebugEntryId: 0,
    lastActivationStatus: 'idle',
    onActivate: null,
    clearPhrases: function() {
        const phrases = this.control && this.control.phrases;
        if (!phrases || typeof phrases.splice !== 'function') return;
        try {
            phrases.splice(0, phrases.length);
        } catch (error) {
            // Contextual biasing is optional; recognition can continue without phrases.
        }
    },
    updatePhrases: function() {
        const recognitionHints = collectRecognitionHints(
            glossary.terms,
            glossary.contextBiasTerms
        );

        if (RECOGNITION_ENGINE === 'sherpa-onnx') {
            const registration = sherpaRecognitionRuntime &&
                typeof sherpaRecognitionRuntime.setHotwords === 'function'
                ? sherpaRecognitionRuntime.setHotwords(recognitionHints)
                : null;
            this.phraseBias = {
                supported: Boolean(registration && registration.supported),
                count: registration ? registration.count : 0,
                boost: registration ? registration.score : 0,
                error: registration && registration.error ? registration.error : null,
                disabledForSession: false,
                pending: Boolean(registration && registration.pending)
            };
            return this.phraseBias.supported;
        }

        if (this.phraseBias.disabledForSession) {
            this.clearPhrases();
            return false;
        }

        const control = this.control;
        const phrases = control && control.phrases;
        const canUpdatePhrases = Boolean(
            control &&
            SpeechRecognitionPhraseApi &&
            'phrases' in control &&
            phrases &&
            typeof phrases.splice === 'function' &&
            typeof phrases.push === 'function'
        );

        if (!canUpdatePhrases) {
            this.phraseBias = {
                supported: false,
                count: 0,
                boost: SPEECH_PHRASE_BOOST,
                error: 'unsupported',
                disabledForSession: false
            };
            return false;
        }

        try {
            phrases.splice(0, phrases.length);
            recognitionHints.forEach(hint => {
                phrases.push(new SpeechRecognitionPhraseApi(hint, SPEECH_PHRASE_BOOST));
            });
            this.phraseBias = {
                supported: true,
                count: recognitionHints.length,
                boost: SPEECH_PHRASE_BOOST,
                error: null,
                disabledForSession: false
            };
            return true;
        } catch (error) {
            try {
                phrases.splice(0, phrases.length);
            } catch (clearError) {
                // Contextual biasing is optional; recognition can continue without phrases.
            }
            this.phraseBias = {
                supported: false,
                count: 0,
                boost: SPEECH_PHRASE_BOOST,
                error: error && error.message ? error.message : 'registration failed',
                disabledForSession: false
            };
            return false;
        }
    },
    activate: function(idx, term, options) {
        const opts = options || {};
        if (!term) {
            this.lastActivationStatus = 'no-term';
            return false;
        }

        const cooldownMs = glossary.settings.cooldownSeconds * 1000;
        const lastShownAt = this.lastShownAt.get(term.id) || 0;
        if (!opts.ignoreCooldown && Date.now() - lastShownAt < cooldownMs) {
            if (idx >= 0) this.state.done = Math.max(this.state.done, idx);
            this.lastActivationStatus = 'cooldown';
            return false;
        }

        const busy = this.state.active || this.exitTimer !== null || this.queueTimer !== null;
        const occupiedItems = this.state.queue.length + (this.state.active ? 1 : 0);
        if (busy && occupiedItems >= glossary.settings.queueMaxItems) {
            if (idx >= 0) this.state.done = Math.max(this.state.done, idx);
            this.lastActivationStatus = 'queue-full';
            return false;
        }

        const entry = {
            queueId: ++this.nextQueueId,
            resultIndex: idx,
            term: term,
            silent: Boolean(opts.silent)
        };
        if (idx >= 0) this.state.done = idx;

        if (busy) {
            this.state.queue.push(entry);
            this.lastActivationStatus = 'queued';
            return true;
        }

        this.showEntry(entry);
        this.lastActivationStatus = 'shown';
        return true;
    },
    showEntry: function(entry) {
        if (!entry || !entry.term) return false;

        if (this.hideTimer !== null) clearTimeout(this.hideTimer);
        this.state.currentTerm = entry.term;
        this.state.currentQueueId = entry.queueId;
        this.state.activationId += 1;
        this.state.active = true;
        this.lastShownAt.set(entry.term.id, Date.now());
        this.hideTimer = setTimeout(() => {
            this.state.active = false;
            this.hideTimer = null;
            this.exitTimer = setTimeout(() => {
                this.exitTimer = null;
                this.state.currentTerm = null;
                this.state.currentQueueId = null;
                if (this.state.queue.length === 0) return;

                const intervalMs = glossary.settings.queueIntervalSeconds * 1000;
                if (intervalMs === 0) {
                    this.showNext();
                    return;
                }
                this.queueTimer = setTimeout(() => {
                    this.queueTimer = null;
                    this.showNext();
                }, intervalMs);
            }, glossary.settings.exitSeconds * 1000);
        }, glossary.settings.displaySeconds * 1000);

        if (!entry.silent && typeof this.onActivate === 'function') this.onActivate(entry.term);
        return true;
    },
    showNext: function() {
        const nextEntry = this.state.queue.shift();
        if (nextEntry) this.showEntry(nextEntry);
    },
    appendDebugEntry: function(entry) {
        const entries = this.state.debugEntries;
        const nextEntry = Object.assign({
            id: ++this.nextDebugEntryId,
            resultIndex: -1,
            phase: 'SYSTEM'
        }, entry);
        const previous = entries[entries.length - 1];

        if (
            nextEntry.phase === 'INTERIM' &&
            previous &&
            previous.phase === 'INTERIM' &&
            previous.resultIndex === nextEntry.resultIndex
        ) {
            entries.splice(entries.length - 1, 1, nextEntry);
        } else {
            entries.push(nextEntry);
        }

        if (entries.length > 100) entries.splice(0, entries.length - 100);
    },
    appendSystemDebug: function(message) {
        this.appendDebugEntry({
            phase: 'SYSTEM',
            text: '[SYSTEM] ' + message
        });
    },
    clearDebug: function() {
        this.state.debugEntries.splice(0);
        this.nextDebugEntryId = 0;
    },
    handleResult: function(event) {
        for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index];
            const transcript = result[0] && result[0].transcript
                ? result[0].transcript
                : '';

            if (result.isFinal) {
                if (transcript) {
                    const separator = this.state.finalTranscript ? ' ' : '';
                    this.state.finalTranscript += separator + transcript;
                }
                this.state.interimTranscript = '';
            } else {
                this.state.interimTranscript = transcript;
            }

            const allMatches = selectDistinctMatches(
                searchWordDetails(transcript, glossary.terms)
            );
            const matches = allMatches.slice(0, glossary.settings.maxMatchesPerTranscript);
            const omittedMatchCount = allMatches.length - matches.length;
            const waitsForFinal = RECOGNITION_ENGINE === 'sherpa-onnx' && !result.isFinal;
            let resultStatuses = [];

            if (matches.length > 0 && waitsForFinal) {
                resultStatuses = matches.map(() => 'pending-final');
            } else if (matches.length > 0 && this.state.done < index) {
                resultStatuses = matches.map(match => {
                    this.activate(index, match.term);
                    return this.lastActivationStatus;
                });
            } else if (matches.length > 0) {
                resultStatuses = matches.map(() => 'processed');
            }

            const statusLabels = {
                shown: '表示開始',
                queued: 'キュー追加',
                cooldown: '未追加：クールダウン中',
                'queue-full': '未追加：キュー上限',
                'pending-final': '候補：FINAL待ち',
                processed: '処理済み',
                'no-match': '一致なし'
            };
            const phase = result.isFinal ? 'FINAL' : 'INTERIM';
            const transcriptLabel = transcript || '（空の認識結果）';
            const matchLabels = matches.map((match, matchIndex) =>
                match.term.title + ' / alias: ' + match.alias +
                ' [' + statusLabels[resultStatuses[matchIndex]] + ']'
            );
            if (omittedMatchCount > 0) {
                matchLabels.push(
                    'ほか' + omittedMatchCount + '件 [未追加：1文当たりの検知上限]'
                );
            }
            const matchLabel = matchLabels.length > 0 ? matchLabels.join(' / ') : '— [一致なし]';

            this.appendDebugEntry({
                resultIndex: index,
                phase: phase,
                text: '[' + phase + '] ' + transcriptLabel + ' → ' + matchLabel
            });
        }
    },
    reset: function() {
        if (this.hideTimer !== null) clearTimeout(this.hideTimer);
        if (this.exitTimer !== null) clearTimeout(this.exitTimer);
        if (this.queueTimer !== null) clearTimeout(this.queueTimer);
        this.hideTimer = null;
        this.exitTimer = null;
        this.queueTimer = null;
        this.lastShownAt.clear();
        this.state.currentTerm = null;
        this.state.currentQueueId = null;
        this.state.queue.splice(0);
        this.state.active = false;
        this.state.finalTranscript = '';
        this.state.interimTranscript = '';
        this.state.done = -1;
        this.clearDebug();
    }
};

if (recogObj.control) {
    recogObj.control.lang = 'ja-JP';
    recogObj.control.interimResults = true;
    recogObj.control.continuous = true;
    recogObj.control.onstart = () => {
        recogObj.recognitionStartPending = false;
        recogObj.state.recording = true;
        recogObj.state.done = -1;
        recogObj.state.finalTranscript = '';
        recogObj.state.interimTranscript = '';
        recogObj.clearDebug();
        if (RECOGNITION_ENGINE === 'sherpa-onnx') {
            recogObj.appendSystemDebug(
                'sherpa-onnx WebAssemblyによる端末内音声認識を開始しました。'
            );
            recogObj.appendSystemDebug(
                '発話中はOffline疑似ストリーミングでINTERIMを更新し、FINALでポップアップを確定します。'
            );
            if (recogObj.phraseBias.supported && recogObj.phraseBias.count > 0) {
                recogObj.appendSystemDebug(
                    '用語ヒント ' + recogObj.phraseBias.count +
                    '語を hotwords score ' + recogObj.phraseBias.boost + ' で登録しています。'
                );
            }
        } else if (recogObj.phraseBias.supported) {
            recogObj.appendSystemDebug('音声認識を開始しました。');
            recogObj.appendSystemDebug(
                '用語ヒント ' + recogObj.phraseBias.count +
                '語を boost ' + recogObj.phraseBias.boost + ' で登録しています。'
            );
        } else if (recogObj.phraseBias.error === 'phrases-not-supported') {
            recogObj.appendSystemDebug('音声認識を開始しました。');
            recogObj.appendSystemDebug(
                '認識モデルが用語ヒントに非対応のため、boostなしで認識しています。'
            );
        } else {
            recogObj.appendSystemDebug('音声認識を開始しました。');
            recogObj.appendSystemDebug('用語ヒントはこのブラウザでは利用できません。');
        }
    };
    recogObj.control.onend = () => {
        recogObj.recognitionStartPending = false;
        recogObj.state.recording = false;
        if (recogObj.phraseFallbackPending) {
            recogObj.phraseFallbackPending = false;
            if (recogObj.phraseRetryTimer !== null) clearTimeout(recogObj.phraseRetryTimer);
            recogObj.phraseRetryTimer = setTimeout(() => {
                recogObj.phraseRetryTimer = null;
                try {
                    recogObj.recognitionStartPending = true;
                    recogObj.control.start();
                } catch (error) {
                    recogObj.recognitionStartPending = false;
                    recogObj.appendSystemDebug(
                        '用語ヒントなしで音声認識を再開できませんでした。'
                    );
                }
            }, 100);
            return;
        }
        recogObj.appendSystemDebug(
            RECOGNITION_ENGINE === 'sherpa-onnx'
                ? 'sherpa-onnx 音声認識を停止しました。'
                : '音声認識を停止しました。'
        );
    };
    recogObj.control.onerror = event => {
        recogObj.state.recording = false;
        if (event && event.error === 'phrases-not-supported') {
            if (recogObj.phraseFallbackPending) return;

            const alreadyDisabled = recogObj.phraseBias.disabledForSession;
            const shouldRestart = recogObj.recognitionStartPending || recogObj.state.recording;
            recogObj.recognitionStartPending = false;
            recogObj.clearPhrases();
            recogObj.phraseBias = {
                supported: false,
                count: 0,
                boost: SPEECH_PHRASE_BOOST,
                error: 'phrases-not-supported',
                disabledForSession: true
            };

            if (!alreadyDisabled && shouldRestart) {
                recogObj.phraseFallbackPending = true;
                recogObj.appendSystemDebug(
                    '認識モデルが用語ヒントに非対応のため、boostなしで自動再開します。'
                );
            } else if (!alreadyDisabled) {
                recogObj.appendSystemDebug(
                    '認識モデルが用語ヒントに非対応のため、boostを無効化しました。'
                );
            } else if (shouldRestart) {
                recogObj.appendSystemDebug(
                    '用語ヒントを外しても音声認識を開始できませんでした。'
                );
            }
            return;
        }
        recogObj.recognitionStartPending = false;
        const detail = event && event.error ? ' (' + event.error + ')' : '';
        recogObj.appendSystemDebug('音声認識エラー' + detail);
    };
    recogObj.control.onresult = event => recogObj.handleResult(event);
}

recogObj.updatePhrases();

Vue.component('pop-up', {
    props: ['title', 'description', 'show', 'active', 'activationKey'],
    template: `
        <div class="popup-host">
            <transition name="popup-slide" mode="out-in">
                <article v-if="show" v-bind:key="activationKey" class="popup-card">
                    <div class="popup-accent-line" aria-hidden="true"></div>
                    <div class="popup-content">
                        <h2 class="popup-title">{{ title }}</h2>
                        <p class="popup-description">{{ description }}</p>
                    </div>
                    <div v-if="active" class="popup-progress" aria-hidden="true">
                        <span></span>
                    </div>
                </article>
            </transition>
        </div>
    `
});

Vue.component('wordlist', {
    props: ['term'],
    template: `<button type="button" v-on:click="$emit('select', term)">{{ term.title }}</button>`
});

const app = new Vue({
    el: '#app',
    data: {
        sharedObj: recogObj,
        state: recogObj.state,
        overlayMode: overlayMode,
        glossaryTitle: glossary.title,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
        settings: glossary.settings,
        terms: glossary.terms.filter(term => term.enabled),
        recognitionEngine: RECOGNITION_ENGINE,
        recognitionEngineStatus: sherpaRecognitionRuntime
            ? clone(sherpaRecognitionRuntime.status)
            : {
                engine: 'web-speech',
                phase: SpeechRecognitionApi ? 'ready' : 'unsupported',
                message: SpeechRecognitionApi
                    ? 'ブラウザの音声認識を利用できます。'
                    : 'このブラウザは音声認識に対応していません。',
                progress: null,
                ready: Boolean(SpeechRecognitionApi)
            },
        speechRecognitionAvailable: Boolean(SpeechRecognitionApi) && (
            RECOGNITION_ENGINE !== 'sherpa-onnx' ||
            Boolean(sherpaRecognitionRuntime && sherpaRecognitionRuntime.status.ready)
        ),
        overlayCopyStatus: 'idle',
        recognitionDebugOpen: true,
        importDialog: {
            visible: false,
            fileName: '',
            schemaVersion: null,
            prompt: ''
        },
        importPromptCopyStatus: 'idle',
        loadStatus: {
            type: 'info',
            message: '用語集を準備しています。'
        }
    },
    computed: {
        previewTerm: function() {
            return this.state.currentTerm || this.terms[0] || {
                title: '専門用語',
                description: 'ここに初心者向けの短い解説が表示されます。'
            };
        },
        popupTitle: function() {
            return this.previewTerm.title;
        },
        popupDescription: function() {
            return this.previewTerm.description;
        },
        popupKey: function() {
            return this.state.activationId;
        },
        queueItems: function() {
            const items = this.state.queue.map(entry => ({
                queueId: entry.queueId,
                title: entry.term.title,
                current: false
            }));
            if (this.state.active && this.state.currentTerm) {
                items.unshift({
                    queueId: this.state.currentQueueId,
                    title: this.state.currentTerm.title,
                    current: true
                });
            }
            return items;
        },
        recognitionDebugText: function() {
            return this.state.debugEntries.map(entry => entry.text).join('\n');
        },
        recognitionStatusLabel: function() {
            if (this.recognitionEngine !== 'sherpa-onnx') {
                return this.speechRecognitionAvailable ? '音声認識 Ready' : '音声認識 非対応';
            }

            const labels = {
                checking: 'WASM 確認中',
                loading: 'WASM 読込中',
                starting: 'マイク 許可待ち',
                recording: 'ローカル認識中',
                'decoding-interim': '途中結果を解析中',
                decoding: '発話を解析中',
                ready: 'ローカル認識 Ready',
                missing: 'WASM 未配置',
                error: 'WASM エラー',
                overlay: 'OBS表示'
            };
            return labels[this.recognitionEngineStatus.phase] || 'sherpa-onnx';
        },
        recognitionEngineSwitchLabel: function() {
            return this.recognitionEngine === 'sherpa-onnx'
                ? 'Google Web Speech API版へ'
                : 'sherpa-onnx版へ';
        },
        recognitionEngineSwitchUrl: function() {
            const targetUrl = new URL(window.location.href);
            if (this.recognitionEngine === 'sherpa-onnx') {
                targetUrl.searchParams.delete('engine');
            } else {
                targetUrl.searchParams.set('engine', 'sherpa');
            }
            return targetUrl.href;
        },
        show: function() {
            return this.state.active;
        }
    },
    watch: {
        recognitionDebugText: function() {
            this.scrollRecognitionDebugToEnd();
        },
        recognitionDebugOpen: function(open) {
            if (open) this.scrollRecognitionDebugToEnd();
        }
    },
    methods: {
        toggleRecognitionDebug: function() {
            this.recognitionDebugOpen = !this.recognitionDebugOpen;
        },
        scrollRecognitionDebugToEnd: function() {
            if (!this.recognitionDebugOpen) return;
            this.$nextTick(() => {
                const textarea = this.$refs.recognitionDebugText;
                if (textarea) textarea.scrollTop = textarea.scrollHeight;
            });
        },
        updateRecognitionEngineStatus: function(event) {
            if (this.recognitionEngine !== 'sherpa-onnx') return;
            const status = event && event.detail
                ? event.detail
                : (sherpaRecognitionRuntime && sherpaRecognitionRuntime.status);
            if (!status) return;
            this.recognitionEngineStatus = Object.assign({}, status);
            this.speechRecognitionAvailable = Boolean(SpeechRecognitionApi) && Boolean(status.ready);
        },
        currentConfig: function() {
            return {
                schemaVersion: CURRENT_SCHEMA_VERSION,
                title: this.glossaryTitle,
                contextBiasTerms: clone(glossary.contextBiasTerms),
                settings: clone(this.settings),
                terms: clone(glossary.terms)
            };
        },
        applyGlossary: function(nextGlossary, sourceLabel, persist, broadcast, resetState) {
            glossary = normalizeGlossary(nextGlossary);
            if (resetState !== false) this.sharedObj.reset();
            this.glossaryTitle = glossary.title;
            this.settings = glossary.settings;
            this.terms = glossary.terms.filter(term => term.enabled);
            this.sharedObj.updatePhrases();
            applyCssSettings(this.settings);

            if (persist) writeStoredGlossary(this.currentConfig());
            if (broadcast && popupChannel) {
                popupChannel.postMessage({ type: 'config', config: this.currentConfig() });
            }

            let hintStatus = '';
            if (this.recognitionEngine === 'sherpa-onnx') {
                if (this.sharedObj.phraseBias.supported) {
                    hintStatus = this.sharedObj.phraseBias.pending
                        ? ' 認識ヒント' + this.sharedObj.phraseBias.count + '語をモデル初期化時に登録します。'
                        : ' 認識ヒント' + this.sharedObj.phraseBias.count + '語をsherpa-onnxへ登録しました。';
                } else {
                    hintStatus = ' 認識ヒントのsherpa-onnx登録に失敗しました。';
                }
            }

            this.loadStatus = {
                type: 'success',
                message: sourceLabel + 'を読み込みました（' + this.terms.length + '語）。' + hintStatus
            };
        },
        openLegacyImportDialog: function(error, fileName, sourceText) {
            if (!error || error.code !== 'LEGACY_SCHEMA_VERSION') return false;

            this.importDialog = {
                visible: true,
                fileName: fileName,
                schemaVersion: error.schemaVersion,
                prompt: buildLegacyConversionPrompt(fileName, sourceText, error.schemaVersion)
            };
            this.importPromptCopyStatus = 'idle';
            this.$nextTick(() => {
                if (this.$refs.importDialogClose) this.$refs.importDialogClose.focus();
            });
            return true;
        },
        closeImportDialog: function() {
            this.importDialog.visible = false;
            this.importPromptCopyStatus = 'idle';
        },
        copyImportPrompt: function() {
            copyTextToClipboard(this.importDialog.prompt)
                .then(() => {
                    this.importPromptCopyStatus = 'copied';
                    if (this._importCopyTimer) clearTimeout(this._importCopyTimer);
                    this._importCopyTimer = setTimeout(() => {
                        this.importPromptCopyStatus = 'idle';
                        this._importCopyTimer = null;
                    }, 1800);
                })
                .catch(() => {
                    this.importPromptCopyStatus = 'error';
                });
        },
        loadInitialGlossary: function() {
            const stored = readStoredGlossary();
            if (stored) {
                try {
                    this.applyGlossary(stored, '保存済み設定', false, false);
                    return;
                } catch (error) {
                    this.openLegacyImportDialog(
                        error,
                        '保存済み設定',
                        JSON.stringify(stored, null, 2)
                    );
                    this.loadStatus = {
                        type: 'error',
                        message: error.code === 'LEGACY_SCHEMA_VERSION'
                            ? '保存済み設定は旧バージョンのため読み込めませんでした。'
                            : '保存済み設定を読み込めませんでした。'
                    };
                }
            }

            fetch('./data/glossary.json', { cache: 'no-store' })
                .then(response => {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                })
                .then(data => this.applyGlossary(data, '初期用語集', false, false))
                .catch(error => {
                    this.applyGlossary(clone(DEFAULT_GLOSSARY), '内蔵サンプル', false, false);
                    if (this.sharedObj.debug) console.error(error);
                });
        },
        uploadGlossary: function(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            let sourceText = '';

            file.text()
                .then(text => {
                    sourceText = text;
                    return JSON.parse(text);
                })
                .then(data => {
                    this.closeImportDialog();
                    this.applyGlossary(data, file.name, true, true);
                })
                .catch(error => {
                    this.openLegacyImportDialog(error, file.name, sourceText);
                    this.loadStatus = {
                        type: 'error',
                        message: '読み込みに失敗しました: ' + error.message
                    };
                })
                .finally(() => {
                    event.target.value = '';
                });
        },
        copyOverlayUrl: function() {
            const overlayUrl = new URL(window.location.href);
            overlayUrl.search = '';
            overlayUrl.hash = '';
            overlayUrl.searchParams.set('overlay', '1');

            copyTextToClipboard(overlayUrl.href)
                .then(() => {
                    this.overlayCopyStatus = 'copied';
                    if (this._overlayCopyTimer) clearTimeout(this._overlayCopyTimer);
                    this._overlayCopyTimer = setTimeout(() => {
                        this.overlayCopyStatus = 'idle';
                        this._overlayCopyTimer = null;
                    }, 1800);
                })
                .catch(() => {
                    this.overlayCopyStatus = 'error';
                    this.loadStatus = {
                        type: 'error',
                        message: 'OBS表示URLをコピーできませんでした。'
                    };
                });
        },
        updateSettings: function() {
            glossary.settings = this.settings;
            const activeItems = this.state.active ? 1 : 0;
            const waitingLimit = Math.max(0, this.settings.queueMaxItems - activeItems);
            if (this.state.queue.length > waitingLimit) {
                this.state.queue.splice(waitingLimit);
            }
            applyCssSettings(this.settings);
            writeStoredGlossary(this.currentConfig());
            if (popupChannel) {
                popupChannel.postMessage({ type: 'config', config: this.currentConfig() });
            }
        },
        resetAppearance: function() {
            this.$set(this.settings, 'appearance', clone(DEFAULT_APPEARANCE));
            this.updateSettings();
        },
        showTerm: function(term) {
            this.sharedObj.activate(-1, term, {
                ignoreCooldown: true
            });
        },
        start: function() {
            if (!this.sharedObj.control) return;
            try {
                this.sharedObj.recognitionStartPending = true;
                this.sharedObj.updatePhrases();
                this.sharedObj.control.start();
            } catch (error) {
                this.sharedObj.recognitionStartPending = false;
                this.loadStatus = { type: 'error', message: '音声認識を開始できませんでした。' };
            }
        },
        stop: function() {
            this.sharedObj.recognitionStartPending = false;
            this.sharedObj.phraseFallbackPending = false;
            if (this.sharedObj.phraseRetryTimer !== null) {
                clearTimeout(this.sharedObj.phraseRetryTimer);
                this.sharedObj.phraseRetryTimer = null;
            }
            if (this.sharedObj.control) this.sharedObj.control.stop();
            this.state.done = -1;
        },
        receiveChannelMessage: function(event) {
            const message = event.data || {};
            if (message.type === 'config' && message.config) {
                try {
                    this.applyGlossary(message.config, '共有設定', false, false, false);
                } catch (error) {
                    if (this.sharedObj.debug) console.error(error);
                }
            }
            if (this.overlayMode && message.type === 'show-term' && message.term) {
                this.sharedObj.activate(-1, message.term, {
                    ignoreCooldown: true,
                    silent: true
                });
            }
        }
    },
    mounted: function() {
        this.loadInitialGlossary();
        window.addEventListener('speech-popup-engine-status', this.updateRecognitionEngineStatus);
        this.updateRecognitionEngineStatus();
        this.sharedObj.onActivate = term => {
            if (!this.overlayMode && popupChannel) {
                popupChannel.postMessage({ type: 'show-term', term: clone(term) });
            }
        };
        if (popupChannel) popupChannel.onmessage = this.receiveChannelMessage;
    },
    beforeDestroy: function() {
        window.removeEventListener('speech-popup-engine-status', this.updateRecognitionEngineStatus);
        if (this._overlayCopyTimer) clearTimeout(this._overlayCopyTimer);
        if (this._importCopyTimer) clearTimeout(this._importCopyTimer);
        if (this.sharedObj.phraseRetryTimer !== null) {
            clearTimeout(this.sharedObj.phraseRetryTimer);
        }
        if (popupChannel) popupChannel.close();
    }
});
