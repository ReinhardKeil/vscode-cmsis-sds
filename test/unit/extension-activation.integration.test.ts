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

const createTreeViewMock = vi.fn();
const executeCommandMock = vi.fn(async () => undefined);
const registerCommandMock = vi.fn((_id: string, callback: (...args: unknown[]) => unknown) => callback);
const onDidChangeConfigurationMock = vi.fn(() => ({ dispose: vi.fn() }));

let checkboxHandler: ((changes: { items: Array<[unknown, number]> }) => void) | undefined;

const sdsIoServiceMethods = {
    canConnect: vi.fn(() => true),
    canDisconnect: vi.fn(() => false),
    canPlay: vi.fn(() => true),
    canRecord: vi.fn(() => true),
    canStop: vi.fn(() => false),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    setEnabledByTreeItems: vi.fn(),
    connectServer: vi.fn(async () => true),
    disconnectServer: vi.fn(async () => undefined),
    play: vi.fn(),
    record: vi.fn(),
    stop: vi.fn(),
    renameFlag: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
};

const explorerProviderMethods = {
    refresh: vi.fn(),
};

const configManagerMethods = {
    dispose: vi.fn(),
    setConfigFile: vi.fn(),
    getConfigFile: vi.fn(() => undefined),
};

vi.mock('vscode', () => {
    createTreeViewMock.mockImplementation(() => ({
        title: 'SDS: Files',
        message: '',
        onDidChangeCheckboxState: (handler: (changes: { items: Array<[unknown, number]> }) => void) => {
            checkboxHandler = handler;
            return { dispose: vi.fn() };
        },
        dispose: vi.fn(),
    }));

    return {
        window: {
            createTreeView: createTreeViewMock,
            showErrorMessage: vi.fn(),
            showWarningMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showQuickPick: vi.fn(),
            showOpenDialog: vi.fn(),
            showInputBox: vi.fn(),
            showSaveDialog: vi.fn(),
            showTextDocument: vi.fn(),
        },
        workspace: {
            workspaceFolders: [],
            onDidChangeConfiguration: onDidChangeConfigurationMock,
            getConfiguration: vi.fn(() => ({
                get: vi.fn(() => ''),
                update: vi.fn(async () => undefined),
            })),
            findFiles: vi.fn(async () => []),
            openTextDocument: vi.fn(async () => ({ uri: { fsPath: '' } })),
            asRelativePath: vi.fn(() => ''),
            getWorkspaceFolder: vi.fn(() => undefined),
        },
        commands: {
            executeCommand: executeCommandMock,
            registerCommand: registerCommandMock,
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
        },
        ConfigurationTarget: {
            Workspace: 0,
        },
    };
});

vi.mock('../../src/diagnostics/sdsDiagnostics', () => {
    const diagnostics = {
        outputChannel: { dispose: vi.fn() },
        writeBanner: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
    };

    return {
        DiagnosticSource: { Extension: 'Extension', Server: 'Server' },
        SdsDiagnostics: { getInstance: () => diagnostics },
        diag: () => diagnostics,
    };
});

vi.mock('../../src/recorder/sdsio/sdsIoMonitorClient', () => {
    class SdsioMonitorClient {
        start = vi.fn(async () => undefined);
        stop = vi.fn();
    }

    return {
        SdsioMonitorClient,
    };
});

vi.mock('../../src/controller/sdsioConfigManager', () => {
    class SdsioConfigManager {
        dispose = configManagerMethods.dispose;
        setConfigFile = configManagerMethods.setConfigFile;
        getConfigFile = configManagerMethods.getConfigFile;
    }

    return {
        SdsioConfigManager,
    };
});

vi.mock('../../src/providers/sdsIoControlService', () => {
    class SdsIoControlService {
        canConnect = sdsIoServiceMethods.canConnect;
        canDisconnect = sdsIoServiceMethods.canDisconnect;
        canPlay = sdsIoServiceMethods.canPlay;
        canRecord = sdsIoServiceMethods.canRecord;
        canStop = sdsIoServiceMethods.canStop;
        onDidChange = sdsIoServiceMethods.onDidChange;
        setEnabledByTreeItems = sdsIoServiceMethods.setEnabledByTreeItems;
        connectServer = sdsIoServiceMethods.connectServer;
        disconnectServer = sdsIoServiceMethods.disconnectServer;
        play = sdsIoServiceMethods.play;
        record = sdsIoServiceMethods.record;
        stop = sdsIoServiceMethods.stop;
        renameFlag = sdsIoServiceMethods.renameFlag;
        shutdown = sdsIoServiceMethods.shutdown;
    }

    return {
        SdsIoControlService,
    };
});

vi.mock('../../src/providers/sdsExplorerProvider', () => {
    class SdsTreeItem {
        constructor(public label: string, public itemType: string, public filePath: string) { }
    }

    class SdsExplorerProvider {
        refresh = explorerProviderMethods.refresh;
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
    parseSdsFile: vi.fn(),
    decodeAllRecords: vi.fn(),
    parseMetadataFile: vi.fn(),
    exportToCsv: vi.fn(),
    SDS_METADATA_EXTENSION: '.sds.yml',
}));

describe('activate integration wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        checkboxHandler = undefined;
    });

    it('creates only sdsExplorer tree and routes checkbox changes to sdsFlag items', async () => {
        const extension = await import('../../src/extension');

        const context = {
            subscriptions: [] as Array<{ dispose?: () => void }>,
            extensionPath: 'c:/workspace/ext',
            extensionUri: { fsPath: 'c:/workspace/ext' },
        };

        extension.activate(context as never);

        expect(createTreeViewMock).toHaveBeenCalledWith('sdsExplorer', expect.objectContaining({
            showCollapseAll: true,
        }));
        expect(createTreeViewMock).not.toHaveBeenCalledWith('sdsIOInterface', expect.anything());

        expect(checkboxHandler).toBeTypeOf('function');
        checkboxHandler?.({
            items: [
                [{ itemType: 'sdsFlag', filePath: 'flag-0' }, 1],
                [{ itemType: 'sdsFile', filePath: 'stream.0.sds' }, 1],
            ],
        });

        expect(sdsIoServiceMethods.setEnabledByTreeItems).toHaveBeenCalledWith([
            [{ itemType: 'sdsFlag', filePath: 'flag-0' }, 1],
        ]);
    });

    it('registers disconnect command in activation flow', async () => {
        const extension = await import('../../src/extension');
        const context = {
            subscriptions: [] as Array<{ dispose?: () => void }>,
            extensionPath: 'c:/workspace/ext',
            extensionUri: { fsPath: 'c:/workspace/ext' },
        };

        extension.activate(context as never);

        expect(registerCommandMock).toHaveBeenCalledWith(
            'arm-sds.sdsinterface.disconnect',
            expect.any(Function),
        );
    });
});
