const normalizeSeparators = (value: string) => value.replace(/\\/g, '/');

export const toFrqFileName = (value: string) => {
    const normalized = normalizeSeparators(value);
    const fileName = normalized.split('/').pop() || normalized;

    if (/_wav\.frq$/i.test(fileName) || /\.frq$/i.test(fileName)) {
        return fileName;
    }

    if (/_wav\.pmk$/i.test(fileName)) {
        return fileName.replace(/_wav\.pmk$/i, '_wav.frq');
    }

    if (/\.pmk$/i.test(fileName)) {
        return fileName.replace(/\.pmk$/i, '_wav.frq');
    }

    if (/\.wav\.llsm$/i.test(fileName)) {
        return fileName.replace(/\.wav\.llsm$/i, '_wav.frq');
    }

    if (/\.llsm$/i.test(fileName)) {
        return fileName.replace(/\.llsm$/i, '_wav.frq');
    }

    if (/\.wav$/i.test(fileName)) {
        return fileName.replace(/\.wav$/i, '_wav.frq');
    }

    return `${fileName}_wav.frq`;
};

export const normalizeFrqPath = (pathLike: string, fallbackFileName: string) => {
    const normalizedPath = normalizeSeparators(pathLike);
    const lastSlash = normalizedPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash + 1) : '';
    const fileName = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
    const targetName = toFrqFileName(fileName || fallbackFileName);

    return `${dir}${targetName}`;
};
