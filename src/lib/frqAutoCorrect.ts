import { type FrqFrame } from './frq';

export interface AutoCorrectOptions {
    /** Spurious voiced runs shorter than this (frames) are silenced. Default: 4 (~23ms at 256/44100 hop) */
    minVoicedRun?: number;
    /** Silent gaps shorter than this (frames) between voiced regions are interpolated. Default: 8 (~46ms) */
    maxFillGap?: number;
    /** Number of Gaussian-smooth passes after correction. Default: 2 */
    smoothPasses?: number;
}

/**
 * Auto-correct an F0 frame array:
 * 1. Remove noise runs — voiced segments shorter than `minVoicedRun`.
 * 2. Fill gaps — unvoiced segments shorter than `maxFillGap` between voiced sections.
 * 3. Smooth boundaries with a light Gaussian kernel.
 *
 * Returns a NEW array (does not mutate in-place).
 */
export function autoCorrectFrq(
    frames: FrqFrame[],
    options: AutoCorrectOptions = {},
): FrqFrame[] {
    const {
        minVoicedRun = 4,
        maxFillGap = 8,
        smoothPasses = 2,
    } = options;

    // Deep copy so we don't mutate the original
    const out: FrqFrame[] = frames.map(f => ({ ...f }));
    const n = out.length;

    // ── Step 1: remove short voiced runs ────────────────────────────────────
    let i = 0;
    while (i < n) {
        if (out[i].f0 <= 0) { i++; continue; }
        // Find end of this voiced run
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
        // Find end of this silent gap
        let j = i;
        while (j < n && out[j].f0 <= 0) j++;
        const gapLen = j - i;

        // We need voiced frames on both sides
        const leftF0 = i > 0 ? out[i - 1].f0 : 0;
        const rightF0 = j < n ? out[j].f0 : 0;

        if (gapLen <= maxFillGap && leftF0 > 0 && rightF0 > 0) {
            for (let k = i; k < j; k++) {
                const t = (k - i + 1) / (gapLen + 1); // 0..1 exclusive
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
    // Instead of silence (f0=0) at the start/end, hold the nearest voiced pitch
    // value flat, so the curve doesn't "drop" to the bottom at either end.
    const firstVoiced = out.findIndex(f => f.f0 > 0);
    const lastVoiced = n - 1 - [...out].reverse().findIndex(f => f.f0 > 0);

    if (firstVoiced > 0) {
        const anchorF0 = out[firstVoiced].f0;
        for (let k = 0; k < firstVoiced; k++) out[k].f0 = anchorF0;
    }
    if (lastVoiced < n - 1 && lastVoiced >= 0) {
        const anchorF0 = out[lastVoiced].f0;
        for (let k = lastVoiced + 1; k < n; k++) out[k].f0 = anchorF0;
    }

    return out;
}
