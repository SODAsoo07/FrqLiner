import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type Language = 'ko' | 'en' | 'ja';

type TranslationParams = Record<string, number | string>;
type TranslationValue = string | ((params?: TranslationParams) => string);

const dictionary: Record<Language, Record<string, TranslationValue>> = {
    ko: {
        language: '\uC5B8\uC5B4',
        languageKo: '\uD55C\uAD6D\uC5B4',
        languageEn: 'English',
        languageJa: '\u65E5\u672C\u8A9E',
        sidebarOpen: '\uC0AC\uC774\uB4DC\uBC14 \uB2EB\uAE30',
        sidebarClose: '\uC0AC\uC774\uB4DC\uBC14 \uC5F4\uAE30',
        openFiles: '\uD30C\uC77C \uC5F4\uAE30',
        addWav: 'WAV \uCD94\uAC00',
        openFolder: '\uD3F4\uB354 \uC5F4\uAE30',
        autoGenerate: '\uC790\uB3D9 F0',
        downloadZip: 'ZIP \uC800\uC7A5',
        clear: '\uC804\uCCB4 \uC9C0\uC6B0\uAE30',
        fileStats: ({ count = 0 } = {}) => `\uD30C\uC77C ${count}\uAC1C`,
        wavStats: ({ count = 0 } = {}) => `WAV ${count}\uAC1C`,
        modifiedStats: ({ count = 0 } = {}) => `\uC218\uC815\uB428 ${count}\uAC1C`,
        sidebarTitle: ({ count = 0 } = {}) => `\uD30C\uC77C \uBAA9\uB85D (${count})`,
        sidebarEmpty: '\uBD88\uB7EC\uC628 \uD30C\uC77C\uC774 \uC5EC\uAE30\uC5D0 \uD45C\uC2DC\uB429\uB2C8\uB2E4.',
        spectrogram: '\uC2A4\uD399\uD2B8\uB85C\uADF8\uB7A8',
        global: '\uC804\uCCB4',
        thisFile: '\uC774 \uD30C\uC77C',
        useGlobal: '\uC804\uCCB4 \uC124\uC815 \uC0AC\uC6A9',
        low: '\uB0AE\uC74C',
        default: '\uAE30\uBCF8',
        high: '\uB192\uC74C',
        loadingSpectrogram: '\uC2A4\uD399\uD2B8\uB85C\uADF8\uB7A8 \uB85C\uB529 \uC911...',
        wavConnected: 'WAV \uC5F0\uACB0\uB428',
        wavMissing: 'WAV \uC5C6\uC74C',
        waveformReady: '\uD30C\uD615 \uBBF8\uB9AC\uBCF4\uAE30 \uC0AC\uC6A9 \uAC00\uB2A5',
        waveformRequiresWav: 'WAV\uB97C \uC5F0\uACB0\uD558\uBA74 \uD30C\uD615 \uBBF8\uB9AC\uBCF4\uAE30\uB97C \uD45C\uC2DC\uD569\uB2C8\uB2E4',
        autoCorrect: '\uC790\uB3D9 \uBCF4\uC815',
        autoCorrectHint: '\uC7A1\uC120 \uC81C\uAC70, \uBE48 \uAD6C\uAC04 \uBCF4\uAC04, \uC2A4\uBB34\uB529',
        reset: '\uCD08\uAE30\uD654',
        resetHint: '\uBD88\uB7EC\uC628 \uCD08\uAE30 \uC0C1\uD0DC\uB85C \uB418\uB3CC\uB9BD\uB2C8\uB2E4',
        resetConfirm: '\uBD88\uB7EC\uC628 \uCD08\uAE30 \uC0C1\uD0DC\uB85C \uCD08\uAE30\uD654\uD560\uAE4C\uC694?\\n\uD604\uC7AC \uC218\uC815 \uB0B4\uC6A9\uC740 \uC0AC\uB77C\uC9D1\uB2C8\uB2E4.',
        undo: '\uCDE8\uC18C',
        undoHint: '\uC2E4\uD589 \uCDE8\uC18C (Ctrl+Z)',
        redo: '\uB2E4\uC2DC',
        redoHint: '\uB2E4\uC2DC \uC2E4\uD589 (Ctrl+Y)',
        shortcuts: '\uC88C\uD074\uB9AD: \uADF8\uB9AC\uAE30 / \uC6B0\uD074\uB9AD: \uC9C0\uC6B0\uAE30 / Ctrl+\uD720: \uD655\uB300 / Shift+\uD720: \uC774\uB3D9',
    },
    en: {
        language: 'Language',
        languageKo: '\uD55C\uAD6D\uC5B4',
        languageEn: 'English',
        languageJa: '\u65E5\u672C\u8A9E',
        sidebarOpen: 'Hide Sidebar',
        sidebarClose: 'Show Sidebar',
        openFiles: 'Open Files',
        addWav: 'Add WAV',
        openFolder: 'Open Folder',
        autoGenerate: 'Auto F0',
        downloadZip: 'Save ZIP',
        clear: 'Clear All',
        fileStats: ({ count = 0 } = {}) => `${count} files`,
        wavStats: ({ count = 0 } = {}) => `${count} WAV`,
        modifiedStats: ({ count = 0 } = {}) => `${count} modified`,
        sidebarTitle: ({ count = 0 } = {}) => `Files (${count})`,
        sidebarEmpty: 'Loaded files will appear here.',
        spectrogram: 'Spectrogram',
        global: 'Global',
        thisFile: 'This file',
        useGlobal: 'Use Global',
        low: 'Low',
        default: 'Default',
        high: 'High',
        loadingSpectrogram: 'Loading spectrogram...',
        wavConnected: 'WAV linked',
        wavMissing: 'No WAV',
        waveformReady: 'Waveform preview available',
        waveformRequiresWav: 'Connect a WAV file to show the waveform preview',
        autoCorrect: 'Auto Correct',
        autoCorrectHint: 'Remove stray points, fill gaps, and smooth the curve',
        reset: 'Reset',
        resetHint: 'Restore the loaded initial state',
        resetConfirm: 'Reset to the loaded initial state?\\nCurrent edits will be lost.',
        undo: 'Undo',
        undoHint: 'Undo (Ctrl+Z)',
        redo: 'Redo',
        redoHint: 'Redo (Ctrl+Y)',
        shortcuts: 'Left drag: draw / Right drag: erase / Ctrl+Wheel: zoom / Shift+Wheel: pan',
    },
    ja: {
        language: '\u8A00\u8A9E',
        languageKo: '\uD55C\uAD6D\uC5B4',
        languageEn: 'English',
        languageJa: '\u65E5\u672C\u8A9E',
        sidebarOpen: '\u30B5\u30A4\u30C9\u30D0\u30FC\u3092\u9589\u3058\u308B',
        sidebarClose: '\u30B5\u30A4\u30C9\u30D0\u30FC\u3092\u958B\u304F',
        openFiles: '\u30D5\u30A1\u30A4\u30EB\u3092\u958B\u304F',
        addWav: 'WAV\u3092\u8FFD\u52A0',
        openFolder: '\u30D5\u30A9\u30EB\u30C0\u3092\u958B\u304F',
        autoGenerate: '\u81EA\u52D5 F0',
        downloadZip: 'ZIP \u4FDD\u5B58',
        clear: '\u3059\u3079\u3066\u30AF\u30EA\u30A2',
        fileStats: ({ count = 0 } = {}) => `\u30D5\u30A1\u30A4\u30EB ${count}\u4EF6`,
        wavStats: ({ count = 0 } = {}) => `WAV ${count}\u4EF6`,
        modifiedStats: ({ count = 0 } = {}) => `\u5909\u66F4 ${count}\u4EF6`,
        sidebarTitle: ({ count = 0 } = {}) => `\u30D5\u30A1\u30A4\u30EB\u4E00\u89A7 (${count})`,
        sidebarEmpty: '\u8AAD\u307F\u8FBC\u3093\u3060\u30D5\u30A1\u30A4\u30EB\u304C\u3053\u3053\u306B\u8868\u793A\u3055\u308C\u307E\u3059\u3002',
        spectrogram: '\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0',
        global: '\u5168\u4F53',
        thisFile: '\u3053\u306E\u30D5\u30A1\u30A4\u30EB',
        useGlobal: '\u5168\u4F53\u8A2D\u5B9A\u3092\u4F7F\u7528',
        low: '\u4F4E',
        default: '\u6A19\u6E96',
        high: '\u9AD8',
        loadingSpectrogram: '\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D...',
        wavConnected: 'WAV \u9023\u643A\u6E08\u307F',
        wavMissing: 'WAV \u306A\u3057',
        waveformReady: '\u6CE2\u5F62\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u8868\u793A\u3067\u304D\u307E\u3059',
        waveformRequiresWav: 'WAV \u3092\u63A5\u7D9A\u3059\u308B\u3068\u6CE2\u5F62\u30D7\u30EC\u30D3\u30E5\u30FC\u3092\u8868\u793A\u3057\u307E\u3059',
        autoCorrect: '\u81EA\u52D5\u88DC\u6B63',
        autoCorrectHint: '\u30CE\u30A4\u30BA\u9664\u53BB\u3001\u7A7A\u767D\u88DC\u9593\u3001\u30B9\u30E0\u30FC\u30B8\u30F3\u30B0',
        reset: '\u521D\u671F\u5316',
        resetHint: '\u8AAD\u307F\u8FBC\u307F\u76F4\u5F8C\u306E\u72B6\u614B\u306B\u623B\u3057\u307E\u3059',
        resetConfirm: '\u8AAD\u307F\u8FBC\u307F\u76F4\u5F8C\u306E\u72B6\u614B\u306B\u623B\u3057\u307E\u3059\u304B?\\n\u73FE\u5728\u306E\u7DE8\u96C6\u5185\u5BB9\u306F\u5931\u308F\u308C\u307E\u3059\u3002',
        undo: '\u5143\u306B\u623B\u3059',
        undoHint: '\u5143\u306B\u623B\u3059 (Ctrl+Z)',
        redo: '\u3084\u308A\u76F4\u3059',
        redoHint: '\u3084\u308A\u76F4\u3059 (Ctrl+Y)',
        shortcuts: '\u5DE6\u30C9\u30E9\u30C3\u30B0: \u63CF\u304F / \u53F3\u30C9\u30E9\u30C3\u30B0: \u6D88\u3059 / Ctrl+\u30DB\u30A4\u30FC\u30EB: \u62E1\u5927 / Shift+\u30DB\u30A4\u30FC\u30EB: \u79FB\u52D5',
    },
};

interface LanguageContextState {
    language: Language;
    setLanguage: (language: Language) => void;
    t: (key: string, params?: TranslationParams) => string;
}

const LanguageContext = createContext<LanguageContextState | null>(null);

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
    const [language, setLanguage] = useState<Language>('ko');

    const value = useMemo<LanguageContextState>(() => ({
        language,
        setLanguage,
        t: (key, params) => {
            const entry = dictionary[language][key];
            if (typeof entry === 'function') return entry(params);
            return entry ?? key;
        },
    }), [language]);

    return (
        <LanguageContext.Provider value={value}>
            {children}
        </LanguageContext.Provider>
    );
};

export const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) throw new Error('useLanguage requires a LanguageProvider');
    return context;
};
