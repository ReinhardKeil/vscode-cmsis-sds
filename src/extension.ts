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
 * CMSIS SDS — VS Code Extension Entry Point
 *
 * Registers commands, views, providers, and webview panels
 * for the CMSIS SDS extension (viewer, media viewer).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { SdsExplorerProvider, SdsTreeItem } from './providers/sdsExplorerProvider';
import { SdsIoControlService } from './providers/sdsIoControlService';
import { SdsioConfigManager } from './controller/sdsioConfigManager';
import { SdsioMonitorClient } from './recorder/sdsio/sdsIoMonitorClient';
import { SdsViewerPanel } from './viewer/sdsViewerPanel';
import { SdsMediaViewerPanel } from './viewer/sdsMediaViewerPanel';
import { SdsDiagnostics, DiagnosticSource, diag } from './diagnostics/sdsDiagnostics';
import { parseSdsFile, decodeAllRecords, parseMetadataFile, exportToCsv, SDS_METADATA_EXTENSION, } from './sds';

export const SDSIO_SERVER_MONITOR_PORT = 6060;
const SDSIO_CONFIG_EXTENSION = '.sdsio.yml';
const SDSIO_TEMPLATE = [
    'sdsio:',
    '  interface:',
    '    usb:',
    '  workdir: .',
    '  metadir: .',
    '  flag-info:',
    '    - 0: Flag 0',
    '    - 1: Flag 1',
    '    - 2: Flag 2',
    '    - 3: Flag 3',
    '    - 4: Flag 4',
    '    - 5: Flag 5',
    '    - 6: Flag 6',
    '    - 7: Flag 7',
    '',
].join('\n');

let activeSdsIoControlService: SdsIoControlService | undefined;

export function activate(context: vscode.ExtensionContext) {
    // ── Diagnostics Output Channel ──────────────────────────────
    const diagnostics = SdsDiagnostics.getInstance();
    diagnostics.writeBanner();
    diagnostics.info(DiagnosticSource.Extension, 'CMSIS SDS extension activating...');
    context.subscriptions.push(diagnostics.outputChannel);

    // ── SDSIO Monitor Client ────────────────────────────────────
    const monitor = new SdsioMonitorClient({ port: SDSIO_SERVER_MONITOR_PORT });
    context.subscriptions.push({
        dispose: () => {
            monitor.stop();
        },
    });
    // Start monitor in background
    monitor.start().catch((err) => {
        diagnostics.error(DiagnosticSource.Extension, `Failed to start monitor: ${err instanceof Error ? err.message : String(err)}`);
    });

    // ── Config Manager ──────────────────────────────────────────
    const configManager = new SdsioConfigManager();
    context.subscriptions.push({ dispose: () => configManager.dispose() });

    // ── Tree Views ──────────────────────────────────────────────
    const sdsIoControlService = new SdsIoControlService(configManager, monitor, context.extensionPath);
    activeSdsIoControlService = sdsIoControlService;

    const explorerProvider = new SdsExplorerProvider(configManager, sdsIoControlService);
    const explorerTreeView = vscode.window.createTreeView('sdsExplorer', {
        treeDataProvider: explorerProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(explorerTreeView);

    let isApplyingConfigSetting = false;

    const updateExplorerConfigUi = async (configPath: string | undefined) => {
        await vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.hasConfig', Boolean(configPath));
        explorerTreeView.title = configPath
            ? path.basename(configPath, SDSIO_CONFIG_EXTENSION)
            : 'Files';
    };

    const setActiveConfig = async (configPath: string | undefined, persist: boolean) => {
        const normalizedPath = configPath && fs.existsSync(configPath) ? configPath : undefined;
        // One call replaces the config and notifies both providers via onDidChangeConfig.
        configManager.setConfigFile(normalizedPath);
        await updateExplorerConfigUi(normalizedPath);

        if (!persist) {
            return;
        }

        isApplyingConfigSetting = true;
        try {
            const relativePath = normalizedPath
                ? toWorkspaceRelativeConfigPath(vscode.Uri.file(normalizedPath))
                : '';
            await vscode.workspace
                .getConfiguration('cmsis-sds.sdsio')
                .update('configFile', relativePath, vscode.ConfigurationTarget.Workspace);
        } finally {
            isApplyingConfigSetting = false;
        }
    };

    void setActiveConfig(resolveConfigPathFromSettings(), false);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('cmsis-sds.sdsio.configFile') || isApplyingConfigSetting) {
                return;
            }

            void setActiveConfig(resolveConfigPathFromSettings(), false);
        })
    );

    const updateSdsIoCommandContext = () => {
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canConnect', sdsIoControlService.canConnect());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canDisconnect', sdsIoControlService.canDisconnect());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canPlay', sdsIoControlService.canPlay());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canRecord', sdsIoControlService.canRecord());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canStop', sdsIoControlService.canStop());
    };
    updateSdsIoCommandContext();

    context.subscriptions.push(
        sdsIoControlService.onDidChange(() => {
            updateSdsIoCommandContext();
            explorerProvider.refresh();
        })
    );

    context.subscriptions.push(
        explorerTreeView.onDidChangeCheckboxState((changes) => {
            const flagChanges = changes.items.filter(([item]) => item.itemType === 'sdsFlag');
            if (flagChanges.length === 0) {
                return;
            }
            sdsIoControlService.setEnabledByTreeItems(flagChanges);
        })
    );

    // ── Commands ────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.refreshExplorer', () => {
            explorerProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sds.newConfig', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                void vscode.window.showErrorMessage('Open a workspace folder before creating an SDS configuration.');
                return;
            }

            const baseName = await vscode.window.showInputBox({
                prompt: 'Enter a name for the SDS configuration file',
                placeHolder: 'example: target-a',
                validateInput: (value) => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                        return 'Name cannot be empty.';
                    }
                    if (/[\\/:]/.test(trimmed)) {
                        return 'Do not include path separators or drive notation.';
                    }
                    return undefined;
                },
            });

            if (!baseName) {
                return;
            }

            const targetPath = path.join(workspaceFolder.uri.fsPath, `${baseName.trim()}${SDSIO_CONFIG_EXTENSION}`);
            if (fs.existsSync(targetPath)) {
                void vscode.window.showWarningMessage(`Configuration already exists: ${path.basename(targetPath)}`);
                const existingDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
                await vscode.window.showTextDocument(existingDoc);
                await setActiveConfig(targetPath, true);
                return;
            }

            fs.writeFileSync(targetPath, SDSIO_TEMPLATE, 'utf-8');
            await setActiveConfig(targetPath, true);

            const createdDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
            await vscode.window.showTextDocument(createdDoc);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sds.openConfig', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'SDS Configuration files': ['sdsio.yml'] },
                openLabel: 'Open SDS Configuration',
            });

            const selectedUri = uris?.[0];
            if (!selectedUri) {
                return;
            }

            const selectedPath = selectedUri.fsPath;
            const currentWorkspaceFolder = vscode.workspace.getWorkspaceFolder(selectedUri);

            if (currentWorkspaceFolder) {
                await setActiveConfig(selectedPath, true);
                const doc = await vscode.workspace.openTextDocument(selectedUri);
                await vscode.window.showTextDocument(doc);
                return;
            }

            const targetFolder = path.dirname(selectedPath);
            ensureWorkspaceConfigFile(targetFolder, path.relative(targetFolder, selectedPath));
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetFolder), false);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sds.selectConfig', async () => {
            const configFiles = await vscode.workspace.findFiles('**/*.sdsio.yml', '**/node_modules/**');
            if (configFiles.length === 0) {
                void vscode.window.showInformationMessage('No .sdsio.yml files found in the current workspace.');
                return;
            }

            const pickItems = configFiles.map((uri) => ({
                label: path.basename(uri.fsPath),
                description: vscode.workspace.asRelativePath(uri, false),
                uri,
            }));

            const selected = await vscode.window.showQuickPick(pickItems, {
                placeHolder: 'Select SDS configuration file',
                matchOnDescription: true,
            });

            if (!selected) {
                return;
            }

            await setActiveConfig(selected.uri.fsPath, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sds.editConfig', async () => {
            const activeConfigPath = configManager.getConfigFile() ?? resolveConfigPathFromSettings();
            if (!activeConfigPath || !fs.existsSync(activeConfigPath)) {
                void vscode.window.showInformationMessage('No active SDS configuration file is selected.');
                return;
            }

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(activeConfigPath));
            await vscode.window.showTextDocument(doc);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.connect', async () => {
            await sdsIoControlService.connectServer();
            updateSdsIoCommandContext();
            // if (!ok) {
            //     void vscode.window.showWarningMessage('Unable to connect to SDSIO monitor server.');
            // }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.disconnect', async () => {
            await sdsIoControlService.disconnectServer();
            updateSdsIoCommandContext();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.play', async () => {
            const connected = await sdsIoControlService.connectServer();
            if (!connected) {
                void vscode.window.showWarningMessage('Unable to connect to SDSIO monitor server.');
                return;
            }
            sdsIoControlService.play();
            updateSdsIoCommandContext();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.record', async () => {
            const connected = await sdsIoControlService.connectServer();
            if (!connected) {
                void vscode.window.showWarningMessage('Unable to connect to SDSIO monitor server.');
                return;
            }
            sdsIoControlService.record();
            updateSdsIoCommandContext();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.stop', () => {
            sdsIoControlService.stop();
            updateSdsIoCommandContext();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.rename', async (item: SdsTreeItem) => {
            await sdsIoControlService.renameFlag(item);
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
                const streamName = path.basename(filePath).replace(/\.\d+(\.p)?\.sds$/, '');
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
                            '1. Capture SDS data using SDSIO tools',
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

                // Workspace already open — ensure recordings directory exists
                const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const recordingsDir = path.join(wsRoot, 'sds_recordings');
                if (!fs.existsSync(recordingsDir)) {
                    fs.mkdirSync(recordingsDir, { recursive: true });
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Workspace init failed: ${err instanceof Error ? err.message : String(err)}`);
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
                    SdsViewerPanel.createOrShow(context.extensionUri, pick.uri.fsPath);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Quick open failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    diagnostics.info(DiagnosticSource.Extension, 'Extension activated successfully');

    function resolveConfigPathFromSettings(): string | undefined {
        const configured = vscode.workspace.getConfiguration('cmsis-sds.sdsio').get<string>('configFile');
        if (!configured) {
            return undefined;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of workspaceFolders) {
            const direct = path.join(folder.uri.fsPath, configured);
            if (fs.existsSync(direct)) {
                return direct;
            }

            const prefix = `${folder.name}${path.sep}`;
            if (configured.startsWith(prefix)) {
                const withoutPrefix = configured.slice(prefix.length);
                const prefixed = path.join(folder.uri.fsPath, withoutPrefix);
                if (fs.existsSync(prefixed)) {
                    return prefixed;
                }
            }
        }

        return undefined;
    }

    function toWorkspaceRelativeConfigPath(configUri: vscode.Uri): string {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const owningFolder = vscode.workspace.getWorkspaceFolder(configUri);
        if (!owningFolder) {
            return vscode.workspace.asRelativePath(configUri, true);
        }

        const relativePath = path.relative(owningFolder.uri.fsPath, configUri.fsPath).replace(/\\/g, '/');
        if (folders.length <= 1) {
            return relativePath;
        }

        return `${owningFolder.name}/${relativePath}`;
    }
}

export async function deactivate() {
    diag().info(DiagnosticSource.Extension, 'Extension deactivating...');
    if (activeSdsIoControlService) {
        await activeSdsIoControlService.shutdown('VS Code is closing; terminating SDSIO server gracefully');
        activeSdsIoControlService = undefined;
    }
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
 * Pattern: <name>.<index>.p.sds → <name>.sds.yml in the same directory.
 */
function metadataPathFor(sdsPath: string): string | undefined {
    const dir = path.dirname(sdsPath);
    const base = path.basename(sdsPath);
    const match = base.match(/^(.+)\.\d+(\.p)?\.sds$/);
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

function ensureWorkspaceConfigFile(workspaceRoot: string, configRelativePath: string): void {
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');

    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
        } catch {
            settings = {};
        }
    }

    settings['cmsis-sds.sdsio.configFile'] = configRelativePath.replace(/\\/g, '/');
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 4)}\n`, 'utf-8');
}
