/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
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
} from '../sds';

export class SdsViewerPanel {
    public static readonly viewType = 'arm-sds.viewer';
    private static panels = new Map<string, SdsViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private sdsFilePath: string;
    private metadataPath: string | undefined;

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

        this.panel.iconPath = new vscode.ThemeIcon('graph-line');
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: any): Promise<void> {
        try {
            switch (message.command) {
                case 'exportCsv':
                    await vscode.commands.executeCommand('arm-sds.exportCsv', this.sdsFilePath);
                    break;
                case 'refresh':
                    this.update();
                    break;
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Viewer error: ${err.message}`);
        }
    }

    private update(): void {
        // Find metadata file if not specified
        if (!this.metadataPath) {
            this.metadataPath = this.findMetadataFile(this.sdsFilePath);
        }

        try {
            const parsed = parseSdsFile(this.sdsFilePath);

            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath);
            }

            const tickFreq = metadata?.sds['tick-frequency'] ?? 1000;
            const stats = getSdsFileStats(parsed, tickFreq);

            const samples: any[] = [];
            let channelNames: string[] = [];

            if (metadata) {
                const decoded = decodeAllRecords(parsed, metadata);
                channelNames = metadata.sds.content.map(c => c.value);

                // Downsample for performance if too many points
                const maxPoints = 10000;
                const step = Math.max(1, Math.floor(decoded.length / maxPoints));
                for (let i = 0; i < decoded.length; i += step) {
                    samples.push(decoded[i]);
                }
            } else {
                // Without metadata, show raw record sizes over time
                channelNames = ['data_size'];
                for (const record of parsed.records) {
                    samples.push({
                        timestamp: record.timestamp,
                        timeSeconds: record.timestamp / tickFreq,
                        values: { data_size: record.dataSize },
                    });
                }
            }

            this.panel.webview.html = this.getHtml(
                samples,
                channelNames,
                stats,
                metadata,
                path.basename(this.sdsFilePath)
            );
        } catch (err: any) {
            this.panel.webview.html = this.getErrorHtml(err.message);
        }
    }

    private findMetadataFile(sdsPath: string): string | undefined {
        const dir = path.dirname(sdsPath);
        const base = path.basename(sdsPath);
        // <name>.<index>.sds -> <name>.sds.yml
        const match = base.match(/^(.+)\.\d+\.sds$/);
        if (match) {
            const metaPath = path.join(dir, `${match[1]}${SDS_METADATA_EXTENSION}`);
            if (fs.existsSync(metaPath)) {
                return metaPath;
            }
        }
        return undefined;
    }

    private getHtml(
        samples: any[],
        channelNames: string[],
        stats: any,
        metadata: SdsMetadata | undefined,
        fileName: string
    ): string {
        const dataJson = JSON.stringify(samples);
        const channelsJson = JSON.stringify(channelNames);
        const statsJson = JSON.stringify(stats);
        const metaJson = JSON.stringify(metadata ?? null);

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SDS Viewer</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border);
            --accent: var(--vscode-focusBorder);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --btn-hover: var(--vscode-button-hoverBackground);
            --badge-bg: var(--vscode-badge-background);
            --badge-fg: var(--vscode-badge-foreground);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--bg);
            color: var(--fg);
            font-family: var(--vscode-font-family);
            font-size: 13px;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border);
            flex-wrap: wrap;
        }
        .toolbar h2 { font-size: 14px; font-weight: 600; margin-right: 16px; }
        .toolbar button {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 4px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }
        .toolbar button:hover { background: var(--btn-hover); }
        .channel-toggles {
            display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto;
        }
        .channel-toggle {
            display: flex; align-items: center; gap: 4px;
            padding: 2px 8px; border-radius: 10px;
            font-size: 11px; cursor: pointer;
            border: 1px solid var(--border);
        }
        .channel-toggle.active { background: var(--badge-bg); color: var(--badge-fg); }
        .channel-toggle .dot {
            width: 8px; height: 8px; border-radius: 50%;
        }
        .stats-bar {
            display: flex; gap: 16px; padding: 6px 12px;
            font-size: 11px; opacity: 0.8;
            border-bottom: 1px solid var(--border);
            flex-wrap: wrap;
        }
        .stats-bar .stat-label { opacity: 0.7; }
        .canvas-container {
            position: relative;
            width: 100%;
            flex: 1;
            min-height: 0;
        }
        canvas {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
        }
        .tooltip {
            position: absolute;
            background: var(--vscode-editorHoverWidget-background);
            border: 1px solid var(--vscode-editorHoverWidget-border);
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 11px;
            pointer-events: none;
            display: none;
            z-index: 10;
            white-space: pre;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <h2>${escapeHtml(fileName)}</h2>
        <button id="btnZoomIn" title="Zoom In">🔍+</button>
        <button id="btnZoomOut" title="Zoom Out">🔍−</button>
        <button id="btnFit" title="Fit to Window">⊞ Fit</button>
        <button id="btnExport" title="Export CSV">📤 Export</button>
        <div class="channel-toggles" id="channelToggles"></div>
    </div>
    <div class="stats-bar" id="statsBar"></div>
    <div class="canvas-container">
        <canvas id="chart"></canvas>
        <div class="tooltip" id="tooltip"></div>
    </div>

    <script>
    (function() {
        const vscode = acquireVsCodeApi();
        const samples = ${dataJson};
        const channelNames = ${channelsJson};
        const stats = ${statsJson};
        const metadata = ${metaJson};

        // Colors for channels
        const COLORS = [
            '#4fc3f7', '#81c784', '#ffb74d', '#e57373',
            '#ba68c8', '#4db6ac', '#fff176', '#f06292',
            '#90a4ae', '#aed581'
        ];

        // State
        let activeChannels = new Set(channelNames);
        let viewStart = 0;
        let viewEnd = samples.length > 0
            ? samples[samples.length - 1].timeSeconds
            : 1;
        let isDragging = false;
        let dragStartX = 0;
        let dragViewStart = 0;
        let dragViewEnd = 0;

        // Setup stats bar
        const statsBar = document.getElementById('statsBar');
        statsBar.innerHTML = [
            stat('Records', stats.totalRecords),
            stat('Duration', stats.recordingTimeSeconds.toFixed(2) + ' s'),
            stat('Interval', (stats.recordingIntervalMs || 0).toFixed(1) + ' ms'),
            stat('Data Rate', stats.dataRate + ' B/s'),
            stat('Avg Block', stats.avgBlockSize + ' B'),
            metadata ? stat('Frequency', metadata.sds.frequency + ' Hz') : '',
            metadata ? stat('Stream', metadata.sds.name) : '',
        ].filter(Boolean).join('');

        function stat(label, value) {
            return '<span><span class="stat-label">' + label + ':</span> ' + value + '</span>';
        }

        // Setup channel toggles
        const togglesEl = document.getElementById('channelToggles');
        channelNames.forEach((name, i) => {
            const el = document.createElement('div');
            el.className = 'channel-toggle active';
            el.innerHTML = '<span class="dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' + name;
            el.addEventListener('click', () => {
                if (activeChannels.has(name)) {
                    activeChannels.delete(name);
                    el.classList.remove('active');
                } else {
                    activeChannels.add(name);
                    el.classList.add('active');
                }
                draw();
            });
            togglesEl.appendChild(el);
        });

        // Canvas setup
        const canvas = document.getElementById('chart');
        const ctx = canvas.getContext('2d');
        const tooltip = document.getElementById('tooltip');
        let dpr = window.devicePixelRatio || 1;

        const MARGIN = { top: 20, right: 40, bottom: 40, left: 60 };

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

        function getPlotArea() {
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            return {
                x: MARGIN.left,
                y: MARGIN.top,
                w: w - MARGIN.left - MARGIN.right,
                h: h - MARGIN.top - MARGIN.bottom,
            };
        }

        function draw() {
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);

            const plot = getPlotArea();
            if (plot.w <= 0 || plot.h <= 0 || samples.length === 0) return;

            // Filter visible samples
            const visible = samples.filter(
                s => s.timeSeconds >= viewStart && s.timeSeconds <= viewEnd
            );
            if (visible.length === 0) return;

            // Calculate Y range across active channels
            let yMin = Infinity, yMax = -Infinity;
            for (const s of visible) {
                for (const ch of activeChannels) {
                    const v = s.values[ch];
                    if (v !== undefined) {
                        if (v < yMin) yMin = v;
                        if (v > yMax) yMax = v;
                    }
                }
            }
            if (yMin === yMax) { yMin -= 1; yMax += 1; }
            const yPad = (yMax - yMin) * 0.05;
            yMin -= yPad;
            yMax += yPad;

            // Transforms
            function xToPixel(t) { return plot.x + (t - viewStart) / (viewEnd - viewStart) * plot.w; }
            function yToPixel(v) { return plot.y + plot.h - (v - yMin) / (yMax - yMin) * plot.h; }

            // Grid
            ctx.strokeStyle = 'rgba(128,128,128,0.15)';
            ctx.lineWidth = 1;
            const xTicks = niceScale(viewStart, viewEnd, 8);
            const yTicks = niceScale(yMin, yMax, 6);

            ctx.beginPath();
            for (const xt of xTicks) {
                const px = xToPixel(xt);
                ctx.moveTo(px, plot.y);
                ctx.lineTo(px, plot.y + plot.h);
            }
            for (const yt of yTicks) {
                const py = yToPixel(yt);
                ctx.moveTo(plot.x, py);
                ctx.lineTo(plot.x + plot.w, py);
            }
            ctx.stroke();

            // Axis labels
            ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            for (const xt of xTicks) {
                ctx.fillText(formatTime(xt), xToPixel(xt), plot.y + plot.h + 16);
            }
            ctx.textAlign = 'right';
            for (const yt of yTicks) {
                ctx.fillText(yt.toPrecision(4), plot.x - 6, yToPixel(yt) + 3);
            }

            // Axis label text
            ctx.save();
            ctx.textAlign = 'center';
            ctx.fillText('Time (s)', plot.x + plot.w / 2, plot.y + plot.h + 34);
            ctx.restore();

            // Plot channels
            channelNames.forEach((ch, i) => {
                if (!activeChannels.has(ch)) return;
                ctx.strokeStyle = COLORS[i % COLORS.length];
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                let started = false;
                for (const s of visible) {
                    const v = s.values[ch];
                    if (v === undefined) continue;
                    const px = xToPixel(s.timeSeconds);
                    const py = yToPixel(v);
                    if (!started) { ctx.moveTo(px, py); started = true; }
                    else { ctx.lineTo(px, py); }
                }
                ctx.stroke();
            });

            // Border
            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.lineWidth = 1;
            ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
        }

        function niceScale(min, max, maxTicks) {
            const range = max - min;
            if (range <= 0) return [min];
            const rough = range / maxTicks;
            const pow = Math.pow(10, Math.floor(Math.log10(rough)));
            let step = pow;
            if (rough / pow >= 5) step = pow * 5;
            else if (rough / pow >= 2) step = pow * 2;

            const ticks = [];
            let t = Math.ceil(min / step) * step;
            while (t <= max) {
                ticks.push(t);
                t += step;
            }
            return ticks;
        }

        function formatTime(t) {
            if (Math.abs(t) < 0.001) return '0';
            if (Math.abs(t) < 1) return (t * 1000).toFixed(1) + 'ms';
            return t.toFixed(3) + 's';
        }

        // Mouse interactions
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const plot = getPlotArea();
            const ratio = (mouseX - plot.x) / plot.w;
            const range = viewEnd - viewStart;
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            const newRange = range * factor;
            const center = viewStart + ratio * range;
            viewStart = center - ratio * newRange;
            viewEnd = center + (1 - ratio) * newRange;
            draw();
        }, { passive: false });

        canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragStartX = e.clientX;
            dragViewStart = viewStart;
            dragViewEnd = viewEnd;
        });

        canvas.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const rect = canvas.getBoundingClientRect();
                const plot = getPlotArea();
                const dx = e.clientX - dragStartX;
                const range = dragViewEnd - dragViewStart;
                const shift = -dx / plot.w * range;
                viewStart = dragViewStart + shift;
                viewEnd = dragViewEnd + shift;
                draw();
                return;
            }

            // Tooltip
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const plot = getPlotArea();

            if (mx >= plot.x && mx <= plot.x + plot.w && my >= plot.y && my <= plot.y + plot.h) {
                const t = viewStart + (mx - plot.x) / plot.w * (viewEnd - viewStart);
                // Find nearest sample
                let best = null, bestDist = Infinity;
                for (const s of samples) {
                    const d = Math.abs(s.timeSeconds - t);
                    if (d < bestDist) { bestDist = d; best = s; }
                }
                if (best) {
                    let text = 'Time: ' + best.timeSeconds.toFixed(4) + 's\\n';
                    text += 'Timestamp: ' + best.timestamp + '\\n';
                    for (const ch of channelNames) {
                        if (activeChannels.has(ch) && best.values[ch] !== undefined) {
                            text += ch + ': ' + best.values[ch].toFixed(4) + '\\n';
                        }
                    }
                    tooltip.style.display = 'block';
                    tooltip.style.left = (mx + 12) + 'px';
                    tooltip.style.top = (my - 10) + 'px';
                    tooltip.textContent = text.trimEnd();
                }
            } else {
                tooltip.style.display = 'none';
            }
        });

        canvas.addEventListener('mouseup', () => { isDragging = false; });
        canvas.addEventListener('mouseleave', () => {
            isDragging = false;
            tooltip.style.display = 'none';
        });

        // Buttons
        document.getElementById('btnZoomIn').addEventListener('click', () => {
            const center = (viewStart + viewEnd) / 2;
            const range = (viewEnd - viewStart) * 0.5;
            viewStart = center - range / 2;
            viewEnd = center + range / 2;
            draw();
        });
        document.getElementById('btnZoomOut').addEventListener('click', () => {
            const center = (viewStart + viewEnd) / 2;
            const range = (viewEnd - viewStart) * 2;
            viewStart = center - range / 2;
            viewEnd = center + range / 2;
            draw();
        });
        document.getElementById('btnFit').addEventListener('click', () => {
            if (samples.length > 0) {
                viewStart = samples[0].timeSeconds;
                viewEnd = samples[samples.length - 1].timeSeconds;
                const pad = (viewEnd - viewStart) * 0.02;
                viewStart -= pad;
                viewEnd += pad;
            }
            draw();
        });
        document.getElementById('btnExport').addEventListener('click', () => {
            vscode.postMessage({ command: 'exportCsv' });
        });

        window.addEventListener('resize', () => { resize(); });
        resize();
    })();
    </script>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        return /*html*/ `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }
        .error { text-align: center; }
        .error h2 { color: var(--vscode-errorForeground); margin-bottom: 16px; }
    </style>
</head>
<body>
    <div class="error">
        <h2>Error Loading SDS File</h2>
        <p>${escapeHtml(message)}</p>
    </div>
</body>
</html>`;
    }

    private dispose(): void {
        SdsViewerPanel.panels.delete(this.sdsFilePath);
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
