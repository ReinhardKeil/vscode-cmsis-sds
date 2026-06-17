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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMockState = vi.hoisted(() => {
    const registeredDisposables: Array<{
        command: string;
        callback: (...args: unknown[]) => unknown;
        dispose: () => void;
    }> = [];

    const registerCommandMock = vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
        const disposable = {
            command,
            callback,
            dispose: vi.fn(),
        };
        registeredDisposables.push(disposable);
        return disposable;
    });

    return {
        registerCommandMock,
        registeredDisposables,
    };
});

vi.mock('vscode', () => {
    class Uri {
        constructor(public fsPath: string) { }

        static file(fsPath: string): Uri {
            return new Uri(fsPath);
        }
    }

    return {
        commands: {
            registerCommand: commandMockState.registerCommandMock,
        },
        Uri,
        window: {
            createTerminal: vi.fn(() => ({
                sendText: vi.fn(),
                show: vi.fn(),
            })),
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showOpenDialog: vi.fn(),
            showQuickPick: vi.fn(),
            showSaveDialog: vi.fn(),
            showTextDocument: vi.fn(),
            showWarningMessage: vi.fn(),
        },
        workspace: {
            asRelativePath: vi.fn(() => ''),
            findFiles: vi.fn(async () => []),
            openTextDocument: vi.fn(async () => ({ uri: Uri.file('') })),
        },
    };
});

vi.mock('../../src/providers/sdsExplorerProvider', () => {
    class SdsTreeItem {
        constructor(public label: string, public itemType: string, public filePath: string) { }
    }

    class SdsExplorerProvider {
        refresh = vi.fn();
    }

    return {
        SdsExplorerProvider,
        SdsTreeItem,
    };
});

vi.mock('../../src/viewer/sdsViewerPanel', () => ({
    SdsViewerPanel: { createOrShow: vi.fn() },
}));

vi.mock('../../src/viewer/sdsMediaViewerPanel', () => ({
    SdsMediaViewerPanel: { createOrShow: vi.fn() },
}));

vi.mock('../../src/sds', () => ({
    decodeAllRecords: vi.fn(),
    exportToCsv: vi.fn(),
    parseMetadataFile: vi.fn(),
    parseSdsFile: vi.fn(),
    SDS_METADATA_EXTENSION: '.sds.yml',
}));

import { registerSdsFileCommands } from '../../src/commands/sdsFileCommands';

describe('registerSdsFileCommands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        commandMockState.registeredDisposables.length = 0;
    });

    it('pushes every command registration disposable into the extension context subscriptions', () => {
        const context = {
            subscriptions: [] as Array<{ dispose: () => void }>,
            extensionUri: { fsPath: 'c:/extension' },
        };

        registerSdsFileCommands({
            context: context as never,
            explorerProvider: { refresh: vi.fn() } as never,
            configManager: {} as never,
        });

        const expectedCommands = [
            'arm-sds.openViewer',
            'arm-sds.createMetadata',
            'arm-sds.openGroupMetadata',
            'arm-sds.exportCsv',
            'arm-sds.deleteFile',
            'arm-sds.openMediaViewer',
            'arm-sds.quickOpen',
            'arm-sds.sdsCheck',
        ];

        expect(commandMockState.registerCommandMock).toHaveBeenCalledTimes(expectedCommands.length);
        expect(commandMockState.registerCommandMock.mock.calls.map(([command]) => command)).toEqual(expectedCommands);
        expect(context.subscriptions).toEqual(commandMockState.registeredDisposables);
        expect(context.subscriptions).toHaveLength(expectedCommands.length);
        expect(context.subscriptions.every((subscription) => typeof subscription.dispose === 'function')).toBe(true);
    });
});
