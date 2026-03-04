import { useRef, useState } from 'react';
import JSZip from 'jszip';
import { useFrqContext } from './FrqContext';
import { extractExpectedF0 } from '../lib/pitch';
import { parseMrq, parsePmk, parseFrq, writeFrq, type FrqFrame } from '../lib/frq';
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

export const Toolbar = ({ toggleSidebar, isSidebarOpen }: { toggleSidebar: () => void, isSidebarOpen: boolean }) => {
    const { files, addFiles, updateWavFile, importFrqToEntry, clearFiles, updateFrqData } = useFrqContext();
    const frqInputRef = useRef<HTMLInputElement>(null);
    const wavInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const [generatingPct, setGeneratingPct] = useState<number | null>(null);

    // Parse and group all files, then add to context.
    const processFiles = async (fileList: File[]) => {
        const groups = new Map<string, {
            frq?: File;
            wav?: File;
            pmk?: File;
            baseName?: string;
            path?: string;
            frqData?: any;
            sourceType?: 'frq' | 'mrq' | 'pmk' | 'generated' | 'wav-only';
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
            } else if (file.name.endsWith('.mrq')) {
                const buffer = await file.arrayBuffer();
                try {
                    const mrqData = parseMrq(buffer);
                    for (const entry of mrqData.entries) {
                        const baseName = entry.filename.replace(/\.wav$/i, '');
                        // Moresampler uses .mrq usually inside the folder
                        // Find or create group
                        const groupKeyMatch = Array.from(groups.keys()).find(k => k.endsWith(baseName));
                        const key = groupKeyMatch || path.replace(file.name, '') + baseName;
                        const group = groups.get(key) || { baseName, path: key };

                        // Fake a FRQ file from MRQ F0 data
                        if (!group.frq) {
                            const frames: FrqFrame[] = Array.from(entry.f0).map(f => ({ f0: f, amp: 100 }));
                            const fakeFrqData = {
                                samplesPerWindow: entry.hopSize || 256,
                                windowInterval: (entry.hopSize || 256) / (entry.sampleRate || 44100) * 1000,
                                unknown20: 0, unknown24: 0, unknown28: 0, unknown32: 0, unknown36: 0,
                                frames
                            };

                            // Create a dummy File object so UI logic holds
                            const dummyFile = new File([new ArrayBuffer(40 + frames.length * 16)], `${baseName}_wav.frq`);
                            group.frq = dummyFile;
                            group.frqData = fakeFrqData; // Inject pre-parsed data
                        }
                        groups.set(key, group);
                    }
                } catch (err) {
                    console.error("Failed to parse MRQ", err);
                }
            }
        }

        // ── Cross-reference: merge new groups with already-loaded entries ────
        // Helper: derive comparable base name from an entry's frqFile.name
        const entryBase = (entryName: string) =>
            entryName.replace(/_wav\.frq$/i, '').replace(/\.frq$/i, '').toLowerCase();
        const groupBase = (g: { baseName?: string }, key: string) =>
            (g.baseName || key).replace(/_wav\.frq$/i, '').replace(/\.frq$/i, '').replace(/\.wav$/i, '').toLowerCase();

        const keysToSkip = new Set<string>();

        for (const [key, group] of groups.entries()) {
            const gb = groupBase(group, key);

            // Case A: new group is WAV-only → try to link to an existing FRQ entry
            if (group.wav && !group.frq && !group.pmk) {
                const match = files.find(e => entryBase(e.name) === gb);
                if (match) {
                    updateWavFile([group.wav]);
                    keysToSkip.add(key);
                    continue;
                }
            }

            // Case B: new group has FRQ/PMK but no WAV → try to link to existing wav-only entry
            if ((group.frq || group.pmk) && !group.wav) {
                const match = files.find(e => entryBase(e.name) === gb && e.sourceType === 'wav-only');
                if (match) {
                    try {
                        let frqData: import('../lib/frq').FrqData;
                        let frqFileObj: File;
                        if (group.frq) {
                            frqFileObj = group.frq;
                            frqData = parseFrq(await group.frq.arrayBuffer());
                        } else {
                            // PMK without WAV – use wav from existing entry
                            const wavBuf = await match.wavFile!.arrayBuffer();
                            const ac = new AudioContext();
                            const decoded = await ac.decodeAudioData(wavBuf.slice(0));
                            const sr = decoded.sampleRate;
                            const nf = Math.ceil(decoded.length / 256);
                            await ac.close();
                            frqData = parsePmk(await group.pmk!.arrayBuffer(), nf, sr);
                            frqFileObj = new File([new ArrayBuffer(0)], gb + '_wav.frq');
                        }
                        importFrqToEntry(match.id, frqData, frqFileObj, group.frq ? 'frq' : 'pmk');
                        keysToSkip.add(key);
                    } catch (e) {
                        console.error('Merge frq to wav-only failed', e);
                    }
                }
            }
        }

        const newEntries = [];
        for (const [baseName, group] of groups.entries()) {
            if (keysToSkip.has(baseName)) continue;
            const expectedF0 = extractExpectedF0(group.baseName || baseName);


            // ── Case 1: real .frq file (or virtual frq injected from MRQ) ──
            if (group.frq) {
                try {
                    let frqData = group.frqData;
                    const sourceType = group.sourceType || 'frq';
                    if (!frqData) {
                        const buffer = await group.frq.arrayBuffer();
                        frqData = parseFrq(buffer);
                    }
                    newEntries.push({
                        id: crypto.randomUUID(),
                        frqFile: group.frq,
                        wavFile: group.wav || null,
                        name: group.frq.name,
                        path: group.path || group.frq.name,
                        frqData, originalFrqData: frqData,
                        history: [], redoStack: [], isModified: false,
                        expectedF0, sourceType
                    });
                } catch (err) {
                    console.error(`Failed to parse ${group.frq.name}`, err);
                }

                // ── Case 2: .pmk file (TIPS / EFB-GW / EFB-GT) ──
            } else if (group.pmk) {
                try {
                    const pmkBuf = await group.pmk.arrayBuffer();
                    let numFrames: number;
                    let sampleRate = 44100;
                    const hopSize = 256;

                    if (group.wav) {
                        // Derive numFrames from actual WAV duration
                        const wavBuf = await group.wav.arrayBuffer();
                        const ac = new AudioContext();
                        const decoded = await ac.decodeAudioData(wavBuf.slice(0));
                        sampleRate = decoded.sampleRate;
                        numFrames = Math.ceil(decoded.length / hopSize);
                        await ac.close();
                    } else {
                        // Estimate: PMK is ~22x data-bytes
                        numFrames = Math.max(1, Math.floor(pmkBuf.byteLength / (22 * 4)));
                    }

                    const frqData = parsePmk(pmkBuf, numFrames, sampleRate, hopSize);
                    const pmkBaseName = group.pmk.name.replace(/_wav\.pmk$/i, '').replace(/\.pmk$/i, '');
                    const frqName = pmkBaseName + '_wav.frq';
                    const dummyFrqFile = new File([new ArrayBuffer(0)], frqName);

                    newEntries.push({
                        id: crypto.randomUUID(),
                        frqFile: dummyFrqFile,
                        wavFile: group.wav || null,
                        name: frqName,
                        path: (group.path || group.pmk.name).replace(/\.pmk$/i, '_wav.frq'),
                        frqData, originalFrqData: frqData,
                        history: [], redoStack: [], isModified: false,
                        expectedF0, sourceType: 'pmk' as const
                    });
                } catch (err) {
                    console.error(`Failed to parse PMK ${group.pmk.name}`, err);
                }

                // ── Case 3: WAV only — add placeholder entry for guidance UI ──
            } else if (group.wav) {
                const wavBaseName = group.wav.name.replace(/\.wav$/i, '');
                const frqName = wavBaseName + '_wav.frq';
                const dummyFrqFile = new File([new ArrayBuffer(0)], frqName);
                const emptyFrqData = {
                    samplesPerWindow: 256, windowInterval: 5.805,
                    unknown20: 0, unknown24: 0, unknown28: 0, unknown32: 0, unknown36: 0,
                    frames: [] as FrqFrame[]
                };
                newEntries.push({
                    id: crypto.randomUUID(),
                    frqFile: dummyFrqFile,
                    wavFile: group.wav,
                    name: frqName,
                    path: group.path?.replace(/\.wav$/i, '_wav.frq') || frqName,
                    frqData: emptyFrqData, originalFrqData: emptyFrqData,
                    history: [], redoStack: [], isModified: false,
                    expectedF0, sourceType: 'wav-only' as const
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

    // When the user loads .wav files separately, auto-pair them with existing .frq entries
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
        const zip = new JSZip();
        for (const entry of files) {
            const newBuffer = writeFrq(entry.frqData);
            zip.file(entry.path, newBuffer);
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'edited_frq_files.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const modifiedCount = files.filter(f => f.isModified).length;
    const wavCount = files.filter(f => f.wavFile).length;

    return (
        <div style={{ display: 'flex', gap: '6px', padding: '8px 12px', borderBottom: '1px solid #ccc', background: '#f8f9fa', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Sidebar toggle */}
            <button onClick={toggleSidebar} style={btnStyle('#6c757d')}>
                {isSidebarOpen ? '◀ 목록 숨기기' : '▶ 목록 보기'}
            </button>

            <div style={{ width: '1px', height: '24px', background: '#dee2e6', margin: '0 4px' }} />

            {/* FRQ + WAV file load (select both in same dialog) */}
            <button onClick={() => frqInputRef.current?.click()} style={btnStyle('#0d6efd')}>
                📂 파일 복수선택 불러오기
            </button>
            <input ref={frqInputRef} type="file" multiple accept=".frq,.wav,.mrq,.pmk" onChange={handleFrqChange} style={{ display: 'none' }} />

            {/* WAV file auto-pair (add wavs to already-loaded frqs) */}
            <button onClick={() => wavInputRef.current?.click()} style={btnStyle('#0dcaf0')} title="이미 불러온 FRQ와 파일명이 같은 WAV를 선택하면 자동 연결됩니다">
                🎵 WAV 추가 연결
            </button>
            <input ref={wavInputRef} type="file" multiple accept=".wav" onChange={handleWavChange} style={{ display: 'none' }} />

            {/* Folder load */}
            <button onClick={() => folderInputRef.current?.click()} style={btnStyle('#6f42c1')}>
                🗂 폴더 불러오기
            </button>
            {/* @ts-ignore */}
            <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple onChange={handleFolderChange} style={{ display: 'none' }} />

            <div style={{ width: '1px', height: '24px', background: '#dee2e6', margin: '0 4px' }} />

            {/* Stats */}
            {files.length > 0 && (
                <span style={{ fontSize: '13px', color: '#495057', background: '#e9ecef', padding: '4px 10px', borderRadius: '4px' }}>
                    총 {files.length}개
                    {wavCount > 0 && <> · WAV {wavCount}개 연결됨</>}
                    {modifiedCount > 0 && <span style={{ color: '#dc3545' }}> · {modifiedCount}개 수정됨</span>}
                </span>
            )}

            <div style={{ flex: 1 }} />

            {/* Experimental Auto-F0 Generation */}
            <button
                disabled={files.filter(f => f.wavFile).length === 0 || generatingPct !== null}
                style={btnStyle('#e67700', files.filter(f => f.wavFile).length === 0 || generatingPct !== null)}
                onClick={async () => {
                    if (files.length === 0 || generatingPct !== null) return;
                    const ok = window.confirm('WAV가 연결된 모든 파일에 대해 파형 기반 F0 분석을 수행합니다.\n기존 FRQ 데이터가 덮어씌워집니다. 계속할까요?\n(실험적 기능 — 처리 중 UI가 잠시 바쁠 수 있습니다)');
                    if (!ok) return;
                    setGeneratingPct(0);
                    const targets = files.filter(f => f.wavFile);
                    for (let i = 0; i < targets.length; i++) {
                        const entry = targets[i];
                        try {
                            const buffer = await entry.wavFile!.arrayBuffer();
                            const newFrq = await generateBasicF0(
                                buffer,
                                entry.expectedF0,
                                pct => setGeneratingPct(
                                    Math.round(((i + pct) / targets.length) * 100)
                                ),
                            );
                            if (newFrq) updateFrqData(entry.id, newFrq);
                        } catch (e) {
                            console.error('F0 gen failed for ' + entry.name, e);
                        }
                        setGeneratingPct(Math.round(((i + 1) / targets.length) * 100));
                    }
                    setGeneratingPct(null);
                }}
            >
                {generatingPct !== null ? `⏳ F0 생성 중… ${generatingPct}%` : '🔮 자체 F0 생성 (실험적)'}
            </button>

            {/* Download */}
            <button onClick={handleDownloadAll} disabled={files.length === 0} style={btnStyle('#198754', files.length === 0)}>
                ⬇ 전체 내보내기 (.zip)
            </button>

            {/* Clear */}
            <button onClick={clearFiles} disabled={files.length === 0} style={btnStyle('#dc3545', files.length === 0)}>
                🗑 목록 비우기
            </button>
        </div>
    );
};
