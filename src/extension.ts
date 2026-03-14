/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * CMSIS SDS — VS Code Extension Entry Point
 *
 * Registers commands, views, providers, and webview panels
 * for the CMSIS SDS extension (viewer, recorder, media viewer).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { SdsExplorerProvider, SdsTreeItem } from './providers/sdsExplorerProvider';
import { SdsViewerPanel } from './viewer/sdsViewerPanel';
import { SdsMediaViewerPanel } from './viewer/sdsMediaViewerPanel';
import { SdsRecorderPanel } from './recorder/sdsRecorderPanel';
import { SdsDiagnostics, DiagnosticSource, diag } from './diagnostics/sdsDiagnostics';
import {
    parseSdsFile,
    decodeAllRecords,
    parseMetadataFile,
    exportToCsv,
    SDS_METADATA_EXTENSION,
    SdsMetadata,
} from './sds';

export function activate(context: vscode.ExtensionContext) {
    // ── Diagnostics Output Channel ──────────────────────────────
    const diagnostics = SdsDiagnostics.getInstance();
    diagnostics.writeBanner();
    diagnostics.info(DiagnosticSource.Extension, 'CMSIS SDS extension activating...');
    context.subscriptions.push(diagnostics.outputChannel);

    // ── Tree Views ──────────────────────────────────────────────
    const explorerProvider = new SdsExplorerProvider();
    vscode.window.registerTreeDataProvider('sdsExplorer', explorerProvider);

    // ── Commands ────────────────────────────────────────────────

    // Refresh Explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.refreshExplorer', () => {
            explorerProvider.refresh();
        })
    );

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
                SdsViewerPanel.createOrShow(context.extensionUri, filePath);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open viewer: ${err.message}`);
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
                const streamName = path.basename(filePath).replace(/\.\d+\.sds$/, '');
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to create metadata: ${err.message}`);
            }
        })
    );

    // Open Recorder
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.openRecorder', () => {
            SdsRecorderPanel.createOrShow(context.extensionUri);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Export failed: ${err.message}`);
            }
        })
    );

    // New Recording (opens recorder)
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.newRecording', () => {
            SdsRecorderPanel.createOrShow(context.extensionUri);
        })
    );

    // Initialize / Open Workspace
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.initWorkspace', async () => {
            try {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                const action = await vscode.window.showInformationMessage(
                    'CMSIS SDS needs an open workspace folder to store recordings and data.',
                    'Open Folder',
                    'Create New Folder'
                );

                if (action === 'Open Folder') {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        openLabel: 'Open as SDS Workspace',
                    });
                    if (uris && uris.length > 0) {
                        await vscode.commands.executeCommand('vscode.openFolder', uris[0]);
                    }
                    return;
                } else if (action === 'Create New Folder') {
                    const parentUri = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        openLabel: 'Select Parent Folder',
                    });
                    if (!parentUri || parentUri.length === 0) { return; }

                    const folderName = await vscode.window.showInputBox({
                        prompt: 'Name for the new SDS project folder',
                        value: 'sds-project',
                        validateInput: (v) => {
                            if (!v || v.trim().length === 0) { return 'Name cannot be empty'; }
                            if (/[/:]/.test(v)) { return 'Invalid characters in name'; }
                            return undefined;
                        },
                    });
                    if (!folderName) { return; }

                    const newFolder = vscode.Uri.joinPath(parentUri[0], folderName.trim());
                    await vscode.workspace.fs.createDirectory(newFolder);
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(newFolder, 'sds_recordings'));

                    const readmeContent = Buffer.from([
                        `# ${folderName.trim()}`,
                        '',
                        'SDS (Synchronous Data Stream) workspace created with CMSIS SDS.',
                        '',
                        '## Directory Structure',
                        '',
                        '- `sds_recordings/` — Raw SDS binary recordings and metadata',
                        '',
                        '## Getting Started',
                        '',
                        '1. Use **CMSIS SDS: Open SDS Recorder** to capture data',
                        '2. View recordings with **CMSIS SDS: Open SDS Viewer**',
                        '3. Export with **CMSIS SDS: Export SDS to CSV**',
                        '',
                        '## Resources',
                        '',
                        '- [SDS Framework](https://arm-software.github.io/SDS-Framework/)',
                        '',
                    ].join('\n'));
                    await vscode.workspace.fs.writeFile(
                        vscode.Uri.joinPath(newFolder, 'README.md'),
                        readmeContent
                    );

                    const gitignoreContent = Buffer.from([
                        '# SDS workspace',
                        '.cmsis-sds',
                        '*.log',
                        '',
                    ].join('\n'));
                    await vscode.workspace.fs.writeFile(
                        vscode.Uri.joinPath(newFolder, '.gitignore'),
                        gitignoreContent
                    );

                    await vscode.commands.executeCommand('vscode.openFolder', newFolder);
                    return;
                }
                return;
            }

            // Workspace already open — ensure recordings directory exists, then open recorder
            const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const recordingsDir = path.join(wsRoot, 'sds_recordings');
            if (!fs.existsSync(recordingsDir)) {
                fs.mkdirSync(recordingsDir, { recursive: true });
            }
            SdsRecorderPanel.createOrShow(context.extensionUri);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Workspace init failed: ${err.message}`);
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
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to delete: ${err.message}`);
                }
            }
        })
    );

    // ── Diagnostics Commands ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.showDiagnostics', () => {
            diag().show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.clearDiagnostics', () => {
            diag().clear();
            vscode.window.showInformationMessage('CMSIS SDS diagnostics log cleared.');
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
                SdsMediaViewerPanel.createOrShow(context.extensionUri, filePath);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open media viewer: ${err.message}`);
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
                    SdsViewerPanel.createOrShow(context.extensionUri, pick.uri.fsPath);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Quick open failed: ${err.message}`);
            }
        })
    );

    // ── Status Bar ──────────────────────────────────────────────
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = '$(graph-line) CMSIS SDS';
    statusItem.tooltip = 'CMSIS SDS — Click to quick-open an SDS file';
    statusItem.command = 'arm-sds.quickOpen';
    statusItem.show();
    context.subscriptions.push(statusItem);

    const fileInfoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    context.subscriptions.push(fileInfoItem);

    const updateFileInfoStatus = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.sds.yml')) {
            fileInfoItem.text = '$(file-code) SDS Metadata';
            fileInfoItem.tooltip = editor.document.fileName;
            fileInfoItem.command = 'arm-sds.showDiagnostics';
            fileInfoItem.show();
        } else {
            fileInfoItem.hide();
        }
    };
    vscode.window.onDidChangeActiveTextEditor(updateFileInfoStatus, null, context.subscriptions);
    updateFileInfoStatus();

    diagnostics.info(DiagnosticSource.Extension, 'Extension activated successfully');
}

export function deactivate() {
    diag().info(DiagnosticSource.Extension, 'Extension deactivating...');
    SdsDiagnostics.getInstance().dispose();
}

// ── Helpers ─────────────────────────────────────────────────────

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
 * Pattern: <name>.<index>.sds → <name>.sds.yml in the same directory.
 */
function metadataPathFor(sdsPath: string): string | undefined {
    const dir = path.dirname(sdsPath);
    const base = path.basename(sdsPath);
    const match = base.match(/^(.+)\.\d+\.sds$/);
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
    } catch (err: any) {
        vscode.window.showErrorMessage(`Export failed: ${err.message}`);
    }
}
