import type { AgentSession } from '@earendil-works/pi-coding-agent';

export interface RecommendedPiPackage {
    id: string;
    /** Pi package source string for settings.json / pi install */
    source: string;
    label: string;
    description: string;
    /** Match if any configured package source contains this substring */
    packageMatch: string;
    /** When set, also treat as installed if this slash command is registered */
    slashCommand?: string;
    /** Shown in prompts — core UX vs optional integration */
    tier: 'core' | 'optional';
}

/** Pi CLI packages this VS Code extension is designed around (not bundled in the VSIX). */
export const RECOMMENDED_PI_PACKAGES: readonly RecommendedPiPackage[] = [
    {
        id: 'pi-plan-mode',
        source: 'npm:@narumitw/pi-plan-mode',
        label: 'Plan mode',
        description: 'Plan/Agent switch, /plan, and interactive plan questions in chat.',
        packageMatch: 'pi-plan-mode',
        slashCommand: 'plan',
        tier: 'core',
    },
    {
        id: 'pi-mcp-adapter',
        source: 'npm:pi-mcp-adapter',
        label: 'MCP adapter',
        description: 'Load MCP servers from ~/.pi/agent/mcp.json and workspace configs.',
        packageMatch: 'pi-mcp-adapter',
        tier: 'optional',
    },
] as const;

export function isPackageSourceConfigured(packages: string[], match: string): boolean {
    const needle = match.toLowerCase();
    return packages.some((p) => p.toLowerCase().includes(needle));
}

export function getRegisteredSlashCommands(session: AgentSession | undefined): string[] {
    if (!session?.extensionRunner) {
        return [];
    }
    try {
        return session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
    } catch {
        return [];
    }
}

/**
 * Missing = not listed in ~/.pi/agent settings packages.
 * (If listed but load failed, user should Reload session — not reinstall.)
 */
export function getMissingRecommendedPackages(
    configuredPackages: string[],
    session?: AgentSession,
): RecommendedPiPackage[] {
    const slash = getRegisteredSlashCommands(session);
    return RECOMMENDED_PI_PACKAGES.filter((pkg) => {
        if (isPackageSourceConfigured(configuredPackages, pkg.packageMatch)) {
            return false;
        }
        if (pkg.slashCommand && slash.includes(pkg.slashCommand)) {
            return false;
        }
        return true;
    });
}

export function formatMissingPackagesList(missing: readonly RecommendedPiPackage[]): string {
    return missing.map((p) => `${p.label} (${p.source})`).join(', ');
}
