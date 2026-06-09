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

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];

        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
        };

        fire(event: T): void {
            for (const listener of this.listeners) {
                listener(event);
            }
        }
    }

    class TreeItem {
        contextValue?: string;
        tooltip?: string;
        iconPath?: unknown;
        command?: unknown;
        description?: string;

        constructor(public label: string, public collapsibleState?: number) { }
    }

    class ThemeIcon {
        constructor(public id: string) { }
    }

    const createFileSystemWatcher = () => ({
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        onDidChange: vi.fn(),
        dispose: vi.fn(),
    });

    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: 'c:/workspace' } }],
            createFileSystemWatcher,
        },
        Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
        window: {
            createOutputChannel: vi.fn(() => ({
                show: vi.fn(),
                hide: vi.fn(),
                clear: vi.fn(),
                appendLine: vi.fn(),
                dispose: vi.fn(),
            })),
        },
    };
});

vi.mock('fs', () => ({
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0 })),
}));

vi.mock('../../src/sds/writer', () => ({
    parseMetadataFile: vi.fn(),
}));

vi.mock('../../src/sds/types', async () => {
    const actual = await vi.importActual('../../src/sds/types');
    return {
        ...actual,
        detectMediaType: vi.fn(() => 'sensor'),
    };
});

import { SdsExplorerProvider, SdsTreeItem } from '../../src/providers/sdsExplorerProvider';

describe('SdsExplorerProvider', () => {
    it('returns two root nodes and includes flags node with description from flags source', async () => {
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };

        const flagItem = new SdsTreeItem('0: Flag 0', 'sdsFlag', 'flag-0', 0);
        const flagsSource = {
            getFlagTreeItems: vi.fn(() => [flagItem]),
            getConnectionState: vi.fn(() => 'connected'),
        };

        const provider = new SdsExplorerProvider(configManager as never, flagsSource);

        const rootItems = await provider.getChildren();

        expect(rootItems).toHaveLength(2);
        expect(rootItems[0].label).toBe('SDS Files');
        expect(rootItems[1].label).toBe('SDSIO Flags');
        expect(rootItems[1].description).toBe('connected');
        expect(rootItems[1].children).toEqual([flagItem]);
    });

    it('returns empty list when no active config file is selected', async () => {
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => undefined),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };

        const provider = new SdsExplorerProvider(configManager as never);
        const rootItems = await provider.getChildren();

        expect(rootItems).toEqual([]);
    });
});
