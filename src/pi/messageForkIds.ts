/** Plain text from a Pi agent user message (for fork entry matching). */
export function userMessagePlainText(msg: unknown): string {
    if (!msg || typeof msg !== 'object') {
        return '';
    }
    const m = msg as Record<string, unknown>;
    if (typeof m.content === 'string') {
        return m.content.trim();
    }
    if (Array.isArray(m.content)) {
        return (m.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('')
            .trim();
    }
    return typeof m.text === 'string' ? m.text.trim() : '';
}

/** Attach `_forkEntryId` to user-role messages by ordinal match with get_fork_messages. */
export function enrichUserMessagesWithForkEntryIds(
    messages: unknown[],
    forkMessages: Array<{ entryId: string; text: string }>,
): void {
    let userOrdinal = 0;
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') {
            continue;
        }
        const m = msg as Record<string, unknown>;
        if (m.role !== 'user') {
            continue;
        }
        const fork = forkMessages[userOrdinal];
        if (fork?.entryId) {
            m._forkEntryId = fork.entryId;
        }
        userOrdinal++;
    }
}

/** Index in `messages` of the user message before assistant at `assistantIndex`. */
export function findPrecedingUserMessageIndex(messages: unknown[], assistantIndex: number): number {
    for (let i = Math.min(assistantIndex, messages.length - 1); i >= 0; i--) {
        const m = messages[i] as { role?: string } | undefined;
        if (m?.role === 'user') {
            return i;
        }
    }
    return -1;
}
