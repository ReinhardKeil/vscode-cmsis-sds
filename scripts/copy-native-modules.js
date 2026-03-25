// Copy native modules (serialport, usb) into out/node_modules for VSIX packaging
const fs = require('fs-extra');
const path = require('path');

const modules = ['serialport', 'usb'];
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
