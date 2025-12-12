import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        lib: {
            entry: 'src/content.js',
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
});
