import { type FrqData, type FrqFrame } from './frq';

const SAMPLE_RATE = 44100;
const DEFAULT_HOP_SIZE = 256;
// Window must be larger than the longest possible lag (44100/80 ≈ 551 samples)
// Use 1024 samples but process asynchronously to keep UI responsive
const WINDOW_SIZE = 1024;

/**
 * Autocorrelation-based F0 estimator.
 * Returns 0 for voiceless/silent frames.
 */
function computeF0Block(samples: Float32Array, sampleRate: number): number {
    const minPitch = 70;   // Hz
    const maxPitch = 800;  // Hz
    const maxLag = Math.floor(sampleRate / minPitch); // ~630
    const minLag = Math.floor(sampleRate / maxPitch); // ~55

    // Need at least maxLag + some samples to compute autocorrelation
    if (samples.length < maxLag + 1) return 0;

    // Compute total energy for normalisation
    let power = 0;
    for (let i = 0; i < samples.length; i++) power += samples[i] * samples[i];
    if (power < 1e-9) return 0; // silence

    let bestLag = -1;
    let maxAc = -1;

    for (let lag = minLag; lag <= maxLag; lag++) {
        let ac = 0;
        const n = samples.length - lag;
        for (let i = 0; i < n; i++) {
            ac += samples[i] * samples[i + lag];
        }
        // Normalise by approximate window energy at this lag
        ac /= power;
        // Lower threshold (0.3) to catch a wider range of voices
        if (ac > maxAc && ac > 0.30) {
            maxAc = ac;
            bestLag = lag;
        }
    }

    return bestLag > 0 ? sampleRate / bestLag : 0;
}

export async function generateBasicF0(
    audioBuffer: ArrayBuffer,
    expectedF0: number | null,
    onProgress?: (pct: number) => void,
): Promise<FrqData | null> {
    try {
        const ctx = new window.AudioContext({ sampleRate: SAMPLE_RATE });
        const decoded = await ctx.decodeAudioData(audioBuffer.slice(0));
        await ctx.close();

        const floatSamples = decoded.getChannelData(0);
        const totalFrames = Math.ceil(floatSamples.length / DEFAULT_HOP_SIZE);
        const frames: FrqFrame[] = [];

        for (let i = 0; i < floatSamples.length; i += DEFAULT_HOP_SIZE) {
            const sliceEnd = Math.min(i + WINDOW_SIZE, floatSamples.length);
            const segment = floatSamples.slice(i, sliceEnd);

            let f0 = computeF0Block(segment, SAMPLE_RATE);

            // Octave correction using expected pitch hint
            if (expectedF0 && f0 > 0) {
                if (f0 > expectedF0 * 1.8) f0 /= 2;
                else if (f0 < expectedF0 * 0.55) f0 *= 2;
            }

            // RMS amplitude
            let sum = 0;
            const n = Math.min(DEFAULT_HOP_SIZE, floatSamples.length - i);
            for (let j = 0; j < n; j++) sum += Math.abs(floatSamples[i + j]);
            const amp = n > 0 ? (sum / n) * Math.pow(2, 15) : 0;

            frames.push({ f0, amp });

            // Yield every 40 frames so the UI thread stays responsive
            if (frames.length % 40 === 0) {
                onProgress?.(frames.length / totalFrames);
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        }

        // 3-point median smoothing to kill glitchy single-frame errors
        for (let i = 1; i < frames.length - 1; i++) {
            if (frames[i - 1].f0 > 0 && frames[i].f0 > 0 && frames[i + 1].f0 > 0) {
                const s = [frames[i - 1].f0, frames[i].f0, frames[i + 1].f0].sort((a, b) => a - b);
                frames[i].f0 = s[1];
            }
        }

        onProgress?.(1);
        return {
            samplesPerWindow: DEFAULT_HOP_SIZE,
            windowInterval: (DEFAULT_HOP_SIZE / SAMPLE_RATE) * 1000,
            unknown20: 0, unknown24: 0, unknown28: 0, unknown32: 0, unknown36: 0,
            frames,
        };
    } catch (err) {
        console.error('F0 Generator Failed', err);
        return null;
    }
}
