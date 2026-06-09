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

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const launcherState = {
    hasTerminal: false,
};

const launcherMock = {
    hasTerminal: vi.fn(() => launcherState.hasTerminal),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async () => true),
};

vi.mock('vscode', () => {
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];

        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((l) => l !== listener);
                },
            };
        };

        fire(event: T): void {
            for (const listener of this.listeners) {
                listener(event);
            }
        }
    }

    class TreeItem {
        constructor(public label: string) { }
    }

    class ThemeIcon {
        constructor(public id: string) { }
    }

    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        TreeItemCollapsibleState: { None: 0 },
        TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
        version: '1.0.0',
        window: {
            showInputBox: vi.fn(),
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

vi.mock('../../src/controller/sdsioServerLauncher', () => {
    const SdsioServerLauncher = vi.fn(function SdsioServerLauncher() {
        return launcherMock;
    });

    return {
        SdsioServerLauncher,
    };
});

import { SdsIoControlService } from '../../src/providers/sdsIoControlService';

class FakeMonitor extends EventEmitter {
    start = vi.fn(async () => {
        this.emit('connected');
    });

    stop = vi.fn();

    setFlag = vi.fn(() => true);

    clearFlag = vi.fn(() => true);

    sendFlags = vi.fn();

    startPlayback = vi.fn(() => true);

    startRecording = vi.fn(() => true);

    stopRecordingOrPlayback = vi.fn(() => true);
}

type ConfigFileChangedHandler = () => Promise<void>;

type FakeConfigManager = {
    onDidChangeConfigFile: ReturnType<typeof vi.fn>;
    onDidChangeConfig: ReturnType<typeof vi.fn>;
    getConfig: ReturnType<typeof vi.fn>;
    getConfigFile: ReturnType<typeof vi.fn>;
    setFlagName: ReturnType<typeof vi.fn>;
    triggerConfigFileChange: () => Promise<void>;
};

function createConfigManager(...args: [string?]): FakeConfigManager {
    const configFile = args.length === 0 ? 'sample.sdsio.yml' : args[0];
    let onConfigFileChange: ConfigFileChangedHandler | undefined;

    return {
        onDidChangeConfigFile: vi.fn((handler: ConfigFileChangedHandler) => {
            onConfigFileChange = handler;
        }),
        onDidChangeConfig: vi.fn(),
        getConfig: vi.fn(() => ({
            flagNames: new Map<number, string>(),
        })),
        getConfigFile: vi.fn(() => configFile),
        setFlagName: vi.fn(),
        triggerConfigFileChange: async () => {
            if (onConfigFileChange) {
                await onConfigFileChange();
            }
        },
    };
}

describe('SdsIoControlService launcher delegation', () => {
    it('connectServer delegates server startup to launcher', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const provider = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        const connected = await provider.connectServer();

        expect(connected).toBe(true);
        expect(launcherMock.start).toHaveBeenCalledWith({
            basePath: 'c:/workspace/ext',
            configFile: 'active.sdsio.yml',
            monitorPort: 6060,
        });
    });

    it('reconnect path stops existing terminal and restarts through launcher', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();

        launcherMock.hasTerminal
            .mockReturnValueOnce(true)
            .mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await configManager.triggerConfigFileChange();

        expect(launcherMock.stop).toHaveBeenCalledWith('Terminating existing SDSIO server terminal due to config file change');
        expect(launcherMock.start).toHaveBeenCalledWith({
            basePath: 'c:/workspace/ext',
            configFile: 'active.sdsio.yml',
            monitorPort: 6060,
        });
    });

    it('does not start launcher when no config file is selected', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager(undefined);
        const provider = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        const connected = await provider.connectServer();

        expect(connected).toBe(false);
        expect(launcherMock.start).not.toHaveBeenCalled();
    });

    it('creates 8 sdsFlag tree items with checkbox metadata', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        const items = service.getFlagTreeItems();

        expect(items).toHaveLength(8);
        expect(items[0].itemType).toBe('sdsFlag');
        expect(items[0].filePath).toBe('flag-0');
        expect(items[0].description).toBe('(unset)');
        expect(items[0].checkboxState).toBe(0);
    });

    it('sends targeted monitor update for one changed checkbox when connected', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();

        const item = service.getFlagTreeItems()[2];
        service.setEnabledByTreeItems([[item, 1] as never]);

        expect(monitor.setFlag).toHaveBeenCalledWith(2);
        expect(monitor.sendFlags).not.toHaveBeenCalled();
    });

    it('sends full flag mask when multiple checkboxes change', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();

        const items = service.getFlagTreeItems();
        service.setEnabledByTreeItems([
            [items[0], 1] as never,
            [items[1], 1] as never,
        ]);

        expect(monitor.sendFlags).toHaveBeenCalledWith(3, 252);
    });

    it('disconnectServer stops launcher and monitor and toggles canDisconnect', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();
        expect(service.canDisconnect()).toBe(true);

        await service.disconnectServer();

        expect(launcherMock.stop).toHaveBeenCalledWith('Disconnecting SDSIO server terminal on user request');
        expect(monitor.stop).toHaveBeenCalled();
        expect(service.canDisconnect()).toBe(false);
    });

    it('canDisconnect is true when a launcher terminal exists even if monitor is not connected', () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        expect(service.canDisconnect()).toBe(true);
    });
});
