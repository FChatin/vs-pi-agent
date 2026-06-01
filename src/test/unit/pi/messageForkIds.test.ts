import { describe, expect, it } from 'vitest';
import {
    enrichUserMessagesWithForkEntryIds,
    findPrecedingUserMessageIndex,
    userMessagePlainText,
} from '../../../pi/messageForkIds';

describe('messageForkIds', () => {
    it('enriches user messages with fork entry ids by ordinal', () => {
        const messages = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'again' },
        ];
        enrichUserMessagesWithForkEntryIds(messages, [
            { entryId: 'e1', text: 'hello' },
            { entryId: 'e2', text: 'again' },
        ]);
        expect((messages[0] as { _forkEntryId?: string })._forkEntryId).toBe('e1');
        expect((messages[2] as { _forkEntryId?: string })._forkEntryId).toBe('e2');
    });

    it('finds preceding user message index', () => {
        const messages = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
            { role: 'assistant', content: 'd' },
        ];
        expect(findPrecedingUserMessageIndex(messages, 3)).toBe(2);
        expect(findPrecedingUserMessageIndex(messages, 1)).toBe(0);
    });

    it('extracts plain user text', () => {
        expect(userMessagePlainText({ role: 'user', content: '  hi  ' })).toBe('hi');
        expect(
            userMessagePlainText({
                role: 'user',
                content: [{ type: 'text', text: 'line' }],
            }),
        ).toBe('line');
    });
});
