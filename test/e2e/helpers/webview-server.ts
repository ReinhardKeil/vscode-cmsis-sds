/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Test helper: serves webview HTML with a mock vscode API.
 *
 * Extracts HTML from panel source files, substitutes template variables
 * with test defaults, and injects a mock `acquireVsCodeApi()` that
 * captures outbound messages and allows injecting inbound messages.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

/** Mock vscode API script injected before the webview's own <script>. */
const MOCK_VSCODE_API = `
<script>
    // Mock vscode API for Playwright testing
    window.__messages = [];
    window.__postToWebview = function(msg) {
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
    };
    window.acquireVsCodeApi = function() {
        return {
            postMessage: function(msg) { window.__messages.push(msg); },
            getState: function() { return window.__state || {}; },
            setState: function(s) { window.__state = s; },
        };
    };
</script>
`;

/**
 * Extract the HTML template from a panel source file.
 * Looks for `return /*html*​/ \`...\`` and returns the content.
 */
function extractHtml(sourceFile: string): string {
    const src = fs.readFileSync(path.join(SRC_ROOT, sourceFile), 'utf-8');
    // Find the HTML template — match `return /*html*/ \`...\``
    // We need to find the matching closing backtick (not inside nested template expressions)
    const marker = 'return /*html*/ `';
    const idx = src.indexOf(marker);
    if (idx === -1) { throw new Error(`No /*html*/ template found in ${sourceFile}`); }

    const start = idx + marker.length;
    // Find the matching closing backtick by tracking nesting depth of ${}
    let depth = 0;
    let i = start;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') { i += 2; continue; } // skip escaped chars
        if (ch === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (ch === '{' && depth > 0) { depth++; }
        if (ch === '}' && depth > 0) { depth--; i++; continue; }
        if (ch === '`' && depth === 0) { break; }
        i++;
    }

    return src.substring(start, i);
}

/**
 * Get the recorder panel HTML with template vars replaced by test defaults.
 */
export function getRecorderHtml(): string {
    let html = extractHtml('recorder/sdsRecorderPanel.ts');

    // Replace template expressions with test defaults
    html = html.replace(/\$\{defaultPort\}/g, '');
    html = html.replace(/\$\{defaultBaud === 115200 \? 'selected' : ''\}/g, 'selected');
    html = html.replace(/\$\{defaultDir\}/g, './sds_recordings');

    return injectMockApi(html);
}

/**
 * Get the viewer panel HTML with fixture data embedded.
 * Uses the first `getHtml` in the viewer (the main data view, not the error view).
 */
export function getViewerHtml(): string {
    // The viewer HTML has complex data embedding (JSON samples, channel names, etc.)
    // Create a fixture HTML that replicates the structure with test data.
    const sampleData = [
        { timeSeconds: 0.0, values: { x: 1.0, y: 2.0, z: 3.0 } },
        { timeSeconds: 0.01, values: { x: 1.5, y: 2.5, z: 3.5 } },
        { timeSeconds: 0.02, values: { x: 2.0, y: 3.0, z: 4.0 } },
    ];
    const channelNames = ['x', 'y', 'z'];
    const stats = {
        fileSize: 1024,
        totalRecords: 3,
        recordingTimeSeconds: 0.02,
        avgBlockSize: 12,
    };
    const metadata = {
        sds: { name: 'TestAccel', frequency: 100, content: [
            { value: 'x', type: 'float', unit: 'mG' },
            { value: 'y', type: 'float', unit: 'mG' },
            { value: 'z', type: 'float', unit: 'mG' },
        ]},
    };

    let html = extractHtml('viewer/sdsViewerPanel.ts');

    // Replace template expressions
    html = html.replace(/\$\{escapeHtml\(fileName\)\}/g, 'TestAccel.0.sds');
    html = html.replace(/\$\{experimental \? '[^']*' : ''\}/g, '');
    html = html.replace(/\$\{experimental \? `[^`]*` : ''\}/g, '');
    html = html.replace(/\$\{dataJson\}/g, JSON.stringify(sampleData));
    html = html.replace(/\$\{channelsJson\}/g, JSON.stringify(channelNames));
    html = html.replace(/\$\{statsJson\}/g, JSON.stringify(stats));
    html = html.replace(/\$\{metaJson\}/g, JSON.stringify(metadata));
    html = html.replace(/\$\{experimental \? 'true' : 'false'\}/g, 'false');

    return injectMockApi(html);
}

/**
 * Get the media viewer HTML for image type with fixture data.
 */
export function getImageViewerHtml(): string {
    const width = 4, height = 4;
    // Create tiny RGBA frames (4x4 pixels, 3 frames) matching the expected format
    const frames: { rgbaBase64: string; timestamp: number }[] = [];
    for (let f = 0; f < 3; f++) {
        const rgba = Buffer.alloc(width * height * 4);
        for (let i = 0; i < rgba.length; i++) {
            rgba[i] = Math.floor(Math.random() * 256);
        }
        frames.push({ rgbaBase64: rgba.toString('base64'), timestamp: f * 0.1 });
    }

    // Extract the image viewer HTML (second getHtml in the file — index-based)
    let html = extractHtmlByIndex('viewer/sdsMediaViewerPanel.ts', 0);

    // Replace template expressions
    html = html.replace(/\$\{width\}/g, String(width));
    html = html.replace(/\$\{height\}/g, String(height));
    html = html.replace(/\$\{totalFrames\}/g, '3');
    html = html.replace(/\$\{frames\.length\}/g, '3');
    html = html.replace(/\$\{frames\.length - 1\}/g, '2');
    html = html.replace(/\$\{JSON\.stringify\(frames\)\}/g, JSON.stringify(frames));

    return injectMockApi(html);
}

/**
 * Get the media viewer HTML for audio type with fixture data.
 */
export function getAudioViewerHtml(): string {
    const sampleRate = 16000;
    const bitDepth = 16;
    const channels = 1;
    const totalSamples = 1600;
    const durationSec = 0.1;
    const totalRecords = 2;

    // Generate simple sine wave samples
    const samples: number[] = [];
    for (let i = 0; i < totalSamples; i++) {
        samples.push(Math.sin(2 * Math.PI * 440 * i / sampleRate));
    }

    let html = extractHtmlByIndex('viewer/sdsMediaViewerPanel.ts', 1);

    html = html.replace(/\$\{sampleRate\}/g, String(sampleRate));
    html = html.replace(/\$\{bitDepth\}/g, String(bitDepth));
    html = html.replace(/\$\{channels\}/g, String(channels));
    html = html.replace(/\$\{totalSamples\.toLocaleString\(\)\}/g, totalSamples.toLocaleString());
    html = html.replace(/\$\{durationSec\.toFixed\(2\)\}/g, durationSec.toFixed(2));
    html = html.replace(/\$\{totalRecords\}/g, String(totalRecords));
    html = html.replace(/\$\{JSON\.stringify\(samples\)\}/g, JSON.stringify(samples));
    html = html.replace(/\$\{totalSamples\}/g, String(totalSamples));

    return injectMockApi(html);
}

/**
 * Get the media viewer HTML for video type with fixture data.
 */
export function getVideoViewerHtml(): string {
    const width = 4, height = 4, fps = 10;
    const frames: { rgbaBase64: string; timestamp: number }[] = [];
    for (let f = 0; f < 5; f++) {
        const rgba = Buffer.alloc(width * height * 4, f * 50);
        frames.push({ rgbaBase64: rgba.toString('base64'), timestamp: f * 0.1 });
    }

    let html = extractHtmlByIndex('viewer/sdsMediaViewerPanel.ts', 2);

    html = html.replace(/\$\{width\}/g, String(width));
    html = html.replace(/\$\{height\}/g, String(height));
    html = html.replace(/\$\{fps\}/g, String(fps));
    html = html.replace(/\$\{totalFrames\}/g, '5');
    html = html.replace(/\$\{frames\.length\}/g, '5');
    html = html.replace(/\$\{frames\.length - 1\}/g, '4');
    html = html.replace(/\$\{JSON\.stringify\(frames\)\}/g, JSON.stringify(frames));

    return injectMockApi(html);
}

/**
 * Extract the Nth HTML template from a source file (0-indexed).
 */
function extractHtmlByIndex(sourceFile: string, index: number): string {
    const src = fs.readFileSync(path.join(SRC_ROOT, sourceFile), 'utf-8');
    const marker = 'return /*html*/ `';
    let searchFrom = 0;
    let count = 0;

    while (count <= index) {
        const idx = src.indexOf(marker, searchFrom);
        if (idx === -1) {
            throw new Error(`HTML template #${index} not found in ${sourceFile}`);
        }
        if (count === index) {
            const start = idx + marker.length;
            let depth = 0;
            let i = start;
            while (i < src.length) {
                const ch = src[i];
                if (ch === '\\') { i += 2; continue; }
                if (ch === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
                if (ch === '{' && depth > 0) { depth++; }
                if (ch === '}' && depth > 0) { depth--; i++; continue; }
                if (ch === '`' && depth === 0) { break; }
                i++;
            }
            return src.substring(start, i);
        }
        searchFrom = idx + marker.length;
        count++;
    }

    throw new Error(`HTML template #${index} not found in ${sourceFile}`);
}

/** Inject mock vscode API script before the first <script> tag in the HTML. */
function injectMockApi(html: string): string {
    // Insert mock before the first <script> in the body
    const scriptIdx = html.lastIndexOf('<script>');
    if (scriptIdx === -1) {
        return html + MOCK_VSCODE_API;
    }
    return html.substring(0, scriptIdx) + MOCK_VSCODE_API + html.substring(scriptIdx);
}

/**
 * Start a simple HTTP server that serves webview HTML.
 * Routes:
 *   /recorder → Recorder panel
 *   /viewer   → Viewer panel
 *   /image    → Image media viewer
 *   /audio    → Audio media viewer
 *   /video    → Video media viewer
 */
export async function startServer(port = 0): Promise<{ server: http.Server; baseUrl: string }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            try {
                switch (req.url) {
                    case '/recorder':
                        res.end(getRecorderHtml());
                        break;
                    case '/viewer':
                        res.end(getViewerHtml());
                        break;
                    case '/image':
                        res.end(getImageViewerHtml());
                        break;
                    case '/audio':
                        res.end(getAudioViewerHtml());
                        break;
                    case '/video':
                        res.end(getVideoViewerHtml());
                        break;
                    default:
                        res.statusCode = 404;
                        res.end('Not found');
                }
            } catch (err: any) {
                res.statusCode = 500;
                res.end(`Error: ${err.message}
${err.stack}`);
            }
        });

        server.listen(port, '127.0.0.1', () => {
            const addr = server.address() as any;
            resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
        });

        server.on('error', reject);
    });
}
