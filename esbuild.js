const esbuild = require('esbuild');

const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/src/extension.js',
    external: [
        'vscode',
        // Native addons — cannot be bundled
        'serialport',
        'usb',
    ],
    format: 'cjs',
    platform: 'node',
    target: 'es2021',
    sourcemap: !production,
    minify: production,
    // Mangle private properties (prefixed with _) for extra obfuscation
    mangleProps: production ? /^_/ : undefined,
    treeShaking: true,
};

async function main() {
    const ctx = await esbuild.context(buildOptions);
    if (process.argv.includes('--watch')) {
        await ctx.watch();
        console.log('Watching for changes…');
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        console.log(`✓ Bundled extension.js${production ? ' (minified)' : ''}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
