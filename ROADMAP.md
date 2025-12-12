# ROADMAP: Code Block Extraction & Heading Cleanup

## Problem Summary

The extension fails to extract code blocks from certain pages and produces unclean headings with anchor links. Comparison with Obsidian Web Clipper shows significant gaps.

### Issue 1: Missing Code Blocks

**Current output:**
```markdown
### Call "get_bot_response" or "get_bot_response_sync".

In a python shell, run the following after replacing the placeholder with an API key.

For asynchronous applications, use `fp.get_bot_response` instead of `fp.get_bot_response_sync`.
```

**Expected output (Obsidian clipper):**
```markdown
### Call "get_bot_response" or "get_bot_response_sync".

In a python shell, run the following after replacing the placeholder with an API key.

\`\`\`
import fastapi_poe as fp
api_key = <api_key> # replace this with your API key
...
\`\`\`
```

### Issue 2: Unclean Headings with Anchor Links

**Current output:**
```markdown
### [Install Dependencies](#install-dependencies)
```

**Expected output:**
```markdown
### Install Dependencies
```

---

## Root Cause Analysis

### Code Block Issue

1. **Readability Stripping**: The Mozilla Readability library may be stripping `<pre>` and `<code>` elements from certain page structures, especially when:
   - Code blocks are inside non-standard containers
   - Code blocks have complex syntax highlighting (many nested `<span>` elements)
   - The page uses custom code block components (React, Vue, etc.)

2. **Language Detection Limitation**: Current rule in `content.js:44-56` only detects language via `class="language-*"` pattern, missing:
   - `data-lang` attribute (used by many highlighters)
   - `data-language` attribute
   - Class patterns like `hljs`, `highlight-*`, `prism-*`

3. **Code Content Extraction**: Using `node.textContent` directly works, but may fail if:
   - The `<pre>` element has no `<code>` child
   - Syntax highlighters insert extra whitespace/formatting

### Heading Link Issue

The current implementation has no special handling for headings wrapped in anchor links. Common pattern on documentation sites:

```html
<a href="#install-dependencies">
  <h3>Install Dependencies</h3>
</a>
```

Or self-linking headings:
```html
<h3>
  <a href="#install-dependencies">Install Dependencies</a>
</h3>
```

---

## Tasks

### Task 1: Improve Pre-Processing Before Readability
**File:** `content.js`
**Priority:** High

Before passing content to Readability, preserve code blocks by:

1. Clone the document
2. Find all `<pre>` elements
3. Mark them with a data attribute to prevent stripping
4. After Readability, restore any missing code blocks

```javascript
// Add method to AdvancedMarkdownConverter class
preserveCodeBlocks(doc) {
    const codeBlocks = doc.querySelectorAll('pre');
    codeBlocks.forEach((pre, index) => {
        pre.setAttribute('data-preserve-code', index);
        // Store original HTML in case Readability modifies it
        pre.setAttribute('data-original-html', pre.innerHTML);
    });
    return doc;
}
```

### Task 2: Enhanced Code Block Detection Rule
**File:** `content.js`
**Priority:** High

Replace the current `codeBlock` rule with a more robust version:

```javascript
this.turndown.addRule('preformattedCode', {
    filter: (node) => {
        return node.nodeName === 'PRE';
    },
    replacement: (content, node) => {
        const codeElement = node.querySelector('code');
        let language = '';
        let codeContent = '';
        
        if (codeElement) {
            // Try multiple language detection methods
            language = this.detectLanguage(codeElement);
            codeContent = codeElement.textContent || '';
        } else {
            // Pre without code child
            codeContent = node.textContent || '';
        }
        
        // Clean up the code content
        const cleanCode = codeContent.trim();
        
        if (!cleanCode) return '';
        
        return `\n\`\`\`${language}\n${cleanCode}\n\`\`\`\n`;
    }
});
```

Add language detection helper:

```javascript
detectLanguage(codeElement) {
    // 1. Check data-lang attribute
    let lang = codeElement.getAttribute('data-lang');
    if (lang) return lang;
    
    // 2. Check data-language attribute
    lang = codeElement.getAttribute('data-language');
    if (lang) return lang;
    
    // 3. Check class for language-* pattern
    const className = codeElement.className || '';
    let match = className.match(/language-(\w+)/);
    if (match) return match[1];
    
    // 4. Check class for lang-* pattern
    match = className.match(/lang-(\w+)/);
    if (match) return match[1];
    
    // 5. Check parent pre element
    const pre = codeElement.closest('pre');
    if (pre) {
        lang = pre.getAttribute('data-lang') || pre.getAttribute('data-language');
        if (lang) return lang;
        
        const preClass = pre.className || '';
        match = preClass.match(/language-(\w+)/) || preClass.match(/lang-(\w+)/);
        if (match) return match[1];
    }
    
    return '';
}
```

### Task 3: Add Heading Link Cleanup Rule
**File:** `content.js`
**Priority:** Medium

Add rule to handle headings inside links or links inside headings:

```javascript
// Handle links inside headings (self-linking headers)
this.turndown.addRule('headingLinks', {
    filter: (node) => {
        // Check if this is a heading with only an anchor link child
        if (/^H[1-6]$/.test(node.nodeName)) {
            const children = Array.from(node.childNodes).filter(
                n => n.nodeType !== Node.TEXT_NODE || n.textContent.trim()
            );
            if (children.length === 1 && children[0].nodeName === 'A') {
                return true;
            }
        }
        return false;
    },
    replacement: (content, node) => {
        const level = parseInt(node.nodeName.substring(1));
        const hashes = '#'.repeat(level);
        // Extract just the text content, stripping the link
        const text = node.textContent.trim();
        return `\n\n${hashes} ${text}\n\n`;
    }
});

// Handle headings wrapped in links
this.turndown.addRule('linkedHeadings', {
    filter: (node) => {
        if (node.nodeName === 'A') {
            const heading = node.querySelector('h1, h2, h3, h4, h5, h6');
            return !!heading;
        }
        return false;
    },
    replacement: (content, node) => {
        const heading = node.querySelector('h1, h2, h3, h4, h5, h6');
        const level = parseInt(heading.nodeName.substring(1));
        const hashes = '#'.repeat(level);
        const text = heading.textContent.trim();
        return `\n\n${hashes} ${text}\n\n`;
    }
});
```

### Task 4: Handle Inline Code Elements
**File:** `content.js`
**Priority:** Low

Ensure inline `<code>` elements (not inside `<pre>`) are properly converted:

```javascript
this.turndown.addRule('inlineCode', {
    filter: (node) => {
        return node.nodeName === 'CODE' && 
               (!node.parentNode || node.parentNode.nodeName !== 'PRE');
    },
    replacement: (content, node) => {
        const code = node.textContent || '';
        if (!code) return '';
        // Handle backticks in code
        if (code.includes('`')) {
            return '``' + code + '``';
        }
        return '`' + code + '`';
    }
});
```

### Task 5: Fallback Content Extraction
**File:** `content.js`
**Priority:** Medium

If Readability strips too much, implement a hybrid approach:

1. Run Readability to get article structure
2. Before conversion, check if code blocks exist in original but not in parsed
3. Re-inject missing code blocks from original document

```javascript
extractMainContent() {
    const originalCodeBlocks = Array.from(document.querySelectorAll('pre'));
    
    // Try Readability...
    // After getting parsed content:
    
    const parsedCodeBlocks = parsedDoc.querySelectorAll('pre');
    
    // If significant code blocks are missing, consider hybrid approach
    if (originalCodeBlocks.length > 0 && parsedCodeBlocks.length === 0) {
        console.warn('Readability stripped code blocks, using hybrid extraction');
        // Inject code blocks back or use different strategy
    }
}
```

### Task 6: Add Debug Mode
**File:** `content.js`
**Priority:** Low

Add optional debug logging to diagnose extraction issues:

```javascript
constructor() {
    this.debug = false; // Set to true for debugging
    // ...
}

log(...args) {
    if (this.debug) {
        console.log('[PageToMD]', ...args);
    }
}
```

---

## Implementation Order

1. **Task 2** - Enhanced code block detection (quick win, may solve most issues)
2. **Task 3** - Heading link cleanup (fixes the cosmetic issue)
3. **Task 1** - Pre-processing preservation (if Task 2 doesn't fully solve it)
4. **Task 5** - Fallback extraction (if Readability is the root cause)
5. **Task 4** - Inline code handling (polish)
6. **Task 6** - Debug mode (development aid)

---

## Testing

After implementation, test against:

1. The Poe API documentation page (original issue)
2. GitHub README pages with code blocks
3. MDN documentation
4. Stack Overflow answers
5. Medium/Dev.to technical articles
6. Sites using Prism.js, Highlight.js, Shiki

---

## Reference

### Obsidian Clipper Implementation

Key code from `obsidian-clipper-src/utils/markdown-converter.ts:433-453`:

```typescript
turndownService.addRule('preformattedCode', {
    filter: (node) => {
        return node.nodeName === 'PRE';
    },
    replacement: (content, node) => {
        if (!(node instanceof HTMLElement)) return content;
        
        const codeElement = node.querySelector('code');
        if (!codeElement) return content;
        
        const language = codeElement.getAttribute('data-lang') || '';
        const code = codeElement.textContent || '';
        
        const cleanCode = code.trim().replace(/`/g, '\\`');
        
        return `\n\`\`\`${language}\n${cleanCode}\n\`\`\`\n`;
    }
});
```

### Current Implementation

From `content.js:44-56`:

```javascript
this.turndown.addRule('codeBlock', {
    filter: ['pre'],
    replacement: (content, node) => {
        const code = node.querySelector('code');
        let language = '';
        if (code) {
            const className = code.className || '';
            const match = className.match(/language-(\w+)/);
            if (match) language = match[1];
        }
        return `\n\`\`\`${language}\n${node.textContent.trim()}\n\`\`\`\n\n`;
    }
});
```

The current implementation should work for basic cases. The issue is likely **Readability stripping the code blocks before they reach Turndown**. Priority should be on Task 1 and Task 5.
