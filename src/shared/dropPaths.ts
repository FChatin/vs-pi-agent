/** Parse Explorer / editor uri-list drops into local filesystem paths. */
export function parseUriListLines(raw: string): string[] {
    const paths: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const p = parseDropPathLine(line);
        if (p) {
            paths.push(p);
        }
    }
    return paths;
}

export function parseDropPathLine(line: string): string | null {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
        return null;
    }
    if (t.startsWith('file://')) {
        return fileUriToPath(t);
    }
    if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) {
        return t;
    }
    return null;
}

function fileUriToPath(uri: string): string {
    try {
        const url = new URL(uri);
        let p = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:/.test(p)) {
            p = p.slice(1);
        }
        return p;
    } catch {
        return decodeURIComponent(uri.replace(/^file:\/\//, ''));
    }
}
