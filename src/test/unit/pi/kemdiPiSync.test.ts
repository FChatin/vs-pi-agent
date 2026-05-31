import { describe, it, expect } from 'vitest';
import { formatKemdiPrimaryModel } from '../../../pi/kemdiPiSync';

describe('formatKemdiPrimaryModel', () => {
    it('maps google provider to g: prefix', () => {
        expect(formatKemdiPrimaryModel('google', 'gemini-2.5-flash')).toBe('g:gemini-2.5-flash');
    });

    it('maps anthropic provider to a: prefix', () => {
        expect(formatKemdiPrimaryModel('anthropic', 'claude-sonnet-4-20250514')).toBe(
            'a:claude-sonnet-4-20250514',
        );
    });

    it('preserves existing kemdi spec', () => {
        expect(formatKemdiPrimaryModel('openrouter', 'g:gemini-2.5-flash')).toBe('g:gemini-2.5-flash');
    });

    it('prefixes openrouter slugs', () => {
        expect(formatKemdiPrimaryModel('openrouter', 'minimax/qwen3-coder')).toBe(
            'openrouter:minimax/qwen3-coder',
        );
    });
});
