import { useRef, useState } from 'react';
import JSZip from 'jszip';
import { useFrqContext } from './FrqContext';
import { useLanguage } from './LanguageContext';
import { extractExpectedF0 } from '../lib/pitch';
import { parseLlsm, parseMrq, parsePmk, parseFrq, writeFrq, type FrqData, type FrqFrame } from '../lib/frq';
import { normalizeFrqPath } from '../lib/filePath';
import { generateBasicF0 } from '../lib/pitchTracker';

const btnStyle = (color: string, disabled = false): React.CSSProperties => ({
    padding: '6px 14px',
    background: disabled ? '#ccc' : color,
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '13px',
    whiteSpace: 'nowrap',
});

export const Toolbar = ({ toggleSidebar, isSidebarOpen }: { toggleSidebar: () => void; isSidebarOpen: boolean }) => {
    const { files, addFiles, updateWavFile, importFrqToEntry, clearFiles, updateFrqData } = useFrqContext();
    const { language, setLanguage, t } = useLanguage();
    const frqInputRef = useRef<HTMLInputElement>(null);
    const wavInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const [generatingPct, setGeneratingPct] = useState<number | null>(null);

    const processFiles = async (fileList: File[]) => {
        const groups = new Map<string, {
            frq?: File;
            wav?: File;
            pmk?: File;
            llsm?: File;
            baseName?: string;
            path?: string;
            frqData?: FrqData;
            sourceType?: 'frq' | 'mrq' | 'pmk' | 'llsm' | 'generated' | 'wav-only';
        }>();

        for (const file of fileList) {
            const path = file.webkitRelativePath || file.name;

            if (file.name.endsWith('.frq')) {
                const baseName = file.name.replace(/_wav\.frq$/i, '').replace(/\.frq$/i, '');
                const key = path.replace(/_wav\.frq$/i, '').replace(/\.frq$/i, '');
                const group = groups.get(key) || { baseName, path };
                group.frq = file;
                groups.set(key, group);
            } else if (file.name.endsWith('.wav')) {
                const baseName = file.name.replace(/\.wav$/i, '');
                const key = path.replace(/\.wav$/i, '');
                const group = groups.get(key) || { baseName, path };
                group.wav = file;
                groups.set(key, group);
            } else if (file.name.endsWith('.pmk')) {
                const baseName = file.name.replace(/_wav\.pmk$/i, '').replace(/\.pmk$/i, '');
                const key = path.replace(/_wav\.pmk$/i, '').replace(/\.pmk$/i, '');
                const group = groups.get(key) || { baseName, path };
                group.pmk = file;
                groups.set(key, group);
            } else if (file.name.endsWith('.llsm')) {
                const baseName = file.name.replace(/\.wav\.llsm$/i, '').replace(/\.llsm$/i, '');
                const key = path.replace(/\.wav\.llsm$/i, '').replace(/\.llsm$/i, '');
                const group = groups.get(key) || { baseName, path };
                group.llsm = file;
                group.sourceType = 'llsm';
                groups.set(key, group);
            } else if (file.name.endsWith('.mrq')) {
                const buffer = await file.arrayBuffer();
                try {
                    const mrqData = parseMrq(buffer);
                    for (const entry of mrqData.entries) {
                        const baseName = entry.filename.replace(/\.wav$/i, '');
                        const groupKeyMatch = Array.from(groups.keys()).find(k => k.endsWith(baseName));
                        const key = groupKeyMatch || path.replace(file.name, '') + baseName;
                        const group = groups.get(key) || { baseName, path: key };

                        if (!group.frq) {
                            const frames: FrqFrame[] = Array.from(entry.f0).map(f0 => ({ f0, amp: 100 }));
                            group.frq = new File([new ArrayBuffer(40 + frames.length * 16)], `${baseName}_wav.frq`);
                            group.frqData = {
                                samplesPerWindow: entry.hopSize || 256,
                                windowInterval: (entry.hopSize || 256) / (entry.sampleRate || 44100) * 1000,
                                unknown20: 0,
                                unknown24: 0,
                                unknown28: 0,
                                unknown32: 0,
                                unknown36: 0,
                                frames,
                            };
                        }
                        groups.set(key, group);
                    }
                } catch (err) {
                    console.error('Failed to parse MRQ', err);
                }
            }
        }

        const entryBase = (entryName: string) =>
            entryName.replace(/_wav\.frq$/i, '').replace(/\.frq$/i, '').toLowerCase();
        const groupBase = (group: { baseName?: string }, key: string) =>
            (group.baseName || key)
                .replace(/_wav\.frq$/i, '')
                .replace(/\.frq$/i, '')
                .replace(/\.wav\.llsm$/i, '')
                .replace(/\.llsm$/i, '')
                .replace(/\.wav$/i, '')
                .toLowerCase();

        const keysToSkip = new Set<string>();

        for (const [key, group] of groups.entries()) {
            const gb = groupBase(group, key);

            if (group.wav && !group.frq && !group.pmk) {
                const match = files.find(entry => entryBase(entry.name) === gb);
                if (match) {
                    updateWavFile([group.wav]);
                    keysToSkip.add(key);
                    continue;
                }
            }

            if ((group.frq || group.pmk || group.llsm) && !group.wav) {
                const match = files.find(entry => entryBase(entry.name) === gb && entry.sourceType === 'wav-only');
                if (match) {
                    try {
                        let frqData: import('../lib/frq').FrqData;
                        let frqFileObj: File;
                        if (group.frq) {
                            frqFileObj = group.frq;
                            frqData = parseFrq(await group.frq.arrayBuffer());
                        } else if (group.llsm) {
                            frqData = parseLlsm(await group.llsm.arrayBuffer());
                            frqFileObj = new File([new ArrayBuffer(0)], `${gb}_wav.frq`);
                        } else {
                            const wavBuf = await match.wavFile!.arrayBuffer();
                            const ac = new AudioContext();
                            const decoded = await ac.decodeAudioData(wavBuf.slice(0));
                            const sampleRate = decoded.sampleRate;
                            const frameCount = Math.ceil(decoded.length / 256);
                            await ac.close();
                            frqData = parsePmk(await group.pmk!.arrayBuffer(), frameCount, sampleRate);
                            frqFileObj = new File([new ArrayBuffer(0)], `${gb}_wav.frq`);
                        }
                        importFrqToEntry(match.id, frqData, frqFileObj, group.frq ? 'frq' : group.llsm ? 'llsm' : 'pmk');
                        keysToSkip.add(key);
                    } catch (err) {
                        console.error('Merge frq to wav-only failed', err);
                    }
                }
            }
        }

        const newEntries = [];
        for (const [baseName, group] of groups.entries()) {
            if (keysToSkip.has(baseName)) continue;
            const expectedF0 = extractExpectedF0(group.baseName || baseName);

            if (group.frq || group.llsm) {
                try {
                    let frqData = group.frqData;
                    const sourceType = group.sourceType || (group.llsm ? 'llsm' : 'frq');
                    if (!frqData) {
                        if (group.frq) {
                            frqData = parseFrq(await group.frq.arrayBuffer());
                        } else if (group.llsm) {
                            frqData = parseLlsm(await group.llsm.arrayBuffer());
                        }
                    }
                    if (!frqData) continue;

                    const frqFile = group.frq || new File([new ArrayBuffer(0)], `${(group.baseName || baseName).replace(/\.wav$/i, '')}_wav.frq`);
                    const pathSourceName = group.path || group.frq?.name || group.llsm?.name || frqFile.name;
                    newEntries.push({
                        id: crypto.randomUUID(),
                        frqFile,
                        wavFile: group.wav || null,
                        name: frqFile.name,
                        path: normalizeFrqPath(pathSourceName, frqFile.name),
                        frqData,
                        originalFrqData: frqData,
                        history: [],
                        redoStack: [],
                        isModified: false,
                        expectedF0,
                        sourceType,
                    });
                } catch (err) {
                    console.error(`Failed to parse ${group.frq?.name || group.llsm?.name || baseName}`, err);
                }
            } else if (group.pmk) {
                try {
                    const pmkBuf = await group.pmk.arrayBuffer();
                    let numFrames: number;
                    let sampleRate = 44100;
                    const hopSize = 256;

                    if (group.wav) {
                        const wavBuf = await group.wav.arrayBuffer();
                        const ac = new AudioContext();
                        const decoded = await ac.decodeAudioData(wavBuf.slice(0));
                        sampleRate = decoded.sampleRate;
                        numFrames = Math.ceil(decoded.length / hopSize);
                        await ac.close();
                    } else {
                        numFrames = Math.max(1, Math.floor(pmkBuf.byteLength / (22 * 4)));
                    }

                    const frqData = parsePmk(pmkBuf, numFrames, sampleRate, hopSize);
                    const pmkBaseName = group.pmk.name.replace(/_wav\.pmk$/i, '').replace(/\.pmk$/i, '');
                    const frqName = `${pmkBaseName}_wav.frq`;
                    const dummyFrqFile = new File([new ArrayBuffer(0)], frqName);

                    newEntries.push({
                        id: crypto.randomUUID(),
                        frqFile: dummyFrqFile,
                        wavFile: group.wav || null,
                        name: frqName,
                        path: normalizeFrqPath(group.path || group.pmk.name, frqName),
                        frqData,
                        originalFrqData: frqData,
                        history: [],
                        redoStack: [],
                        isModified: false,
                        expectedF0,
                        sourceType: 'pmk' as const,
                    });
                } catch (err) {
                    console.error(`Failed to parse PMK ${group.pmk.name}`, err);
                }
            } else if (group.wav) {
                const wavBaseName = group.wav.name.replace(/\.wav$/i, '');
                const frqName = `${wavBaseName}_wav.frq`;
                const dummyFrqFile = new File([new ArrayBuffer(0)], frqName);
                const emptyFrqData = {
                    samplesPerWindow: 256,
                    windowInterval: 5.805,
                    unknown20: 0,
                    unknown24: 0,
                    unknown28: 0,
                    unknown32: 0,
                    unknown36: 0,
                    frames: [] as FrqFrame[],
                };
                newEntries.push({
                    id: crypto.randomUUID(),
                    frqFile: dummyFrqFile,
                    wavFile: group.wav,
                    name: frqName,
                    path: normalizeFrqPath(group.path || group.wav.name, frqName),
                    frqData: emptyFrqData,
                    originalFrqData: emptyFrqData,
                    history: [],
                    redoStack: [],
                    isModified: false,
                    expectedF0,
                    sourceType: 'wav-only' as const,
                });
            }
        }

        if (newEntries.length > 0) addFiles(newEntries);
    };

    const handleFrqChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        await processFiles(Array.from(e.target.files));
        e.target.value = '';
    };

    const handleWavChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        updateWavFile(Array.from(e.target.files));
        e.target.value = '';
    };

    const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        await processFiles(Array.from(e.target.files));
        e.target.value = '';
    };

    const handleDownloadAll = async () => {
        if (files.length === 0) return;
        const exportableFiles = files.filter(entry => entry.frqData.frames.length > 0);
        if (exportableFiles.length === 0) return;

        const zip = new JSZip();
        for (const entry of exportableFiles) {
            zip.file(normalizeFrqPath(entry.path, entry.name), writeFrq(entry.frqData));
        }

        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'edited_frq_files.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const modifiedCount = files.filter(file => file.isModified).length;
    const wavCount = files.filter(file => file.wavFile).length;
    const exportableCount = files.filter(file => file.frqData.frames.length > 0).length;

    return (
        <div style={{ display: 'flex', gap: '6px', padding: '8px 12px', borderBottom: '1px solid #ccc', background: '#f8f9fa', alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={toggleSidebar} style={btnStyle('#6c757d')}>
                {isSidebarOpen ? t('sidebarOpen') : t('sidebarClose')}
            </button>

            <div style={{ width: '1px', height: '24px', background: '#dee2e6', margin: '0 4px' }} />

            <button onClick={() => frqInputRef.current?.click()} style={btnStyle('#0d6efd')}>
                {t('openFiles')}
            </button>
            <input ref={frqInputRef} type="file" multiple accept=".frq,.wav,.mrq,.pmk,.llsm" onChange={handleFrqChange} style={{ display: 'none' }} />

            <button onClick={() => wavInputRef.current?.click()} style={btnStyle('#0dcaf0')} title="Add WAV files and pair them with loaded FRQ files">
                {t('addWav')}
            </button>
            <input ref={wavInputRef} type="file" multiple accept=".wav" onChange={handleWavChange} style={{ display: 'none' }} />

            <button onClick={() => folderInputRef.current?.click()} style={btnStyle('#6f42c1')}>
                {t('openFolder')}
            </button>
            {/* @ts-ignore */}
            <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple onChange={handleFolderChange} style={{ display: 'none' }} />

            <div style={{ width: '1px', height: '24px', background: '#dee2e6', margin: '0 4px' }} />

            {files.length > 0 && (
                <span style={{ fontSize: '13px', color: '#495057', background: '#e9ecef', padding: '4px 10px', borderRadius: '4px' }}>
                    {t('fileStats', { count: files.length })}
                    {wavCount > 0 && <> · {t('wavStats', { count: wavCount })}</>}
                    {modifiedCount > 0 && <span style={{ color: '#dc3545' }}> · {t('modifiedStats', { count: modifiedCount })}</span>}
                </span>
            )}

            <div style={{ flex: 1 }} />

            <label
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    color: '#1f2937',
                    background: '#eef6ff',
                    border: '1px solid #b6d4fe',
                    borderRadius: '999px',
                    padding: '4px 10px',
                    fontWeight: 600,
                }}
                title="UI language"
            >
                {t('language')}
                <select
                    value={language}
                    onChange={e => setLanguage(e.target.value as typeof language)}
                    style={{ fontSize: '12px', padding: '4px 6px', border: '1px solid #8fb8ff', borderRadius: '999px', background: '#fff', fontWeight: 600 }}
                >
                    <option value="ko">{t('languageKo')}</option>
                    <option value="en">{t('languageEn')}</option>
                    <option value="ja">{t('languageJa')}</option>
                </select>
            </label>

            <button
                disabled={files.filter(file => file.wavFile).length === 0 || generatingPct !== null}
                style={btnStyle('#e67700', files.filter(file => file.wavFile).length === 0 || generatingPct !== null)}
                onClick={async () => {
                    if (files.length === 0 || generatingPct !== null) return;
                    const ok = window.confirm('WAV files will be analyzed to generate a base F0 curve. Continue?');
                    if (!ok) return;
                    setGeneratingPct(0);
                    const targets = files.filter(file => file.wavFile);
                    for (let i = 0; i < targets.length; i++) {
                        const entry = targets[i];
                        try {
                            const buffer = await entry.wavFile!.arrayBuffer();
                            const newFrq = await generateBasicF0(
                                buffer,
                                entry.expectedF0,
                                pct => setGeneratingPct(Math.round(((i + pct) / targets.length) * 100)),
                            );
                            if (newFrq) updateFrqData(entry.id, newFrq);
                        } catch (err) {
                            console.error(`F0 gen failed for ${entry.name}`, err);
                        }
                        setGeneratingPct(Math.round(((i + 1) / targets.length) * 100));
                    }
                    setGeneratingPct(null);
                }}
            >
                {generatingPct !== null ? `${t('autoGenerate')} ${generatingPct}%` : t('autoGenerate')}
            </button>

            <button onClick={handleDownloadAll} disabled={exportableCount === 0} style={btnStyle('#198754', exportableCount === 0)}>
                {t('downloadZip')}
            </button>

            <button onClick={clearFiles} disabled={files.length === 0} style={btnStyle('#dc3545', files.length === 0)}>
                {t('clear')}
            </button>
        </div>
    );
};
