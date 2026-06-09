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
import { describe, expect, it } from 'vitest';

describe('extension activation wiring contracts', () => {
    const extensionPath = path.join(process.cwd(), 'src', 'extension.ts');
    const source = fs.readFileSync(extensionPath, 'utf-8');

    it('creates explorer tree view and no separate flags tree view', () => {
        expect(source).toContain("createTreeView('sdsExplorer'");
        expect(source).toContain('showCollapseAll: true');
        expect(source).not.toContain("createTreeView('sdsIOInterface'");
    });

    it('routes checkbox changes only for sdsFlag items', () => {
        expect(source).toContain('onDidChangeCheckboxState');
        expect(source).toContain("item.itemType === 'sdsFlag'");
        expect(source).toContain('sdsIoControlService.setEnabledByTreeItems(flagChanges)');
    });

    it('registers explicit disconnect command backed by control service', () => {
        expect(source).toContain("registerCommand('arm-sds.sdsinterface.disconnect'");
        expect(source).toContain('sdsIoControlService.disconnectServer()');
    });
});
