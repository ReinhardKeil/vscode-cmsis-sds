/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
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

export type SdsTreeItemType = 'group' | 'sdsFile' | 'metadataFile' | 'info';

export class SdsTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly itemType: SdsTreeItemType,
        public readonly filePath: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly children?: SdsTreeItem[]
    ) {
        super(label, collapsibleState);
        this.contextValue = itemType === 'sdsFile' ? 'sdsFile' : itemType;
        this.tooltip = filePath;

        switch (itemType) {
            case 'group':
                this.iconPath = new vscode.ThemeIcon('folder');
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
    private _onDidChangeTreeData = new vscode.EventEmitter<SdsTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private fileWatcher: vscode.FileSystemWatcher | undefined;

    constructor() {
        // Watch for SDS file changes in workspace
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.sds');
        this.fileWatcher.onDidCreate(() => { try { this.refresh(); } catch { /* ignore */ } });
        this.fileWatcher.onDidDelete(() => { try { this.refresh(); } catch { /* ignore */ } });
        this.fileWatcher.onDidChange(() => { try { this.refresh(); } catch { /* ignore */ } });

        // Also watch metadata files
        const ymlWatcher = vscode.workspace.createFileSystemWatcher('**/*.sds.yml');
        ymlWatcher.onDidCreate(() => { try { this.refresh(); } catch { /* ignore */ } });
        ymlWatcher.onDidDelete(() => { try { this.refresh(); } catch { /* ignore */ } });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SdsTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SdsTreeItem): Promise<SdsTreeItem[]> {
        if (!vscode.workspace.workspaceFolders) {
            return [];
        }

        if (!element) {
            return this.getRootItems();
        }

        return element.children ?? [];
    }

    private async getRootItems(): Promise<SdsTreeItem[]> {
        const groups = new Map<string, SdsTreeItem[]>();

        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            await this.scanDirectory(folder.uri.fsPath, groups);
        }

        const result: SdsTreeItem[] = [];

        for (const [groupName, items] of groups) {
            if (items.length === 1 && items[0].itemType === 'sdsFile') {
                result.push(items[0]);
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
                result.push(group);
            }
        }

        return result.sort((a, b) => a.label.localeCompare(b.label as string));
    }

    private async scanDirectory(dirPath: string, groups: Map<string, SdsTreeItem[]>): Promise<void> {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    await this.scanDirectory(fullPath, groups);
                    continue;
                }

                if (!entry.isFile()) { continue; }

                // Match .sds files: <name>.<index>.sds
                const sdsMatch = entry.name.match(/^(.+)\.(\d+)\.sds$/);
                if (sdsMatch) {
                    const streamName = sdsMatch[1];

                    if (!groups.has(streamName)) {
                        groups.set(streamName, []);
                    }

                    // Check for associated metadata
                    const metaPath = path.join(dirPath, `${streamName}${SDS_METADATA_EXTENSION}`);

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
                                    image: 'file-media',
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
        } catch {
            // Skip inaccessible directories
        }
    }

    dispose(): void {
        this.fileWatcher?.dispose();
    }
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
