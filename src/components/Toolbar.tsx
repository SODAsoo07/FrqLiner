import { useRef } from 'react';
import JSZip from 'jszip';
import { useFrqContext } from './FrqContext';
import { writeFrq, parseFrq } from '../lib/frq';
import { extractExpectedF0 } from '../lib/pitch';

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
    const { files, addFiles, updateWavFile, clearFiles } = useFrqContext();
    const frqInputRef = useRef<HTMLInputElement>(null);
    const wavInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);

    // Parse and group all files, then add to context.
    const processFiles = async (fileList: File[]) => {
        const groups = new Map<string, { frq?: File; wav?: File; baseName?: string; path?: string }>();

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
            }
        }

        const newEntries = [];
        for (const [baseName, group] of groups.entries()) {
            if (group.frq) {
                const buffer = await group.frq.arrayBuffer();
                try {
                    const frqData = parseFrq(buffer);
                    const expectedF0 = extractExpectedF0(group.baseName || baseName);
                    newEntries.push({
                        id: crypto.randomUUID(),
                        frqFile: group.frq,
                        wavFile: group.wav || null,
                        name: group.frq.name,
                        path: group.path || group.frq.name,
                        frqData,
                        history: [],
                        redoStack: [],
                        isModified: false,
                        expectedF0
                    });
                } catch (err) {
                    console.error(`Failed to parse ${group.frq.name}`, err);
                }
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
                📂 FRQ 불러오기
            </button>
            <input ref={frqInputRef} type="file" multiple accept=".frq,.wav" onChange={handleFrqChange} style={{ display: 'none' }} />

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
