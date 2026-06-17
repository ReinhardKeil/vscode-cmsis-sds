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
import * as path from 'path';
import * as vscode from 'vscode';

import { SdsioConfigManager } from '../controller/sdsioConfigManager';

type EnsureWorkspaceConfigFile = (workspaceRoot: string, configRelativePath: string) => void;

export interface RegisterSdsioConfigCommandsArgs {
    context: vscode.ExtensionContext;
    configManager: SdsioConfigManager;
    configExtension: string;
    configTemplate: string;
    setActiveConfig: (configPath: string | undefined, persist: boolean) => Promise<void>;
    resolveConfigPathFromSettings: () => string | undefined;
    ensureWorkspaceConfigFile: EnsureWorkspaceConfigFile;
}

export function registerSdsioConfigCommands(args: RegisterSdsioConfigCommandsArgs): void {
    const {
        context,
        configManager,
        configExtension,
        configTemplate,
        setActiveConfig,
        resolveConfigPathFromSettings,
        ensureWorkspaceConfigFile,
    } = args;

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

            const targetPath = path.join(workspaceFolder.uri.fsPath, `${baseName.trim()}${configExtension}`);
            if (fs.existsSync(targetPath)) {
                void vscode.window.showWarningMessage(`Configuration already exists: ${path.basename(targetPath)}`);
                const existingDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
                await vscode.window.showTextDocument(existingDoc);
                await setActiveConfig(targetPath, true);
                return;
            }

            fs.writeFileSync(targetPath, configTemplate, 'utf-8');
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

}
