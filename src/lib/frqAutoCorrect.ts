import { type FrqFrame } from './frq';

export interface AutoCorrectOptions {
    /** Frames with f0 below this (Hz) are treated as noise/silence. Default: 80 Hz */
    minPitchHz?: number;
    /** Frames with f0 above this (Hz) are treated as high-freq noise. Default: 800 Hz */
    maxPitchHz?: number;
    /** Spurious voiced runs shorter than this (frames) are silenced. Default: 4 (~23ms at 256/44100 hop) */
    minVoicedRun?: number;
    /** Silent gaps shorter than this (frames) between voiced regions are interpolated. Default: 8 (~46ms) */
    maxFillGap?: number;
    /** Number of Gaussian-smooth passes after correction. Default: 2 */
    smoothPasses?: number;
}

/**
 * Auto-correct an F0 frame array:
 * 1. Remove noise — frames below minPitchHz, then runs shorter than minVoicedRun.
 * 2. Fill gaps — unvoiced segments shorter than maxFillGap between voiced sections.
 * 3. Smooth boundaries with a light Gaussian kernel.
 * 4. Extend boundary voiced values to file edges (no drop to zero at start/end).
 *
 * Returns a NEW array (does not mutate in-place).
 */
export function autoCorrectFrq(
    frames: FrqFrame[],
    options: AutoCorrectOptions = {},
): FrqFrame[] {
    const {
        minPitchHz = 80,
        maxPitchHz = 800,
        minVoicedRun = 4,
        maxFillGap = 8,
        smoothPasses = 2,
    } = options;

    // Deep copy so we don't mutate the original
    const out: FrqFrame[] = frames.map(f => ({ ...f }));
    const n = out.length;

    // ── Step 1: remove sub-threshold and short voiced runs ───────────────────
    // First pass: zero any frame below minPitchHz or above maxPitchHz (treat as noise)
    for (let k = 0; k < n; k++) {
        if (out[k].f0 > 0 && (out[k].f0 < minPitchHz || out[k].f0 > maxPitchHz)) out[k].f0 = 0;
    }
    // Second pass: zero runs shorter than minVoicedRun
    let i = 0;
    while (i < n) {
        if (out[i].f0 <= 0) { i++; continue; }
        let j = i;
        while (j < n && out[j].f0 > 0) j++;
        const runLen = j - i;
        if (runLen < minVoicedRun) {
            for (let k = i; k < j; k++) out[k].f0 = 0;
        }
        i = j;
    }

    // ── Step 2: fill short unvoiced gaps ────────────────────────────────────
    i = 0;
    while (i < n) {
        if (out[i].f0 > 0) { i++; continue; }
        let j = i;
        while (j < n && out[j].f0 <= 0) j++;
        const gapLen = j - i;

        const leftF0 = i > 0 ? out[i - 1].f0 : 0;
        const rightF0 = j < n ? out[j].f0 : 0;

        if (gapLen <= maxFillGap && leftF0 > 0 && rightF0 > 0) {
            for (let k = i; k < j; k++) {
                const t = (k - i + 1) / (gapLen + 1);
                out[k].f0 = leftF0 + t * (rightF0 - leftF0);
            }
        }
        i = j;
    }

    // ── Step 3: light Gaussian smoothing ───────────────────────────────────
    const KERNEL = [0.07, 0.20, 0.46, 0.20, 0.07] as const;
    for (let pass = 0; pass < smoothPasses; pass++) {
        const tmp = out.map(f => f.f0);
        for (let k = 2; k < n - 2; k++) {
            if (tmp[k] <= 0) continue;
            let sum = 0, w = 0;
            for (let d = -2; d <= 2; d++) {
                const v = tmp[k + d];
                if (v > 0) { sum += v * KERNEL[d + 2]; w += KERNEL[d + 2]; }
            }
            if (w > 0) out[k].f0 = sum / w;
        }
    }

    // ── Step 4: extend boundary values to file edges ────────────────────────
    // Only extend from the first/last GENUINELY voiced frame (>= minPitchHz)
    const firstVoiced = out.findIndex(f => f.f0 >= minPitchHz);
    const lastVoiced = n - 1 - [...out].reverse().findIndex(f => f.f0 >= minPitchHz);

    if (firstVoiced > 0) {
        const anchorF0 = out[firstVoiced].f0;
        for (let k = 0; k < firstVoiced; k++) out[k].f0 = anchorF0;
    }
    if (lastVoiced >= 0 && lastVoiced < n - 1) {
        const anchorF0 = out[lastVoiced].f0;
        for (let k = lastVoiced + 1; k < n; k++) out[k].f0 = anchorF0;
    }

    return out;
}
