// The one web-ext ignore list, shared by every `web-ext lint`/`sign`/`build`
// invocation (CI, the publish workflow, local runs) — before this file there
// were three drifting --ignore-files copies and CI linted a different set of
// files than the release did. Semantics: what web-ext sees is exactly what
// ships — manifest.json, dist/ and icons/.
export default {
    ignoreFiles: [
        'web-ext-artifacts/**',
        'node_modules/**',
        '.git/**',
        '.github/**',
        '*.zip',
        '*.xpi',
        'tools/**',
        'tests/**',
        'src/**',
        'scripts/**',
        'ROADMAP.md',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'vite.*.config.js',
        'build_zip.sh',
        'tsconfig.json',
        'eslint.config.js',
        'vitest.config.js',
        'package.json',
        'LICENSE',
        'README.md',
        'AGENTS.md',
        'icons/*.xcf',
        'web-ext-config.mjs'
    ]
};
