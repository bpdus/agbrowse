// @ts-check
/**
 * Serialize the Naver top bar without exposing page text or arbitrary DOM
 * attributes. This function is self-contained because it runs in page context.
 * @param {ParentNode | undefined} doc
 */
export function sanitizeNaverTopbarStructure(doc) {
    try {
        const root = doc && typeof doc.querySelectorAll === 'function' ? doc : globalThis.document;
        if (!root || typeof root.querySelectorAll !== 'function') return '';

        const candidates = new Set();
        const classifierSelector = 'header, [role="banner"], #header, #gnb, #account, '
            + '[data-testid*="topbar" i], [class*="topbar" i]';
        for (const element of root.querySelectorAll(classifierSelector)) candidates.add(element);
        for (const selector of ['header', '#header', '#gnb', '#account']) {
            const first = root.querySelector(selector);
            if (first) candidates.add(first);
        }
        for (const element of root.querySelectorAll('*')) {
            const className = String(element.getAttribute('class') || '').toLowerCase();
            if (['gnb', 'account', 'myview', 'link_login'].some((part) => className.includes(part))) {
                candidates.add(element);
            }
        }

        const selected = [...root.querySelectorAll('*')].filter((element) => candidates.has(element));
        const roots = selected.filter((element) => {
            let parent = element.parentElement;
            while (parent) {
                if (candidates.has(parent)) return false;
                parent = parent.parentElement;
            }
            return true;
        });
        let elementCount = 0;
        const maxElements = 4000;
        const safeTokenPattern = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
        const safePathSegmentPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,30}$/;
        const ariaRoles = new Set([
            'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
            'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo',
            'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure',
            'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
            'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
            'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option',
            'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
            'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
            'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
            'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
        ]);

        /** @param {string} value */
        const escapeAttribute = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        /** @param {string} value */
        const safeToken = (value) => safeTokenPattern.test(value)
            && !(/[@%]|\d{6}|secret|session|token|cookie|auth/i.test(value))
            ? value
            : 'X';
        /** @param {string} value */
        const reducedHref = (value) => {
            try {
                const url = new URL(value, root.baseURI || 'https://www.naver.com/');
                if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
                const pathname = url.pathname.split('/').map((segment) => {
                    if (segment === '') return '';
                    return safePathSegmentPattern.test(segment)
                        && !(/[@%]|\d{6}|secret|session|token|cookie|auth/i.test(segment))
                        ? segment
                        : ':x';
                }).join('/');
                return `${url.origin}${pathname}`;
            } catch {
                return null;
            }
        };
        /** @param {Element} element */
        const iframeOrigin = (element) => {
            const source = element.getAttribute('src');
            if (!source) return null;
            try {
                const url = new URL(source, root.baseURI || 'https://www.naver.com/');
                if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
                return url.origin;
            } catch {
                return null;
            }
        };
        /** @param {Element} element */
        const serialize = (element) => {
            if (elementCount >= maxElements) return '';
            elementCount += 1;
            const tag = element.tagName.toLowerCase();
            if (tag === 'iframe') {
                const origin = iframeOrigin(element);
                return origin
                    ? `<iframe data-src-origin="${escapeAttribute(origin)}"></iframe>`
                    : '<iframe></iframe>';
            }

            const attributes = [];
            for (const name of ['class', 'id', 'role', 'aria-label', 'href', 'data-clk']) {
                if (!element.hasAttribute(name)) continue;
                let value = element.getAttribute(name) || '';
                if (name === 'aria-label') value = 'LABEL';
                if (name === 'class') {
                    value = value.trim().split(/\s+/).filter(Boolean).map(safeToken).join(' ') || 'X';
                }
                if (name === 'id' || name === 'data-clk') value = safeToken(value);
                if (name === 'role') {
                    value = value.toLowerCase();
                    if (!ariaRoles.has(value)) continue;
                }
                if (name === 'href') {
                    const href = reducedHref(value);
                    if (href === null) continue;
                    value = href;
                }
                attributes.push(`${name}="${escapeAttribute(value)}"`);
            }

            const open = `<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}>`;
            let children = '';
            for (const child of element.childNodes) {
                if (child.nodeType === 1) {
                    children += serialize(/** @type {Element} */ (child));
                } else if (child.nodeType === 3) {
                    children += 'TEXT';
                }
                if (elementCount >= maxElements) break;
            }
            return `${open}${children}</${tag}>`;
        };

        return roots.map(serialize).join('');
    } catch {
        return '';
    }
}
