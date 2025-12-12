import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        lib: {
            entry: 'src/background.js',
            name: 'PageToMarkdownBackground',
            formats: ['iife'],
            fileName: () => 'background.js'
        },
        rollupOptions: {
            output: {
                inlineDynamicImports: true
            }
        }
    }
});
