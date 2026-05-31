import { createRequire } from 'node:module';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { savePastedFile } from './pastedAttachmentStore';
import type { ImageContent } from '@earendil-works/pi-ai';
import { getPiExtensionPath } from './piSdk';

export interface ProcessedFileAttachment {
    displayName: string;
    isImage: boolean;
    textFragment: string;
    image?: ImageContent;
    /** Thumbnail for composer chips (pasted images). */
    previewDataUrl?: string;
    /** On-disk path for open-on-click (images + files). */
    absolutePath?: string;
}

export interface PastedImageInput {
    mimeType: string;
    dataBase64: string;
    name?: string;
}

interface PiFileUtils {
    detectSupportedImageMimeTypeFromFile: (absolutePath: string) => Promise<string | undefined>;
    resizeImage: (inputBytes: Uint8Array, mimeType: string) => Promise<{
        mimeType: string;
        data: string;
        width?: number;
        height?: number;
    } | null>;
    formatDimensionNote: (result: { width?: number; height?: number }) => string | undefined;
    resolveReadPath: (filePath: string, cwd: string) => string;
}

let piFileUtilsCache: PiFileUtils | null | undefined;

/** Lazy-load Pi file helpers via createRequire (package exports block deep subpath imports). */
async function getPiFileUtils(): Promise<PiFileUtils | null> {
    if (piFileUtilsCache !== undefined) {
        return piFileUtilsCache;
    }
    const base = getPiExtensionPath();
    if (!base) {
        piFileUtilsCache = null;
        return null;
    }
    try {
        const pkgJson = join(
            base,
            'node_modules',
            '@earendil-works',
            'pi-coding-agent',
            'package.json',
        );
        const req = createRequire(pkgJson);
        piFileUtilsCache = {
            detectSupportedImageMimeTypeFromFile: req('./dist/utils/mime.js')
                .detectSupportedImageMimeTypeFromFile,
            resizeImage: req('./dist/utils/image-resize.js').resizeImage,
            formatDimensionNote: req('./dist/utils/image-resize.js').formatDimensionNote,
            resolveReadPath: req('./dist/core/tools/path-utils.js').resolveReadPath,
        };
        return piFileUtilsCache;
    } catch {
        piFileUtilsCache = null;
        return null;
    }
}

function resolveReadPathFallback(filePath: string, cwd: string): string {
    const trimmed = filePath.trim();
    if (trimmed.startsWith('~/')) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        return resolve(home, trimmed.slice(2));
    }
    return resolve(cwd, trimmed);
}

const IMAGE_EXT_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};

async function detectImageMimeFallback(absolutePath: string): Promise<string | undefined> {
    const ext = absolutePath.slice(absolutePath.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXT_MIME[ext]) {
        return IMAGE_EXT_MIME[ext];
    }
    try {
        const head = await readFile(absolutePath);
        const buf = head.subarray(0, 12);
        if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
        if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
        if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
        if (buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp';
    } catch {
        // ignore
    }
    return undefined;
}

async function imageFromBytes(
    absolutePath: string,
    bytes: Buffer,
    mimeType: string,
    utils: PiFileUtils | null,
): Promise<ProcessedFileAttachment | null> {
    let attachment: ImageContent;
    let dimensionNote: string | undefined;
    if (utils) {
        const resized = await utils.resizeImage(bytes, mimeType);
        if (!resized) {
            return {
                displayName: basename(absolutePath),
                isImage: false,
                textFragment: `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`,
            };
        }
        dimensionNote = utils.formatDimensionNote(resized);
        attachment = {
            type: 'image',
            mimeType: resized.mimeType,
            data: resized.data,
        };
    } else {
        attachment = {
            type: 'image',
            mimeType,
            data: bytes.toString('base64'),
        };
    }
    const textFragment = dimensionNote
        ? `<file name="${absolutePath}">${dimensionNote}</file>\n`
        : `<file name="${absolutePath}"></file>\n`;
    return {
        displayName: basename(absolutePath),
        isImage: true,
        textFragment,
        image: attachment,
        absolutePath,
    };
}

export async function processFilePaths(
    filePaths: string[],
    cwd: string,
): Promise<ProcessedFileAttachment[]> {
    const utils = await getPiFileUtils();
    const resolvePath = utils?.resolveReadPath ?? resolveReadPathFallback;
    const results: ProcessedFileAttachment[] = [];

    for (const filePath of filePaths) {
        const absolutePath = resolve(resolvePath(filePath, cwd));
        try {
            await access(absolutePath);
        } catch {
            continue;
        }
        const stats = await stat(absolutePath);
        if (stats.size === 0) {
            continue;
        }
        const mimeType =
            (utils
                ? await utils.detectSupportedImageMimeTypeFromFile(absolutePath)
                : undefined) ?? (await detectImageMimeFallback(absolutePath));
        if (mimeType) {
            const content = await readFile(absolutePath);
            const item = await imageFromBytes(absolutePath, content, mimeType, utils);
            if (item) {
                results.push(item);
            }
        } else {
            try {
                const content = await readFile(absolutePath, 'utf-8');
                results.push({
                    displayName: basename(absolutePath),
                    isImage: false,
                    textFragment: `<file name="${absolutePath}">\n${content}\n</file>\n`,
                    absolutePath,
                });
            } catch {
                // skip unreadable files
            }
        }
    }
    return results;
}

export async function processPastedImages(
    items: PastedImageInput[],
    pastedStorageDir?: string,
): Promise<ProcessedFileAttachment[]> {
    const utils = await getPiFileUtils();
    const results: ProcessedFileAttachment[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const displayName = item.name?.trim() || `pasted-image-${i + 1}.png`;
        const bytes = Buffer.from(item.dataBase64, 'base64');
        if (bytes.length === 0) {
            continue;
        }

        let absolutePath: string;
        if (pastedStorageDir) {
            absolutePath = await savePastedFile(pastedStorageDir, displayName, bytes);
        } else {
            absolutePath = resolve(displayName);
        }

        const isTextFile = !item.mimeType.startsWith('image/');
        if (isTextFile) {
            const content = bytes.toString('utf-8');
            results.push({
                displayName,
                isImage: false,
                textFragment: `<file name="${absolutePath}">\n${content}\n</file>\n`,
                absolutePath,
            });
            continue;
        }

        const processed = await imageFromBytes(absolutePath, bytes, item.mimeType, utils);
        if (processed) {
            processed.displayName = displayName;
            if (processed.image) {
                processed.previewDataUrl = `data:${processed.image.mimeType};base64,${processed.image.data}`;
            }
            results.push(processed);
        }
    }
    return results;
}

export interface ComposedPrompt {
    text: string;
    images: ImageContent[];
}

export function composePrompt(
    userText: string,
    attachments: Array<{ textFragment: string; image?: ImageContent }>,
): ComposedPrompt {
    const images = attachments
        .map((a) => a.image)
        .filter((img): img is ImageContent => img !== undefined);

    // Path markers in text (empty <file> for images) so chat UI can open on click
    const fileText = attachments.map((a) => a.textFragment).join('');
    const trimmed = userText.trim();
    let text = trimmed;
    if (fileText) {
        text = trimmed ? `${trimmed}\n${fileText}` : fileText.trimEnd();
    }
    if (!text && images.length > 0) {
        text = 'See attached files.';
    }
    return { text, images };
}
