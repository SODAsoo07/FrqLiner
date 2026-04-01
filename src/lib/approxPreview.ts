import type { FrqFrame } from './frq';

export interface ApproxPreviewDebugInfo {
    globalRatio: number;
    semitoneDelta: number;
    diff: number;
    fallbackUsed: boolean;
    segmentCount: number;
    voicedFrames: number;
    totalFrames: number;
    samplesPerFrame: number;
    inputSamples: number;
    outputSamples: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const sampleLinear = (src: Float32Array, index: number) => {
    if (src.length === 0) return 0;
    if (index <= 0) return src[0] ?? 0;
    const last = src.length - 1;
    if (index >= last) return src[last] ?? 0;
    const i0 = Math.floor(index);
    const i1 = Math.min(last, i0 + 1);
    const frac = index - i0;
    return (src[i0] ?? 0) * (1 - frac) + (src[i1] ?? 0) * frac;
};

const buildHannWindow = (size: number) => {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, size - 1)));
    }
    return w;
};

const smooth = (values: Float32Array, radius: number) => {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
        let sum = 0;
        let count = 0;
        for (let k = -radius; k <= radius; k++) {
            const idx = i + k;
            if (idx < 0 || idx >= values.length) continue;
            sum += values[idx];
            count += 1;
        }
        out[i] = count > 0 ? sum / count : values[i];
    }
    return out;
};

const resampleLinear = (input: Float32Array, ratio: number) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return input.slice();
    const outLength = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
        output[i] = sampleLinear(input, i * ratio);
    }
    return output;
};

const olaTimeStretch = (input: Float32Array, targetLength: number) => {
    if (targetLength <= 0) return new Float32Array(0);
    if (input.length === 0) return new Float32Array(targetLength);
    if (input.length === 1) return new Float32Array(targetLength).fill(input[0]);

    const windowSize = 1024;
    const hopOut = 256;
    const hopIn = hopOut * (input.length / targetLength);
    const window = buildHannWindow(windowSize);
    const output = new Float32Array(targetLength + windowSize);
    const norm = new Float32Array(targetLength + windowSize);

    let srcCenter = 0;
    for (let outCenter = 0; outCenter < targetLength + windowSize; outCenter += hopOut) {
        for (let i = 0; i < windowSize; i++) {
            const outIdx = outCenter - (windowSize >> 1) + i;
            if (outIdx < 0 || outIdx >= output.length) continue;
            const srcIdx = srcCenter - (windowSize >> 1) + i;
            const sample = sampleLinear(input, srcIdx);
            const win = window[i];
            output[outIdx] += sample * win;
            norm[outIdx] += win;
        }
        srcCenter += hopIn;
    }

    const finalized = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
        const n = norm[i];
        finalized[i] = n > 1e-6 ? output[i] / n : 0;
    }
    return finalized;
};

const pitchShiftPreserveLength = (input: Float32Array, ratio: number) => {
    const safeRatio = clamp(ratio, 0.35, 3.0);
    if (Math.abs(safeRatio - 1) < 0.01) return input.slice();
    const pitched = resampleLinear(input, safeRatio);
    return olaTimeStretch(pitched, input.length);
};

const resolveSamplesPerFrame = (
    waveformSamples: number,
    sampleRate: number,
    editedFrames: number,
    originalFrames: number,
    windowIntervalMs: number,
    samplesPerWindow?: number | null,
) => {
    const frameCount = Math.max(editedFrames, originalFrames, 1);
    const fromFrameCount = waveformSamples / frameCount;
    const fromWindowSamples = Number.isFinite(samplesPerWindow) && (samplesPerWindow as number) > 0
        ? Number(samplesPerWindow)
        : NaN;
    const fromWindowMs = Number.isFinite(windowIntervalMs) && windowIntervalMs > 0
        ? sampleRate * (windowIntervalMs / 1000)
        : NaN;

    let chosen = Number.isFinite(fromWindowSamples) ? fromWindowSamples : fromWindowMs;
    if (!Number.isFinite(chosen) || chosen <= 0) {
        chosen = Number.isFinite(fromFrameCount) && fromFrameCount > 0 ? fromFrameCount : 256;
    }

    if (Number.isFinite(fromFrameCount) && fromFrameCount > 0) {
        const low = fromFrameCount / 4;
        const high = fromFrameCount * 4;
        if (chosen < low || chosen > high) {
            chosen = fromFrameCount;
        }
    }

    return Math.max(1, chosen);
};

const buildFrameRatioTrack = (
    editedFrames: FrqFrame[],
    originalFrames: FrqFrame[],
    targetFrames: number,
    expectedF0?: number | null,
) => {
    const ratio = new Float32Array(targetFrames).fill(1);
    const voiced = new Uint8Array(targetFrames);
    const max = Math.min(targetFrames, editedFrames.length, originalFrames.length);
    const expected = expectedF0 && Number.isFinite(expectedF0) && expectedF0 > 1 ? expectedF0 : null;
    const originalVoiced = originalFrames
        .map(frame => frame.f0)
        .filter(f0 => Number.isFinite(f0) && f0 > 1)
        .sort((a, b) => a - b);
    const originalMedian = originalVoiced.length > 0
        ? originalVoiced[Math.floor(originalVoiced.length / 2)]
        : null;
    const baseTone = expected ?? originalMedian;

    for (let i = 0; i < max; i++) {
        const edited = editedFrames[i]?.f0 ?? 0;
        const original = originalFrames[i]?.f0 ?? 0;
        if (edited > 1) voiced[i] = 1;
        if (edited > 1 && Number.isFinite(edited)) {
            if (original > 1 && Number.isFinite(original)) {
                // Keep preview behavior aligned with edited/original FRQ changes.
                const raw = edited / original;
                ratio[i] = clamp(Math.pow(raw, 1.08), 0.35, 3.0);
            } else if (baseTone) {
                ratio[i] = clamp(edited / baseTone, 0.35, 3.0);
            } else {
                ratio[i] = 1;
            }
        } else {
            // No f0 line => always treat as unvoiced for preview rendering.
            ratio[i] = 1;
        }
    }

    const smoothed = smooth(ratio, 0);
    for (let i = 0; i < smoothed.length; i++) {
        smoothed[i] = clamp(smoothed[i], 0.35, 3.0);
    }
    return { ratio: smoothed, voiced };
};

const frameValueAtSample = (
    frameValues: Float32Array,
    sampleIndex: number,
    samplesPerFrame: number,
) => {
    const framePos = sampleIndex / Math.max(1, samplesPerFrame);
    const left = Math.floor(framePos);
    const right = Math.min(frameValues.length - 1, left + 1);
    const t = framePos - left;
    const lv = frameValues[Math.max(0, left)] ?? 1;
    const rv = frameValues[Math.max(0, right)] ?? lv;
    return lv * (1 - t) + rv * t;
};

const detectSampleSegments = (
    voicedFrames: Uint8Array,
    totalSamples: number,
    samplesPerFrame: number,
) => {
    const segments: Array<{ start: number; end: number; voiced: boolean }> = [];
    if (totalSamples <= 0) return segments;
    if (voicedFrames.length === 0) {
        segments.push({ start: 0, end: totalSamples, voiced: false });
        return segments;
    }

    let segStartFrame = 0;
    let current = voicedFrames[0] === 1;
    for (let i = 1; i <= voicedFrames.length; i++) {
        const next = i < voicedFrames.length ? voicedFrames[i] === 1 : !current;
        if (next === current) continue;
        const start = Math.floor(segStartFrame * samplesPerFrame);
        const end = i >= voicedFrames.length
            ? totalSamples
            : Math.min(totalSamples, Math.floor(i * samplesPerFrame));
        if (end > start) {
            segments.push({ start, end, voiced: current });
        }
        segStartFrame = i;
        current = next;
    }
    return segments;
};

const overlapAddWithVariableHop = (
    segment: Float32Array,
    absoluteStart: number,
    samplesPerFrame: number,
    frameRatios: Float32Array,
) => {
    if (segment.length < 32) return segment.slice();
    const windowSize = 1024;
    const hopOut = 256;
    const window = buildHannWindow(windowSize);
    const output = new Float32Array(segment.length + windowSize);
    const norm = new Float32Array(segment.length + windowSize);

    let srcCenter = 0;
    for (let outCenter = 0; outCenter < segment.length + windowSize; outCenter += hopOut) {
        const globalSample = absoluteStart + outCenter;
        const ratio = frameValueAtSample(frameRatios, globalSample, samplesPerFrame);
        const hopIn = hopOut * clamp(ratio, 0.35, 3.0);

        for (let i = 0; i < windowSize; i++) {
            const outIdx = outCenter - (windowSize >> 1) + i;
            if (outIdx < 0 || outIdx >= output.length) continue;
            const srcIdx = srcCenter - (windowSize >> 1) + i;
            const sample = sampleLinear(segment, srcIdx);
            const win = window[i];
            output[outIdx] += sample * win;
            norm[outIdx] += win;
        }
        srcCenter += hopIn;
    }

    const finalized = new Float32Array(segment.length);
    for (let i = 0; i < segment.length; i++) {
        const n = norm[i];
        finalized[i] = n > 1e-6 ? output[i] / n : 0;
    }
    return finalized;
};

const wsolaPreserveLength = (segment: Float32Array) => {
    if (segment.length < 32) return segment.slice();
    const targetLength = segment.length;
    const windowSize = 512;
    const hopOut = 128;
    const searchRadius = 48;
    const window = buildHannWindow(windowSize);

    const output = new Float32Array(targetLength + windowSize);
    const norm = new Float32Array(targetLength + windowSize);
    let srcPos = 0;
    let outPos = 0;
    let previousStart = 0;
    let frameIndex = 0;

    while (outPos < targetLength + windowSize) {
        let bestStart = Math.round(srcPos);
        if (frameIndex > 0) {
            let bestScore = Number.NEGATIVE_INFINITY;
            const predicted = Math.round(srcPos);
            for (let off = -searchRadius; off <= searchRadius; off++) {
                const cand = predicted + off;
                if (cand < 0 || cand + windowSize >= segment.length) continue;
                let score = 0;
                const overlap = Math.min(windowSize - hopOut, targetLength);
                for (let i = 0; i < overlap; i++) {
                    const outIdx = outPos - overlap + i;
                    if (outIdx < 0 || outIdx >= output.length) continue;
                    score += output[outIdx] * segment[cand + i];
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestStart = cand;
                }
            }
            if (!Number.isFinite(bestScore)) {
                bestStart = clamp(predicted, 0, Math.max(0, segment.length - windowSize));
            }
        } else {
            bestStart = 0;
        }

        for (let i = 0; i < windowSize; i++) {
            const outIdx = outPos - (windowSize >> 1) + i;
            if (outIdx < 0 || outIdx >= output.length) continue;
            const srcIdx = bestStart + i;
            const sample = srcIdx >= 0 && srcIdx < segment.length ? segment[srcIdx] : 0;
            const win = window[i];
            output[outIdx] += sample * win;
            norm[outIdx] += win;
        }

        frameIndex += 1;
        previousStart = bestStart;
        srcPos = previousStart + hopOut;
        outPos += hopOut;
    }

    const finalized = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
        const n = norm[i];
        finalized[i] = n > 1e-6 ? output[i] / n : 0;
    }
    return finalized;
};

const mixSegments = (
    original: Float32Array,
    segments: Array<{ start: number; end: number; voiced: boolean }>,
    frameRatios: Float32Array,
    samplesPerFrame: number,
) => {
    const out = original.slice();
    const fade = 48;
    for (const seg of segments) {
        const len = seg.end - seg.start;
        if (len <= 0) continue;
        const slice = original.subarray(seg.start, seg.end);
        const processed = seg.voiced
            ? overlapAddWithVariableHop(slice, seg.start, samplesPerFrame, frameRatios)
            : wsolaPreserveLength(slice);

        for (let i = 0; i < len; i++) {
            const idx = seg.start + i;
            const p = processed[i] ?? 0;
            let w = 1;
            if (i < fade) w = i / fade;
            if (i > len - fade) w = Math.min(w, (len - i) / fade);
            w = clamp(w, 0, 1);
            out[idx] = out[idx] * (1 - w) + p * w;
        }
    }
    return out;
};

const getMedianRatio = (ratios: Float32Array, voiced: Uint8Array) => {
    const values: number[] = [];
    for (let i = 0; i < ratios.length; i++) {
        if (voiced[i] !== 1) continue;
        const r = ratios[i];
        if (!Number.isFinite(r) || r <= 0) continue;
        values.push(r);
    }
    if (values.length === 0) return 1;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
};

const getMeanAbsDiff = (a: Float32Array, b: Float32Array) => {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    }
    return acc / n;
};

const encodeWav16Mono = (pcm: Float32Array, sampleRate: number) => {
    const numSamples = pcm.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    const writeString = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, Math.max(8000, Math.round(sampleRate)), true);
    view.setUint32(28, Math.max(8000, Math.round(sampleRate)) * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = clamp(pcm[i], -1, 1);
        const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        view.setInt16(offset, v, true);
        offset += 2;
    }
    return buffer;
};

export const createApproxPreviewWav = (
    waveformData: Float32Array,
    sampleRate: number,
    editedFrames: FrqFrame[],
    originalFrames: FrqFrame[],
    windowIntervalMs: number,
    expectedF0?: number | null,
    samplesPerWindow?: number | null,
) => {
    const samplesPerFrame = resolveSamplesPerFrame(
        waveformData.length,
        sampleRate,
        editedFrames.length,
        originalFrames.length,
        windowIntervalMs,
        samplesPerWindow,
    );
    const estimatedFrames = Math.max(
        1,
        Math.ceil(waveformData.length / samplesPerFrame),
        editedFrames.length,
        originalFrames.length,
    );
    const { ratio, voiced } = buildFrameRatioTrack(editedFrames, originalFrames, estimatedFrames, expectedF0);
    const segments = detectSampleSegments(voiced, waveformData.length, samplesPerFrame);
    let processed = mixSegments(waveformData, segments, ratio, samplesPerFrame);
    const globalRatio = getMedianRatio(ratio, voiced);
    const diff = getMeanAbsDiff(processed, waveformData);
    const semitoneDelta = Math.abs(12 * Math.log2(Math.max(1e-6, globalRatio)));
    let fallbackUsed = false;

    // Fallback: if segment-mode result is still too close to original despite large pitch target,
    // force a global pitch shift so users always hear clear preview differences.
    if (semitoneDelta >= 2 && diff < 0.0025) {
        processed = pitchShiftPreserveLength(waveformData, globalRatio);
        fallbackUsed = true;
    }
    if (processed.length !== waveformData.length) {
        processed = olaTimeStretch(processed, waveformData.length);
    }

    const wav = encodeWav16Mono(processed, sampleRate);
    const debug: ApproxPreviewDebugInfo = {
        globalRatio,
        semitoneDelta,
        diff,
        fallbackUsed,
        segmentCount: segments.length,
        voicedFrames: voiced.reduce((sum, v) => sum + (v ? 1 : 0), 0),
        totalFrames: voiced.length,
        samplesPerFrame,
        inputSamples: waveformData.length,
        outputSamples: processed.length,
    };
    return {
        blob: new Blob([wav], { type: 'audio/wav' }),
        debug,
    };
};
