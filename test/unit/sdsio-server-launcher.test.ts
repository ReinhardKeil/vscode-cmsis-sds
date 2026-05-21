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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SdsioServerLauncher } from '../../src/controller/sdsioServerLauncher';
import { SdsDiagnostics } from '../../src/diagnostics/sdsDiagnostics';

type MockTerminal = {
    sendText: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
};

let mockTerminal: MockTerminal;
let defaultProfile = 'Command Prompt';

vi.mock('vscode', () => {
    class ThemeIcon {
        constructor(public readonly id: string) { }
    }

    const window = {
        createTerminal: vi.fn(() => mockTerminal),
        onDidCloseTerminal: vi.fn(() => ({
            dispose: vi.fn(),
        })),
    };

    const workspace = {
        getConfiguration: vi.fn(() => ({
            get: vi.fn(() => defaultProfile),
        })),
    };

    return {
        ThemeIcon,
        window,
        workspace,
    };
});

describe('SdsioServerLauncher', () => {
    let tmpDir: string;
    let diagnostics: SdsDiagnostics;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsio-launcher-'));
        mockTerminal = {
            sendText: vi.fn(),
            show: vi.fn(),
            dispose: vi.fn(),
        };
        defaultProfile = 'Command Prompt';
        diagnostics = {
            info: vi.fn(),
            error: vi.fn(),
        } as unknown as SdsDiagnostics;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.useRealTimers();
    });

    it('starts server in terminal with CMD-style command', async () => {
        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        const serverBinary = path.join(toolsDir, 'sdsio-server.exe');
        fs.writeFileSync(serverBinary, '');

        const launcher = new SdsioServerLauncher(diagnostics);
        const started = await launcher.start({
            basePath: tmpDir,
            configFile: 'sample.sdsio.yml',
            monitorPort: 6060,
        });

        expect(started).toBe(true);
        expect(launcher.hasTerminal()).toBe(true);
        expect(mockTerminal.show).toHaveBeenCalledWith(true);
        expect(mockTerminal.sendText).toHaveBeenCalledWith(
            `"${serverBinary}" "--control" "sample.sdsio.yml" "--mon-port" "6060"`,
            true,
        );
    });

    it('uses PowerShell call operator for PowerShell profiles', async () => {
        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        const serverBinary = path.join(toolsDir, 'sdsio-server.exe');
        fs.writeFileSync(serverBinary, '');
        defaultProfile = 'PowerShell';

        const launcher = new SdsioServerLauncher(diagnostics);
        await launcher.start({
            basePath: tmpDir,
            configFile: 'sample.sdsio.yml',
            monitorPort: 6060,
        });

        expect(mockTerminal.sendText).toHaveBeenCalledWith(
            `& "${serverBinary}" "--control" "sample.sdsio.yml" "--mon-port" "6060"`,
            true,
        );
    });

    it('logs an error and returns false when server binary is missing', async () => {
        const launcher = new SdsioServerLauncher(diagnostics);

        const started = await launcher.start({
            basePath: tmpDir,
            configFile: 'sample.sdsio.yml',
            monitorPort: 6060,
        });

        expect(started).toBe(false);
        expect(launcher.hasTerminal()).toBe(false);
        expect((diagnostics.error as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('stop sends shutdown command and disposes terminal', async () => {
        vi.useFakeTimers();

        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        const serverBinary = path.join(toolsDir, 'sdsio-server.exe');
        fs.writeFileSync(serverBinary, '');

        const launcher = new SdsioServerLauncher(diagnostics);
        await launcher.start({
            basePath: tmpDir,
            configFile: 'sample.sdsio.yml',
            monitorPort: 6060,
        });

        const stopPromise = launcher.stop('stop reason');
        vi.runAllTimers();
        await stopPromise;

        expect(mockTerminal.sendText).toHaveBeenCalledWith('x', false);
        expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
        expect(launcher.hasTerminal()).toBe(false);
    });
});
