export interface ScoredFileMatch {
    relativePath: string;
    basename: string;
}

export function escapeGlob(s: string): string {
    return s.replace(/[*?[\]{}]/g, '');
}

export function buildSearchPatterns(query: string): string[] {
    const safe = escapeGlob(query);
    const patterns = new Set<string>();
    const segments = safe.split('/').filter(Boolean);

    if (segments.length > 1) {
        patterns.add(`**/${segments.join('/')}*`);
        patterns.add(`**/${segments.join('/**/')}*`);
        patterns.add(`**/*/${segments[segments.length - 1]}*`);
    } else if (segments.length === 1) {
        const seg = segments[0];
        patterns.add(`**/${seg}*`);
        patterns.add(`**/*${seg}*`);
        patterns.add(`**/*/${seg}*`);
    }

    return [...patterns];
}

export function scoreFileMatch(m: ScoredFileMatch, query: string): number {
    const rel = m.relativePath.toLowerCase();
    const base = m.basename.toLowerCase();
    const q = query.toLowerCase();
    const segments = q.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? q;

    if (rel === q || base === q) {
        return 100;
    }
    if (rel.endsWith(q) || rel.endsWith(`/${q}`)) {
        return 95;
    }
    if (base === last) {
        return 90;
    }
    if (base.startsWith(last)) {
        return 80;
    }
    if (segments.length > 1 && rel.includes(q)) {
        return 75;
    }
    if (rel.includes(q)) {
        return 65;
    }
    if (base.includes(last)) {
        return 50;
    }
    const initials = last
        .split(/[-_.]/)
        .filter(Boolean)
        .map((p) => p[0])
        .join('');
    if (initials.length >= 2 && base.replace(/[-_.]/g, '').includes(initials)) {
        return 40;
    }
    return 0;
}
