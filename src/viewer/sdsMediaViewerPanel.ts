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
 * SDS Media Viewer Panel
 *
 * Provides webview-based viewers for image, audio, and video SDS streams.
 * - Image: renders decoded frames with pixel format conversion, zoom, pan
 * - Audio: renders waveform + spectrogram with playback controls
 * - Video: sequential frame browser with play/pause
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    parseSdsFile,
    indexSdsRecords,
    parseMetadataFile,
    decodeImageFrameToRGBA,
    decodeAudioBlock,
    SdsMetadata,
    SdsMediaType,
    SDS_METADATA_EXTENSION,
    detectMediaType,
    SdsParsedFile,
} from '../sds';
import { ViewerSettings } from './viewerSettings';
import { ImageFrame, SampleFrame, WebviewMessage } from '../webview/protocol';
import {
    buildViewerWebviewHtml,
    registerViewerWebview,
    resolveMetadataPathForSdsFile,
} from './viewerPanelUtils';

type MediaFrameWindowRequest = {
    command: 'requestMediaFrameWindow';
    requestId: number;
    payload: {
        mediaType: 'image' | 'video';
        centerIndex: number;
        windowSize: number;
        quality: 'low' | 'high';
    };
};

type MediaAudioWindowRequest = {
    command: 'requestMediaAudioWindow';
    requestId: number;
    payload: {
        rangeStart: number;
        rangeEnd: number;
        plotWidth: number;
        quality: 'low' | 'high';
    };
};

export class SdsMediaViewerPanel {
    public static readonly viewType = 'arm-sds.mediaViewer';
    private static panels = new Map<string, SdsMediaViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private webview: vscode.Webview | undefined;

    private sdsFilePath: string;
    private metadataPath: string | undefined;
    private mediaType: SdsMediaType;
    private parsedFile: SdsParsedFile | undefined;
    private recordIndex: Array<{ timestamp: number; dataSize: number; dataOffset: number }> = [];
    private metadata: SdsMetadata | undefined;
    private audioFrames: SampleFrame[] = [];
    private audioSampleRate = 0;
    private audioBitDepth = 0;
    private audioChannels = 0;

    public static createOrShow(
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        metadataPath?: string
    ): SdsMediaViewerPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const existing = SdsMediaViewerPanel.panels.get(sdsFilePath);
        if (existing) {
            existing.panel.reveal(column);
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(
            SdsMediaViewerPanel.viewType,
            `SDS Media Viewer: ${path.basename(sdsFilePath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        const viewer = new SdsMediaViewerPanel(panel, extensionUri, sdsFilePath, metadataPath);

        SdsMediaViewerPanel.panels.set(sdsFilePath, viewer);
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
        this.metadataPath = metadataPath || resolveMetadataPathForSdsFile(sdsFilePath, SDS_METADATA_EXTENSION);
        this.mediaType = 'sensor';

        this.panel.iconPath = new vscode.ThemeIcon('device-camera');
        this.update();
        this.webview = this.panel.webview;
        this.disposables.push(registerViewerWebview(this.webview));

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Media Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'refresh':
                    this.update();
                    break;
                case 'requestMediaFrameWindow': {
                    const req = message as unknown as MediaFrameWindowRequest;
                    const requestId = typeof req.requestId === 'number' ? req.requestId : 0;
                    const mediaType = req.payload?.mediaType;
                    if (mediaType !== 'image' && mediaType !== 'video') {
                        break;
                    }
                    const centerIndex = Math.max(0, Math.floor(req.payload?.centerIndex ?? 0));
                    const windowSize = Math.max(1, Math.floor(req.payload?.windowSize ?? 100));
                    const quality = req.payload?.quality === 'low' ? 'low' : 'high';

                    const frameWindow = this.getFrameWindow(mediaType, centerIndex, windowSize);
                    if (!frameWindow) {
                        break;
                    }

                    void this.panel.webview.postMessage({
                        command: 'mediaFrameWindowData',
                        requestId,
                        payload: {
                            mediaType,
                            rangeStart: frameWindow.rangeStart,
                            rangeEnd: frameWindow.rangeEnd,
                            quality,
                            frames: frameWindow.frames,
                        },
                    });
                    break;
                }
                case 'requestMediaAudioWindow': {
                    const req = message as unknown as MediaAudioWindowRequest;
                    const requestId = typeof req.requestId === 'number' ? req.requestId : 0;
                    const rangeStart = typeof req.payload?.rangeStart === 'number' ? req.payload.rangeStart : 0;
                    const rangeEnd = typeof req.payload?.rangeEnd === 'number' ? req.payload.rangeEnd : 0;
                    const plotWidth = typeof req.payload?.plotWidth === 'number' ? req.payload.plotWidth : 800;
                    const quality = req.payload?.quality === 'low' ? 'low' : 'high';

                    const audioWindow = this.getAudioWindow(rangeStart, rangeEnd, plotWidth, quality);
                    if (!audioWindow) {
                        break;
                    }

                    void this.panel.webview.postMessage({
                        command: 'mediaAudioWindowData',
                        requestId,
                        payload: {
                            rangeStart: audioWindow.rangeStart,
                            rangeEnd: audioWindow.rangeEnd,
                            quality,
                            samples: audioWindow.samples,
                        },
                    });
                    break;
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Media viewer error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private update(): void {
        try {
            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath);
            }
            this.metadata = metadata;

            if (!metadata) {
                this.panel.webview.html = this.getErrorHtml('No metadata (.sds.yml) found. Media viewer requires metadata to decode frames.');
                return;
            }

            this.mediaType = detectMediaType(metadata);
            this.recordIndex = [];
            this.parsedFile = undefined;

            if (this.mediaType === 'image' || this.mediaType === 'video') {
                this.recordIndex = indexSdsRecords(this.sdsFilePath);
            } else {
                this.parsedFile = parseSdsFile(this.sdsFilePath);
            }

            this.audioFrames = [];
            this.audioSampleRate = 0;
            this.audioBitDepth = 0;
            this.audioChannels = 0;
            this.panel.title = `${this.mediaType === 'image' ? 'SDS Image Viewer' : this.mediaType === 'audio' ? 'SDS Audio Viewer' : 'SDS Video Viewer'}: ${path.basename(this.sdsFilePath)}`;

            const initialState = this.buildInitialState();
            this.panel.webview.html = this.getHtml(initialState);
        } catch (err) {
            this.panel.webview.html = this.getErrorHtml(err instanceof Error ? err.message : String(err));
        }
    }
    private buildInitialState() {
        const metadata = this.metadata;
        const decimationPreset = ViewerSettings.getDecimationPreset();
        if (!metadata) {
            return { fileName: path.basename(this.sdsFilePath), error: 'Media data not available.' };
        }

        const base = { fileName: path.basename(this.sdsFilePath), decimationPreset };
        switch (this.mediaType) {
            case 'image': {
                this.panel.iconPath = new vscode.ThemeIcon('device-camera');
                const content = metadata.sds.content;
                const imgMeta = content.find(c => c.image)?.image;
                if (!imgMeta) { return { ...base, error: 'No image metadata found in content.' }; }
                return {
                    ...base,
                    mediaType: 'image',
                    image: {
                        frames: [],
                        rangeStart: 0,
                        width: imgMeta.width,
                        height: imgMeta.height,
                        totalFrames: this.recordIndex.length,
                    },
                };
            }
            case 'audio': {
                this.panel.iconPath = new vscode.ThemeIcon('unmute');
                const parsed = this.parsedFile;
                if (!parsed) {
                    return { ...base, error: 'Audio data not available.' };
                }
                const content = metadata.sds.content;
                const audioMeta = content.find(c => c.audio)?.audio;
                if (!audioMeta) { return { ...base, error: 'No audio metadata found in content.' }; }
                const frames: SampleFrame[] = [];
                const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
                for (const record of parsed.records) {
                    try {
                        const block = decodeAudioBlock(record.data, audioMeta.sample_rate, audioMeta.bit_depth, audioMeta.audio_channels);
                        frames.push({ timestamp: record.timestamp / tickFreq, samples: Array.from(block[0]) });
                    } catch { /* skip */ }
                }

                this.audioFrames = frames;
                this.audioSampleRate = audioMeta.sample_rate;
                this.audioBitDepth = audioMeta.bit_depth;
                this.audioChannels = audioMeta.audio_channels;

                const totalSamples = frames.reduce((sum, frame) => sum + frame.samples.length, 0);
                const domainStart = frames.length > 0 ? frames[0].timestamp : 0;
                const domainEnd = frames.length > 0
                    ? frames[frames.length - 1].timestamp + (frames[frames.length - 1].samples.length / audioMeta.sample_rate)
                    : 1;
                const audioWindow = this.getAudioWindow(domainStart, domainEnd, 1200, 'high');
                return {
                    ...base,
                    mediaType: 'audio',
                    audio: {
                        samples: audioWindow?.samples ?? [],
                        rangeStart: audioWindow?.rangeStart ?? domainStart,
                        rangeEnd: audioWindow?.rangeEnd ?? domainEnd,
                        domainStart,
                        domainEnd,
                        decimationPreset,
                        sampleRate: audioMeta.sample_rate,
                        bitDepth: audioMeta.bit_depth,
                        channels: audioMeta.audio_channels,
                        totalSamples,
                        totalRecords: parsed.records.length,
                    },
                };
            }
            case 'video': {
                this.panel.iconPath = new vscode.ThemeIcon('device-camera-video');
                const content = metadata.sds.content;
                const vidMeta = content.find(c => c.video)?.video;
                if (!vidMeta) { return { ...base, error: 'No video metadata found in content.' }; }
                return {
                    ...base,
                    mediaType: 'video',
                    video: {
                        frames: [],
                        rangeStart: 0,
                        width: vidMeta.width,
                        height: vidMeta.height,
                        fps: vidMeta.fps,
                        totalFrames: this.recordIndex.length,
                    },
                };
            }
            default:
                return { ...base, error: 'This file contains sensor data. Use the standard SDS Viewer instead.' };
        }
    }

    private getAudioWindow(rangeStart: number, rangeEnd: number, plotWidth: number, quality: 'low' | 'high'): { rangeStart: number; rangeEnd: number; samples: SampleFrame[] } | undefined {
        if (this.audioFrames.length === 0 || this.audioSampleRate <= 0) {
            return undefined;
        }

        const domainStart = this.audioFrames[0].timestamp;
        const lastFrame = this.audioFrames[this.audioFrames.length - 1];
        const domainEnd = lastFrame.timestamp + (lastFrame.samples.length / this.audioSampleRate);

        const start = Math.max(domainStart, Math.min(rangeStart, rangeEnd));
        const end = Math.min(domainEnd, Math.max(rangeStart, rangeEnd));
        if (end <= start) {
            return { rangeStart: start, rangeEnd: end, samples: [] };
        }

        const selected: SampleFrame[] = [];
        for (const frame of this.audioFrames) {
            const frameEnd = frame.timestamp + (frame.samples.length / this.audioSampleRate);
            if (frameEnd < start) {
                continue;
            }
            if (frame.timestamp > end) {
                break;
            }
            selected.push(frame);
        }

        if (quality === 'high' || selected.length === 0) {
            return { rangeStart: start, rangeEnd: end, samples: selected };
        }

        const targetFrames = Math.max(80, Math.min(1500, Math.floor(plotWidth * 0.8)));
        if (selected.length <= targetFrames) {
            return { rangeStart: start, rangeEnd: end, samples: selected };
        }

        const step = selected.length / targetFrames;
        const reduced: SampleFrame[] = [];
        for (let i = 0; i < targetFrames; i++) {
            const idx = Math.min(selected.length - 1, Math.floor(i * step));
            reduced.push(selected[idx]);
        }

        const last = selected[selected.length - 1];
        if (reduced[reduced.length - 1] !== last) {
            reduced.push(last);
        }

        return { rangeStart: start, rangeEnd: end, samples: reduced };
    }

    private getFrameWindow(mediaType: 'image' | 'video', centerIndex: number, windowSize: number): { rangeStart: number; rangeEnd: number; frames: ImageFrame[] } | undefined {
        const metadata = this.metadata;
        if (!metadata) {
            return undefined;
        }

        const content = metadata.sds.content;
        const mediaMeta = mediaType === 'image'
            ? content.find(c => c.image)?.image
            : content.find(c => c.video)?.video;
        if (!mediaMeta) {
            return undefined;
        }

        const total = this.recordIndex.length;
        if (total === 0) {
            return { rangeStart: 0, rangeEnd: 0, frames: [] };
        }

        const clampedCenter = Math.max(0, Math.min(total - 1, centerIndex));
        const half = Math.floor(windowSize / 2);
        let start = Math.max(0, clampedCenter - half);
        let endExclusive = Math.min(total, start + windowSize);
        if (endExclusive - start < windowSize) {
            start = Math.max(0, endExclusive - windowSize);
        }

        const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
        const frames: ImageFrame[] = [];
        let fd: number | undefined;
        try {
            fd = fs.openSync(this.sdsFilePath, 'r');
            for (let i = start; i < endExclusive; i++) {
                const entry = this.recordIndex[i];
                if (!entry || entry.dataSize <= 0) {
                    continue;
                }

                const data = Buffer.alloc(entry.dataSize);
                const read = fs.readSync(fd, data, 0, entry.dataSize, entry.dataOffset);
                if (read < entry.dataSize) {
                    continue;
                }

                try {
                    const rgba = decodeImageFrameToRGBA(data, mediaMeta.width, mediaMeta.height, mediaMeta.pixel_format);
                    frames.push({ timestamp: entry.timestamp / tickFreq, rgbaBase64: Buffer.from(rgba).toString('base64') });
                } catch {
                    // Skip decode failures.
                }
            }
        } finally {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
        }

        return {
            rangeStart: start,
            rangeEnd: endExclusive,
            frames,
        };
    }

    private getHtml(initialState: Record<string, unknown>): string {
        const title = typeof initialState.fileName === 'string'
            ? initialState.fileName
            : 'SDS Media Viewer';

        return buildViewerWebviewHtml({
            webview: this.panel.webview,
            extensionUri: this.extensionUri,
            styleFile: 'mediaViewerWebview.css',
            scriptFile: 'mediaViewerWebview.js',
            title,
            initialState,
        });
    }

    private getErrorHtml(message: string): string {
        return this.getHtml({ error: message, fileName: path.basename(this.sdsFilePath) });
    }

    private dispose(): void {
        SdsMediaViewerPanel.panels.delete(this.sdsFilePath);
        this.webview = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
