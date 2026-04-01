import { useRef, useEffect, useState, useCallback, useMemo, type MouseEvent } from 'react';
import { useFrqContext } from './FrqContext';
import { useLanguage } from './LanguageContext';
import Meyda from 'meyda';
import {
    LLSM_EXPERIMENTAL_INPUT_LIMITS,
    sanitizeLlsmExperimentalSettingsForPatch,
    type FrqFrame,
    type LlsmExperimentalSettings,
    type LlsmVoicingMode,
} from '../lib/frq';
import { autoCorrectFrq } from '../lib/frqAutoCorrect';
import { createApproxPreviewWav, type ApproxPreviewDebugInfo } from '../lib/approxPreview';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
const MIN_FREQ = 50;
const VISUAL_MAX_FREQ = 2400;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NATURAL_NOTES = new Set([0, 2, 4, 5, 7, 9, 11]);
const TARGET_NOTE_MIN_MIDI = 36; // C2
const TARGET_NOTE_MAX_MIDI = 96; // C7
type SpectrogramQuality = 'low' | 'default' | 'high';
const SPECTROGRAM_CONFIG: Record<SpectrogramQuality, { bufferSize: number; hopSize: number; visibleBins: number; gain: number }> = {
    low: { bufferSize: 1024, hopSize: 512, visibleBins: 72, gain: 28 },
    default: { bufferSize: 2048, hopSize: 256, visibleBins: 120, gain: 32 },
    high: { bufferSize: 4096, hopSize: 128, visibleBins: 192, gain: 36 },
};
const EXPERIMENTAL_LIMITS = LLSM_EXPERIMENTAL_INPUT_LIMITS;

const LOG_MIN_FREQ = Math.log(MIN_FREQ);
const LOG_VISUAL_MAX_FREQ = Math.log(VISUAL_MAX_FREQ);
const LOG_VISUAL_FREQ_RANGE = LOG_VISUAL_MAX_FREQ - LOG_MIN_FREQ;

const canvasY = (f0: number, h: number) => {
    if (f0 <= 0) return h;
    const clamped = Math.max(MIN_FREQ, Math.min(VISUAL_MAX_FREQ, f0));
    const normalized = (Math.log(clamped) - LOG_MIN_FREQ) / LOG_VISUAL_FREQ_RANGE;
    return Math.max(0, Math.min(h - normalized * h, h));
};

const f0FromY = (y: number, h: number) => {
    const normalized = Math.max(0, Math.min(1, (h - y) / h));
    return Math.exp(LOG_MIN_FREQ + normalized * LOG_VISUAL_FREQ_RANGE);
};

const remapSpectrumRowToVisibleBins = (
    row: Float32Array | number[],
    visibleBins: number,
    sampleRate: number,
    bufferSize: number,
    gain: number,
) => {
    const remapped = new Uint8Array(visibleBins);
    const maxIndex = Math.max(1, row.length - 1);
    const nyquist = sampleRate / 2;

    for (let i = 0; i < visibleBins; i++) {
        const ratio = i / Math.max(1, visibleBins - 1);
        const freq = MIN_FREQ * Math.pow(VISUAL_MAX_FREQ / MIN_FREQ, ratio);
        const sourceIndex = Math.min(
            maxIndex,
            Math.max(0, (freq / nyquist) * (bufferSize / 2)),
        );
        const leftIndex = Math.floor(sourceIndex);
        const rightIndex = Math.min(maxIndex, leftIndex + 1);
        const blend = sourceIndex - leftIndex;
        const leftValue = row[leftIndex] ?? 0;
        const rightValue = row[rightIndex] ?? leftValue;
        const interpolated = leftValue + (rightValue - leftValue) * blend;
        remapped[i] = Math.min(255, Math.max(0, Math.log10(1 + interpolated * gain) * 105));
    }

    return remapped;
};

const formatPitch = (f0: number) => {
    if (!Number.isFinite(f0) || f0 <= 0) return null;

    const midi = 69 + 12 * Math.log2(f0 / 440);
    const roundedMidi = Math.round(midi);
    const cents = Math.round((midi - roundedMidi) * 100);
    const noteName = NOTE_NAMES[(roundedMidi % 12 + 12) % 12];
    const octave = Math.floor(roundedMidi / 12) - 1;
    const snappedHz = 440 * Math.pow(2, (roundedMidi - 69) / 12);

    return {
        note: `${noteName}${octave}`,
        cents: `${cents > 0 ? '+' : ''}${cents}c`,
        snappedHz,
        hz: `${f0.toFixed(1)} Hz`,
    };
};

const midiToNoteLabel = (midi: number) => {
    const noteName = NOTE_NAMES[(midi % 12 + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${noteName}${octave}`;
};

const TARGET_NOTE_OPTIONS = Array.from(
    { length: TARGET_NOTE_MAX_MIDI - TARGET_NOTE_MIN_MIDI + 1 },
    (_, i) => {
        const midi = TARGET_NOTE_MIN_MIDI + i;
        const hz = 440 * Math.pow(2, (midi - 69) / 12);
        return {
            midi,
            label: `${midiToNoteLabel(midi)} (${hz.toFixed(1)}Hz)`,
        };
    },
);

const getMedianVoicedF0 = (frames: FrqFrame[]) => {
    const voiced = frames
        .map(frame => frame.f0)
        .filter(f0 => Number.isFinite(f0) && f0 > 1)
        .sort((a, b) => a - b);
    if (voiced.length === 0) return null;
    return voiced[Math.floor(voiced.length / 2)];
};

const getMeanVoicedF0 = (frames: FrqFrame[]) => {
    const voiced = frames
        .map(frame => frame.f0)
        .filter(f0 => Number.isFinite(f0) && f0 > 1);
    if (voiced.length === 0) return null;
    const sum = voiced.reduce((acc, f0) => acc + f0, 0);
    return sum / voiced.length;
};

const shiftCurveToTargetMidi = (
    frames: FrqFrame[],
    targetMidi: number,
    referenceMode: 'median' | 'mean',
) => {
    const sourceF0 = referenceMode === 'mean'
        ? getMeanVoicedF0(frames)
        : getMedianVoicedF0(frames);
    if (!sourceF0) return null;
    const sourceMidi = 69 + 12 * Math.log2(sourceF0 / 440);
    const semitoneDelta = targetMidi - sourceMidi;
    const ratio = Math.pow(2, semitoneDelta / 12);
    const shifted = frames.map(frame => {
        if (!Number.isFinite(frame.f0) || frame.f0 <= 1) return frame;
        return { ...frame, f0: Math.max(1, frame.f0 * ratio) };
    });
    return {
        frames: shifted,
        semitoneDelta,
    };
};

const computeApproxPreviewRate = (
    editedFrames: FrqFrame[],
    originalFrames: FrqFrame[],
) => {
    const count = Math.min(editedFrames.length, originalFrames.length);
    if (count === 0) return 1;

    const ratios: number[] = [];
    for (let i = 0; i < count; i++) {
        const edited = editedFrames[i]?.f0 ?? 0;
        const original = originalFrames[i]?.f0 ?? 0;
        if (!Number.isFinite(edited) || !Number.isFinite(original)) continue;
        if (edited <= 1 || original <= 1) continue;
        const ratio = edited / original;
        if (Number.isFinite(ratio) && ratio > 0.25 && ratio < 4) {
            ratios.push(ratio);
        }
    }

    if (ratios.length < 8) return 1;
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    return Math.max(0.5, Math.min(2, median));
};

const hashFrames = (frames: FrqFrame[]) => {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < frames.length; i++) {
        const f0 = frames[i]?.f0 ?? 0;
        const quantized = f0 > 1 && Number.isFinite(f0)
            ? Math.round(1200 * Math.log2(f0 / 440))
            : -32768;
        hash = Math.imul(hash ^ (quantized & 0xffff), 16777619) >>> 0;
    }
    return hash.toString(16);
};

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────
const Editor = () => {
    const { files, activeFileId, updateFrqData, updateLlsmExperimental, updateLlsmVoicingMode, resetFrqData, undo, redo } = useFrqContext();
    const { t } = useLanguage();
    const activeFile = files.find(f => f.id === activeFileId);
    const activeFileRef = useRef(activeFile);
    useEffect(() => {
        activeFileRef.current = activeFile;
    }, [activeFile]);

    // ── Canvas refs ────────────────────────────
    const frqCanvasRef = useRef<HTMLCanvasElement>(null);
    const frqContainerRef = useRef<HTMLDivElement>(null);
    const waveCanvasRef = useRef<HTMLCanvasElement>(null);
    const waveContainerRef = useRef<HTMLDivElement>(null);
    const spgCanvasRef = useRef<HTMLCanvasElement>(null);

    // ── View state ─────────────────────────────
    const [zoomX, setZoomX] = useState(1);
    const [offsetX, setOffsetX] = useState(0);

    // ── Drawing state ──────────────────────────
    const isDrawing = useRef(false);
    const isRightDrag = useRef(false); // true = erasing
    const lastDrawPos = useRef<{ x: number; y: number } | null>(null);
    const dragStartFrqRef = useRef<import('../lib/frq').FrqData | null>(null);
    const dragDraftFrqRef = useRef<import('../lib/frq').FrqData | null>(null);

    // ── Audio state ────────────────────────────
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const animFrameRef = useRef<number | null>(null);
    const originalAudioUrlRef = useRef<string | null>(null);
    const previewAudioRef = useRef<{ key: string; url: string } | null>(null);
    const [hoverPitch, setHoverPitch] = useState<number | null>(null);
    const [showSpectrogram, setShowSpectrogram] = useState(true);
    const [globalSpectrogramQuality, setGlobalSpectrogramQuality] = useState<SpectrogramQuality>('low');
    const [fileSpectrogramQualities, setFileSpectrogramQualities] = useState<Record<string, SpectrogramQuality>>({});
    const [editorTab, setEditorTab] = useState<'pitch' | 'experimental'>('pitch');
    const [llsmNumericInputs, setLlsmNumericInputs] = useState<{ _9: string; _a: string; _b: string }>({
        _9: '',
        _a: '',
        _b: '',
    });
    const [llsm13Input, setLlsm13Input] = useState<string>('');
    const [targetShiftMidi, setTargetShiftMidi] = useState<number>(69);
    const [shiftReferenceMode, setShiftReferenceMode] = useState<'median' | 'mean'>('median');

    // Storing decoded audio as STATE so renders are triggered
    const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
    const [waveformSampleRate, setWaveformSampleRate] = useState<number | null>(null);
    const [spectrogramData, setSpectrogramData] = useState<Uint8Array[] | null>(null);
    const [isPreparingPreviewAudio, setIsPreparingPreviewAudio] = useState(false);
    const [previewDebug, setPreviewDebug] = useState<ApproxPreviewDebugInfo | null>(null);
    const activeSpectrogramQuality = activeFile
        ? (fileSpectrogramQualities[activeFile.id] ?? globalSpectrogramQuality)
        : globalSpectrogramQuality;
    const approxPreviewRate = useMemo(() => {
        if (!activeFile) return 1;
        return computeApproxPreviewRate(activeFile.frqData.frames, activeFile.originalFrqData.frames);
    }, [activeFile]);
    const approxPreviewText = useMemo(() => {
        const semitones = 12 * Math.log2(approxPreviewRate);
        const sign = semitones >= 0 ? '+' : '';
        return `${approxPreviewRate.toFixed(3)}x (${sign}${semitones.toFixed(2)} st)`;
    }, [approxPreviewRate]);
    const editedPitchHash = useMemo(
        () => hashFrames(activeFile?.frqData.frames ?? []),
        [activeFile?.frqData.frames],
    );
    const originalPitchHash = useMemo(
        () => hashFrames(activeFile?.originalFrqData.frames ?? []),
        [activeFile?.originalFrqData.frames],
    );
    const hasPitchPreviewDiff = editedPitchHash !== originalPitchHash;
    const applyAutoCorrectToFiles = useCallback((entries: typeof files) => {
        for (const entry of entries) {
            if (!entry.frqData.frames.length) continue;
            const corrected = autoCorrectFrq(entry.frqData.frames);
            updateFrqData(entry.id, { ...entry.frqData, frames: corrected });
        }
    }, [updateFrqData]);
    const applyShiftToFiles = useCallback((
        entries: typeof files,
        targetMidi: number,
        referenceMode: 'median' | 'mean',
    ) => {
        let changedCount = 0;
        for (const entry of entries) {
            if (!entry.frqData.frames.length) continue;
            const shifted = shiftCurveToTargetMidi(entry.frqData.frames, targetMidi, referenceMode);
            if (!shifted) continue;
            updateFrqData(entry.id, { ...entry.frqData, frames: shifted.frames });
            changedCount += 1;
        }
        if (changedCount === 0) {
            window.alert(t('pitchShiftNoVoiced'));
        }
    }, [t, updateFrqData]);
    const attachAudio = useCallback((url: string) => {
        if (audioRef.current) {
            audioRef.current.pause();
        }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.addEventListener('ended', () => {
            setIsPlaying(false);
            setCurrentTime(0);
        });
    }, []);

    // ── Reset on file change ───────────────────
    useEffect(() => {
        setZoomX(1);
        setOffsetX(0);
        setCurrentTime(0);
        setIsPlaying(false);
        setWaveformData(null);
        setWaveformSampleRate(null);
        setSpectrogramData(null);
        setHoverPitch(null);
        setPreviewDebug(null);
        dragStartFrqRef.current = null;
        dragDraftFrqRef.current = null;
        setEditorTab('pitch');
        setLlsmNumericInputs({ _9: '', _a: '', _b: '' });

        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
        if (originalAudioUrlRef.current) {
            URL.revokeObjectURL(originalAudioUrlRef.current);
            originalAudioUrlRef.current = null;
        }
        if (previewAudioRef.current) {
            URL.revokeObjectURL(previewAudioRef.current.url);
            previewAudioRef.current = null;
        }

        if (activeFile?.wavFile) {
            const url = URL.createObjectURL(activeFile.wavFile);
            originalAudioUrlRef.current = url;
            attachAudio(url);

            // Decode audio data for visualization
            activeFile.wavFile.arrayBuffer().then(async rawBuffer => {
                try {
                    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
                        audioCtxRef.current = new AudioContext();
                    }
                    const decoded = await audioCtxRef.current.decodeAudioData(rawBuffer);

                    // Store waveform PCM as STATE so render is triggered
                    setWaveformData(decoded.getChannelData(0).slice());
                    setWaveformSampleRate(decoded.sampleRate);
                } catch (err) {
                    console.error('Audio decode failed:', err);
                }
            }).catch(err => console.error('File read failed:', err));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeFileId, attachAudio]);

    useEffect(() => {
        if (!activeFile || activeFile.sourceType !== 'llsm') {
            setLlsmNumericInputs({ _9: '', _a: '', _b: '' });
            setLlsm13Input('');
            return;
        }
        const current = activeFile.llsmExperimental;
        if (current) {
            setLlsmNumericInputs({
                _9: Number(current._9.toFixed(6)).toString(),
                _a: Number(current._a.toFixed(6)).toString(),
                _b: Number(current._b.toFixed(6)).toString(),
            });
        }
        const values = activeFile.llsmExperimental?._13 ?? [];
        setLlsm13Input(values.map(v => Number(v.toFixed(6))).join(', '));
    }, [
        activeFile?.id,
        activeFile?.sourceType,
        activeFile?.llsmExperimental?._9,
        activeFile?.llsmExperimental?._a,
        activeFile?.llsmExperimental?._b,
        activeFile?.llsmExperimental?._13,
    ]);

    useEffect(() => {
        setFileSpectrogramQualities(prev => {
            const validIds = new Set(files.map(file => file.id));
            const next = Object.fromEntries(
                Object.entries(prev).filter(([id]) => validIds.has(id)),
            ) as Record<string, SpectrogramQuality>;
            return Object.keys(next).length === Object.keys(prev).length ? prev : next;
        });
    }, [files]);

    useEffect(() => {
        if (!showSpectrogram || !waveformData || !waveformSampleRate || !activeFile?.wavFile) {
            setSpectrogramData(null);
            return;
        }

        let cancelled = false;
        setSpectrogramData(null);

        const config = SPECTROGRAM_CONFIG[activeSpectrogramQuality];
        const previousConfig = {
            bufferSize: Meyda.bufferSize,
            sampleRate: Meyda.sampleRate,
        };

        const buildSpectrogram = async () => {
            try {
                Meyda.bufferSize = config.bufferSize;
                Meyda.sampleRate = waveformSampleRate;

                const bands: Uint8Array[] = [];
                for (let i = 0; i < waveformData.length; i += config.hopSize) {
                    if (cancelled) return;

                    let slice: Float32Array;
                    if (i + config.bufferSize <= waveformData.length) {
                        slice = waveformData.subarray(i, i + config.bufferSize);
                    } else {
                        slice = new Float32Array(config.bufferSize);
                        slice.set(waveformData.subarray(i));
                    }

                    const result = Meyda.extract('amplitudeSpectrum', slice) as Float32Array | null;
                    if (!result) continue;

                    bands.push(
                        remapSpectrumRowToVisibleBins(
                            result,
                            config.visibleBins,
                            waveformSampleRate,
                            config.bufferSize,
                            config.gain,
                        ),
                    );

                    if (bands.length % 120 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }

                if (!cancelled) setSpectrogramData(bands);
            } catch (err) {
                if (!cancelled) console.error('Spectrogram analyze failed:', err);
            } finally {
                Meyda.bufferSize = previousConfig.bufferSize;
                Meyda.sampleRate = previousConfig.sampleRate;
            }
        };

        buildSpectrogram();
        return () => { cancelled = true; };
    }, [activeFile?.id, activeFile?.wavFile, activeSpectrogramQuality, waveformData, waveformSampleRate, showSpectrogram]);

    const togglePlayback = useCallback(() => {
        const liveFile = activeFileRef.current;
        if (!audioRef.current || !liveFile?.wavFile) return;
        if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();

        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
            return;
        }

        const startPlayback = async () => {
            let playUrl = originalAudioUrlRef.current;
            const useApprox = liveFile.isModified || hasPitchPreviewDiff;

            if (useApprox && waveformData && waveformSampleRate) {
                setIsPreparingPreviewAudio(true);
                try {
                    const preview = createApproxPreviewWav(
                        waveformData,
                        waveformSampleRate,
                        liveFile.frqData.frames,
                        liveFile.originalFrqData.frames,
                        liveFile.frqData.windowInterval,
                        liveFile.expectedF0,
                        liveFile.frqData.samplesPerWindow,
                    );
                    const previewUrl = URL.createObjectURL(preview.blob);
                    if (previewAudioRef.current) {
                        URL.revokeObjectURL(previewAudioRef.current.url);
                    }
                    previewAudioRef.current = { key: `${liveFile.id}:${Date.now()}`, url: previewUrl };
                    setPreviewDebug(preview.debug);
                } finally {
                    setIsPreparingPreviewAudio(false);
                }
                playUrl = previewAudioRef.current?.url ?? playUrl;
            } else {
                setPreviewDebug(null);
            }

            if (!playUrl) return;
            if (!audioRef.current || audioRef.current.src !== playUrl) {
                attachAudio(playUrl);
            }
            if (!audioRef.current) return;
            audioRef.current.currentTime = currentTime;
            audioRef.current.playbackRate = 1;
            await audioRef.current.play();
            setIsPlaying(true);
        };

        startPlayback().catch(err => {
            setIsPreparingPreviewAudio(false);
            console.error('Playback start failed:', err);
        });
    }, [
        activeFileId,
        approxPreviewRate,
        attachAudio,
        currentTime,
        hasPitchPreviewDiff,
        isPlaying,
        waveformData,
        waveformSampleRate,
    ]);

    // ── Keyboard shortcuts ─────────────────────
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!activeFile) return;

            if (e.code === 'Space' && e.target === document.body) {
                e.preventDefault();
                togglePlayback();
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
    }, [activeFile, togglePlayback, undo, redo]);

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
        for (let f = Math.ceil(MIN_FREQ / 100) * 100; f <= VISUAL_MAX_FREQ; f += 100) {
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

        const snapGuide = formatPitch(hoverPitch ?? 0);
        if (snapGuide) {
            const guideY = canvasY(snapGuide.snappedHz, H);
            const guideLabel = `Snap ${snapGuide.note} ${snapGuide.cents}`;

            ctx.strokeStyle = 'rgba(255,193,7,0.95)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(0, guideY);
            ctx.lineTo(W, guideY);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.save();
            ctx.font = '11px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
            const textWidth = ctx.measureText(guideLabel).width;
            const labelY = Math.max(12, Math.min(H - 6, guideY - 6));
            ctx.fillStyle = 'rgba(32,24,0,0.78)';
            ctx.fillRect(8, labelY - 10, textWidth + 10, 16);
            ctx.fillStyle = '#ffd43b';
            ctx.textAlign = 'left';
            ctx.fillText(guideLabel, 13, labelY + 2);
            ctx.restore();
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
        void NOTE_KO;
        void FLAT_KO;
        void CHROMATIC;

        ctx.save();
        ctx.font = '10px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
        for (let midi = 24; midi <= 108; midi++) {
            const hz = 440 * Math.pow(2, (midi - 69) / 12);
            if (hz > VISUAL_MAX_FREQ) break;
            const y = canvasY(hz, H);
            if (y < 0 || y > H) continue;

            const noteIdx = midi % 12;
            const octave = Math.floor(midi / 12) - 1;
            const isNatural = NATURAL_NOTES.has(noteIdx);
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
                const label = `${NOTE_NAMES[noteIdx]}${octave}`;

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
    }, [activeFile, zoomX, offsetX, currentTime, waveformData, hoverPitch]);

    useEffect(() => { drawFrq(); }, [drawFrq]);

    // ── Spectrogram draw ───────────────────────
    const drawSpectrogram = useCallback(() => {
        const canvas = spgCanvasRef.current;
        const container = frqContainerRef.current;
        if (!canvas || !container) return;

        const W = container.clientWidth;
        const H = container.clientHeight;
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;

        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#787878';
        ctx.fillRect(0, 0, W, H);

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
            const sliceStart = Math.max(0, Math.floor(i * slicesPerFrame));
            const sliceEnd = Math.min(totalSlices, Math.max(sliceStart + 1, Math.ceil((i + 1) * slicesPerFrame)));
            if (sliceStart >= totalSlices) continue;

            const row = new Uint8Array(bins);
            for (let s = sliceStart; s < sliceEnd; s++) {
                const sourceRow = spectrogramData[s];
                for (let b = 0; b < bins; b++) {
                    if (sourceRow[b] > row[b]) row[b] = sourceRow[b];
                }
            }

            for (let b = 0; b < bins; b++) {
                const v = row[b];
                if (v < 6) continue;
                const r = Math.min(255, 40 + v * 1.35);
                const g = Math.min(255, Math.max(0, 20 + v * 1.1));
                const bl = Math.min(255, Math.max(0, 50 + v * 2.1));
                const alpha = Math.min(0.96, 0.2 + v / 320);
                ctx.fillStyle = `rgba(${r},${g},${bl},${alpha})`;
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

    const finishDrawingSession = () => {
        if (activeFile && dragStartFrqRef.current && dragDraftFrqRef.current) {
            updateFrqData(activeFile.id, dragDraftFrqRef.current, {
                historyBase: dragStartFrqRef.current,
            });
        }
        isDrawing.current = false;
        isRightDrag.current = false;
        lastDrawPos.current = null;
        dragStartFrqRef.current = null;
        dragDraftFrqRef.current = null;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!activeFile) return;
        if (e.button !== 0 && e.button !== 2) return;
        isDrawing.current = true;
        isRightDrag.current = e.button === 2;
        const idx = getFrame(e.clientX);
        if (idx >= 0 && idx < activeFile.frqData.frames.length) {
            // Deep copy so history entries are not mutated by subsequent edits
            const newFrames = activeFile.frqData.frames.map(f => ({ ...f }));
            dragStartFrqRef.current = activeFile.frqData;
            if (isRightDrag.current) {
                // Capture the pointer so erase continues even if mouse leaves canvas
                e.currentTarget.setPointerCapture(e.pointerId);
                newFrames[idx].f0 = 0;
                lastDrawPos.current = { x: idx, y: 0 };
            } else {
                const canvas = frqCanvasRef.current!;
                const rect = canvas.getBoundingClientRect();
                const f0 = f0FromY(e.clientY - rect.top, canvas.height);
                setHoverPitch(f0);
                newFrames[idx].f0 = f0;
                lastDrawPos.current = { x: idx, y: f0 };
            }
            const draftFrqData = { ...activeFile.frqData, frames: newFrames };
            dragDraftFrqRef.current = draftFrqData;
            updateFrqData(activeFile.id, draftFrqData, { pushHistory: false });
        }
    };

    const onPointerMove = (e: MouseEvent<HTMLCanvasElement>) => {
        const canvas = frqCanvasRef.current;
        if (canvas) {
            const rect = canvas.getBoundingClientRect();
            setHoverPitch(f0FromY(e.clientY - rect.top, canvas.height));
        }

        if (!isDrawing.current || !activeFile || !lastDrawPos.current) return;
        // Check if the right or left button is still held
        const leftHeld = (e.buttons & 1) !== 0;
        const rightHeld = (e.buttons & 2) !== 0;
        if (!leftHeld && !rightHeld) {
            finishDrawingSession();
            return;
        }
        const erasing = isRightDrag.current;
        const idx = getFrame(e.clientX);
        if (idx >= 0 && idx < activeFile.frqData.frames.length) {
            // Deep copy so history entries are not mutated by subsequent edits
            const newFrames = activeFile.frqData.frames.map(f => ({ ...f }));
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
            const draftFrqData = { ...activeFile.frqData, frames: newFrames };
            dragDraftFrqRef.current = draftFrqData;
            updateFrqData(activeFile.id, draftFrqData, { pushHistory: false });
        }
    };

    const onPointerUp = () => { finishDrawingSession(); };
    // Only stop left-click drawing on leave; right-click erase is handled by pointer capture
    const onPointerLeave = () => {
        setHoverPitch(null);
        if (!isRightDrag.current) finishDrawingSession();
    };

    const onWheel = (e: React.WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            setZoomX((z: number) => Math.max(0.5, z - e.deltaY * 0.008));
        } else if (e.shiftKey) {
            setOffsetX((o: number) => Math.max(0, o + e.deltaY));
        }
    };

    const updateExperimentalField = (field: '_9' | '_a' | '_b', value: number) => {
        if (!activeFile || activeFile.sourceType !== 'llsm' || !activeFile.llsmExperimental) return;
        const limits = EXPERIMENTAL_LIMITS[field];
        if (value < limits.min || value > limits.max) {
            window.alert(t('experimentalUnsafe'));
            return;
        }
        const current = activeFile.llsmExperimental;
        const baseline = activeFile.originalLlsmExperimental ?? current;
        const next: LlsmExperimentalSettings = {
            ...current,
            [field]: value,
        };
        const sanitized = sanitizeLlsmExperimentalSettingsForPatch(next, baseline);
        if (!sanitized) {
            window.alert(t('experimentalUnsafe'));
            return;
        }
        updateLlsmExperimental(activeFile.id, sanitized);
    };

    const applyExperimentalNumericField = (field: '_9' | '_a' | '_b') => {
        if (!activeFile || activeFile.sourceType !== 'llsm' || !activeFile.llsmExperimental) return;
        const raw = llsmNumericInputs[field].trim();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            window.alert(t('experimentalUnsafe'));
            setLlsmNumericInputs(prev => ({
                ...prev,
                [field]: Number(activeFile.llsmExperimental![field].toFixed(6)).toString(),
            }));
            return;
        }
        updateExperimentalField(field, parsed);
    };

    const applyExperimental13 = () => {
        if (!activeFile || activeFile.sourceType !== 'llsm' || !activeFile.llsmExperimental) return;
        const baseline = activeFile.originalLlsmExperimental ?? activeFile.llsmExperimental;
        const parsed = llsm13Input
            .split(',')
            .map(v => Number(v.trim()))
            .filter(v => Number.isFinite(v));
        for (let i = 0; i < parsed.length; i++) {
            const limits = EXPERIMENTAL_LIMITS._13[i] ?? EXPERIMENTAL_LIMITS._13Fallback;
            if (parsed[i] < limits.min || parsed[i] > limits.max) {
                window.alert(t('experimentalUnsafe'));
                setLlsm13Input(activeFile.llsmExperimental._13.map(v => Number(v.toFixed(6))).join(', '));
                return;
            }
        }
        const sanitized = sanitizeLlsmExperimentalSettingsForPatch({
            ...activeFile.llsmExperimental,
            _13: parsed,
            _12: parsed.length + 1,
        }, baseline);
        if (!sanitized) {
            window.alert(t('experimentalUnsafe'));
            setLlsm13Input(activeFile.llsmExperimental._13.map(v => Number(v.toFixed(6))).join(', '));
            return;
        }
        updateLlsmExperimental(activeFile.id, sanitized);
    };

    // ── Empty state ────────────────────────────
    if (!activeFile) {
        return (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', fontSize: '16px' }}>
                사이드바에서 편집할 파일을 선택하세요
            </div>
        );
    }

    // ── WAV-only guidance state ─────────────────
    // Only show guidance when no FRQ has ever been loaded (pure wav-only placeholder).
    // If a user manually erases all F0 data from a real FRQ, keep the editor open so
    // they can continue drawing.
    const isWavOnly = activeFile.sourceType === 'wav-only' &&
        activeFile.frqData.frames.length === 0;
    const expectedPitchInfo = formatPitch(activeFile.expectedF0 ?? 0);
    const hoverPitchInfo = formatPitch(hoverPitch ?? 0);
    const isLlsmFile = activeFile.sourceType === 'llsm';
    const llsmExperimental = activeFile.llsmExperimental ?? null;
    const llsmVoicingMode: LlsmVoicingMode = activeFile.llsmVoicingMode ?? 'preserve';
    if (isWavOnly) {
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
                {isLlsmFile && (
                    <span style={{ display: 'inline-flex', border: '1px solid #ced4da', borderRadius: 6, overflow: 'hidden', marginRight: 4 }}>
                        <button
                            onClick={() => setEditorTab('pitch')}
                            style={{
                                border: 'none',
                                borderRight: '1px solid #ced4da',
                                background: editorTab === 'pitch' ? '#0d6efd' : '#fff',
                                color: editorTab === 'pitch' ? '#fff' : '#495057',
                                padding: '2px 8px',
                                fontSize: 11,
                                cursor: 'pointer',
                                fontWeight: 600,
                            }}
                        >
                            {t('pitchTab')}
                        </button>
                        <button
                            onClick={() => setEditorTab('experimental')}
                            style={{
                                border: 'none',
                                background: editorTab === 'experimental' ? '#7c3aed' : '#fff',
                                color: editorTab === 'experimental' ? '#fff' : '#495057',
                                padding: '2px 8px',
                                fontSize: 11,
                                cursor: 'pointer',
                                fontWeight: 600,
                            }}
                        >
                            {t('experimentalTab')}
                        </button>
                    </span>
                )}
                {(editorTab === 'pitch' || !isLlsmFile) && activeFile.expectedF0 && (
                    <span style={{ fontSize: '11px', background: '#e9ecef', padding: '1px 6px', borderRadius: 3 }}>
                        {expectedPitchInfo ? `${expectedPitchInfo.note} ${Math.round(activeFile.expectedF0)} Hz` : `${Math.round(activeFile.expectedF0)} Hz`}
                    </span>
                )}
                {(editorTab === 'pitch' || !isLlsmFile) && hoverPitchInfo && (
                    <span style={{ fontSize: '11px', background: '#fff3bf', color: '#5f3b00', padding: '1px 6px', borderRadius: 3 }}>
                        {hoverPitchInfo.note} {hoverPitchInfo.cents} {hoverPitchInfo.hz}
                    </span>
                )}
                {activeFile.wavFile ? (
                    <span style={{ fontSize: '11px', background: '#cff4fc', color: '#055160', padding: '1px 6px', borderRadius: 3 }}>
                        {t('wavConnected')}
                    </span>
                ) : (
                    <span style={{ fontSize: '11px', color: '#999' }}>
                        {t('wavMissing')}
                    </span>
                )}
                {isLlsmFile && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '11px', color: '#4c1d95', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 4, padding: '1px 6px' }}>
                        {t('voicingMode')}
                        <select
                            value={llsmVoicingMode}
                            onChange={e => {
                                if (!activeFile || activeFile.sourceType !== 'llsm') return;
                                updateLlsmVoicingMode(activeFile.id, e.target.value as LlsmVoicingMode);
                            }}
                            style={{ fontSize: 11, padding: '1px 4px', border: '1px solid #7c3aed', borderRadius: 4, background: '#fff' }}
                        >
                            <option value="preserve">{t('voicingPreserve')}</option>
                            <option value="edge-extend">{t('voicingEdgeExtend')}</option>
                            <option value="full">{t('voicingFull')}</option>
                        </select>
                    </label>
                )}
                {(editorTab === 'pitch' || !isLlsmFile) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '11px', color: '#555' }}>
                        <input
                            type="checkbox"
                            checked={showSpectrogram}
                            onChange={e => setShowSpectrogram(e.target.checked)}
                        />
                        {t('spectrogram')}
                    </label>
                )}
                {(editorTab === 'pitch' || !isLlsmFile) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '11px', color: '#555' }}>
                        {t('global')}
                        <select
                            disabled={!showSpectrogram}
                            value={globalSpectrogramQuality}
                            onChange={e => {
                                const nextQuality = e.target.value as SpectrogramQuality;
                                setGlobalSpectrogramQuality(nextQuality);
                                setFileSpectrogramQualities({});
                            }}
                            style={{ fontSize: '11px', padding: '1px 4px', border: '1px solid #ced4da', borderRadius: 3, background: '#fff' }}
                        >
                            <option value="low">{t('low')}</option>
                            <option value="default">{t('default')}</option>
                            <option value="high">{t('high')}</option>
                        </select>
                    </label>
                )}
                {(editorTab === 'pitch' || !isLlsmFile) && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '11px', color: '#555' }}>
                        {t('thisFile')}
                        <select
                            disabled={!showSpectrogram}
                            value={activeFile ? (fileSpectrogramQualities[activeFile.id] ?? '__global__') : '__global__'}
                            onChange={e => {
                                if (!activeFile) return;
                                const nextValue = e.target.value;
                                setFileSpectrogramQualities(prev => {
                                    if (nextValue === '__global__') {
                                        const next = { ...prev };
                                        delete next[activeFile.id];
                                        return next;
                                    }
                                    return { ...prev, [activeFile.id]: nextValue as SpectrogramQuality };
                                });
                            }}
                            style={{ fontSize: '11px', padding: '1px 4px', border: '1px solid #ced4da', borderRadius: 3, background: '#fff' }}
                        >
                            <option value="__global__">{t('useGlobal')}</option>
                            <option value="low">{t('low')}</option>
                            <option value="default">{t('default')}</option>
                            <option value="high">{t('high')}</option>
                        </select>
                    </label>
                )}
                {(editorTab === 'pitch' || !isLlsmFile) && showSpectrogram && activeFile.wavFile && !spectrogramData && (
                    <span style={{ fontSize: '11px', color: '#8a6d3b', background: '#fff3cd', padding: '1px 6px', borderRadius: 3 }}>
                        {t('loadingSpectrogram')}
                    </span>
                )}
                {isLlsmFile && editorTab === 'experimental' && llsmExperimental && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '4px 8px', border: '1px solid #d8b4fe', borderRadius: 6, background: '#faf5ff', maxWidth: '100%' }}>
                        <span style={{ fontSize: 11, color: '#6b21a8', fontWeight: 700 }}>{t('experimentalWarning')}</span>
                        <label style={{ fontSize: 11, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 4 }}>
                            {t('voicingMode')}
                            <select
                                value={llsmVoicingMode}
                                onChange={e => {
                                    if (!activeFile || activeFile.sourceType !== 'llsm') return;
                                    updateLlsmVoicingMode(activeFile.id, e.target.value as LlsmVoicingMode);
                                }}
                                style={{ fontSize: 11, padding: '1px 4px', border: '1px solid #7c3aed', borderRadius: 4, background: '#fff' }}
                            >
                                <option value="preserve">{t('voicingPreserve')}</option>
                                <option value="edge-extend">{t('voicingEdgeExtend')}</option>
                                <option value="full">{t('voicingFull')}</option>
                            </select>
                        </label>
                        <span style={{ flexBasis: '100%', fontSize: 10, color: '#6b21a8' }}>{t('voicingModeDesc')}</span>
                        <span style={{ flexBasis: '100%', fontSize: 10, color: '#6b21a8' }}>{t('llsmExpRange')}</span>
                        <label style={{ fontSize: 11, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 4 }}>
                            `_9`
                            <input
                                type="number"
                                step={EXPERIMENTAL_LIMITS._9.step}
                                min={EXPERIMENTAL_LIMITS._9.min}
                                max={EXPERIMENTAL_LIMITS._9.max}
                                value={llsmNumericInputs._9}
                                onChange={e => setLlsmNumericInputs(prev => ({ ...prev, _9: e.target.value }))}
                                onKeyDown={e => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    applyExperimentalNumericField('_9');
                                }}
                                style={{ width: 82, fontSize: 11, padding: '1px 4px' }}
                            />
                        </label>
                        <label style={{ fontSize: 11, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 4 }}>
                            `_a`
                            <input
                                type="number"
                                step={EXPERIMENTAL_LIMITS._a.step}
                                min={EXPERIMENTAL_LIMITS._a.min}
                                max={EXPERIMENTAL_LIMITS._a.max}
                                value={llsmNumericInputs._a}
                                onChange={e => setLlsmNumericInputs(prev => ({ ...prev, _a: e.target.value }))}
                                onKeyDown={e => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    applyExperimentalNumericField('_a');
                                }}
                                style={{ width: 82, fontSize: 11, padding: '1px 4px' }}
                            />
                        </label>
                        <label style={{ fontSize: 11, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 4 }}>
                            `_b`
                            <input
                                type="number"
                                step={EXPERIMENTAL_LIMITS._b.step}
                                min={EXPERIMENTAL_LIMITS._b.min}
                                max={EXPERIMENTAL_LIMITS._b.max}
                                value={llsmNumericInputs._b}
                                onChange={e => setLlsmNumericInputs(prev => ({ ...prev, _b: e.target.value }))}
                                onKeyDown={e => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    applyExperimentalNumericField('_b');
                                }}
                                style={{ width: 82, fontSize: 11, padding: '1px 4px' }}
                            />
                        </label>
                        <label style={{ fontSize: 11, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 4 }}>
                            `_12`
                            <input type="number" readOnly value={llsmExperimental._12} style={{ width: 60, fontSize: 11, padding: '1px 4px', background: '#f3f4f6' }} />
                        </label>
                        <label style={{ fontSize: 11, color: '#4c1d95', display: 'flex', alignItems: 'center', gap: 4, minWidth: 260 }}>
                            `_13`
                            <input
                                value={llsm13Input}
                                onChange={e => setLlsm13Input(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    applyExperimental13();
                                }}
                                style={{ flex: 1, minWidth: 180, fontSize: 11, padding: '1px 4px' }}
                            />
                        </label>
                        <button
                            onClick={applyExperimental13}
                            style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #7c3aed', borderRadius: 4, background: '#ede9fe', color: '#5b21b6', cursor: 'pointer' }}
                        >
                            {t('applyExperimental')}
                        </button>
                        <span style={{ flexBasis: '100%', fontSize: 10, color: '#6b21a8' }}>{t('llsmExpDesc9')}</span>
                        <span style={{ flexBasis: '100%', fontSize: 10, color: '#6b21a8' }}>{t('llsmExpDescA')}</span>
                        <span style={{ flexBasis: '100%', fontSize: 10, color: '#6b21a8' }}>{t('llsmExpDescB')}</span>
                        <span style={{ flexBasis: '100%', fontSize: 10, color: '#6b21a8' }}>{t('llsmExpDesc1213')}</span>
                    </div>
                )}
                {isLlsmFile && editorTab === 'experimental' && !llsmExperimental && (
                    <span style={{ fontSize: 11, color: '#6b21a8', background: '#faf5ff', border: '1px solid #d8b4fe', borderRadius: 6, padding: '3px 8px' }}>
                        {t('experimentalUnavailable')}
                    </span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid #bbf7d0', borderRadius: 8, background: '#f0fdf4' }}>
                    <span style={{ fontSize: 11, color: '#166534', fontWeight: 700 }}>{t('autoCorrect')}</span>
                    <button
                        onClick={() => applyAutoCorrectToFiles([activeFile])}
                        style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #16a34a', borderRadius: 999, background: '#dcfce7', color: '#166534', cursor: 'pointer', fontWeight: 700 }}
                        title={t('autoCorrectHint')}
                    >
                        {t('applyThisFile')}
                    </button>
                    <button
                        onClick={() => applyAutoCorrectToFiles(files)}
                        style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #15803d', borderRadius: 999, background: '#bbf7d0', color: '#14532d', cursor: 'pointer', fontWeight: 700 }}
                        title={t('autoCorrectHint')}
                    >
                        {t('applyAllOpen')}
                    </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', border: '1px solid #bfdbfe', borderRadius: 8, background: '#eff6ff' }}>
                    <span style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 700 }}>{t('pitchShiftToNote')}</span>
                    <select
                        value={shiftReferenceMode}
                        onChange={e => setShiftReferenceMode(e.target.value as 'median' | 'mean')}
                        style={{ fontSize: 11, padding: '1px 4px', border: '1px solid #93c5fd', borderRadius: 4, background: '#fff', minWidth: 90 }}
                    >
                        <option value="median">{t('referenceMedian')}</option>
                        <option value="mean">{t('referenceMean')}</option>
                    </select>
                    <select
                        value={targetShiftMidi}
                        onChange={e => setTargetShiftMidi(Number(e.target.value))}
                        style={{ fontSize: 11, padding: '1px 4px', border: '1px solid #93c5fd', borderRadius: 4, background: '#fff', minWidth: 120 }}
                    >
                        {TARGET_NOTE_OPTIONS.map(option => (
                            <option key={option.midi} value={option.midi}>{option.label}</option>
                        ))}
                    </select>
                    <button
                        onClick={() => applyShiftToFiles([activeFile], targetShiftMidi, shiftReferenceMode)}
                        style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #2563eb', borderRadius: 999, background: '#dbeafe', color: '#1e3a8a', cursor: 'pointer', fontWeight: 700 }}
                        title={t('pitchShiftHint')}
                    >
                        {t('applyThisFile')}
                    </button>
                    <button
                        onClick={() => applyShiftToFiles(files, targetShiftMidi, shiftReferenceMode)}
                        style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #1d4ed8', borderRadius: 999, background: '#bfdbfe', color: '#1e3a8a', cursor: 'pointer', fontWeight: 700 }}
                        title={t('pitchShiftHint')}
                    >
                        {t('applyAllOpen')}
                    </button>
                </div>
                <div style={{ flex: 1 }} />
                <button
                    onClick={() => {
                        if (!activeFile) return;
                        if (!window.confirm(t('resetConfirm'))) return;
                        resetFrqData(activeFile.id);
                    }}
                    style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid #f2a20a', borderRadius: 3, background: '#fff8e1', cursor: 'pointer', color: '#7c5600' }}
                    title={t('resetHint')}
                >{t('reset')}</button>
                <button
                    onClick={() => undo(activeFile.id)}
                    disabled={activeFile.history.length === 0}
                    style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid #ccc', borderRadius: 3, background: '#fff', cursor: activeFile.history.length ? 'pointer' : 'default', color: activeFile.history.length ? '#333' : '#bbb' }}
                    title={t('undoHint')}
                >{t('undo')}</button>
                <button
                    onClick={() => redo(activeFile.id)}
                    disabled={activeFile.redoStack.length === 0}
                    style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid #ccc', borderRadius: 3, background: '#fff', cursor: activeFile.redoStack.length ? 'pointer' : 'default', color: activeFile.redoStack.length ? '#333' : '#bbb' }}
                    title={t('redoHint')}
                >{t('redo')}</button>
                <span style={{ fontSize: '11px', color: '#888' }}>{t('shortcuts')}</span>
            </div>

            {/* ─── Waveform overview panel ─────────────── */}
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderBottom: '1px solid #ddd', background: '#f8fbff', flexWrap: 'wrap' }}>
                <button
                    onClick={togglePlayback}
                    disabled={!activeFile.wavFile || isPreparingPreviewAudio}
                    style={{
                        fontSize: '12px',
                        padding: '4px 12px',
                        border: '1px solid #2563eb',
                        borderRadius: 6,
                        background: (activeFile.wavFile && !isPreparingPreviewAudio) ? '#eff6ff' : '#f1f5f9',
                        color: (activeFile.wavFile && !isPreparingPreviewAudio) ? '#1d4ed8' : '#94a3b8',
                        cursor: (activeFile.wavFile && !isPreparingPreviewAudio) ? 'pointer' : 'default',
                        fontWeight: 700,
                    }}
                    title={t('previewApproxNotice')}
                >
                    {isPreparingPreviewAudio ? t('previewPreparing') : (isPlaying ? t('pause') : t('play'))}
                </button>
                <span style={{ fontSize: '11px', color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '2px 8px', minWidth: 148, textAlign: 'center' }}>
                    {t('previewRate')}: {approxPreviewText}
                </span>
                <span style={{ fontSize: '11px', color: '#9a3412', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 4, padding: '2px 6px' }}>
                    {t('previewApproxNotice')}
                </span>
                {previewDebug && (
                    <span
                        style={{
                            fontSize: '11px',
                            color: '#1f2937',
                            background: '#f8fafc',
                            border: '1px solid #cbd5e1',
                            borderRadius: 4,
                            padding: '2px 8px',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        }}
                        title="Preview debug"
                    >
                        ratio {previewDebug.globalRatio.toFixed(3)} | st {previewDebug.semitoneDelta.toFixed(2)} | diff {previewDebug.diff.toFixed(4)} | seg {previewDebug.segmentCount} | voiced {previewDebug.voicedFrames}/{previewDebug.totalFrames} | spf {previewDebug.samplesPerFrame.toFixed(1)} | len {previewDebug.inputSamples}/{previewDebug.outputSamples} | fallback {previewDebug.fallbackUsed ? 'Y' : 'N'}
                    </span>
                )}
            </div>

            <div
                ref={waveContainerRef}
                style={{ flexShrink: 0, height: '65px', position: 'relative', overflow: 'hidden', background: '#f0f4ff', borderTop: '1px solid #d0d9f0' }}
            >
                {waveformData
                    ? <canvas ref={waveCanvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
                    : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aab', fontSize: 11 }}>
                            {activeFile.wavFile ? t('waveformReady') : t('waveformRequiresWav')}
                        </div>
                    )
                }
            </div>

            {/* ─── FRQ editor canvas (fills remaining space) ── */}
            <div
                ref={frqContainerRef}
                style={{ flex: 1, position: 'relative', overflow: 'hidden', cursor: 'crosshair', minHeight: 0, background: activeFile.wavFile ? '#787878' : '#fff' }}
                onWheel={onWheel}
            >
                {showSpectrogram && (
                    <canvas
                        ref={spgCanvasRef}
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
                    />
                )}
                {!showSpectrogram && (
                    <div style={{ position: 'absolute', inset: 0, background: '#fff', pointerEvents: 'none' }} />
                )}
                {showSpectrogram && !activeFile.wavFile && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12, pointerEvents: 'none' }}>
                        WAV 甯護攵・・・壱洳・､・ｴ ・・・､寬呰敢・懋ｷｸ・ｨ・ｴ 岺懍亨・ｩ・壱共
                    </div>
                )}
                <canvas
                    ref={frqCanvasRef}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerLeave={onPointerLeave}
                    onContextMenu={e => e.preventDefault()}  // prevent right-click menu
                />
                {showSpectrogram && activeFile.wavFile && !spectrogramData && (
                    <div style={{ position: 'absolute', right: 12, top: 12, fontSize: 11, color: '#f1f3f5', background: 'rgba(0,0,0,0.35)', padding: '4px 8px', borderRadius: 4, pointerEvents: 'none' }}>
                        Loading spectrogram...
                    </div>
                )}
            </div>

            {/* ─── Spectrogram ────────────────────────────── */}
            <div
                style={{ display: 'none' }}
                onWheel={onWheel}
            >
                <canvas style={{ width: '100%', height: '100%', display: 'block' }} />
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
