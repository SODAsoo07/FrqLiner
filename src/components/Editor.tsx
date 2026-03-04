import { useRef, useEffect, useState, useCallback, type MouseEvent } from 'react';
import { useFrqContext } from './FrqContext';
import Meyda from 'meyda';
import type { FrqFrame } from '../lib/frq';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
const MIN_FREQ = 50;
const MAX_FREQ = 700; // Hz — narrows Y range for more precise editing

const canvasY = (f0: number, h: number) => {
    if (f0 <= 0) return h;
    return Math.max(0, Math.min(h - ((f0 - MIN_FREQ) / (MAX_FREQ - MIN_FREQ)) * h, h));
};

const f0FromY = (y: number, h: number) =>
    Math.max(0, MIN_FREQ + ((h - y) / h) * (MAX_FREQ - MIN_FREQ));

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────
const Editor = () => {
    const { files, activeFileId, updateFrqData, resetFrqData, undo, redo } = useFrqContext();
    const activeFile = files.find(f => f.id === activeFileId);

    // ── Canvas refs ────────────────────────────
    const frqCanvasRef = useRef<HTMLCanvasElement>(null);
    const frqContainerRef = useRef<HTMLDivElement>(null);
    const waveCanvasRef = useRef<HTMLCanvasElement>(null);
    const waveContainerRef = useRef<HTMLDivElement>(null);
    const spgCanvasRef = useRef<HTMLCanvasElement>(null);
    const spgContainerRef = useRef<HTMLDivElement>(null);

    // ── View state ─────────────────────────────
    const [zoomX, setZoomX] = useState(1);
    const [offsetX, setOffsetX] = useState(0);

    // ── Drawing state ──────────────────────────
    const isDrawing = useRef(false);
    const isRightDrag = useRef(false); // true = erasing
    const lastDrawPos = useRef<{ x: number; y: number } | null>(null);

    // ── Audio state ────────────────────────────
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const animFrameRef = useRef<number | null>(null);

    // Storing decoded audio as STATE so renders are triggered
    const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
    const [spectrogramData, setSpectrogramData] = useState<Uint8Array[] | null>(null);

    // ── Reset on file change ───────────────────
    useEffect(() => {
        setZoomX(1);
        setOffsetX(0);
        setCurrentTime(0);
        setIsPlaying(false);
        setWaveformData(null);
        setSpectrogramData(null);

        if (audioRef.current) {
            audioRef.current.pause();
            URL.revokeObjectURL(audioRef.current.src);
            audioRef.current = null;
        }

        if (activeFile?.wavFile) {
            const url = URL.createObjectURL(activeFile.wavFile);
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.addEventListener('ended', () => {
                setIsPlaying(false);
                setCurrentTime(0);
            });

            // Decode audio data for visualization
            activeFile.wavFile.arrayBuffer().then(async rawBuffer => {
                try {
                    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
                        audioCtxRef.current = new AudioContext();
                    }
                    const decoded = await audioCtxRef.current.decodeAudioData(rawBuffer);

                    // Store waveform PCM as STATE so render is triggered
                    setWaveformData(decoded.getChannelData(0));

                    // Spectrogram via Meyda (runs on JS main thread; 44100Hz * 5s = ~220k samples)
                    const pcm = decoded.getChannelData(0);
                    const BUFSZ = 1024;
                    const HOP = BUFSZ / 2;
                    const bands: Uint8Array[] = [];

                    for (let i = 0; i < pcm.length; i += HOP) {
                        let slice: Float32Array;
                        if (i + BUFSZ <= pcm.length) {
                            slice = pcm.subarray(i, i + BUFSZ);
                        } else {
                            // pad last slice
                            slice = new Float32Array(BUFSZ);
                            slice.set(pcm.subarray(i));
                        }

                        const result = Meyda.extract('melBands', slice) as number[] | null;
                        if (!result) continue;

                        const row = new Uint8Array(result.length);
                        for (let k = 0; k < result.length; k++) {
                            // log scale for visibility
                            row[k] = Math.min(255, Math.log1p(result[k]) * 60);
                        }
                        bands.push(row);
                    }

                    setSpectrogramData(bands);
                } catch (err) {
                    console.error('Audio decode/analyze failed:', err);
                }
            }).catch(err => console.error('File read failed:', err));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFileId]);

    // ── Keyboard shortcuts ─────────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!activeFile) return;

            if (e.code === 'Space' && e.target === document.body) {
                e.preventDefault();
                if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
                if (audioRef.current) {
                    if (isPlaying) {
                        audioRef.current.pause();
                        setIsPlaying(false);
                    } else {
                        audioRef.current.currentTime = currentTime;
                        audioRef.current.play();
                        setIsPlaying(true);
                    }
                }
            }

            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                undo(activeFile.id);
            } else if ((e.ctrlKey || e.metaKey) && (e.shiftKey && e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
                e.preventDefault();
                redo(activeFile.id);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [activeFile, isPlaying, currentTime, undo, redo]);

    // ── Playhead animation ─────────────────────
    useEffect(() => {
        if (isPlaying) {
            const loop = () => {
                if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
                animFrameRef.current = requestAnimationFrame(loop);
            };
            animFrameRef.current = requestAnimationFrame(loop);
        } else {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        }
        return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
    }, [isPlaying]);

    // ── F0 Canvas draw ─────────────────────────
    const drawFrq = useCallback(() => {
        const canvas = frqCanvasRef.current;
        const container = frqContainerRef.current;
        if (!canvas || !container || !activeFile) return;

        const W = container.clientWidth;
        const H = container.clientHeight;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;

        const ctx = canvas.getContext('2d')!;
        const frames = activeFile.frqData.frames;

        ctx.clearRect(0, 0, W, H);

        const ptW = Math.max(1, (W / frames.length) * zoomX);
        const startF = Math.max(0, Math.floor(offsetX / ptW));
        const endF = Math.min(frames.length - 1, Math.ceil((offsetX + W) / ptW));

        // 1. (Waveform is now shown in its own panel above — no overlay here)

        // 2. 100 Hz grid lines (light, behind note-pitch ruler)
        ctx.strokeStyle = 'rgba(200,200,200,0.4)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        for (let f = Math.ceil(MIN_FREQ / 100) * 100; f <= MAX_FREQ; f += 100) {
            const y = canvasY(f, H);
            ctx.moveTo(0, y); ctx.lineTo(W, y);
        }
        ctx.stroke();

        // 3. Guide F0 line
        if (activeFile.expectedF0) {
            ctx.strokeStyle = 'rgba(0,123,255,0.5)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            const y = canvasY(activeFile.expectedF0, H);
            ctx.moveTo(0, y); ctx.lineTo(W, y);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 4. Amplitude bars (subtle)
        ctx.fillStyle = 'rgba(0,0,0,0.06)';
        for (let i = startF; i <= endF; i++) {
            const cx = i * ptW - offsetX;
            const ampH = (frames[i].amp / 100) * H;
            ctx.fillRect(cx, H - ampH, ptW, ampH);
        }

        // 5. F0 line
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        let first = true;
        for (let i = startF; i <= endF; i++) {
            const frame = frames[i];
            if (frame.f0 <= 0) { first = true; continue; }
            const cx = i * ptW - offsetX;
            const cy = canvasY(frame.f0, H);
            if (first) { ctx.moveTo(cx, cy); first = false; }
            else ctx.lineTo(cx, cy);
        }
        ctx.stroke();

        // 6. Note labels (right-side pitch ruler)
        // Korean solfège: 도(C) 레(D) 미(E) 파(F) 솔(G) 라(A) 시(B)
        const NOTE_KO = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
        const FLAT_KO = ['도', '레b', '레', '미b', '미', '파', '솔b', '솔', '라b', '라', '시b', '시'];
        const CHROMATIC = [0, 2, 4, 5, 7, 9, 11]; // natural note indices

        ctx.save();
        ctx.font = '10px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
        for (let midi = 24; midi <= 108; midi++) {
            const hz = 440 * Math.pow(2, (midi - 69) / 12);
            if (hz > MAX_FREQ) break;
            const y = canvasY(hz, H);
            if (y < 0 || y > H) continue;

            const noteIdx = midi % 12;
            const octave = Math.floor(midi / 12) - 1;
            const isNatural = CHROMATIC.includes(noteIdx);
            const isC = noteIdx === 0;

            // Subtle horizontal line for each pitch
            ctx.strokeStyle = isC
                ? 'rgba(220,80,80,0.3)'
                : isNatural
                    ? 'rgba(0,0,0,0.10)'
                    : 'rgba(0,0,0,0.04)';
            ctx.lineWidth = isC ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();

            // Label only natural notes to reduce clutter
            if (isNatural) {
                const sharp = NOTE_KO[noteIdx];
                const flat = FLAT_KO[noteIdx];
                const label = sharp === flat ? `${sharp}${octave}` : `${sharp}/${flat}${octave}`;

                // Draw label background for readability
                const textWidth = ctx.measureText(label).width;
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.fillRect(W - textWidth - 6, y - 6, textWidth + 6, 12);

                ctx.fillStyle = isC ? 'rgba(210,50,50,0.85)' : 'rgba(60,60,80,0.65)';
                ctx.textAlign = 'right';
                ctx.fillText(label, W - 4, y + 3.5);
            }
        }
        ctx.restore();

        // 7. Playhead
        if (audioRef.current && activeFile.wavFile) {
            const dur = audioRef.current.duration || 1;
            const cfIdx = (currentTime / dur) * frames.length;
            const px = cfIdx * ptW - offsetX;
            ctx.strokeStyle = '#2dc653';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px, 0); ctx.lineTo(px, H);
            ctx.stroke();
        }
    }, [activeFile, zoomX, offsetX, currentTime, waveformData]);

    useEffect(() => { drawFrq(); }, [drawFrq]);

    // ── Spectrogram draw ───────────────────────
    const drawSpectrogram = useCallback(() => {
        const canvas = spgCanvasRef.current;
        const container = spgContainerRef.current;
        if (!canvas || !container) return;

        const W = container.clientWidth;
        const H = container.clientHeight;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;

        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, W, H);

        if (!spectrogramData || !activeFile || spectrogramData.length === 0) return;

        const frames = activeFile.frqData.frames;
        const ptW = Math.max(1, (W / frames.length) * zoomX);
        const startF = Math.max(0, Math.floor(offsetX / ptW));
        const endF = Math.min(frames.length - 1, Math.ceil((offsetX + W) / ptW));
        const totalSlices = spectrogramData.length;
        const slicesPerFrame = totalSlices / frames.length;
        const bins = spectrogramData[0].length;
        const binH = H / bins;

        for (let i = startF; i <= endF; i++) {
            const cx = i * ptW - offsetX;
            const sIdx = Math.floor(i * slicesPerFrame);
            if (sIdx < 0 || sIdx >= totalSlices) continue;

            const row = spectrogramData[sIdx];
            for (let b = 0; b < bins; b++) {
                const v = row[b];
                if (v < 8) continue;
                const r = Math.min(255, v * 2.5);
                const g = Math.min(255, Math.max(0, v * 2 - 80));
                const bl = Math.min(255, Math.max(0, v * 2 - 180));
                ctx.fillStyle = `rgb(${r},${g},${bl})`;
                ctx.fillRect(cx, H - (b + 1) * binH, ptW + 0.5, binH + 0.5);
            }
        }

        // Playhead on spectrogram
        if (audioRef.current && activeFile.wavFile) {
            const dur = audioRef.current.duration || 1;
            const cfIdx = (currentTime / dur) * frames.length;
            const px = cfIdx * ptW - offsetX;
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px, 0); ctx.lineTo(px, H);
            ctx.stroke();
        }
    }, [activeFile, zoomX, offsetX, currentTime, spectrogramData]);

    useEffect(() => { drawSpectrogram(); }, [drawSpectrogram]);

    // ── Waveform mini-panel draw ────────────────
    const drawWaveform = useCallback(() => {
        const canvas = waveCanvasRef.current;
        const container = waveContainerRef.current;
        if (!canvas || !container || !waveformData) return;

        const W = container.clientWidth;
        const H = container.clientHeight;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;

        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#f0f4ff';
        ctx.fillRect(0, 0, W, H);

        // Draw full waveform (not frame-aligned, just pixel-aligned)
        const total = waveformData.length;
        const cy = H / 2;
        ctx.fillStyle = '#6ea8fe';
        for (let px = 0; px < W; px++) {
            const sFrom = Math.floor((px / W) * total);
            const sTo = Math.floor(((px + 1) / W) * total);
            let mn = 0, mx = 0;
            for (let s = sFrom; s < sTo && s < total; s++) {
                if (waveformData[s] < mn) mn = waveformData[s];
                if (waveformData[s] > mx) mx = waveformData[s];
            }
            const y1 = cy + mn * (H * 0.48);
            const y2 = cy + mx * (H * 0.48);
            ctx.fillRect(px, y1, 1, Math.max(1, y2 - y1));
        }

        // Playhead
        if (audioRef.current && activeFile?.wavFile) {
            const dur = audioRef.current.duration || 1;
            const px = (audioRef.current.currentTime / dur) * W;
            ctx.strokeStyle = '#e63946';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(px, 0); ctx.lineTo(px, H);
            ctx.stroke();
        }
    }, [waveformData, activeFile, currentTime]);

    useEffect(() => { drawWaveform(); }, [drawWaveform]);

    // ── Drawing interactions ───────────────────
    const getFrame = (clientX: number) => {
        const canvas = frqCanvasRef.current;
        if (!canvas || !activeFile) return -1;
        const rect = canvas.getBoundingClientRect();
        const ptW = Math.max(1, (canvas.width / activeFile.frqData.frames.length) * zoomX);
        return Math.round((clientX - rect.left + offsetX) / ptW);
    };

    const interpolate = (s: number, sf: number, e: number, ef: number, frames: FrqFrame[]) => {
        const lo = Math.min(s, e), hi = Math.max(s, e);
        const vLo = s < e ? sf : ef, vHi = s < e ? ef : sf;
        for (let i = lo; i <= hi; i++) {
            if (i < 0 || i >= frames.length) continue;
            const r = hi === lo ? 0 : (i - lo) / (hi - lo);
            frames[i].f0 = vLo + r * (vHi - vLo);
        }
    };

    const onPointerDown = (e: MouseEvent<HTMLCanvasElement>) => {
        if (!activeFile) return;
        if (e.button !== 0 && e.button !== 2) return;
        isDrawing.current = true;
        isRightDrag.current = e.button === 2;
        const idx = getFrame(e.clientX);
        if (idx >= 0 && idx < activeFile.frqData.frames.length) {
            const newFrames = [...activeFile.frqData.frames];
            if (isRightDrag.current) {
                newFrames[idx].f0 = 0;
                lastDrawPos.current = { x: idx, y: 0 };
            } else {
                const canvas = frqCanvasRef.current!;
                const rect = canvas.getBoundingClientRect();
                const f0 = f0FromY(e.clientY - rect.top, canvas.height);
                newFrames[idx].f0 = f0;
                lastDrawPos.current = { x: idx, y: f0 };
            }
            updateFrqData(activeFile.id, { ...activeFile.frqData, frames: newFrames });
        }
    };

    const onPointerMove = (e: MouseEvent<HTMLCanvasElement>) => {
        if (!isDrawing.current || !activeFile || !lastDrawPos.current) return;
        // Check if the right or left button is still held
        const leftHeld = (e.buttons & 1) !== 0;
        const rightHeld = (e.buttons & 2) !== 0;
        if (!leftHeld && !rightHeld) { isDrawing.current = false; return; }
        const erasing = isRightDrag.current;
        const idx = getFrame(e.clientX);
        if (idx >= 0 && idx < activeFile.frqData.frames.length) {
            const newFrames = [...activeFile.frqData.frames];
            if (erasing) {
                const lo = Math.min(lastDrawPos.current.x, idx);
                const hi = Math.max(lastDrawPos.current.x, idx);
                for (let i = lo; i <= hi; i++) {
                    if (i >= 0 && i < newFrames.length) newFrames[i].f0 = 0;
                }
                lastDrawPos.current = { x: idx, y: 0 };
            } else {
                const canvas = frqCanvasRef.current!;
                const rect = canvas.getBoundingClientRect();
                const f0 = f0FromY(e.clientY - rect.top, canvas.height);
                interpolate(lastDrawPos.current.x, lastDrawPos.current.y, idx, f0, newFrames);
                lastDrawPos.current = { x: idx, y: f0 };
            }
            updateFrqData(activeFile.id, { ...activeFile.frqData, frames: newFrames });
        }
    };

    const onPointerUp = () => { isDrawing.current = false; lastDrawPos.current = null; };

    const onWheel = (e: React.WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            setZoomX((z: number) => Math.max(0.5, z - e.deltaY * 0.008));
        } else if (e.shiftKey) {
            setOffsetX((o: number) => Math.max(0, o + e.deltaY));
        }
    };

    // ── Empty state ────────────────────────────
    if (!activeFile) {
        return (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: '16px' }}>
                사이드바에서 편집할 파일을 선택하세요
            </div>
        );
    }

    // ── WAV-only / no-F0 guidance state ────────
    const hasF0 = activeFile.frqData.frames.length > 0 && activeFile.frqData.frames.some(f => f.f0 > 0);
    if (!hasF0) {
        return (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#888', background: '#fafafa' }}>
                <div style={{ fontSize: '40px' }}>🎵</div>
                <div style={{ fontSize: '15px', fontWeight: 600, color: '#555' }}>
                    {activeFile.name}
                </div>
                <div style={{ fontSize: '13px', color: '#999', textAlign: 'center', maxWidth: 380, lineHeight: 1.7 }}>
                    WAV 파일만 불러왔거나 FRQ 데이터가 없습니다.<br />
                    편집할 <strong>.frq</strong> 파일을 불러오거나,<br />
                    툴바의 <strong>🔮 자체 F0 생성</strong> 버튼을 눌러 그래프를 생성하세요.
                </div>
                {activeFile.wavFile && (
                    <div style={{ fontSize: '12px', background: '#e7f5ff', color: '#1971c2', padding: '6px 14px', borderRadius: '6px' }}>
                        🎵 {activeFile.wavFile.name} 연결됨 — 자체 F0 생성 가능
                    </div>
                )}
            </div>
        );
    }

    // ── Render ─────────────────────────────────
    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>

            {/* ─── Info bar ─────────────────────── */}
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderBottom: '1px solid #ddd', background: '#f5f5f5', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '13px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeFile.name}
                </strong>
                {activeFile.expectedF0 && (
                    <span style={{ fontSize: '11px', background: '#e9ecef', padding: '1px 6px', borderRadius: 3 }}>
                        {Math.round(activeFile.expectedF0)} Hz
                    </span>
                )}
                {activeFile.wavFile ? (
                    <span style={{ fontSize: '11px', background: '#cff4fc', color: '#055160', padding: '1px 6px', borderRadius: 3 }}>
                        🎵 WAV 연결됨 · 스페이스바로 재생
                    </span>
                ) : (
                    <span style={{ fontSize: '11px', color: '#999' }}>
                        WAV 미연결
                    </span>
                )}
                <div style={{ flex: 1 }} />
                <button
                    onClick={() => {
                        if (!activeFile) return;
                        if (!window.confirm('불러온 초기 상태로 되돌릴까요?\n수정 내역이 모두 사라집니다.')) return;
                        resetFrqData(activeFile.id);
                    }}
                    style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid #f2a20a', borderRadius: 3, background: '#fff8e1', cursor: 'pointer', color: '#7c5600' }}
                    title="불러온 초기 상태로 초기화"
                >🔄 초기화</button>
                <button
                    onClick={() => undo(activeFile.id)}
                    disabled={activeFile.history.length === 0}
                    style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid #ccc', borderRadius: 3, background: '#fff', cursor: activeFile.history.length ? 'pointer' : 'default', color: activeFile.history.length ? '#333' : '#bbb' }}
                    title="실행 취소 (Ctrl+Z)"
                >↩ 취소</button>
                <button
                    onClick={() => redo(activeFile.id)}
                    disabled={activeFile.redoStack.length === 0}
                    style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid #ccc', borderRadius: 3, background: '#fff', cursor: activeFile.redoStack.length ? 'pointer' : 'default', color: activeFile.redoStack.length ? '#333' : '#bbb' }}
                    title="다시 실행 (Ctrl+Y)"
                >↪ 다시</button>
                <span style={{ fontSize: '11px', color: '#bbb' }}>좌클릭: 그리기 · 우클릭: 지우기 · Ctrl+휠: 확대 · Shift+휠: 이동</span>
            </div>

            {/* ─── Waveform overview panel ─────────────── */}
            <div
                ref={waveContainerRef}
                style={{ flexShrink: 0, height: '65px', position: 'relative', overflow: 'hidden', background: '#f0f4ff', borderBottom: '1px solid #d0d9f0' }}
            >
                {waveformData
                    ? <canvas ref={waveCanvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
                    : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aab', fontSize: 11 }}>
                            {activeFile.wavFile ? '파형 분석 중…' : 'WAV 파일을 불러오면 파형이 표시됩니다'}
                        </div>
                    )
                }
            </div>

            {/* ─── FRQ editor canvas (fills remaining space) ── */}
            <div
                ref={frqContainerRef}
                style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: 'crosshair', minHeight: 0 }}
                onWheel={onWheel}
            >
                <canvas
                    ref={frqCanvasRef}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerLeave={onPointerUp}
                    onContextMenu={e => e.preventDefault()}  // prevent right-click menu
                />
            </div>

            {/* ─── Spectrogram ────────────────────────────── */}
            <div
                ref={spgContainerRef}
                style={{ flexShrink: 0, height: '130px', position: 'relative', overflow: 'hidden', background: '#111' }}
                onWheel={onWheel}
            >
                <canvas ref={spgCanvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
                {!activeFile.wavFile && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 12 }}>
                        WAV 파일을 불러오면 멜 스펙트로그램이 표시됩니다
                    </div>
                )}
                {activeFile.wavFile && !spectrogramData && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 12 }}>
                        스펙트로그램 분석 중...
                    </div>
                )}
            </div>
        </div >
    );
};

export default Editor;
