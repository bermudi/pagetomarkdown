import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: mode !== 'production',
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
}));
