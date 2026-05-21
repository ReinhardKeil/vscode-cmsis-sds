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

import * as vscode from 'vscode';
import { SdsioMonitorClient, SdsioMonitorInfo } from '../recorder/sdsio/sdsIoMonitorClient';
import { SdsioConfigManager } from '../controller/sdsioConfigManager';
import { SDSIO_SERVER_MONITOR_PORT } from '../extension';
import { DiagnosticSource, SdsDiagnostics } from '../diagnostics/sdsDiagnostics';
import { SdsioServerLauncher } from '../controller/sdsioServerLauncher';

const FLAG_NAME_PATTERN = /^[a-zA-Z0-9 \-_.+,/()]+$/;
const MAX_FLAGS = 8;

export type SdsFlag = {
    id: string;
    name: string;
    enabled: boolean;
};

export type SdsFlagMasks = {
    setMask: number;
    unsetMask: number;
};

type SdsIoMode = 'idle' | 'play' | 'record';

export class SdsFlagTreeItem extends vscode.TreeItem {
    constructor(public readonly flag: SdsFlag) {
        super(SdsFlagTreeItem.getNumberedLabel(flag.id, flag.name), vscode.TreeItemCollapsibleState.None);
        this.id = flag.id;
        this.description = flag.enabled ? '(set)' : '(unset)';
        this.contextValue = 'sdsFlag';
        this.iconPath = new vscode.ThemeIcon('symbol-boolean');
        this.checkboxState = flag.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    }

    static getNumberedLabel: (flagIndex: string, flagLabel: string) => string = (flagIndex, flagLabel) => {
        const index = flagIndex.split('-')[1];
        if (index === flagLabel) {
            return flagLabel;
        }
        return `${index}: ${flagLabel}`;
    }
}

export class SdsIOInterfaceProvider implements vscode.TreeDataProvider<SdsFlagTreeItem> {
    private readonly diagnostics = SdsDiagnostics.getInstance();
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SdsFlagTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly flags: SdsFlag[] = Array.from({ length: MAX_FLAGS }, (_, i) => ({ id: `flag-${i}`, name: `${i}`, enabled: false }));
    private nextId = 1;
    private mode: SdsIoMode = 'idle';
    private monitor?: SdsioMonitorClient;
    private extensionInstallPath?: string;
    private monitorConnected = false;
    private remoteFlags = 0;
    private readonly serverLauncher: SdsioServerLauncher;
    private shutdownPromise?: Promise<void>;

    constructor(private readonly configManager: SdsioConfigManager, monitor?: SdsioMonitorClient, extensionInstallPath?: string) {
        this.monitor = monitor;
        this.extensionInstallPath = extensionInstallPath;
        this.serverLauncher = new SdsioServerLauncher(this.diagnostics);
        if (monitor) {
            monitor.on('connected', () => this._onMonitorConnected());
            monitor.on('disconnected', () => this._onMonitorDisconnected());
            monitor.on('info', (info: SdsioMonitorInfo) => this._onMonitorInfo(info));
        }

        // Sync flag names whenever the config file changes or is replaced.
        configManager.onDidChangeConfigFile(async () => await this.reConnectServer());
        configManager.onDidChangeConfig(() => this.syncFlagNamesFromManager());
        this.syncFlagNamesFromManager();
    }

    private _onMonitorConnected(): void {
        if (!this.monitorConnected) {
            this.monitorConnected = true;
            this.diagnostics.info(DiagnosticSource.Server, 'Connected to SDSIO monitor');
            this._onDidChangeTreeData.fire();
        }
    }

    private _onMonitorDisconnected(): void {
        if (this.monitorConnected) {
            this.monitorConnected = false;
            this.diagnostics.info(DiagnosticSource.Server, 'Disconnected from SDSIO monitor');
            this._onDidChangeTreeData.fire();
        }
    }

    private _onMonitorInfo(info: SdsioMonitorInfo): void {
        this.remoteFlags = info.sdsFlags;
        // Synchronize local flag state from remote
        for (let i = 0; i < this.flags.length && i < 8; i++) {
            const bit = (info.sdsFlags >> i) & 1;
            this.flags[i].enabled = bit !== 0;
        }
        this._onDidChangeTreeData.fire();
        this.diagnostics.info(DiagnosticSource.Server, `Received monitor info: sdsFlags=0x${info.sdsFlags.toString(16).toUpperCase().padStart(2, '0')}`);
    }

    getTreeItem(element: SdsFlagTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(_element?: SdsFlagTreeItem): Thenable<SdsFlagTreeItem[]> {
        const items = this.flags.map((flag) => new SdsFlagTreeItem(flag));
        return Promise.resolve(items);
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    private syncFlagNamesFromManager(): void {
        const { flagNames } = this.configManager.getConfig();
        for (let i = 0; i < this.flags.length; i++) {
            this.flags[i].name = flagNames.get(i) ?? `${i}`;
        }
        this._onDidChangeTreeData.fire();
    }

    async renameFlag(item: SdsFlagTreeItem): Promise<void> {
        const flag = this.findFlag(item.flag.id);
        if (!flag) {
            return;
        }

        const index = this.flags.indexOf(flag);
        const fallbackName = this.getFallbackName(flag.id);
        const input = await vscode.window.showInputBox({
            prompt: 'Rename flag',
            value: flag.name,
            validateInput: (value) => this.validateFlagName(value, flag.id),
            ignoreFocusOut: true,
        });

        const newName = this.normalizeFlagName(input, fallbackName);
        flag.name = newName;

        // Persist to .sdsio.yml; onDidChangeConfig will fire → syncFlagNamesFromManager.
        if (index >= 0) {
            this.configManager.setFlagName(index, newName);
            this.diagnostics.info(DiagnosticSource.Server, `Flag ${index} renamed to "${newName}" and saved to config`);
        } else {
            this.refresh();
        }
    }

    setEnabledByTreeItems(items: ReadonlyArray<[SdsFlagTreeItem, vscode.TreeItemCheckboxState]>): void {
        const changed: Array<{ index: number; enabled: boolean }> = [];

        for (const [item, checkboxState] of items) {
            const flag = this.findFlag(item.flag.id);
            if (!flag) {
                continue;
            }

            const enabled = checkboxState === vscode.TreeItemCheckboxState.Checked;
            if (flag.enabled === enabled) {
                continue;
            }

            flag.enabled = enabled;
            const index = this.flags.findIndex((f) => f.id === flag.id);
            if (index >= 0 && index < MAX_FLAGS) {
                changed.push({ index, enabled });
            }
        }

        if (changed.length === 0) {
            this.refresh();
            return;
        }

        if (this.monitor && this.monitorConnected && changed.length === 1) {
            const op = changed[0];
            const sent = op.enabled
                ? this.monitor.setFlag(op.index)
                : this.monitor.clearFlag(op.index);

            // Fallback to full sync if a targeted update fails.
            if (!sent) {
                this.sendFlagsToMonitor();
            }
        } else {
            // Multiple changed items are sent as one full mask update.
            this.sendFlagsToMonitor();
        }

        this.refresh();
    }

    play(): void {
        this.mode = 'play';
        const modeSent = this.monitorConnected ? this.monitor?.startPlayback() === true : false;
        this.diagnostics.info(DiagnosticSource.Server, `Play invoked. Control flags ${modeSent ? 'sent' : 'not sent'};`);
    }

    record(): void {
        this.mode = 'record';
        const modeSent = this.monitorConnected ? this.monitor?.startRecording() === true : false;
        this.diagnostics.info(DiagnosticSource.Server, `Record invoked. Control flags ${modeSent ? 'sent' : 'not sent'};`);
    }

    stop(): void {
        this.mode = 'idle';
        const modeSent = this.monitorConnected ? this.monitor?.stopRecordingOrPlayback() === true : false;
        this.diagnostics.info(DiagnosticSource.Server, `Stop invoked. Control flags ${modeSent ? 'sent' : 'not sent'};`);
    }

    canPlay(): boolean {
        return this.mode === 'idle';
    }

    canRecord(): boolean {
        return this.mode === 'idle';
    }

    canStop(): boolean {
        return this.mode !== 'idle';
    }

    canConnect(): boolean {
        return !this.monitorConnected;
    }

    private async reConnectServer(): Promise<void> {
        if (this.serverLauncher.hasTerminal()) {
            await this.serverLauncher.stop('Terminating existing SDSIO server terminal due to config file change');

            if (this.monitorConnected && this.monitor) {
                this.monitorConnected = false;
                this.monitor.stop();
            }

            await this.connectServer();
        }
    }

    async connectServer(): Promise<boolean> {
        this.diagnostics.info(DiagnosticSource.Server, 'Attempting to connect to SDSIO monitor...');
        if (!this.monitor) {
            this.diagnostics.error(DiagnosticSource.Server, 'No monitor client available to connect to.');
            return false;
        }

        if (this.monitorConnected) {
            this.diagnostics.info(DiagnosticSource.Server, 'Already connected to SDSIO monitor.');
            return true;
        }

        try {
            if (this.serverLauncher.hasTerminal()) {
                await this.serverLauncher.stop('Terminating existing SDSIO server terminal before connecting');
            }

            const basePath = this.extensionInstallPath;
            if (!basePath) {
                this.diagnostics.error(DiagnosticSource.Server, 'No workspace folder or extension install path available to locate server binary.');
                return false;
            }

            const sdsIoFile = this.configManager.getConfigFile();
            if (!sdsIoFile) {
                this.diagnostics.error(DiagnosticSource.Server, 'No SDSIO config file selected. Please select or create a .sdsio.yml file.');
                return false;
            }

            await this.serverLauncher.start({
                basePath,
                configFile: sdsIoFile,
                monitorPort: SDSIO_SERVER_MONITOR_PORT,
            });
        } catch {
            // Ignore spawn failures and still try monitor reconnect below.
        }

        try {
            this.diagnostics.info(DiagnosticSource.Server, 'Attempting to connect monitor client to server...');
            await this.monitor.start();
        } catch {
            return false;
        }

        for (let i = 0; i < 20; i++) {
            if (this.monitorConnected) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return this.monitorConnected;
    }

    async shutdown(reason = 'Shutting down SDSIO server'): Promise<void> {
        if (this.shutdownPromise) {
            await this.shutdownPromise;
            return;
        }

        this.shutdownPromise = (async () => {
            this.stop();
            await this.serverLauncher.stop(reason);

            if (this.monitorConnected && this.monitor) {
                this.monitorConnected = false;
                this.monitor.stop();
                this._onDidChangeTreeData.fire();
            }

            this.serverLauncher.dispose();
        })();

        try {
            await this.shutdownPromise;
        } finally {
            this.shutdownPromise = undefined;
        }
    }

    getConnectionState(): string {
        const connection = this.monitorConnected ? '🟢 connected' : '⭕ disconnected';
        return `${connection}`;
    }

    getFlagMasks(): SdsFlagMasks {
        // Only manage the bits for flags that exist in this provider
        const managedMask = this.flags.length > 0 ? (1 << this.flags.length) - 1 : 0;
        const setMask = this.computeSetMask() & managedMask;
        const unsetMask = managedMask & ~setMask;
        return { setMask, unsetMask };
    }

    private sendFlagsToMonitor(): void {
        if (!this.monitor || !this.monitorConnected) {
            return;
        }
        const { setMask, unsetMask } = this.getFlagMasks();
        this.monitor.sendFlags(setMask, unsetMask);
    }

    private findFlag(id: string): SdsFlag | undefined {
        return this.flags.find((f) => f.id === id);
    }

    private validateFlagName(input: string, currentId?: string): string | undefined {
        if (!input || input.trim().length === 0) {
            return undefined;
        }

        const value = input.trim();
        if (!FLAG_NAME_PATTERN.test(value)) {
            return 'Allowed characters: a-z, A-Z, 0-9, - _ . , + / ( )';
        }

        const duplicate = this.flags.find((f) => f.id !== currentId && f.name === value);
        if (duplicate) {
            return 'Name already exists';
        }

        return undefined;
    }

    private normalizeFlagName(input: string | undefined, fallbackName: string): string {
        const value = input?.trim() ?? '';
        if (!value) {
            return fallbackName;
        }
        if (!FLAG_NAME_PATTERN.test(value)) {
            return fallbackName;
        }
        return value;
    }

    private getFallbackName(currentId?: string): string {
        for (let i = 0; i < MAX_FLAGS; i++) {
            const candidate = `${i}`;
            const isUsed = this.flags.some((f) => f.id !== currentId && f.name === candidate);
            if (!isUsed) {
                return candidate;
            }
        }
        return '0';
    }

    private computeSetMask(): number {
        return this.flags.reduce((acc, flag, index) => {
            if (flag.enabled) {
                return acc | (1 << index);
            }
            return acc;
        }, 0);
    }
}
