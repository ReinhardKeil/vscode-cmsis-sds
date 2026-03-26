// Copy native modules (serialport, usb) into out/node_modules for VSIX packaging
const fs = require('fs-extra');
const path = require('path');

const modules = [
    'serialport',
    'usb',
    '@serialport/binding-mock',
    '@serialport/bindings-cpp',
    '@serialport/bindings-interface',
    '@serialport/parser-byte-length',
    '@serialport/parser-cctalk',
    '@serialport/parser-delimiter',
    '@serialport/parser-inter-byte-timeout',
    '@serialport/parser-packet-length',
    '@serialport/parser-readline',
    '@serialport/parser-ready',
    '@serialport/parser-regex',
    '@serialport/parser-slip-encoder',
    '@serialport/parser-spacepacket',
    '@serialport/stream',
    'ms',
    'debug',
    'node-gyp-build',
];
const outNodeModules = path.join(__dirname, '..', 'out', 'node_modules');

fs.ensureDirSync(outNodeModules);

for (const mod of modules) {
    const src = path.join(__dirname, '..', 'node_modules', mod);
    const dest = path.join(outNodeModules, mod);
    if (fs.existsSync(src)) {
        fs.copySync(src, dest, { overwrite: true });
        console.log(`Copied ${mod} to out/node_modules`);
    } else {
        console.warn(`Module ${mod} not found in node_modules`);
    }
}
