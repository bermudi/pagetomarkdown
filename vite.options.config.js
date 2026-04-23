import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

export default defineConfig({
    base: './',
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        sourcemap: true,
        rollupOptions: {
            input: path.resolve(__dirname, 'src/options.html'),
            output: {
                entryFileNames: 'options.js',
                assetFileNames: (assetInfo) => {
                    if (assetInfo.names?.some((n) => n.endsWith('.css'))) {
                        return 'options.css';
                    }
                    return '[name][extname]';
                }
            }
        }
    },
    plugins: [
        {
            name: 'flatten-options-html',
            writeBundle(_options, bundle) {
                const srcKey = Object.keys(bundle).find(
                    (k) => k.includes('/options.html') || k.includes('\\options.html')
                );
                if (srcKey && srcKey !== 'options.html') {
                    const srcPath = path.resolve(__dirname, 'dist', srcKey);
                    const destPath = path.resolve(__dirname, 'dist', 'options.html');
                    if (fs.existsSync(srcPath)) {
                        let html = fs.readFileSync(srcPath, 'utf-8');
                        html = html.replace(/src="\.\.\//g, 'src="./');
                        html = html.replace(/href="\.\.\//g, 'href="./');
                        fs.writeFileSync(destPath, html, 'utf-8');
                        fs.unlinkSync(srcPath);
                        const dir = path.dirname(srcPath);
                        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                            fs.rmdirSync(dir);
                        }
                    }
                }
            }
        }
    ]
});
