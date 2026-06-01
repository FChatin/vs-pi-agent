const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    minify: false,
};

const webviewConfig = {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'out/webview/main.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: false,
};

const settingsWebviewConfig = {
    entryPoints: ['src/webview/settings.ts'],
    bundle: true,
    outfile: 'out/webview/settings.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    minify: false,
};

async function copyStyles() {
    const stylesDir = path.join('out', 'webview', 'styles');
    await fs.promises.mkdir(stylesDir, { recursive: true });
    const srcDir = path.join('src', 'webview', 'styles');
    for (const file of await fs.promises.readdir(srcDir)) {
        await fs.promises.copyFile(path.join(srcDir, file), path.join(stylesDir, file));
    }
}

async function build() {
    if (isWatch) {
        await copyStyles();
        const extCtx = await esbuild.context(extensionConfig);
        const webCtx = await esbuild.context(webviewConfig);
        const settingsCtx = await esbuild.context(settingsWebviewConfig);
        await Promise.all([extCtx.watch(), webCtx.watch(), settingsCtx.watch()]);
        console.log('Watching for changes...');
    } else {
        await esbuild.build(extensionConfig);
        await esbuild.build(webviewConfig);
        await esbuild.build(settingsWebviewConfig);
        await copyStyles();
        console.log('Build complete.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
