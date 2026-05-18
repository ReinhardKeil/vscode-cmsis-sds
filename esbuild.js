/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/src/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'es2021',
    sourcemap: !production,
    minify: production,
    // Mangle private properties (prefixed with _) for extra obfuscation
    mangleProps: production ? /^_/ : undefined,
    treeShaking: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewBase = {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    define: {
        'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
};

const webviewEntries = [
    { entryPoints: ['src/viewer/webview/viewerApp.tsx'], outfile: 'out/viewerWebview.js' },
    { entryPoints: ['src/viewer/webview/mediaViewerApp.tsx'], outfile: 'out/mediaViewerWebview.js' },
];

async function buildOnce() {
    await esbuild.build(extensionBuild);
    await Promise.all(webviewEntries.map(cfg => esbuild.build({ ...webviewBase, ...cfg })));
    console.log(`✓ Bundled extension + webviews${production ? ' (minified)' : ''}`);
}

async function buildWatch() {
    const contexts = [];
    contexts.push(await esbuild.context(extensionBuild));
    for (const cfg of webviewEntries) {
        contexts.push(await esbuild.context({ ...webviewBase, ...cfg }));
    }
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes…');
}

async function main() {
    if (watch) {
        await buildWatch();
    } else {
        await buildOnce();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
