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
import path from 'path';
import * as vscode from 'vscode';
import { DiagnosticSource, SdsDiagnostics } from '../diagnostics/sdsDiagnostics';

export type SdsioServerLaunchOptions = {
    basePath: string;
    configFile: string;
    monitorPort: number;
};

export class SdsioServerLauncher {
    private terminal?: vscode.Terminal;
    private stoppingPromise?: Promise<void>;
    private readonly closeListener: vscode.Disposable;

    constructor(private readonly diagnostics: SdsDiagnostics) {
        this.closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
            if (this.terminal === closedTerminal) {
                void this.stop('vscode closing');
            }
        });
    }

    hasTerminal(): boolean {
        return this.terminal !== undefined;
    }

    async stop(reason: string): Promise<void> {
        if (this.stoppingPromise) {
            await this.stoppingPromise;
            return;
        }

        if (!this.terminal) {
            return;
        }

        const terminal = this.terminal;
        this.stoppingPromise = (async () => {
            this.diagnostics.info(DiagnosticSource.Server, reason);
            terminal.sendText('x', false);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            terminal.dispose();
            if (this.terminal === terminal) {
                this.terminal = undefined;
            }
        })();

        try {
            await this.stoppingPromise;
        } finally {
            this.stoppingPromise = undefined;
        }
    }

    async start(options: SdsioServerLaunchOptions): Promise<boolean> {
        const serverBinary = this.resolveServerBinary(options.basePath);
        if (!serverBinary) {
            return false;
        }

        const configDir = path.dirname(options.configFile);

        this.terminal = vscode.window.createTerminal({
            name: `SDSIO Server ${new Date().toLocaleTimeString()}`,
            cwd: configDir,
            iconPath: new vscode.ThemeIcon('arm-sds-sds-icon'),
        });

        this.diagnostics.info(
            DiagnosticSource.Server,
            `Spawning SDSIO server from binary: ${serverBinary} with config file: ${options.configFile}`,
        );

        this.terminal.show(true);
        this.terminal.sendText(this.buildLaunchCommand(serverBinary, options.configFile, options.monitorPort), true);
        this.diagnostics.info(DiagnosticSource.Server, 'SDSIO server process started, waiting for monitor connection...');
        return true;
    }

    dispose(): void {
        void this.stop('Disposing SDSIO server terminal');
        this.closeListener.dispose();
    }

    private resolveServerBinary(basePath: string): string | undefined {
        const toolsDir = path.join(basePath, 'tools');
        const bin = path.join(toolsDir, 'sdsio-server');
        const binWin32 = `${bin}.exe`;
        const serverBinary = fs.existsSync(binWin32) ? binWin32 : bin;
        if (!fs.existsSync(serverBinary)) {
            this.diagnostics.error(DiagnosticSource.Server, `SDSIO server binary not found at expected location: ${serverBinary}`);
            return undefined;
        }
        return serverBinary;
    }

    private buildLaunchCommand(serverBinary: string, configFile: string, monitorPort: number): string {
        const isPowerShell = this.isPowerShellProfile();
        if (isPowerShell) {
            return `& "${serverBinary}" "--control" "${configFile}" "--mon-port" "${monitorPort}"`;
        }
        return `"${serverBinary}" "--control" "${configFile}" "--mon-port" "${monitorPort}"`;
    }

    private isPowerShellProfile(): boolean {
        const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
        const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        const defaultProfile = terminalConfig.get<string>(`defaultProfile.${platform}`)?.toLowerCase() ?? '';
        return defaultProfile.includes('powershell') || defaultProfile.includes('pwsh');
    }
}
