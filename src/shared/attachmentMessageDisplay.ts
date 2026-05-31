/** Strip Pi `<file>` blocks from user messages for chat UI (content still went to the model). */
const FILE_BLOCK_RE = /<file name="([^"]*)">[\s\S]*?<\/file>\s*/gi;

export interface DisplayFileAttachment {
    displayName: string;
    path: string;
}

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;

export function isImageFilePath(filePath: string): boolean {
    return IMAGE_PATH_RE.test(filePath.trim());
}

export function parseUserMessageForDisplay(rawText: string): {
    displayText: string;
    fileAttachments: DisplayFileAttachment[];
} {
    const fileAttachments: DisplayFileAttachment[] = [];
    const displayText = rawText
        .replace(FILE_BLOCK_RE, (_match, filePath: string) => {
            const path = filePath.trim();
            const displayName = path.split(/[/\\]/).pop() || path;
            fileAttachments.push({ displayName, path });
            return '';
        })
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const text =
        displayText === 'See attached files.' && fileAttachments.length > 0 ? '' : displayText;

    return { displayText: text, fileAttachments };
}
