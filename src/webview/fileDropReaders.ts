export function readImageFileAsItem(
    file: File,
): Promise<{ mimeType: string; dataBase64: string; name?: string } | null> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result !== 'string' || !result.includes(',')) {
                resolve(null);
                return;
            }
            const dataBase64 = result.split(',')[1] ?? '';
            if (!dataBase64) {
                resolve(null);
                return;
            }
            resolve({
                mimeType: file.type || 'image/png',
                dataBase64,
                name: file.name || undefined,
            });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

export function readTextFileAsItem(file: File): Promise<{ name: string; text: string } | null> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result !== 'string') {
                resolve(null);
                return;
            }
            resolve({ name: file.name || 'dropped-file.txt', text: result });
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
    });
}

const TEXT_FILE_RE =
    /\.(md|json|ts|tsx|js|jsx|py|html|css|mdx|yaml|yml|txt|xml|csv|sh|zsh|bash|rs|go|java|kt|cs|rb|php|sql|toml|ini|env)$/i;

export function isLikelyTextFile(file: File): boolean {
    if (file.type.startsWith('text/')) {
        return true;
    }
    return TEXT_FILE_RE.test(file.name);
}
