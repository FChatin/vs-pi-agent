import * as https from 'https';

export interface PiCatalogEntry {
    name: string;
    source: string;
    description: string;
    version: string;
    monthlyDownloads: number;
    resourceTypes: string[];
    publisher?: string;
    homepage?: string;
}

interface NpmSearchResponse {
    objects?: Array<{
        package?: {
            name?: string;
            description?: string;
            version?: string;
            keywords?: string[];
            publisher?: { username?: string };
            links?: { homepage?: string };
        };
        downloads?: { monthly?: number };
    }>;
}

const RESOURCE_KEYWORDS = new Set(['extension', 'skill', 'theme', 'prompt']);

export function normalizePiPackageSource(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Package source is empty');
    }
    if (
        trimmed.startsWith('npm:') ||
        trimmed.startsWith('git:') ||
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('ssh://') ||
        trimmed.startsWith('/') ||
        trimmed.startsWith('./') ||
        trimmed.startsWith('~/')
    ) {
        return trimmed;
    }
    return `npm:${trimmed}`;
}

function inferResourceTypes(keywords: string[] | undefined): string[] {
    if (!keywords?.length) {
        return ['package'];
    }
    const lower = keywords.map((k) => k.toLowerCase());
    const types = [...RESOURCE_KEYWORDS].filter((t) => lower.includes(t));
    if (types.length > 0) {
        return types;
    }
    if (lower.includes('pi-package') || lower.includes('pi')) {
        return ['package'];
    }
    return ['package'];
}

function formatDownloads(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
}

function fetchJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`npm registry returned ${res.statusCode}`));
                res.resume();
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15_000, () => {
            req.destroy(new Error('npm registry request timed out'));
        });
    });
}

/**
 * Search Pi packages from npm (keyword pi-package), same catalog as pi.dev/packages.
 * @see https://pi.dev/packages
 */
export async function searchPiPackageCatalog(query: string, size = 40): Promise<PiCatalogEntry[]> {
    const q = query.trim();
    const text = q
        ? `keywords:pi-package ${q}`
        : 'keywords:pi-package';
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;

    const data = await fetchJson<NpmSearchResponse>(url);
    const entries: PiCatalogEntry[] = [];

    for (const obj of data.objects ?? []) {
        const pkg = obj.package;
        if (!pkg?.name) {
            continue;
        }
        entries.push({
            name: pkg.name,
            source: `npm:${pkg.name}`,
            description: pkg.description?.trim() || 'No description',
            version: pkg.version ?? '',
            monthlyDownloads: obj.downloads?.monthly ?? 0,
            resourceTypes: inferResourceTypes(pkg.keywords),
            publisher: pkg.publisher?.username,
            homepage: pkg.links?.homepage,
        });
    }

    return entries;
}

const DETAIL_DESC_MAX = 220;

function truncate(text: string, max: number): string {
    const t = text.trim();
    if (t.length <= max) {
        return t;
    }
    return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Owner + package kind for the quick-pick secondary column. */
export function formatCatalogOwnerLine(entry: PiCatalogEntry): string {
    const types = entry.resourceTypes.join(', ');
    const owner = entry.publisher ? `@${entry.publisher}` : 'unknown author';
    return `${owner} · ${types}`;
}

/** Version / download stats (tertiary, after description). */
export function formatCatalogMeta(entry: PiCatalogEntry): string {
    const dl = formatDownloads(entry.monthlyDownloads);
    const ver = entry.version ? `v${entry.version}` : '';
    const parts = [ver, `${dl}/mo`].filter(Boolean);
    return parts.join(' · ');
}

/** Full quick-pick detail line: description first, then stats. */
export function formatCatalogDetail(entry: PiCatalogEntry): string {
    const desc = truncate(entry.description || 'No description', DETAIL_DESC_MAX);
    const meta = formatCatalogMeta(entry);
    return meta ? `${desc} — ${meta}` : desc;
}
