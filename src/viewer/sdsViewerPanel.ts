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

/**
 * SDS Viewer Panel
 *
 * Provides a webview-based waveform viewer for SDS data files.
 * Renders interactive time-series charts with zoom and pan,
 * channel toggling, and statistics overlay.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    parseSdsFile,
    decodeAllRecords,
    parseMetadataFile,
    getSdsFileStats,
    SdsMetadata,
    SDS_METADATA_EXTENSION,
    SdsDecodedSample,
} from '../sds';
import { ViewerSettings } from './viewerSettings';
import { WebviewMessage } from '../webview/protocol';
import {
    buildViewerWebviewHtml,
    registerViewerWebview,
    resolveMetadataPathForSdsFile,
} from './viewerPanelUtils';

type VisibleRangeRequest = {
    command: 'requestVisibleRangeData';
    requestId: number;
    payload: {
        rangeStart: number;
        rangeEnd: number;
        plotWidth: number;
        quality: 'low' | 'high';
    };
};

export class SdsViewerPanel {
    public static readonly viewType = 'arm-sds.viewer';
    private static panels = new Map<string, SdsViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private webview: vscode.Webview | undefined;

    private sdsFilePath: string;
    private metadataPath: string | undefined;
    private decodedSamples: SdsDecodedSample[] = [];
    private channelNames: string[] = [];
    private stats: ReturnType<typeof getSdsFileStats> | undefined;
    private metadata: SdsMetadata | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        metadataPath?: string
    ): SdsViewerPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists for this file, reveal it
        const existing = SdsViewerPanel.panels.get(sdsFilePath);
        if (existing) {
            existing.panel.reveal(column);
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(
            SdsViewerPanel.viewType,
            `SDS Viewer: ${path.basename(sdsFilePath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        const viewer = new SdsViewerPanel(panel, extensionUri, sdsFilePath, metadataPath);
        SdsViewerPanel.panels.set(sdsFilePath, viewer);
        return viewer;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        metadataPath?: string
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.sdsFilePath = sdsFilePath;
        this.metadataPath = metadataPath;
        this.webview = panel.webview;
        this.disposables.push(registerViewerWebview(this.webview));

        this.panel.iconPath = new vscode.ThemeIcon('graph-line');
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'exportCsv':
                    await vscode.commands.executeCommand('arm-sds.exportCsv', this.sdsFilePath);
                    break;
                case 'refresh':
                    this.update();
                    break;
                case 'requestVisibleRangeData': {
                    const req = message as unknown as VisibleRangeRequest;
                    const requestId = typeof req.requestId === 'number' ? req.requestId : 0;
                    const payload = req.payload;
                    const rangeStart = typeof payload?.rangeStart === 'number' ? payload.rangeStart : 0;
                    const rangeEnd = typeof payload?.rangeEnd === 'number' ? payload.rangeEnd : 0;
                    const plotWidth = typeof payload?.plotWidth === 'number' ? payload.plotWidth : 800;
                    const quality = payload?.quality === 'low' ? 'low' : 'high';
                    const samples = this.getVisibleRangeSamples(rangeStart, rangeEnd, plotWidth, quality);
                    void this.panel.webview.postMessage({
                        command: 'visibleRangeData',
                        requestId,
                        payload: {
                            rangeStart,
                            rangeEnd,
                            quality,
                            samples,
                        },
                    });
                    break;
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Viewer error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private update(): void {
        // Find metadata file if not specified
        if (!this.metadataPath) {
            this.metadataPath = resolveMetadataPathForSdsFile(this.sdsFilePath, SDS_METADATA_EXTENSION);
        }

        try {
            const parsed = parseSdsFile(this.sdsFilePath);

            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath);
            }
            const tickFreq = metadata?.sds['tick-frequency'] ?? 1000;
            this.stats = getSdsFileStats(parsed, tickFreq);

            this.decodedSamples = [];
            this.channelNames = [];
            this.metadata = metadata;

            if (metadata) {
                this.decodedSamples = decodeAllRecords(parsed, metadata);
                this.channelNames = metadata.sds.content.map(c => c.value);
            } else {
                // Without metadata, show raw record sizes over time
                this.channelNames = ['data_size'];
                for (const record of parsed.records) {
                    this.decodedSamples.push({
                        timestamp: record.timestamp,
                        timeSeconds: record.timestamp / tickFreq,
                        values: { data_size: record.dataSize },
                    } as SdsDecodedSample);
                }
            }

            const domainStart = this.decodedSamples.length > 0 ? this.decodedSamples[0].timeSeconds : 0;
            const domainEnd = this.decodedSamples.length > 0 ? this.decodedSamples[this.decodedSamples.length - 1].timeSeconds : 1;
            const initialSamples = this.getVisibleRangeSamples(domainStart, domainEnd, 1200, 'high');

            this.panel.webview.html = this.getHtml({
                samples: initialSamples,
                channelNames: this.channelNames,
                stats: this.stats,
                metadata: this.metadata,
                domainStart,
                domainEnd,
                fileName: path.basename(this.sdsFilePath),
                decimationPreset: ViewerSettings.getDecimationPreset(),
            });
        } catch (err) {
            this.panel.webview.html = this.getErrorHtml(err instanceof Error ? err.message : String(err));
        }
    }

    private getVisibleRangeSamples(viewStart: number, viewEnd: number, plotWidth: number, quality: 'low' | 'high'): SdsDecodedSample[] {
        if (this.decodedSamples.length === 0) {
            return [];
        }

        const domainStart = this.decodedSamples[0].timeSeconds;
        const domainEnd = this.decodedSamples[this.decodedSamples.length - 1].timeSeconds;
        const start = Math.max(domainStart, Math.min(viewStart, viewEnd));
        const end = Math.min(domainEnd, Math.max(viewStart, viewEnd));

        const startIdx = this.lowerBoundTime(start);
        const endIdxExclusive = this.upperBoundTime(end);
        if (endIdxExclusive <= startIdx) {
            return [];
        }

        const visibleCount = endIdxExclusive - startIdx;
        const width = Math.max(64, Math.floor(plotWidth));
        const bucketCount = quality === 'low'
            ? Math.max(64, Math.min(1200, Math.floor(width * 0.75)))
            : Math.max(128, Math.min(2400, Math.floor(width * 1.5)));

        if (visibleCount <= bucketCount * 2) {
            return this.decodedSamples.slice(startIdx, endIdxExclusive);
        }

        const reduced: SdsDecodedSample[] = [];
        const channels = this.channelNames;
        const bucketSpan = visibleCount / bucketCount;

        for (let bucket = 0; bucket < bucketCount; bucket++) {
            const bucketStart = startIdx + Math.floor(bucket * bucketSpan);
            const bucketEnd = Math.min(endIdxExclusive, startIdx + Math.floor((bucket + 1) * bucketSpan));
            if (bucketEnd <= bucketStart) {
                continue;
            }

            const first = this.decodedSamples[bucketStart];
            const last = this.decodedSamples[bucketEnd - 1];

            const minValues: Record<string, number> = {};
            const maxValues: Record<string, number> = {};
            for (const ch of channels) {
                minValues[ch] = Infinity;
                maxValues[ch] = -Infinity;
            }

            for (let i = bucketStart; i < bucketEnd; i++) {
                const sample = this.decodedSamples[i];
                for (const ch of channels) {
                    const value = sample.values[ch];
                    if (value === undefined) {
                        continue;
                    }
                    if (value < minValues[ch]) {
                        minValues[ch] = value;
                    }
                    if (value > maxValues[ch]) {
                        maxValues[ch] = value;
                    }
                }
            }

            const minSampleValues: Record<string, number> = {};
            const maxSampleValues: Record<string, number> = {};
            for (const ch of channels) {
                if (Number.isFinite(minValues[ch])) {
                    minSampleValues[ch] = minValues[ch];
                }
                if (Number.isFinite(maxValues[ch])) {
                    maxSampleValues[ch] = maxValues[ch];
                }
            }

            if (Object.keys(minSampleValues).length === 0 || Object.keys(maxSampleValues).length === 0) {
                continue;
            }

            reduced.push({
                timestamp: first.timestamp,
                timeSeconds: first.timeSeconds,
                values: minSampleValues,
            } as SdsDecodedSample);

            reduced.push({
                timestamp: last.timestamp,
                timeSeconds: last.timeSeconds,
                values: maxSampleValues,
            } as SdsDecodedSample);
        }

        const last = this.decodedSamples[endIdxExclusive - 1];
        if (reduced.length === 0 || reduced[reduced.length - 1].timestamp !== last.timestamp) {
            reduced.push(last);
        }

        return reduced;
    }

    private lowerBoundTime(target: number): number {
        let lo = 0;
        let hi = this.decodedSamples.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.decodedSamples[mid].timeSeconds < target) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    private upperBoundTime(target: number): number {
        let lo = 0;
        let hi = this.decodedSamples.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.decodedSamples[mid].timeSeconds <= target) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    private getHtml(initialState: Record<string, unknown>): string {
        return buildViewerWebviewHtml({
            webview: this.panel.webview,
            extensionUri: this.extensionUri,
            styleFile: 'dataViewerWebview.css',
            scriptFile: 'dataViewerWebview.js',
            title: 'SDS Viewer',
            initialState,
        });
    }

    private getErrorHtml(message: string): string {
        return this.getHtml({ error: message });
    }

    private dispose(): void {
        SdsViewerPanel.panels.delete(this.sdsFilePath);
        this.webview = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
