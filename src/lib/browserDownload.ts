interface DownloadFallbackText {
    hint: string;
    action: string;
    close: string;
}

let fallbackTimer: number | null = null;
let fallbackContainer: HTMLDivElement | null = null;
let fallbackUrl: string | null = null;

const clearFallback = () => {
    if (fallbackTimer != null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
    }
    if (fallbackUrl) {
        URL.revokeObjectURL(fallbackUrl);
        fallbackUrl = null;
    }
    if (fallbackContainer && fallbackContainer.parentNode) {
        fallbackContainer.parentNode.removeChild(fallbackContainer);
    }
    fallbackContainer = null;
};

const showFallback = (url: string, fileName: string, text: DownloadFallbackText) => {
    clearFallback();
    fallbackUrl = url;

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.right = '16px';
    container.style.bottom = '16px';
    container.style.zIndex = '9999';
    container.style.background = '#111827';
    container.style.color = '#f9fafb';
    container.style.padding = '10px 12px';
    container.style.borderRadius = '8px';
    container.style.boxShadow = '0 8px 20px rgba(0,0,0,0.2)';
    container.style.fontSize = '12px';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '8px';
    container.style.maxWidth = '420px';

    const hint = document.createElement('span');
    hint.textContent = text.hint;

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.textContent = text.action;
    link.style.color = '#93c5fd';
    link.style.textDecoration = 'underline';
    link.style.fontWeight = '600';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = text.close;
    closeBtn.style.marginLeft = 'auto';
    closeBtn.style.border = '1px solid #374151';
    closeBtn.style.background = '#1f2937';
    closeBtn.style.color = '#f9fafb';
    closeBtn.style.borderRadius = '4px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.padding = '2px 6px';
    closeBtn.onclick = () => clearFallback();

    container.appendChild(hint);
    container.appendChild(link);
    container.appendChild(closeBtn);

    document.body.appendChild(container);
    fallbackContainer = container;
    fallbackTimer = window.setTimeout(() => clearFallback(), 45000);
};

export const downloadBlobWithFallback = (
    blob: Blob,
    fileName: string,
    text: DownloadFallbackText,
) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showFallback(url, fileName, text);
};

