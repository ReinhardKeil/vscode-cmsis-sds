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
 * SDS Explorer Tree Data Provider
 *
 * Provides a tree view in the activity bar showing all SDS files
 * in the workspace, grouped by stream name.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SDS_METADATA_EXTENSION, SdsMediaType } from '../sds/types';
import { parseMetadataFile } from '../sds/writer';
import { detectMediaType } from '../sds/types';
import { SdsioConfigManager } from '../controller/sdsioConfigManager';
import { DiagnosticSource, SdsDiagnostics } from '../diagnostics/sdsDiagnostics';

type SdsFlagsTreeSource = {
    getFlagTreeItems(): SdsTreeItem[];
    getConnectionState(): string;
};

export type SdsTreeItemType = 'flags' | 'folder' | 'group' | 'sdsFile' | 'metadataFile' | 'info' | 'sdsFlag';

export class SdsTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly itemType: SdsTreeItemType,
        public readonly filePath: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public children?: SdsTreeItem[]
    ) {
        super(label, collapsibleState);
        this.contextValue = itemType === 'sdsFile' ? 'sdsFile' : itemType;
        this.tooltip = filePath;

        switch (itemType) {
            case 'folder':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
            case 'flags':
                this.iconPath = new vscode.ThemeIcon('symbol-boolean');
                break;
            case 'sdsFlag':
                this.iconPath = new vscode.ThemeIcon('symbol-method-arrow');
                break;
            case 'group':
                this.iconPath = new vscode.ThemeIcon('library');
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                break;
            case 'sdsFile':
                this.iconPath = new vscode.ThemeIcon('graph-line');
                this.command = {
                    command: 'arm-sds.openViewer',
                    title: 'Open in Viewer',
                    arguments: [this],
                };
                break;
            case 'metadataFile':
                this.iconPath = new vscode.ThemeIcon('file-code');
                this.command = {
                    command: 'vscode.open',
                    title: 'Open Metadata',
                    arguments: [vscode.Uri.file(filePath)],
                };
                break;
            case 'info':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
        }
    }
}

export class SdsExplorerProvider implements vscode.TreeDataProvider<SdsTreeItem> {
    private readonly diagnostics = SdsDiagnostics.getInstance();
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SdsTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private fileWatchers: vscode.FileSystemWatcher[] = [];

    constructor(
        private readonly configManager: SdsioConfigManager,
        private readonly flagsSource?: SdsFlagsTreeSource,
    ) {
        this.fileWatchers.push(vscode.workspace.createFileSystemWatcher('**/*.sds'));
        this.fileWatchers.push(vscode.workspace.createFileSystemWatcher('**/*.sds.yml'));
        this.fileWatchers.push(vscode.workspace.createFileSystemWatcher('**/*.sdsio.yml'));

        for (const watcher of this.fileWatchers) {
            watcher.onDidCreate(() => { try { this.refresh(); } catch { /* ignore */ } });
            watcher.onDidDelete(() => { try { this.refresh(); } catch { /* ignore */ } });
            watcher.onDidChange(() => { try { this.refresh(); } catch { /* ignore */ } });
        }

        configManager.onDidChangeConfig(() => { try { this.refresh(); } catch { /* ignore */ } });
    }

    refresh(): void {
        this.diagnostics.info(DiagnosticSource.Extension, 'Refreshing SDS Explorer view');
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SdsTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SdsTreeItem): Promise<SdsTreeItem[]> {
        this.diagnostics.debug(DiagnosticSource.Extension, `Getting children for ${element ? element.label : 'root'}`);
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        if (!element) {
            return this.getRootItems();
        }

        this.diagnostics.debug(DiagnosticSource.Extension, `Returning ${element.children?.length ?? 0} children for ${element.label}`);

        return element.children ?? [];
    }

    private async getRootItems(): Promise<SdsTreeItem[]> {
        this.diagnostics.debug(DiagnosticSource.Extension, 'Scanning workspace for SDS files');
        if (!this.configManager.getConfigFile()) {
            return [];
        }

        const { workdir, metadir } = this.configManager.getConfig();
        const groups = new Map<string, SdsTreeItem[]>();

        if (metadir) {
            const sdsDirectory = workdir ?? metadir;
            await this.scanConfiguredDirectories(metadir, sdsDirectory, groups);
        } else if (workdir) {
            await this.scanConfiguredDirectories(workdir, workdir, groups);
        } else {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
                await this.scanDirectory(folder.uri.fsPath, groups, false);
            }
        }

        const files: SdsTreeItem[] = [];

        for (const [groupName, items] of groups) {
            if (items.length === 1 && items[0].itemType === 'sdsFile') {
                files.push(items[0]);
            } else {
                const group = new SdsTreeItem(
                    groupName,
                    'group',
                    '',
                    vscode.TreeItemCollapsibleState.Expanded,
                    items
                );
                const sdsCount = items.filter(i => i.itemType === 'sdsFile').length;
                group.description = `${sdsCount} recordings`;
                files.push(group);
            }
        }
        this.diagnostics.debug(DiagnosticSource.Extension, `Found ${files.length} top-level groups in SDS Explorer`);

        const root: SdsTreeItem[] = [];
        root.push(
            new SdsTreeItem(
                'SDS Files',
                'folder',
                '',
                vscode.TreeItemCollapsibleState.Expanded,
                files
                    .sort((a, b) => a.label.localeCompare(b.label as string))
                    .sort((a, b) => a.itemType === 'group' && b.itemType !== 'group' ? -1 : 1)
            ));

        const flagItems = this.flagsSource?.getFlagTreeItems() ?? [];
        const flagsNode = new SdsTreeItem(
            'SDSIO Flags',
            'flags',
            '',
            vscode.TreeItemCollapsibleState.Expanded, flagItems);
        flagsNode.description = this.flagsSource?.getConnectionState();
        root.push(flagsNode);

        return root;
    }

    private async scanConfiguredDirectories(
        metadataDirectory: string,
        sdsDirectory: string,
        groups: Map<string, SdsTreeItem[]>
    ): Promise<void> {
        const metadataByStream = new Map<string, string>();
        const usedMetadataFiles = new Set<string>();

        if (fs.existsSync(metadataDirectory)) {
            this.collectMetadataFiles(metadataDirectory, metadataByStream);
        }

        await this.scanDirectory(sdsDirectory, groups, true, metadataByStream, usedMetadataFiles);

        for (const [streamName, metadataPath] of metadataByStream.entries()) {
            if (usedMetadataFiles.has(metadataPath)) {
                continue;
            }

            if (!groups.has(streamName)) {
                groups.set(streamName, []);
            }

            groups.get(streamName)!.push(
                new SdsTreeItem(
                    `${streamName}.sds.yml`,
                    'metadataFile',
                    metadataPath,
                    vscode.TreeItemCollapsibleState.None
                )
            );
        }
    }

    private collectMetadataFiles(dirPath: string, metadataByStream: Map<string, string>): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    this.collectMetadataFiles(fullPath, metadataByStream);
                    continue;
                }

                if (!entry.isFile() || !entry.name.endsWith(SDS_METADATA_EXTENSION)) {
                    continue;
                }

                const streamName = entry.name.slice(0, -SDS_METADATA_EXTENSION.length);
                if (!metadataByStream.has(streamName)) {
                    metadataByStream.set(streamName, fullPath);
                }
            }
            this.diagnostics.info(DiagnosticSource.Extension, `Collected ${metadataByStream.size} metadata files from ${dirPath}`);
        } catch {
            // Ignore inaccessible directories and parse errors.
        }
    }

    private async scanDirectory(
        dirPath: string,
        groups: Map<string, SdsTreeItem[]>,
        recursive: boolean,
        metadataByStream?: Map<string, string>,
        usedMetadataFiles?: Set<string>
    ): Promise<void> {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (recursive && entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    await this.scanDirectory(fullPath, groups, recursive, metadataByStream, usedMetadataFiles);
                    continue;
                }

                if (!entry.isFile()) { continue; }

                // Match .sds files: <name>.<index>.sds and <name>.<index>.p.sds
                const sdsMatch = entry.name.match(/^(.+)\.(\d+)(\.p)?\.sds$/);
                if (sdsMatch) {
                    const streamName = sdsMatch[1];

                    if (!groups.has(streamName)) {
                        groups.set(streamName, []);
                    }

                    // Check for associated metadata
                    const metaPath = metadataByStream?.get(streamName) ?? path.join(dirPath, `${streamName}${SDS_METADATA_EXTENSION}`);

                    // File size for description
                    const stat = fs.statSync(fullPath);
                    const sizeStr = formatFileSize(stat.size);

                    const item = new SdsTreeItem(
                        entry.name,
                        'sdsFile',
                        fullPath,
                        vscode.TreeItemCollapsibleState.None
                    );
                    item.description = sizeStr;
                    item.resourceUri = vscode.Uri.file(fullPath);

                    // Detect media type from metadata — route to media viewer if not sensor data
                    if (fs.existsSync(metaPath)) {
                        try {
                            const metadata = parseMetadataFile(metaPath);
                            const mediaType = detectMediaType(metadata);
                            if (mediaType !== 'sensor') {
                                item.command = {
                                    command: 'arm-sds.openMediaViewer',
                                    title: 'Open in Media Viewer',
                                    arguments: [item],
                                };
                                const iconMap: Record<SdsMediaType, string> = {
                                    image: 'paintcan',
                                    video: 'device-camera-video',
                                    audio: 'unmute',
                                    sensor: 'graph-line',
                                };
                                item.iconPath = new vscode.ThemeIcon(iconMap[mediaType]);
                            }
                        } catch {
                            // Metadata parse error — fall back to default waveform viewer
                        }
                    }

                    groups.get(streamName)!.push(item);

                    // Add metadata file if exists and not already added
                    if (fs.existsSync(metaPath)) {
                        usedMetadataFiles?.add(metaPath);
                        const existingMeta = groups.get(streamName)!.find(
                            i => i.itemType === 'metadataFile' && i.filePath === metaPath
                        );
                        if (!existingMeta) {
                            groups.get(streamName)!.unshift(
                                new SdsTreeItem(
                                    `${streamName}.sds.yml`,
                                    'metadataFile',
                                    metaPath,
                                    vscode.TreeItemCollapsibleState.None
                                )
                            );
                        }
                    }
                }
            }
            this.diagnostics.info(DiagnosticSource.Extension, `Scanned ${dirPath} and found ${groups.size} groups so far`);
        } catch {
            // Skip inaccessible directories
        }
    }

    dispose(): void {
        this.fileWatchers.forEach(w => w.dispose());
    }
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
