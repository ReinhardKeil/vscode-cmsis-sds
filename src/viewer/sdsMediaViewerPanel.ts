/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
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
    parseMetadataFile,
    decodeMediaFrames,
    decodeImageFrameToRGBA,
    decodeAudioBlock,
    SdsMetadata,
    SdsDecodedFrame,
    SdsMediaType,
    SDS_METADATA_EXTENSION,
    detectMediaType,
} from '../sds';

export class SdsMediaViewerPanel {
    public static readonly viewType = 'arm-sds.mediaViewer';
    private static panels = new Map<string, SdsMediaViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private sdsFilePath: string;
    private metadataPath: string | undefined;
    private mediaType: SdsMediaType;

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
            `Media: ${path.basename(sdsFilePath)}`,
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
        this.metadataPath = metadataPath || this.findMetadataFile(sdsFilePath);
        this.mediaType = 'sensor';

        this.panel.iconPath = new vscode.ThemeIcon('device-camera');
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Media Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: any): Promise<void> {
        try {
            switch (message.command) {
                case 'refresh':
                    this.update();
                    break;
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Media viewer error: ${err.message}`);
        }
    }

    private update(): void {
        try {
            const parsed = parseSdsFile(this.sdsFilePath);

            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath);
            }

            if (!metadata) {
                this.panel.webview.html = this.getErrorHtml('No metadata (.sds.yml) found. Media viewer requires metadata to decode frames.');
                return;
            }

            this.mediaType = detectMediaType(metadata);
            this.panel.title = `${this.mediaType === 'image' ? '🖼' : this.mediaType === 'audio' ? '🔊' : '🎬'} ${path.basename(this.sdsFilePath)}`;

            switch (this.mediaType) {
                case 'image':
                    this.renderImageViewer(parsed, metadata);
                    break;
                case 'audio':
                    this.renderAudioViewer(parsed, metadata);
                    break;
                case 'video':
                    this.renderVideoViewer(parsed, metadata);
                    break;
                default:
                    this.panel.webview.html = this.getErrorHtml('This file contains sensor data. Use the standard SDS Viewer instead.');
            }
        } catch (err: any) {
            this.panel.webview.html = this.getErrorHtml(err.message);
        }
    }

    private renderImageViewer(parsed: any, metadata: SdsMetadata): void {
        const content = metadata.sds.content;
        const imgMeta = content.find(c => c.image)?.image;
        if (!imgMeta) {
            this.panel.webview.html = this.getErrorHtml('No image metadata found in content.');
            return;
        }

        const frames: { timestamp: number; rgbaBase64: string }[] = [];
        const maxFrames = 100;
        const tickFreq = metadata.sds['tick-frequency'] ?? 1000;

        for (let i = 0; i < Math.min(parsed.records.length, maxFrames); i++) {
            const record = parsed.records[i];
            try {
                const rgba = decodeImageFrameToRGBA(record.data, imgMeta.width, imgMeta.height, imgMeta.pixel_format);
                frames.push({
                    timestamp: record.timestamp / tickFreq,
                    rgbaBase64: Buffer.from(rgba).toString('base64'),
                });
            } catch {
                // Skip corrupted frames
            }
        }

        this.panel.webview.html = this.getImageHtml(frames, imgMeta.width, imgMeta.height, parsed.records.length);
    }

    private renderAudioViewer(parsed: any, metadata: SdsMetadata): void {
        const content = metadata.sds.content;
        const audioMeta = content.find(c => c.audio)?.audio;
        if (!audioMeta) {
            this.panel.webview.html = this.getErrorHtml('No audio metadata found in content.');
            return;
        }

        const allSamples: number[][] = [];
        const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
        const timestamps: number[] = [];

        for (const record of parsed.records) {
            try {
                const block = decodeAudioBlock(record.data, audioMeta.sample_rate, audioMeta.bit_depth, audioMeta.audio_channels);
                allSamples.push(Array.from(block[0]));
                timestamps.push(record.timestamp / tickFreq);
            } catch {
                // Skip corrupted blocks
            }
        }

        const flatSamples = allSamples.flat();
        const maxPoints = 20000;
        const step = Math.max(1, Math.floor(flatSamples.length / maxPoints));
        const displaySamples: number[] = [];
        for (let i = 0; i < flatSamples.length; i += step) {
            displaySamples.push(flatSamples[i]);
        }

        this.panel.webview.html = this.getAudioHtml(
            displaySamples,
            audioMeta.sample_rate,
            audioMeta.bit_depth,
            audioMeta.audio_channels,
            flatSamples.length,
            parsed.records.length
        );
    }

    private renderVideoViewer(parsed: any, metadata: SdsMetadata): void {
        const content = metadata.sds.content;
        const vidMeta = content.find(c => c.video)?.video;
        if (!vidMeta) {
            this.panel.webview.html = this.getErrorHtml('No video metadata found in content.');
            return;
        }

        const frames: { timestamp: number; rgbaBase64: string }[] = [];
        const maxFrames = 50;
        const tickFreq = metadata.sds['tick-frequency'] ?? 1000;

        for (let i = 0; i < Math.min(parsed.records.length, maxFrames); i++) {
            const record = parsed.records[i];
            try {
                const rgba = decodeImageFrameToRGBA(record.data, vidMeta.width, vidMeta.height, vidMeta.pixel_format);
                frames.push({
                    timestamp: record.timestamp / tickFreq,
                    rgbaBase64: Buffer.from(rgba).toString('base64'),
                });
            } catch {
                // Skip corrupted frames
            }
        }

        this.panel.webview.html = this.getVideoHtml(frames, vidMeta.width, vidMeta.height, vidMeta.fps, parsed.records.length);
    }

    // ── HTML generators ─────────────────────────────────────────

    private getImageHtml(frames: { timestamp: number; rgbaBase64: string }[], width: number, height: number, totalFrames: number): string {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Image Viewer</title>
<style>
    :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border); --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground); --btn-hover: var(--vscode-button-hoverBackground); }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; display: flex; flex-direction: column; height: 100vh; }
    .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .toolbar h2 { font-size: 14px; margin-right: 16px; }
    button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--btn-hover); }
    .info-bar { display: flex; gap: 16px; padding: 6px 12px; font-size: 11px; opacity: 0.8; border-bottom: 1px solid var(--border); }
    .canvas-area { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 20px; }
    canvas { image-rendering: pixelated; border: 1px solid var(--border); }
    .frame-nav { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); }
    input[type=range] { flex: 1; }
    .frame-info { font-size: 11px; min-width: 120px; text-align: center; }
</style>
</head>
<body>
<div class="toolbar">
    <h2>🖼 Image Viewer</h2>
    <button id="btnZoomIn">🔍+</button>
    <button id="btnZoomOut">🔍−</button>
    <button id="btnFit">Fit</button>
</div>
<div class="info-bar">
    <span>${width}×${height}</span>
    <span>${totalFrames} frames</span>
    <span>Showing ${frames.length} of ${totalFrames}</span>
</div>
<div class="canvas-area">
    <canvas id="canvas" width="${width}" height="${height}"></canvas>
</div>
<div class="frame-nav">
    <button id="btnPrev">◀</button>
    <input type="range" id="slider" min="0" max="${frames.length - 1}" value="0">
    <button id="btnNext">▶</button>
    <div class="frame-info" id="frameInfo">Frame 1/${frames.length}</div>
</div>
<script>
(function() {
    const vscode = acquireVsCodeApi();
    const frames = ${JSON.stringify(frames)};
    const W = ${width}, H = ${height};
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let zoom = 1;
    let idx = 0;

    function drawFrame() {
        if (frames.length === 0) return;
        const f = frames[idx];
        const raw = atob(f.rgbaBase64);
        const arr = new Uint8ClampedArray(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        const imgData = new ImageData(arr, W, H);
        canvas.width = W; canvas.height = H;
        canvas.style.width = (W * zoom) + 'px';
        canvas.style.height = (H * zoom) + 'px';
        ctx.putImageData(imgData, 0, 0);
        document.getElementById('frameInfo').textContent = 'Frame ' + (idx+1) + '/' + frames.length + ' — ' + f.timestamp.toFixed(3) + 's';
        document.getElementById('slider').value = idx;
    }

    document.getElementById('btnPrev').onclick = () => { if (idx > 0) { idx--; drawFrame(); } };
    document.getElementById('btnNext').onclick = () => { if (idx < frames.length - 1) { idx++; drawFrame(); } };
    document.getElementById('slider').oninput = (e) => { idx = parseInt(e.target.value); drawFrame(); };
    document.getElementById('btnZoomIn').onclick = () => { zoom = Math.min(8, zoom * 1.5); drawFrame(); };
    document.getElementById('btnZoomOut').onclick = () => { zoom = Math.max(0.25, zoom / 1.5); drawFrame(); };
    document.getElementById('btnFit').onclick = () => { zoom = 1; drawFrame(); };

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { if (idx > 0) { idx--; drawFrame(); } }
        if (e.key === 'ArrowRight') { if (idx < frames.length - 1) { idx++; drawFrame(); } }
    });

    drawFrame();
})();
</script>
</body>
</html>`;
    }

    private getAudioHtml(samples: number[], sampleRate: number, bitDepth: number, channels: number, totalSamples: number, totalRecords: number): string {
        const durationSec = totalSamples / sampleRate;
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audio Viewer</title>
<style>
    :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border); --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground); --btn-hover: var(--vscode-button-hoverBackground); }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; display: flex; flex-direction: column; height: 100vh; }
    .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .toolbar h2 { font-size: 14px; margin-right: 16px; }
    button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--btn-hover); }
    .info-bar { display: flex; gap: 16px; padding: 6px 12px; font-size: 11px; opacity: 0.8; border-bottom: 1px solid var(--border); }
    .canvas-area { flex: 1; position: relative; min-height: 200px; }
    canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
</style>
</head>
<body>
<div class="toolbar">
    <h2>🔊 Audio Viewer</h2>
    <button id="btnZoomIn">🔍+</button>
    <button id="btnZoomOut">🔍−</button>
    <button id="btnFit">Fit</button>
</div>
<div class="info-bar">
    <span>${sampleRate} Hz</span>
    <span>${bitDepth}-bit</span>
    <span>${channels}ch</span>
    <span>${totalSamples.toLocaleString()} samples</span>
    <span>${durationSec.toFixed(2)}s</span>
    <span>${totalRecords} records</span>
</div>
<div class="canvas-area">
    <canvas id="waveform"></canvas>
</div>
<script>
(function() {
    const vscode = acquireVsCodeApi();
    const samples = ${JSON.stringify(samples)};
    const sampleRate = ${sampleRate};
    const totalSamples = ${totalSamples};
    const canvas = document.getElementById('waveform');
    const ctx = canvas.getContext('2d');
    let dpr = window.devicePixelRatio || 1;
    let viewStart = 0, viewEnd = 1;

    function resize() {
        dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
    }

    function draw() {
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;
        ctx.clearRect(0, 0, w, h);
        if (samples.length === 0) return;

        const M = { top: 20, right: 20, bottom: 30, left: 50 };
        const pW = w - M.left - M.right;
        const pH = h - M.top - M.bottom;

        const startIdx = Math.floor(viewStart * samples.length);
        const endIdx = Math.ceil(viewEnd * samples.length);
        const visible = samples.slice(startIdx, endIdx);

        let yMin = -1, yMax = 1;
        for (const v of visible) {
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
        const yPad = (yMax - yMin) * 0.1 || 0.1;
        yMin -= yPad; yMax += yPad;

        const zeroY = M.top + pH - (-yMin) / (yMax - yMin) * pH;
        ctx.strokeStyle = 'rgba(128,128,128,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(M.left, zeroY);
        ctx.lineTo(M.left + pW, zeroY);
        ctx.stroke();

        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < visible.length; i++) {
            const x = M.left + (i / visible.length) * pW;
            const y = M.top + pH - (visible[i] - yMin) / (yMax - yMin) * pH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        if (visible.length > pW * 2) {
            ctx.fillStyle = '#4fc3f733';
            const binSize = visible.length / pW;
            for (let px = 0; px < pW; px++) {
                const from = Math.floor(px * binSize);
                const to = Math.min(Math.floor((px + 1) * binSize), visible.length);
                let min = Infinity, max = -Infinity;
                for (let j = from; j < to; j++) {
                    if (visible[j] < min) min = visible[j];
                    if (visible[j] > max) max = visible[j];
                }
                const y1 = M.top + pH - (max - yMin) / (yMax - yMin) * pH;
                const y2 = M.top + pH - (min - yMin) / (yMax - yMin) * pH;
                ctx.fillRect(M.left + px, y1, 1, y2 - y1);
            }
        }

        const tStart = startIdx / sampleRate;
        const tEnd = endIdx / sampleRate;
        ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        for (let i = 0; i <= 5; i++) {
            const t = tStart + (tEnd - tStart) * i / 5;
            const px = M.left + (i / 5) * pW;
            ctx.fillText(t.toFixed(3) + 's', px, M.top + pH + 16);
        }

        ctx.strokeStyle = 'rgba(128,128,128,0.3)';
        ctx.strokeRect(M.left, M.top, pW, pH);
    }

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const M = { left: 50 };
        const pW = (canvas.width / dpr) - M.left - 20;
        const ratio = Math.max(0, Math.min(1, (mx - M.left) / pW));
        const range = viewEnd - viewStart;
        const factor = e.deltaY > 0 ? 1.2 : 0.8;
        const newRange = Math.max(0.001, Math.min(1, range * factor));
        const center = viewStart + ratio * range;
        viewStart = Math.max(0, center - ratio * newRange);
        viewEnd = Math.min(1, center + (1 - ratio) * newRange);
        draw();
    }, { passive: false });

    let dragging = false, dragX = 0, dragVS = 0, dragVE = 0;
    canvas.addEventListener('mousedown', (e) => { dragging = true; dragX = e.clientX; dragVS = viewStart; dragVE = viewEnd; });
    canvas.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const pW = (canvas.width / dpr) - 70;
        const dx = e.clientX - dragX;
        const shift = -(dx / pW) * (dragVE - dragVS);
        viewStart = Math.max(0, Math.min(1 - (dragVE - dragVS), dragVS + shift));
        viewEnd = viewStart + (dragVE - dragVS);
        draw();
    });
    canvas.addEventListener('mouseup', () => { dragging = false; });

    document.getElementById('btnZoomIn').onclick = () => { const c = (viewStart+viewEnd)/2, r = (viewEnd-viewStart)*0.25; viewStart = Math.max(0,c-r); viewEnd = Math.min(1,c+r); draw(); };
    document.getElementById('btnZoomOut').onclick = () => { const c = (viewStart+viewEnd)/2, r = (viewEnd-viewStart); viewStart = Math.max(0,c-r); viewEnd = Math.min(1,c+r); draw(); };
    document.getElementById('btnFit').onclick = () => { viewStart = 0; viewEnd = 1; draw(); };

    window.addEventListener('resize', resize);
    resize();
})();
</script>
</body>
</html>`;
    }

    private getVideoHtml(frames: { timestamp: number; rgbaBase64: string }[], width: number, height: number, fps: number, totalFrames: number): string {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Video Viewer</title>
<style>
    :root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border); --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground); --btn-hover: var(--vscode-button-hoverBackground); }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; display: flex; flex-direction: column; height: 100vh; }
    .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    .toolbar h2 { font-size: 14px; margin-right: 16px; }
    button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--btn-hover); }
    .info-bar { display: flex; gap: 16px; padding: 6px 12px; font-size: 11px; opacity: 0.8; border-bottom: 1px solid var(--border); }
    .canvas-area { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 20px; }
    canvas { image-rendering: pixelated; border: 1px solid var(--border); }
    .controls { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); }
    input[type=range] { flex: 1; }
    .frame-info { font-size: 11px; min-width: 140px; text-align: center; }
</style>
</head>
<body>
<div class="toolbar">
    <h2>🎬 Video Viewer</h2>
    <button id="btnZoomIn">🔍+</button>
    <button id="btnZoomOut">🔍−</button>
    <button id="btnFit">Fit</button>
</div>
<div class="info-bar">
    <span>${width}×${height}</span>
    <span>${fps} FPS</span>
    <span>${totalFrames} total frames</span>
    <span>Loaded: ${frames.length}</span>
</div>
<div class="canvas-area">
    <canvas id="canvas" width="${width}" height="${height}"></canvas>
</div>
<div class="controls">
    <button id="btnPlay">▶ Play</button>
    <button id="btnPrev">◀</button>
    <input type="range" id="slider" min="0" max="${frames.length - 1}" value="0">
    <button id="btnNext">▶</button>
    <div class="frame-info" id="frameInfo">Frame 1/${frames.length}</div>
</div>
<script>
(function() {
    const vscode = acquireVsCodeApi();
    const frames = ${JSON.stringify(frames)};
    const W = ${width}, H = ${height}, FPS = ${fps};
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let zoom = 1, idx = 0, playing = false, timer = null;

    function drawFrame() {
        if (frames.length === 0) return;
        const f = frames[idx];
        const raw = atob(f.rgbaBase64);
        const arr = new Uint8ClampedArray(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        const imgData = new ImageData(arr, W, H);
        canvas.width = W; canvas.height = H;
        canvas.style.width = (W * zoom) + 'px';
        canvas.style.height = (H * zoom) + 'px';
        ctx.putImageData(imgData, 0, 0);
        document.getElementById('frameInfo').textContent = 'Frame ' + (idx+1) + '/' + frames.length + ' — ' + f.timestamp.toFixed(3) + 's';
        document.getElementById('slider').value = idx;
    }

    function togglePlay() {
        playing = !playing;
        document.getElementById('btnPlay').textContent = playing ? '⏸ Pause' : '▶ Play';
        if (playing) {
            timer = setInterval(() => {
                idx = (idx + 1) % frames.length;
                drawFrame();
            }, 1000 / FPS);
        } else {
            clearInterval(timer);
            timer = null;
        }
    }

    document.getElementById('btnPlay').onclick = togglePlay;
    document.getElementById('btnPrev').onclick = () => { if (playing) togglePlay(); if (idx > 0) { idx--; drawFrame(); } };
    document.getElementById('btnNext').onclick = () => { if (playing) togglePlay(); if (idx < frames.length - 1) { idx++; drawFrame(); } };
    document.getElementById('slider').oninput = (e) => { if (playing) togglePlay(); idx = parseInt(e.target.value); drawFrame(); };
    document.getElementById('btnZoomIn').onclick = () => { zoom = Math.min(8, zoom * 1.5); drawFrame(); };
    document.getElementById('btnZoomOut').onclick = () => { zoom = Math.max(0.25, zoom / 1.5); drawFrame(); };
    document.getElementById('btnFit').onclick = () => { zoom = 1; drawFrame(); };

    document.addEventListener('keydown', (e) => {
        if (e.key === ' ') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') { if (idx > 0) { idx--; drawFrame(); } }
        if (e.key === 'ArrowRight') { if (idx < frames.length - 1) { idx++; drawFrame(); } }
    });

    drawFrame();
})();
</script>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        return /*html*/ `<!DOCTYPE html>
<html><head><style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); display: flex; align-items: center; justify-content: center; height: 100vh; }
    .error { text-align: center; }
    .error h2 { color: var(--vscode-errorForeground); margin-bottom: 16px; }
</style></head><body>
<div class="error"><h2>Media Viewer Error</h2><p>${escapeHtml(message)}</p></div>
</body></html>`;
    }

    private findMetadataFile(sdsPath: string): string | undefined {
        const dir = path.dirname(sdsPath);
        const base = path.basename(sdsPath);
        const match = base.match(/^(.+)\.\d+\.sds$/);
        if (match) {
            const metaPath = path.join(dir, `${match[1]}${SDS_METADATA_EXTENSION}`);
            if (fs.existsSync(metaPath)) {
                return metaPath;
            }
        }
        return undefined;
    }

    private dispose(): void {
        SdsMediaViewerPanel.panels.delete(this.sdsFilePath);
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
