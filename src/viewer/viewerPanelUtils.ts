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

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { webviewBus } from '../webview/webview-bus';
import { isMessage } from '../webview/guard';

export function resolveMetadataPathForSdsFile(sdsPath: string, metadataExtension: string): string | undefined {
    const dir = path.dirname(sdsPath);
    const base = path.basename(sdsPath);
    const match = base.match(/^(.+)\.\d+(\.p)?\.sds$/);
    if (!match) {
        return undefined;
    }

    const metadataPath = path.join(dir, `${match[1]}${metadataExtension}`);
    return fs.existsSync(metadataPath) ? metadataPath : undefined;
}

export function generateNonce(length = 16): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export type ViewerHtmlOptions = {
    webview: vscode.Webview;
    extensionUri: vscode.Uri;
    styleFile: string;
    scriptFile: string;
    title: string;
    initialState: Record<string, unknown>;
};

export function buildViewerWebviewHtml(options: ViewerHtmlOptions): string {
    const { webview, extensionUri, styleFile, scriptFile, title, initialState } = options;

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', styleFile));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', scriptFile));
    const nonce = generateNonce();
    const stateJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource}; connect-src 'self';`;

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__INITIAL_STATE__ = ${stateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function registerViewerWebview(webview: vscode.Webview): vscode.Disposable {
    webviewBus.register(webview);

    const incomingDisposable = webview.onDidReceiveMessage((raw) => {
        if (!isMessage(raw)) {
            return;
        }
        webviewBus.handleIncoming(webview, raw);
    });

    webviewBus.sendInit(webview);

    return new vscode.Disposable(() => {
        incomingDisposable.dispose();
        webviewBus.unregister(webview);
    });
}
