import { createContext, useContext, useState, type ReactNode } from 'react';
import type { FrqData, LlsmExperimentalSettings, LlsmVoicingMode } from '../lib/frq';

export interface FrqFileEntry {
    id: string;
    frqFile: File;
    wavFile: File | null;
    name: string;
    path: string;
    frqData: FrqData;
    originalFrqData: FrqData;  // immutable copy of the data at load time
    history: FrqData[];
    redoStack: FrqData[];
    isModified: boolean;
    expectedF0: number | null;
    sourceType?: 'frq' | 'mrq' | 'pmk' | 'llsm' | 'generated' | 'wav-only';
    llsmExperimental?: LlsmExperimentalSettings | null;
    originalLlsmExperimental?: LlsmExperimentalSettings | null;
    llsmVoicingMode?: LlsmVoicingMode;
}

interface UpdateFrqOptions {
    pushHistory?: boolean;
    historyBase?: FrqData;
}

interface FrqContextState {
    files: FrqFileEntry[];
    activeFileId: string | null;
    addFiles: (entries: FrqFileEntry[]) => void;
    setActiveFile: (id: string) => void;
    updateFrqData: (id: string, newFrqData: FrqData, options?: UpdateFrqOptions) => void;
    updateLlsmExperimental: (id: string, settings: LlsmExperimentalSettings) => void;
    updateLlsmVoicingMode: (id: string, mode: LlsmVoicingMode) => void;
    updateWavFile: (wavFiles: File[]) => void;
    importFrqToEntry: (
        id: string,
        frqData: FrqData,
        frqFile: File,
        sourceType?: FrqFileEntry['sourceType'],
        llsmExperimental?: LlsmExperimentalSettings | null,
        llsmVoicingMode?: LlsmVoicingMode,
    ) => void;
    resetFrqData: (id: string) => void;
    undo: (id: string) => void;
    redo: (id: string) => void;
    clearFiles: () => void;
}

const FrqContext = createContext<FrqContextState | null>(null);

export const useFrqContext = () => {
    const ctx = useContext(FrqContext);
    if (!ctx) throw new Error('useFrqContext requires a FrqProvider');
    return ctx;
};

export const FrqProvider = ({ children }: { children: ReactNode }) => {
    const [files, setFiles] = useState<FrqFileEntry[]>([]);
    const [activeFileId, setActiveFileId] = useState<string | null>(null);

    const addFiles = (newFiles: FrqFileEntry[]) => {
        setFiles((prev) => {
            const added = [...prev, ...newFiles];
            if (!activeFileId && added.length > 0) {
                setActiveFileId(added[0].id);
            }
            return added;
        });
    };

    // Merge a newly loaded FRQ/PMK into an existing wav-only placeholder entry
    const importFrqToEntry = (
        id: string,
        frqData: FrqData,
        frqFile: File,
        sourceType: FrqFileEntry['sourceType'] = 'frq',
        llsmExperimental?: LlsmExperimentalSettings | null,
        llsmVoicingMode: LlsmVoicingMode = 'preserve',
    ) => {
        setFiles(prev => prev.map(f => {
            if (f.id !== id) return f;
            return {
                ...f,
                frqData,
                originalFrqData: frqData,
                frqFile,
                sourceType,
                llsmExperimental: sourceType === 'llsm' ? (llsmExperimental ?? null) : undefined,
                originalLlsmExperimental: sourceType === 'llsm' ? (llsmExperimental ?? null) : undefined,
                llsmVoicingMode: sourceType === 'llsm' ? llsmVoicingMode : undefined,
                history: [],
                redoStack: [],
                isModified: false,
            };
        }));
    };

    // Reset FRQ data to original loaded state
    const resetFrqData = (id: string) => {
        setFiles(prev => prev.map(f => {
            if (f.id !== id) return f;
            return {
                ...f,
                frqData: f.originalFrqData,
                llsmExperimental: f.originalLlsmExperimental,
                history: [],
                redoStack: [],
                isModified: false,
            };
        }));
    };
    const setActiveFile = (id: string) => {
        setActiveFileId(id);
    };

    const updateFrqData = (id: string, newFrqData: FrqData, options?: UpdateFrqOptions) => {
        setFiles((prev) =>
            prev.map(f => {
                if (f.id === id) {
                    const shouldPushHistory = options?.pushHistory !== false;
                    return {
                        ...f,
                        history: shouldPushHistory
                            ? [...f.history, options?.historyBase ?? f.frqData]
                            : f.history,
                        redoStack: [],
                        frqData: newFrqData,
                        isModified: true
                    };
                }
                return f;
            })
        );
    };

    const updateLlsmExperimental = (id: string, settings: LlsmExperimentalSettings) => {
        setFiles(prev =>
            prev.map(f => {
                if (f.id !== id) return f;
                if (f.sourceType !== 'llsm') return f;
                return {
                    ...f,
                    llsmExperimental: settings,
                    isModified: true,
                };
            }),
        );
    };

    const updateLlsmVoicingMode = (id: string, mode: LlsmVoicingMode) => {
        setFiles(prev =>
            prev.map(f => {
                if (f.id !== id) return f;
                if (f.sourceType !== 'llsm') return f;
                return {
                    ...f,
                    llsmVoicingMode: mode,
                    isModified: true,
                };
            }),
        );
    };

    // Match incoming .wav files to existing .frq entries by base name
    const updateWavFile = (wavFiles: File[]) => {
        setFiles(prev => prev.map(entry => {
            // Match by frq basename vs wav basename
            const frqBase = entry.name
                .replace(/_wav\.frq$/i, '')
                .replace(/\.frq$/i, '')
                .replace(/\.wav\.llsm$/i, '')
                .replace(/\.llsm$/i, '')
                .toLowerCase();
            const match = wavFiles.find(w =>
                w.name.replace(/\.wav$/i, '').toLowerCase() === frqBase
            );
            if (match) {
                return { ...entry, wavFile: match };
            }
            return entry;
        }));
    };

    const undo = (id: string) => {
        setFiles(prev => prev.map(f => {
            if (f.id === id && f.history.length > 0) {
                const newHistory = [...f.history];
                const previousState = newHistory.pop()!;
                return {
                    ...f,
                    history: newHistory,
                    redoStack: [...f.redoStack, f.frqData],
                    frqData: previousState,
                    isModified: true
                };
            }
            return f;
        }));
    };

    const redo = (id: string) => {
        setFiles(prev => prev.map(f => {
            if (f.id === id && f.redoStack.length > 0) {
                const newRedo = [...f.redoStack];
                const nextState = newRedo.pop()!;
                return {
                    ...f,
                    history: [...f.history, f.frqData],
                    redoStack: newRedo,
                    frqData: nextState,
                    isModified: true
                };
            }
            return f;
        }));
    };

    const clearFiles = () => {
        setFiles([]);
        setActiveFileId(null);
    }

    return (
        <FrqContext.Provider value={{ files, activeFileId, addFiles, setActiveFile, updateFrqData, updateLlsmExperimental, updateLlsmVoicingMode, updateWavFile, importFrqToEntry, resetFrqData, undo, redo, clearFiles }}>
            {children}
        </FrqContext.Provider>
    );
};
