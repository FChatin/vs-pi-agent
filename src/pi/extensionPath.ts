let extensionRoot: string | undefined;

export function setPiExtensionPath(extensionPath: string): void {
    extensionRoot = extensionPath;
}

export function getPiExtensionPath(): string | undefined {
    return extensionRoot;
}
