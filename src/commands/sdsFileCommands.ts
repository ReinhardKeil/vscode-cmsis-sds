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

import { SdsExplorerProvider, SdsTreeItem } from '../providers/sdsExplorerProvider';
import type { SdsioConfigManager } from '../controller/sdsioConfigManager';
import { SdsViewerPanel } from '../viewer/sdsViewerPanel';
import { SdsMediaViewerPanel } from '../viewer/sdsMediaViewerPanel';
import { decodeAllRecords, exportToCsv, parseMetadataFile, parseSdsFile, SDS_METADATA_EXTENSION } from '../sds';
import { SDS_FILE_MATCHER } from '../webview/utilities';

export interface RegisterSdsFileCommandsArgs {
    context: vscode.ExtensionContext;
    explorerProvider: SdsExplorerProvider;
    configManager: SdsioConfigManager;
}

export function registerSdsFileCommands(args: RegisterSdsFileCommandsArgs): void {
    const { context, explorerProvider, configManager } = args;

    // Open Viewer
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.openViewer', async (arg?: SdsTreeItem | vscode.Uri | string) => {
            try {
                let filePath = resolveSdsPath(arg);
                if (!filePath) {
                    const fp = await selectSdsFile();
                    if (!fp) { return; }
                    filePath = fp;
                }
                SdsViewerPanel.createOrShow(context.extensionUri, filePath, configManager);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open viewer: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // Create / Edit Metadata
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.createMetadata', async (arg?: SdsTreeItem | vscode.Uri | string) => {
            try {
                let filePath = resolveSdsPath(arg);
                if (!filePath) {
                    const fp = await selectSdsFile();
                    if (!fp) { return; }
                    filePath = fp;
                }
                const metaPath = metadataPathFor(filePath);
                if (!metaPath) {
                    vscode.window.showErrorMessage('Could not determine metadata file path.');
                    return;
                }
                if (fs.existsSync(metaPath)) {
                    const doc = await vscode.workspace.openTextDocument(metaPath);
                    await vscode.window.showTextDocument(doc);
                    return;
                }
                // Create a starter metadata template
                const streamName = path.basename(filePath).replace(SDS_FILE_MATCHER, '$1');
                const template = [
                    `sds:`,
                    `  name: ${streamName}`,
                    `  description: ''`,
                    `  frequency: 100`,
                    `  content:`,
                    `    - value: channel1`,
                    `      type: float`,
                    `      unit: ''`,
                ].join('\n') + '\n';
                fs.writeFileSync(metaPath, template, 'utf-8');
                const doc = await vscode.workspace.openTextDocument(metaPath);
                await vscode.window.showTextDocument(doc);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create metadata: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // Open group metadata
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.openGroupMetadata', async (arg?: SdsTreeItem | vscode.Uri | string) => {
            try {
                const metadataPath = resolveSdsPath(arg);
                if (!metadataPath) {
                    vscode.window.showErrorMessage('No metadata file found for this SDS group.');
                    return;
                }
                if (!fs.existsSync(metadataPath)) {
                    vscode.window.showErrorMessage(`Metadata file not found: ${metadataPath}`);
                    return;
                }

                const doc = await vscode.workspace.openTextDocument(metadataPath);
                await vscode.window.showTextDocument(doc);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open metadata: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // Export CSV
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.exportCsv', async (arg?: SdsTreeItem | vscode.Uri | string) => {
            try {
                const filePath = resolveSdsPath(arg);
                if (!filePath) {
                    const fp = await selectSdsFile();
                    if (!fp) { return; }
                    await doExportCsv(fp);
                    return;
                }
                await doExportCsv(filePath);
            } catch (err) {
                vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // Delete File
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.deleteFile', async (item: SdsTreeItem) => {
            if (!item?.filePath) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Delete ${path.basename(item.filePath)}?`,
                { modal: true },
                'Delete'
            );

            if (confirm === 'Delete') {
                try {
                    fs.unlinkSync(item.filePath);
                    explorerProvider.refresh();
                    vscode.window.showInformationMessage(`Deleted ${path.basename(item.filePath)}`);
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        })
    );

    // ── Media Viewer (image/audio/video) ──────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.openMediaViewer', async (arg?: SdsTreeItem | vscode.Uri | string) => {
            try {
                let filePath = resolveSdsPath(arg);
                if (!filePath) {
                    const fp = await selectSdsFile();
                    if (!fp) { return; }
                    filePath = fp;
                }
                SdsMediaViewerPanel.createOrShow(context.extensionUri, filePath, configManager);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open media viewer: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── Quick Open SDS File ─────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.quickOpen', async () => {
            try {
                const sdsFiles = await vscode.workspace.findFiles('**/*.sds', '**/node_modules/**');
                if (sdsFiles.length === 0) {
                    vscode.window.showInformationMessage('No SDS files found in workspace.');
                    return;
                }

                const items = sdsFiles.map(u => {
                    const rel = vscode.workspace.asRelativePath(u);
                    return { label: '$(graph-line) ' + path.basename(u.fsPath), description: rel, uri: u };
                });

                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select an SDS file to open',
                    matchOnDescription: true,
                });
                if (pick) {
                    SdsViewerPanel.createOrShow(context.extensionUri, pick.uri.fsPath, configManager);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Quick open failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsCheck', (arg?: SdsTreeItem | vscode.Uri | string) => {
            if (!arg) {
                void vscode.window.showErrorMessage('No SDS file selected for sds-check.');
                return;
            }
            const filePath = arg instanceof SdsTreeItem ? arg.filePath : (arg instanceof vscode.Uri ? arg.fsPath : arg);
            if (!filePath || !fs.existsSync(filePath)) {
                void vscode.window.showErrorMessage(`Selected SDS file does not exist: ${filePath}`);
                return;
            }
            const cmsisPackRoot = process.env.CMSIS_PACK_ROOT;
            if (!cmsisPackRoot) {
                void vscode.window.showErrorMessage('CMSIS_PACK_ROOT environment variable is not set. Please set it to the CMSIS Pack root directory.');
                return;
            }

            const sdsPackRoot = path.join(cmsisPackRoot, 'ARM', 'SDS');
            if (!fs.existsSync(sdsPackRoot)) {
                void vscode.window.showErrorMessage(`SDS Pack root directory does not exist: ${sdsPackRoot}`);
                return;
            }
            const recentVersionFolder = fs.readdirSync(sdsPackRoot).sort().pop();
            if (!recentVersionFolder) {
                void vscode.window.showErrorMessage(`No version folders found in SDS Pack root: ${sdsPackRoot}`);
                return;
            }
            const sdsCheck = path.join(sdsPackRoot, recentVersionFolder, 'utilities', 'sds-check.py');
            if (!fs.existsSync(sdsCheck)) {
                void vscode.window.showErrorMessage(`sds-check.py not found in SDS Pack: ${sdsCheck}`);
                return;
            }
            const terminal = vscode.window.createTerminal('SDS Check');
            terminal.show();
            terminal.sendText(`python "${sdsCheck}" -i "${filePath}"`);
        })
    );

}

function resolveSdsPath(arg?: SdsTreeItem | vscode.Uri | string): string | undefined {
    if (!arg) { return undefined; }
    if (typeof arg === 'string') { return arg; }
    if (arg instanceof vscode.Uri) { return arg.fsPath; }
    if ('filePath' in arg) { return (arg as SdsTreeItem).filePath; }
    return undefined;
}

async function selectSdsFile(): Promise<string | undefined> {
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'SDS files': ['sds'] },
        title: 'Select SDS data file',
    });
    return uris?.[0]?.fsPath;
}

/**
 * Return the expected metadata (.sds.yml) path for a given .sds file.
 * Pattern: <name>.<index>.sds -> <name>.sds.yml in the same directory.
 * Pattern: <name>.<index>.p.sds -> <name>.sds.yml in the same directory.
 */
function metadataPathFor(sdsPath: string): string | undefined {
    const dir = path.dirname(sdsPath);
    const base = path.basename(sdsPath);
    const match = base.match(SDS_FILE_MATCHER);
    if (match) {
        return path.join(dir, `${match[1]}${SDS_METADATA_EXTENSION}`);
    }
    return undefined;
}

async function doExportCsv(sdsPath: string): Promise<void> {
    const metaPath = metadataPathFor(sdsPath);
    if (!metaPath || !fs.existsSync(metaPath)) {
        vscode.window.showErrorMessage('No metadata (.sds.yml) file found. Cannot decode data for CSV export.');
        return;
    }

    const csvUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(sdsPath.replace(/\.sds$/, '.csv')),
        filters: { 'CSV files': ['csv'] },
        title: 'Export SDS to CSV',
    });
    if (!csvUri) { return; }

    try {
        const metadata = parseMetadataFile(metaPath);
        const parsed = parseSdsFile(sdsPath);
        const samples = decodeAllRecords(parsed, metadata);

        exportToCsv(samples, metadata.sds.content, csvUri.fsPath, true);
        vscode.window.showInformationMessage(
            `Exported ${samples.length} samples to ${path.basename(csvUri.fsPath)}`
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
