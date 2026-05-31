import type { ExtensionUiRequestPayload } from '../shared/extensionUi';
import { vscode } from './vscodeApi';

let activeRequest: ExtensionUiRequestPayload | null = null;

export function initExtensionUiHost(): void {
    const host = document.getElementById('extension-ui-host');
    if (!host) {
        return;
    }
    host.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const cancelBtn = target.closest('[data-extension-ui-cancel]');
        if (cancelBtn && activeRequest) {
            respond({ id: activeRequest.id, cancelled: true });
            return;
        }

        const optionBtn = target.closest('[data-extension-ui-option]') as HTMLElement | null;
        if (optionBtn && activeRequest) {
            const value = optionBtn.dataset.extensionUiOption ?? '';
            if (activeRequest.method === 'select') {
                respond({ id: activeRequest.id, value });
                return;
            }
        }

        const confirmBtn = target.closest('[data-extension-ui-confirm]') as HTMLElement | null;
        if (confirmBtn && activeRequest?.method === 'confirm') {
            respond({
                id: activeRequest.id,
                confirmed: confirmBtn.dataset.extensionUiConfirm === 'yes',
            });
        }

        const submitBtn = target.closest('[data-extension-ui-submit]');
        if (submitBtn && activeRequest && (activeRequest.method === 'input' || activeRequest.method === 'editor')) {
            const input = document.getElementById('extension-ui-input') as HTMLTextAreaElement | null;
            const value = input?.value.trim();
            if (!value) {
                return;
            }
            respond({ id: activeRequest.id, value });
        }
    });
}

export function showExtensionUiRequest(request: ExtensionUiRequestPayload): void {
    activeRequest = request;
    const host = document.getElementById('extension-ui-host');
    if (!host) {
        return;
    }
    host.style.display = 'block';
    host.innerHTML = renderRequest(request);
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function dismissExtensionUi(id: string): void {
    if (activeRequest?.id !== id) {
        return;
    }
    activeRequest = null;
    const host = document.getElementById('extension-ui-host');
    if (host) {
        host.style.display = 'none';
        host.innerHTML = '';
    }
}

function respond(payload: { id: string; cancelled?: boolean; value?: string; confirmed?: boolean }): void {
    vscode.postMessage({ type: 'extensionUiResponse', ...payload });
    dismissExtensionUi(payload.id);
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function optionLetter(index: number): string {
    if (index < 26) {
        return String.fromCharCode(65 + index);
    }
    return String(index + 1);
}

function renderRequest(req: ExtensionUiRequestPayload): string {
    const title = req.title?.trim() || 'Selection required';
    const badge =
        req.method === 'select'
            ? 'Question'
            : req.method === 'confirm'
              ? 'Confirm'
              : req.method === 'editor'
                ? 'Text'
                : 'Input';

    if (req.method === 'confirm') {
        const msg = req.message?.trim() || '';
        return `
            <div class="extension-ui-card" role="dialog" aria-label="${escHtml(title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">${badge}</span>
                    <div class="extension-ui-title">${escHtml(title)}</div>
                    ${msg ? `<p class="extension-ui-subtitle">${escHtml(msg)}</p>` : ''}
                </div>
                <div class="extension-ui-actions-row">
                    <button type="button" class="extension-ui-btn primary" data-extension-ui-confirm="yes">Yes</button>
                    <button type="button" class="extension-ui-btn" data-extension-ui-confirm="no">No</button>
                    <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
                </div>
            </div>`;
    }

    if (req.method === 'input' || req.method === 'editor') {
        const placeholder = req.placeholder?.trim() || 'Type your answer…';
        const prefill = req.prefill ?? '';
        const rows = req.method === 'editor' ? 4 : 2;
        return `
            <div class="extension-ui-card" role="dialog" aria-label="${escHtml(title)}">
                <div class="extension-ui-header">
                    <span class="extension-ui-badge">${badge}</span>
                    <div class="extension-ui-title">${escHtml(title)}</div>
                    <p class="extension-ui-subtitle">Submit to reply; leave empty and use Cancel to dismiss.</p>
                </div>
                <textarea id="extension-ui-input" class="extension-ui-textarea" rows="${rows}" placeholder="${escHtml(placeholder)}">${escHtml(prefill)}</textarea>
                <div class="extension-ui-actions-row">
                    <button type="button" class="extension-ui-btn primary" data-extension-ui-submit>Submit</button>
                    <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
                </div>
            </div>`;
    }

    const options = req.options ?? [];
    const optionButtons = options
        .map((opt, i) => {
            const letter = optionLetter(i);
            const label = opt.replace(/^\d+\.\s*/, '').trim() || opt;
            return `
                <button type="button" class="extension-ui-option" data-extension-ui-option="${escHtml(opt)}">
                    <span class="extension-ui-letter">${letter}</span>
                    <span class="extension-ui-option-text">${escHtml(label)}</span>
                </button>`;
        })
        .join('');

    return `
        <div class="extension-ui-card" role="dialog" aria-label="${escHtml(title)}">
            <div class="extension-ui-header">
                <span class="extension-ui-badge">${badge}</span>
                <div class="extension-ui-title">${escHtml(title)}</div>
                <p class="extension-ui-subtitle">Click an option — no need to type A/B/C in chat.</p>
            </div>
            <div class="extension-ui-options">${optionButtons}</div>
            <div class="extension-ui-actions-row">
                <button type="button" class="extension-ui-btn ghost" data-extension-ui-cancel>Cancel</button>
            </div>
        </div>`;
}
