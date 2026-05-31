import { describe, it, expect } from 'vitest';
import { getModelRegistry, TEST_MODEL_PROVIDER, TEST_MODEL_ID } from '../../setup';

describe('Model Registry', () => {
    it('lists available models', () => {
        const registry = getModelRegistry();
        const models = registry.getAvailable();
        expect(models.length).toBeGreaterThan(0);
    });

    it('finds the test model', () => {
        const registry = getModelRegistry();
        const model = registry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
        expect(model).toBeDefined();
        expect(model!.id).toBe(TEST_MODEL_ID);
    });

    it('model has expected properties', () => {
        const registry = getModelRegistry();
        const model = registry.find(TEST_MODEL_PROVIDER, TEST_MODEL_ID);
        expect(model).toBeDefined();
        expect(model!.provider).toBe(TEST_MODEL_PROVIDER);
        expect(typeof model!.id).toBe('string');
    });

    it('returns undefined for nonexistent model', () => {
        const registry = getModelRegistry();
        const model = registry.find('nonexistent', 'nonexistent');
        expect(model).toBeUndefined();
    });
});
