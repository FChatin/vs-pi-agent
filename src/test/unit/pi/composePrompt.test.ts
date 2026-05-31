import { describe, expect, it } from 'vitest';
import { composePrompt } from '../../../pi/fileAttachments';

describe('composePrompt', () => {
    it('includes empty file tag for images so chat can resolve open path', () => {
        const path = '/tmp/pasted-attachments/pasted-image-1.png';
        const { text, images } = composePrompt('bu nedir', [
            {
                textFragment: `<file name="${path}"></file>\n`,
                image: { type: 'image', mimeType: 'image/png', data: 'abc' },
            },
        ]);
        expect(images).toHaveLength(1);
        expect(text).toContain(path);
        expect(text).toContain('bu nedir');
    });

    it('still includes text file fragments', () => {
        const { text } = composePrompt('hi', [
            {
                textFragment: '<file name="/a/readme.md">\n# Title\n</file>\n',
            },
        ]);
        expect(text).toContain('readme.md');
        expect(text).toContain('# Title');
    });
});
