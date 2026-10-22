import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: mode !== 'production',
        lib: {
            entry: 'src/content.ts',
            name: 'PageToMarkdownContent',
            formats: ['iife'],
            fileName: () => 'content.js'
        },
        rollupOptions: {
            output: {
                inlineDynamicImports: true
            }
        }
    }
}));
