const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

const importMetaPlugin = {
    name: 'import-meta-shim',
    setup(build) {
        build.onLoad({ filter: /node_modules[\\/]@(?:mariozechner|earendil-works)[\\/].*\.js$/ }, async (args) => {
            let contents = await fs.promises.readFile(args.path, 'utf8');
            if (!contents.includes('import.meta')) return;
            contents = contents.replace(
                /\bimport\.meta\.resolve\b/g,
                '((_spec) => globalThis.__piBundle.pathToFileURL(require.resolve(_spec)).href)',
            );
            contents = contents.replace(
                /\bimport\.meta\.url\b/g,
                'globalThis.__piBundle.url',
            );
            return { contents, loader: 'js' };
        });
    },
};

/** Must match runtime node_modules so ~/.pi/agent npm packages share one SDK. */
const PI_SDK_EXTERNALS = [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
];

const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode', ...PI_SDK_EXTERNALS],
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    minify: false,
    plugins: [importMetaPlugin],
    banner: {
        js: [
            'globalThis.__piBundle = (function() {',
            '  var u = require("url");',
            '  var meta = u.pathToFileURL(__filename).href;',
            '  return { url: meta, pathToFileURL: u.pathToFileURL };',
            '})();',
        ].join('\n'),
    },
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
