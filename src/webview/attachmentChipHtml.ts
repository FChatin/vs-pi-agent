import type { PendingAttachmentPreview } from '../shared/protocol';

export const CHIP_FILE_ICON = `<svg class="chip-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.15"/></svg>`;

export const CHIP_IMAGE_ICON = `<svg class="chip-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.15"/><circle cx="5.5" cy="6.5" r="1.25" fill="currentColor"/><path d="M3 12l3.5-3.5 2 2L11 8l2 2" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const CHIP_CLOSE_ICON = `<svg class="chip-svg chip-svg-close" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>`;

function fileExtension(name: string): string {
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) {
        return '';
    }
    return name.slice(i + 1).toLowerCase();
}

export function renderComposerAttachmentChip(
    a: PendingAttachmentPreview,
    escHtml: (s: string) => string,
    escAttr: (s: string) => string,
): string {
    const ext = fileExtension(a.displayName);
    let iconHtml: string;
    if (a.isImage && a.previewDataUrl) {
        iconHtml = `<img class="attachment-thumb" src="${escAttr(a.previewDataUrl)}" alt="">`;
    } else if (a.isImage) {
        iconHtml = `<span class="attachment-chip-icon attachment-chip-icon--image">${CHIP_IMAGE_ICON}</span>`;
    } else {
        iconHtml = `<span class="attachment-chip-icon attachment-chip-icon--file">${CHIP_FILE_ICON}</span>`;
    }

    const extLabel = ext
        ? `<span class="attachment-ext">${escHtml(ext)}</span>`
        : `<span class="attachment-ext attachment-ext--muted">file</span>`;

    const pathAttr = a.absolutePath
        ? ` data-filepath="${escAttr(a.absolutePath)}"`
        : '';
    const openable = a.absolutePath ? ' attachment-chip--openable' : '';

    return `<div class="attachment-chip${openable}" data-id="${escAttr(a.id)}"${pathAttr} role="${a.absolutePath ? 'button' : 'group'}" tabindex="${a.absolutePath ? '0' : '-1'}" title="${escAttr(a.absolutePath ? `Open ${a.displayName}` : a.displayName)}">
        ${iconHtml}
        <span class="attachment-chip-text">
            <span class="attachment-name">${escHtml(a.displayName)}</span>
            ${extLabel}
        </span>
        <button type="button" class="attachment-remove" data-id="${escAttr(a.id)}" title="Remove" aria-label="Remove ${escAttr(a.displayName)}">${CHIP_CLOSE_ICON}</button>
    </div>`;
}

export function renderMessageAttachmentChip(
    displayName: string,
    filePath: string,
    isImage: boolean,
    escHtml: (s: string) => string,
    escAttr: (s: string) => string,
): string {
    const ext = fileExtension(displayName);
    const extLabel = ext
        ? `<span class="attachment-ext">${escHtml(ext)}</span>`
        : `<span class="attachment-ext attachment-ext--muted">${isImage ? 'image' : 'file'}</span>`;
    const iconClass = isImage ? 'attachment-chip-icon--image' : 'attachment-chip-icon--file';
    const icon = isImage ? CHIP_IMAGE_ICON : CHIP_FILE_ICON;
    const chipClass = isImage
        ? 'message-attachment-chip message-attachment-chip--image'
        : 'message-attachment-chip';

    return `<div class="${chipClass} attachment-chip--openable" data-filepath="${escAttr(filePath)}" role="button" tabindex="0" title="${escAttr(`Open ${displayName}`)}">
        <span class="attachment-chip-icon ${iconClass}">${icon}</span>
        <span class="attachment-chip-text">
            <span class="message-attachment-name">${escHtml(displayName)}</span>
            ${extLabel}
        </span>
    </div>`;
}
