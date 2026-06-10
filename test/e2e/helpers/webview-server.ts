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
const REPO_ROOT = path.resolve(__dirname, '../../..');

function assertWebviewAssetsExist(assets: string[]): void {
    const missing = assets.filter(asset => !fs.existsSync(path.join(REPO_ROOT, asset)));
    if (missing.length > 0) {
        throw new Error(
            `Missing webview build artifacts: ${missing.join(', ')}. Run \"npm run compile:webviews\" before e2e tests.`
        );
    }
}

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
 * Get the viewer panel HTML with fixture data embedded.
 * Uses the first `getHtml` in the viewer (the main data view, not the error view).
 */
export function getViewerHtml(): string {
    assertWebviewAssetsExist(['out/dataViewerWebview.css', 'out/dataViewerWebview.js']);

    const sampleData = [
        { timestamp: 0, timeSeconds: 0.0, values: { x: 1.0, y: 2.0, z: 3.0 } },
        { timestamp: 10, timeSeconds: 0.01, values: { x: 1.5, y: 2.5, z: 3.5 } },
        { timestamp: 20, timeSeconds: 0.02, values: { x: 2.0, y: 3.0, z: 4.0 } },
    ];
    const channelNames = ['x', 'y', 'z'];
    const stats = {
        fileSize: 1024,
        totalRecords: 3,
        recordingTimeSeconds: 0.02,
        recordingIntervalMs: 10,
        dataRate: 600,
        avgBlockSize: 12,
    };
    const metadata = {
        sds: {
            name: 'TestAccel', frequency: 100, content: [
                { value: 'x', type: 'float', unit: 'mG' },
                { value: 'y', type: 'float', unit: 'mG' },
                { value: 'z', type: 'float', unit: 'mG' },
            ]
        },
    };

    const initialState = {
        samples: sampleData,
        channelNames,
        stats,
        metadata,
        domainStart: 0,
        domainEnd: 0.02,
        fileName: 'TestAccel.0.sds',
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Viewer Test</title>
    <link rel="stylesheet" href="/out/dataViewerWebview.css">
</head>
<body>
    <div id="root"></div>
    ${MOCK_VSCODE_API}
    <script>window.__INITIAL_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};</script>
    <script src="/out/dataViewerWebview.js"></script>
</body>
</html>`;
}

/**
 * Get the media viewer HTML for image type with fixture data.
 */
export function getImageViewerHtml(): string {
    const width = 4, height = 4;
    const frames: { rgbaBase64: string; timestamp: number }[] = [];
    for (let f = 0; f < 3; f++) {
        const rgba = Buffer.alloc(width * height * 4);
        for (let i = 0; i < rgba.length; i++) {
            rgba[i] = Math.floor(Math.random() * 256);
        }
        frames.push({ rgbaBase64: rgba.toString('base64'), timestamp: f * 0.1 });
    }
    return buildMediaHtml({
        fileName: 'test-image.sds',
        mediaType: 'image',
        image: {
            frames,
            rangeStart: 0,
            width,
            height,
            totalFrames: 3,
        },
    });
}

/**
 * Get the media viewer HTML for audio type with fixture data.
 */
export function getAudioViewerHtml(): string {
    const sampleRate = 16000;
    const bitDepth = 16;
    const channels = 1;
    const totalSamples = 1600;
    const totalRecords = 2;

    const frameSamples = Array.from({ length: 800 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / sampleRate));
    const frames = [
        { timestamp: 0, samples: frameSamples },
        { timestamp: 0.05, samples: frameSamples },
    ];

    return buildMediaHtml({
        fileName: 'test-audio.sds',
        mediaType: 'audio',
        audio: {
            samples: frames,
            rangeStart: 0,
            rangeEnd: 0.1,
            domainStart: 0,
            domainEnd: 0.1,
            sampleRate,
            bitDepth,
            channels,
            totalSamples,
            totalRecords,
        },
    });
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

    return buildMediaHtml({
        fileName: 'test-video.sds',
        mediaType: 'video',
        video: {
            frames,
            rangeStart: 0,
            width,
            height,
            fps,
            totalFrames: 5,
        },
    });
}

function buildMediaHtml(initialState: Record<string, unknown>): string {
    assertWebviewAssetsExist(['out/mediaViewerWebview.css', 'out/mediaViewerWebview.js']);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Media Viewer Test</title>
    <link rel="stylesheet" href="/out/mediaViewerWebview.css">
</head>
<body>
    <div id="root"></div>
    ${MOCK_VSCODE_API}
    <script>window.__INITIAL_STATE__ = ${JSON.stringify(initialState).replace(/</g, '\\u003c')};</script>
    <script src="/out/mediaViewerWebview.js"></script>
</body>
</html>`;
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
 *   /viewer   → Viewer panel
 *   /image    → Image media viewer
 *   /audio    → Audio media viewer
 *   /video    → Video media viewer
 */
export async function startServer(port = 0): Promise<{ server: http.Server; baseUrl: string }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (!req.url) {
                res.statusCode = 400;
                res.end('Bad request');
                return;
            }

            if (req.url.startsWith('/out/')) {
                const filePath = path.join(REPO_ROOT, req.url.replace(/^\//, ''));
                if (!fs.existsSync(filePath)) {
                    res.statusCode = 404;
                    res.end('Not found');
                    return;
                }

                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                } else if (filePath.endsWith('.css')) {
                    res.setHeader('Content-Type', 'text/css; charset=utf-8');
                } else {
                    res.setHeader('Content-Type', 'application/octet-stream');
                }
                res.end(fs.readFileSync(filePath));
                return;
            }

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            try {
                switch (req.url) {
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
            } catch (err) {
                res.statusCode = 500;
                res.end(`Error: ${err instanceof Error ? err.message : String(err)}
${err instanceof Error ? err.stack : ''}`);
            }
        });

        server.listen(port, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object' && 'port' in addr) {
                resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
            } else {
                reject(new Error('Failed to get server address'));
            }
        });

        server.on('error', reject);
    });
}
