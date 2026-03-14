/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Recorder Panel
 *
 * Webview-based recording interface for capturing SDS data streams.
 * Supports real hardware via serial, socket, or USB (SDSIO protocol),
 * plus a built-in demo signal (multi-channel sinewave) for testing.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    SdsRecord,
    SdsMetadata,
    SdsRecordingSession,
    SDS_METADATA_EXTENSION,
} from '../sds/types';
import { writeSdsFile, writeMetadataFile, findNextFileIndex } from '../sds/writer';
import {
    SdsioServer,
    SdsioServerConfig,
    SdsioServerState,
} from './sdsio';
import { SerialTransport } from './sdsio/serialTransport';

export class SdsRecorderPanel {
    public static readonly viewType = 'arm-sds.recorder';
    private static instance: SdsRecorderPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private session: SdsRecordingSession | undefined;
    private recordingTimer: NodeJS.Timeout | undefined;
    private accumulatedRecords: SdsRecord[] = [];
    /** Prevents concurrent start/stop operations */
    private busy = false;
    /** True once the panel has been disposed */
    private disposed = false;

    /** Native SDSIO server for real-hardware recording */
    private sdsioServer: SdsioServer | undefined;
    private outputChannel: vscode.OutputChannel;

    public static createOrShow(extensionUri: vscode.Uri): SdsRecorderPanel {
        if (SdsRecorderPanel.instance) {
            SdsRecorderPanel.instance.panel.reveal();
            return SdsRecorderPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            SdsRecorderPanel.viewType,
            'SDS Recorder',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        SdsRecorderPanel.instance = new SdsRecorderPanel(panel, extensionUri);
        return SdsRecorderPanel.instance;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.outputChannel = vscode.window.createOutputChannel('SDS Recorder');

        this.panel.iconPath = new vscode.ThemeIcon('record');
        this.panel.webview.html = this.getHtml();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => this.outputChannel.appendLine(`[SDS Recorder] Message error: ${err}`)); },
            null,
            this.disposables
        );
    }

    /** Safe wrapper — silently drops messages if the panel has been disposed. */
    private postMessage(message: any): void {
        if (this.disposed) { return; }
        try {
            this.panel.webview.postMessage(message);
        } catch {
            // Panel may have been disposed between the check and the call
        }
    }

    private async handleMessage(message: any): Promise<void> {
        try {
            switch (message.command) {
                case 'startRecording':
                    await this.startRecording(message.config);
                    break;
                case 'stopRecording':
                    await this.stopRecording();
                    break;
                case 'getSerialPorts':
                    await this._enumerateSerialPorts();
                    break;
                case 'getServerState':
                    this.postMessage({
                        command: 'serverStateChanged',
                        state: this.sdsioServer?.state ?? 'stopped',
                    });
                    break;
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Recorder error: ${err.message}`);
        }
    }

    /** Public accessor for the recording session (used in testing / wiring) */
    public getSession(): SdsRecordingSession | undefined {
        return this.session;
    }

    private async startRecording(config: any): Promise<void> {
        if (this.busy) {
            vscode.window.showWarningMessage('Recorder is busy — please wait.');
            return;
        }
        this.busy = true;
        try {
            await this._doStartRecording(config);
        } finally {
            this.busy = false;
        }
    }

    private async _doStartRecording(config: any): Promise<void> {
        // Guard against starting while already recording — clean up previous session
        if (this.session) {
            if (this.recordingTimer) {
                clearInterval(this.recordingTimer);
                this.recordingTimer = undefined;
            }
            this.session.isRecording = false;
            if (this.sdsioServer) {
                this.sdsioServer.removeAllListeners();
                this.sdsioServer.stop();
                this.sdsioServer = undefined;
            }
            this.session = undefined;
            this.accumulatedRecords = [];
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('Open a workspace folder first.');
            return;
        }

        const outputDir = path.join(
            workspaceFolders[0].uri.fsPath,
            config.outputDirectory || 'sds_recordings'
        );

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const streamName = config.streamName || 'Recording';
        const fileIndex = findNextFileIndex(outputDir, streamName);
        const outputFile = path.join(outputDir, `${streamName}.${fileIndex}.sds`);

        this.session = {
            id: Date.now().toString(),
            config: {
                mode: config.mode || 'demo',
                serialPort: config.serialPort,
                baudRate: config.baudRate || 115200,
                outputDirectory: outputDir,
                streamName,
            },
            startTime: new Date(),
            recordCount: 0,
            totalBytes: 0,
            isRecording: true,
            outputFile,
        };

        this.accumulatedRecords = [];

        if (config.mode === 'demo') {
            this.startDemoRecording(config);
        } else {
            // Real hardware — launch SDSIO server
            try {
                await this.startHardwareRecording(config);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to start recording: ${err.message}`);
                this.session = undefined;
                return;
            }
        }

        this.postMessage({
            command: 'recordingStarted',
            session: {
                ...this.session,
                startTime: this.session.startTime.toISOString(),
            },
            isHardwareMode: config.mode !== 'demo',
        });

        if (config.mode === 'demo') {
            vscode.window.showInformationMessage(`SDS Recording started: ${outputFile}`);
        } else {
            vscode.window.showInformationMessage(`SDS Server started (${config.mode}) — waiting for device...`);
        }
    }

    // ── Hardware recording via native SDSIO server ────────────────

    private async startHardwareRecording(config: any): Promise<void> {
        const workDir = this.session!.config.outputDirectory;
        this.outputChannel.appendLine(`[SDS Recorder] Mode: ${config.mode}`);
        this.outputChannel.appendLine(`[SDS Recorder] Working directory: ${workDir}`);
        this.outputChannel.show(true);

        const serverConfig: SdsioServerConfig = {
            mode: config.mode,
            workDir,
        };

        if (config.mode === 'serial') {
            if (!config.serialPort) { throw new Error('Serial port is required.'); }
            serverConfig.serial = {
                port: config.serialPort,
                baudRate: config.baudRate,
                parity: config.parity,
                stopBits: config.stopBits,
            };
        } else if (config.mode === 'socket') {
            serverConfig.socket = {
                ipAddress: config.ipAddress,
                port: config.tcpPort,
            };
        }

        this.sdsioServer = new SdsioServer(workDir);
        this._wireSdsioServerEvents(this.sdsioServer);

        await this.sdsioServer.start(serverConfig);

        // Periodic status reporter for the webview
        this.recordingTimer = setInterval(() => {
            try {
                if (!this.session?.isRecording) { return; }
                this._sendServerStatus();
            } catch { /* timer error */ }
        }, 1000);
    }

    /** Wire native SDSIO server events to webview messages. */
    private _wireSdsioServerEvents(server: SdsioServer): void {
        server.on('log', (msg: string) => {
            try { this.outputChannel.appendLine(msg); } catch { /* disposed */ }
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'log', message: msg },
            });
        });

        server.on('error', (msg: string) => {
            try { this.outputChannel.appendLine(`ERROR: ${msg}`); } catch { /* disposed */ }
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'error', message: msg },
            });
        });

        server.on('record', (name: string, filePath: string) => {
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'stream-open', message: `Record: ${name} (${filePath})`, streamName: name, filePath },
            });
            this._sendServerStatus();
        });

        server.on('close', (name: string, filePath: string) => {
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'stream-close', message: `Closed: ${name} (${filePath})`, streamName: name, filePath },
            });
            this._sendServerStatus();
        });

        server.on('stateChange', (state: SdsioServerState) => {
            this.postMessage({
                command: 'serverStateChanged',
                state,
            });

            // If server stopped unexpectedly during recording, clean up session
            if (state === 'stopped' && this.session?.isRecording) {
                this.session.isRecording = false;
                this.postMessage({
                    command: 'recordingStopped',
                    recordCount: this.sdsioServer?.fileCount ?? 0,
                    totalBytes: this.sdsioServer?.totalBytes ?? 0,
                    outputFile: this.session.outputFile,
                });
                this.session = undefined;
            }
        });

        server.on('filesChanged', () => {
            this._sendServerStatus();
        });
    }

    private _sendServerStatus(): void {
        if (!this.session || !this.sdsioServer) { return; }
        const elapsed = Date.now() - this.session.startTime.getTime();
        this.session.totalBytes = this.sdsioServer.totalBytes;
        this.session.recordCount = this.sdsioServer.fileCount;

        this.postMessage({
            command: 'recordingStatus',
            recordCount: this.sdsioServer.fileCount,
            totalBytes: this.sdsioServer.totalBytes,
            elapsed,
            streams: Array.from(this.sdsioServer.openStreams.entries()).map(
                ([name, filePath]) => ({ name, filePath })
            ),
            serverState: this.sdsioServer.state,
        });
    }

    // ── Serial port enumeration ─────────────────────────────────

    private async _enumerateSerialPorts(): Promise<void> {
        let ports: string[] = [];

        try {
            ports = await SerialTransport.listPorts();
        } catch (err: any) {
            this.outputChannel.appendLine(`[SDS Recorder] Port enumeration error: ${err.message}`);
        }

        if (ports.length === 0) {
            ports.push('(no ports detected — enter manually)');
        }

        this.postMessage({
            command: 'serialPorts',
            ports,
        });
    }

    // ── Demo signal (multi-channel sinewave) ─────────────────────

    /**
     * Generates a multi-channel sinewave demo signal.
     * Each channel uses a slightly different frequency so the traces are visually distinct.
     */
    private startDemoRecording(config: any): void {
        const frequency = config.frequency || 100;
        const channels = config.channels || ['x', 'y', 'z'];
        const intervalMs = Math.max(10, Math.round(1000 / frequency));

        let timestamp = 0;
        let t = 0;

        this.recordingTimer = setInterval(() => {
            try {
                if (!this.session?.isRecording) { return; }

                const frameSize = channels.length * 4; // float32 per channel
                const data = Buffer.alloc(frameSize);

                channels.forEach((ch: string, i: number) => {
                    const freq = 1 + i * 0.5;          // 1 Hz, 1.5 Hz, 2 Hz, …
                    const amplitude = 100 + i * 50;
                    const noise = (Math.random() - 0.5) * 10;
                    const value = amplitude * Math.sin(2 * Math.PI * freq * t) + noise;
                    data.writeFloatLE(value, i * 4);
                });

                const record: SdsRecord = {
                    timestamp,
                    dataSize: frameSize,
                    data,
                };

                this.accumulatedRecords.push(record);
                this.session!.recordCount++;
                this.session!.totalBytes += 8 + frameSize;

                timestamp += intervalMs;
                t += intervalMs / 1000;

                if (this.session!.recordCount % 10 === 0) {
                    this.postMessage({
                        command: 'recordingStatus',
                        recordCount: this.session!.recordCount,
                        totalBytes: this.session!.totalBytes,
                        elapsed: Date.now() - this.session!.startTime.getTime(),
                    });
                }
            } catch { /* timer error */ }
        }, intervalMs);
    }

    /** Write metadata for the demo sinewave recording (only if no file exists yet). */
    private writeDemoMetadata(): void {
        if (!this.session) { return; }
        const metaPath = path.join(
            this.session.config.outputDirectory,
            `${this.session.config.streamName}${SDS_METADATA_EXTENSION}`
        );
        if (fs.existsSync(metaPath)) { return; }
        const metadata: SdsMetadata = {
            sds: {
                name: this.session.config.streamName,
                description: 'Demo sensor data (sinewave)',
                frequency: 100,
                content: [
                    { value: 'x', type: 'float', unit: 'mG' },
                    { value: 'y', type: 'float', unit: 'mG' },
                    { value: 'z', type: 'float', unit: 'mG' },
                ],
            },
        };
        writeMetadataFile(metaPath, metadata);
    }

    private async stopRecording(): Promise<void> {
        if (!this.session) { return; }
        if (this.busy) {
            vscode.window.showWarningMessage('Recorder is busy — please wait.');
            return;
        }
        this.busy = true;
        try {
            await this._doStopRecording();
        } finally {
            this.busy = false;
        }
    }

    private async _doStopRecording(): Promise<void> {
        if (!this.session) { return; }

        const stoppingSession = this.session;
        const stoppingRecords = this.accumulatedRecords;
        const stoppingServer = this.sdsioServer;

        stoppingSession.isRecording = false;

        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = undefined;
        }

        const isDemo = stoppingSession.config.mode === 'demo';

        if (!isDemo && stoppingServer) {
            stoppingServer.stop();
        }

        if (stoppingRecords.length > 0) {
            try {
                writeSdsFile(stoppingSession.outputFile, stoppingRecords);
                if (isDemo) {
                    this.writeDemoMetadata();
                }
                vscode.window.showInformationMessage(
                    `SDS Recording saved: ${path.basename(stoppingSession.outputFile)} ` +
                    `(${stoppingSession.recordCount} records, ${formatBytes(stoppingSession.totalBytes)})`
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to save recording: ${err.message}`);
            }
        } else if (!isDemo) {
            const fileCount = stoppingServer?.fileCount ?? 0;
            const totalBytes = stoppingServer?.totalBytes ?? 0;
            if (fileCount > 0) {
                vscode.window.showInformationMessage(
                    `SDS Recording complete: ${fileCount} stream(s), ${formatBytes(totalBytes)}`
                );
            } else {
                vscode.window.showInformationMessage('SDS Recording stopped (no data captured).');
            }
        }

        vscode.commands.executeCommand('arm-sds.refreshExplorer');

        const hwFileCount = stoppingServer?.fileCount ?? 0;
        const hwTotalBytes = stoppingServer?.totalBytes ?? 0;

        this.postMessage({
            command: 'recordingStopped',
            recordCount: isDemo ? stoppingSession.recordCount : hwFileCount,
            totalBytes: isDemo ? stoppingSession.totalBytes : hwTotalBytes,
            outputFile: stoppingSession.outputFile,
        });

        if (this.session === stoppingSession) {
            this.accumulatedRecords = [];
            this.session = undefined;
        }
        if (this.sdsioServer === stoppingServer) {
            this.sdsioServer = undefined;
        }
    }

    private getHtml(): string {
        const config = vscode.workspace.getConfiguration('arm-sds.recorder');
        const defaultPort = config.get<string>('serialPort', '');
        const defaultBaud = config.get<number>('baudRate', 115200);
        const defaultDir = config.get<string>('outputDirectory', './sds_recordings');

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SDS Recorder</title>
    <style>
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --border: var(--vscode-panel-border);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --btn-hover: var(--vscode-button-hoverBackground);
            --error: var(--vscode-errorForeground);
            --success: #4caf50;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--bg);
            color: var(--fg);
            font-family: var(--vscode-font-family);
            font-size: 13px;
            padding: 20px;
        }
        h1 { font-size: 18px; margin-bottom: 20px; }
        h2 { font-size: 14px; margin-bottom: 12px; opacity: 0.9; }
        .section {
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .form-group {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 12px;
        }
        .form-row {
            display: flex;
            gap: 12px;
        }
        .form-row .form-group { flex: 1; }
        label { font-size: 11px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
        input, select {
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            padding: 6px 10px;
            border-radius: 3px;
            font-size: 13px;
            font-family: inherit;
        }
        button {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 8px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-family: inherit;
        }
        button:hover { background: var(--btn-hover); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-record {
            background: #d32f2f;
            color: white;
            font-weight: bold;
            font-size: 14px;
            padding: 10px 32px;
        }
        .btn-record:hover { background: #b71c1c; }
        .btn-stop {
            background: #555;
            color: white;
            font-size: 14px;
            padding: 10px 32px;
        }
        .btn-secondary {
            background: var(--btn-bg);
            color: var(--btn-fg);
            font-size: 12px;
            padding: 6px 14px;
        }
        .controls { display: flex; gap: 12px; align-items: center; }
        .status-panel {
            display: none;
            margin-top: 16px;
        }
        .status-panel.active { display: block; }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
        }
        .status-item {
            padding: 8px 12px;
            border-radius: 4px;
            background: rgba(128,128,128,0.1);
        }
        .status-item .label { font-size: 10px; opacity: 0.7; text-transform: uppercase; }
        .status-item .value { font-size: 16px; font-weight: 600; margin-top: 2px; }
        .recording-indicator {
            display: inline-block;
            width: 10px; height: 10px;
            background: #d32f2f;
            border-radius: 50%;
            animation: pulse 1s infinite;
            margin-right: 8px;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .live-preview {
            width: 100%;
            height: 120px;
            margin-top: 12px;
            border: 1px solid var(--border);
            border-radius: 4px;
        }
        .server-state {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .server-state .dot {
            width: 8px; height: 8px;
            border-radius: 50%;
        }
        .server-state.stopped .dot { background: #888; }
        .server-state.starting .dot { background: #ff9800; }
        .server-state.waiting .dot { background: #ff9800; animation: pulse 1s infinite; }
        .server-state.connected .dot { background: #4caf50; }
        .server-state.recording .dot { background: #d32f2f; animation: pulse 0.5s infinite; }
        .server-state.error .dot { background: #d32f2f; }
        .log-panel {
            margin-top: 12px;
            max-height: 200px;
            overflow-y: auto;
            background: rgba(0,0,0,0.15);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 8px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            line-height: 1.5;
        }
        .log-line { white-space: pre-wrap; word-break: break-all; }
        .log-line.error { color: var(--error); }
        .log-line.stream { color: var(--success); }
        .streams-list {
            margin-top: 8px;
            padding: 0;
            list-style: none;
        }
        .streams-list li {
            padding: 4px 8px;
            border-radius: 3px;
            background: rgba(76,175,80,0.1);
            margin-bottom: 4px;
            font-size: 12px;
        }
        .streams-list li::before { content: "📡 "; }
    </style>
</head>
<body>
    <h1>⏺ SDS Recorder</h1>

    <div class="section">
        <h2>Connection Settings</h2>
        <div class="form-row">
            <div class="form-group">
                <label>Mode</label>
                <select id="mode">
                    <option value="usb">USB (Bulk)</option>
                    <option value="serial">Serial (UART)</option>
                    <option value="socket">Socket (TCP/IP)</option>
                    <option value="demo">Demo Signal (Sinewave)</option>
                </select>
            </div>
        </div>

        <div id="serialConfig" style="display:none">
            <div class="form-row">
                <div class="form-group">
                    <label>Serial Port</label>
                    <div style="display:flex; gap:6px;">
                        <select id="serialPort" style="flex:1;">
                            <option value="">Select port...</option>
                        </select>
                        <button class="btn-secondary" id="btnRefreshPorts" title="Refresh ports">↻</button>
                    </div>
                    <input type="text" id="serialPortManual" placeholder="Or enter manually (e.g. /dev/ttyACM0)" style="margin-top:4px;" value="${defaultPort}">
                </div>
                <div class="form-group">
                    <label>Baud Rate</label>
                    <select id="baudRate">
                        <option value="9600">9600</option>
                        <option value="115200" ${defaultBaud === 115200 ? 'selected' : ''}>115200</option>
                        <option value="230400">230400</option>
                        <option value="460800">460800</option>
                        <option value="921600">921600</option>
                    </select>
                </div>
            </div>
        </div>

        <div id="socketConfig" style="display:none">
            <div class="form-row">
                <div class="form-group">
                    <label>IP Address</label>
                    <input type="text" id="ipAddress" value="127.0.0.1">
                </div>
                <div class="form-group">
                    <label>TCP Port</label>
                    <input type="number" id="tcpPort" value="5050">
                </div>
            </div>
        </div>

        <div id="demoConfig" style="display:none">
            <div class="form-row">
                <div class="form-group">
                    <label>Stream Name</label>
                    <input type="text" id="streamName" value="Sensors" placeholder="e.g. Sensors, Camera, Microphone">
                </div>
                <div class="form-group">
                    <label>Frequency (Hz)</label>
                    <input type="number" id="frequency" value="100" min="1" max="10000">
                </div>
                <div class="form-group">
                    <label>Channels</label>
                    <input type="text" id="channels" value="x, y, z" placeholder="Comma-separated">
                </div>
            </div>
        </div>

        <div class="form-group">
            <label>Output Directory</label>
            <input type="text" id="outputDir" value="${defaultDir}">
        </div>
    </div>

    <div class="section">
        <div class="controls">
            <button class="btn-record" id="btnStart">⏺ Start Recording</button>
            <button class="btn-stop" id="btnStop" disabled>⏹ Stop</button>
            <span class="server-state stopped" id="serverState"><span class="dot"></span><span id="serverStateText">Stopped</span></span>
        </div>

        <div class="status-panel" id="statusPanel">
            <h2><span class="recording-indicator"></span><span id="statusTitle">Starting...</span></h2>
            <div class="status-grid">
                <div class="status-item">
                    <div class="label" id="statRecordsLabel">Records</div>
                    <div class="value" id="statRecords">0</div>
                </div>
                <div class="status-item">
                    <div class="label">Total Size</div>
                    <div class="value" id="statSize">0 B</div>
                </div>
                <div class="status-item">
                    <div class="label">Elapsed</div>
                    <div class="value" id="statElapsed">0.0s</div>
                </div>
                <div class="status-item">
                    <div class="label">Data Rate</div>
                    <div class="value" id="statRate">0 B/s</div>
                </div>
            </div>

            <ul class="streams-list" id="streamsList" style="display:none"></ul>

            <canvas class="live-preview" id="livePreview"></canvas>

            <div class="log-panel" id="logPanel" style="display:none"></div>
        </div>
    </div>

    <script>
    (function() {
        const vscode = acquireVsCodeApi();
        let isHardwareMode = true;
        let startTime = 0;

        const modeSelect = document.getElementById('mode');
        const serialConfig = document.getElementById('serialConfig');
        const socketConfig = document.getElementById('socketConfig');
        const demoConfig = document.getElementById('demoConfig');
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');
        const statusPanel = document.getElementById('statusPanel');
        const logPanel = document.getElementById('logPanel');
        const streamsList = document.getElementById('streamsList');
        const serverStateEl = document.getElementById('serverState');
        const serverStateText = document.getElementById('serverStateText');
        const statusTitle = document.getElementById('statusTitle');
        const statRecordsLabel = document.getElementById('statRecordsLabel');

        function updateModeUI() {
            const mode = modeSelect.value;
            isHardwareMode = mode !== 'demo';

            serialConfig.style.display = mode === 'serial' ? 'block' : 'none';
            socketConfig.style.display = mode === 'socket' ? 'block' : 'none';
            demoConfig.style.display = mode === 'demo' ? 'block' : 'none';

            if (mode === 'serial') {
                vscode.postMessage({ command: 'getSerialPorts' });
            }
        }

        modeSelect.addEventListener('change', updateModeUI);
        updateModeUI();

        document.getElementById('btnRefreshPorts').addEventListener('click', () => {
            vscode.postMessage({ command: 'getSerialPorts' });
        });

        btnStart.addEventListener('click', () => {
            const channels = document.getElementById('channels').value
                .split(',').map(s => s.trim()).filter(Boolean);

            let serialPort = document.getElementById('serialPort').value;
            const manualPort = document.getElementById('serialPortManual').value.trim();
            if (manualPort) { serialPort = manualPort; }

            startTime = Date.now();

            vscode.postMessage({
                command: 'startRecording',
                config: {
                    mode: modeSelect.value,
                    streamName: modeSelect.value === 'demo' ? (document.getElementById('streamName').value || 'Recording') : undefined,
                    serialPort: serialPort,
                    baudRate: parseInt(document.getElementById('baudRate').value),
                    ipAddress: document.getElementById('ipAddress').value,
                    tcpPort: parseInt(document.getElementById('tcpPort').value),
                    frequency: parseInt(document.getElementById('frequency').value) || 100,
                    channels: channels.length > 0 ? channels : ['x', 'y', 'z'],
                    outputDirectory: document.getElementById('outputDir').value,
                },
            });
        });

        btnStop.addEventListener('click', () => {
            vscode.postMessage({ command: 'stopRecording' });
        });

        function updateServerState(state) {
            serverStateEl.className = 'server-state ' + state;
            const labels = {
                stopped: 'Stopped',
                starting: 'Starting...',
                waiting: 'Waiting for device...',
                connected: 'Device connected',
                recording: 'Recording data',
                error: 'Error',
            };
            serverStateText.textContent = labels[state] || state;
        }

        function appendLog(text, className) {
            const div = document.createElement('div');
            div.className = 'log-line' + (className ? ' ' + className : '');
            div.textContent = text;
            logPanel.appendChild(div);
            logPanel.scrollTop = logPanel.scrollHeight;
            while (logPanel.children.length > 200) {
                logPanel.removeChild(logPanel.firstChild);
            }
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.command) {
                case 'serialPorts': {
                    const select = document.getElementById('serialPort');
                    select.innerHTML = '<option value="">Select port...</option>';
                    msg.ports.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p;
                        opt.textContent = p;
                        select.appendChild(opt);
                    });
                    break;
                }

                case 'recordingStarted': {
                    btnStart.disabled = true;
                    btnStop.disabled = false;
                    statusPanel.classList.add('active');
                    startTime = Date.now();
                    const hwMode = msg.isHardwareMode !== undefined ? msg.isHardwareMode : isHardwareMode;
                    if (hwMode) {
                        logPanel.style.display = 'block';
                        logPanel.innerHTML = '';
                        streamsList.style.display = 'block';
                        streamsList.innerHTML = '';
                        statusTitle.textContent = 'Server starting — waiting for device...';
                        statRecordsLabel.textContent = 'Streams';
                    } else {
                        logPanel.style.display = 'none';
                        streamsList.style.display = 'none';
                        statusTitle.textContent = 'Recording in progress...';
                        statRecordsLabel.textContent = 'Records';
                    }
                    break;
                }

                case 'recordingStopped':
                    btnStart.disabled = false;
                    btnStop.disabled = true;
                    statusPanel.classList.remove('active');
                    updateServerState('stopped');
                    break;

                case 'recordingStatus':
                    document.getElementById('statRecords').textContent = msg.recordCount;
                    document.getElementById('statSize').textContent = formatBytes(msg.totalBytes);
                    const elapsed = msg.elapsed || (Date.now() - startTime);
                    document.getElementById('statElapsed').textContent = (elapsed / 1000).toFixed(1) + 's';
                    const rate = elapsed > 0 ? Math.round(msg.totalBytes / (elapsed / 1000)) : 0;
                    document.getElementById('statRate').textContent = formatBytes(rate) + '/s';

                    if (msg.streams && msg.streams.length > 0) {
                        streamsList.innerHTML = '';
                        msg.streams.forEach(s => {
                            const li = document.createElement('li');
                            li.textContent = s.name + ' → ' + s.filePath;
                            streamsList.appendChild(li);
                        });
                        streamsList.style.display = 'block';
                    }
                    break;

                case 'serverStateChanged':
                    updateServerState(msg.state);
                    if (msg.state === 'recording') {
                        statusTitle.textContent = 'Recording data from device...';
                    } else if (msg.state === 'connected') {
                        statusTitle.textContent = 'Device connected — waiting for data...';
                    } else if (msg.state === 'waiting') {
                        statusTitle.textContent = 'Server running — waiting for device...';
                    } else if (msg.state === 'error') {
                        statusTitle.textContent = 'Server error — check log';
                    }
                    break;

                case 'serverEvent':
                    if (msg.event) {
                        const cls = msg.event.type === 'error' ? 'error' :
                                    msg.event.type === 'stream-open' || msg.event.type === 'stream-close' ? 'stream' : '';
                        appendLog(msg.event.message, cls);
                    }
                    break;
            }
        });

        function formatBytes(b) {
            if (b < 1024) return b + ' B';
            if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
            return (b/(1024*1024)).toFixed(1) + ' MB';
        }

        vscode.postMessage({ command: 'getServerState' });
    })();
    </script>
</body>
</html>`;
    }

    private dispose(): void {
        this.disposed = true;

        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = undefined;
        }
        if (this.sdsioServer) {
            this.sdsioServer.removeAllListeners();
            this.sdsioServer.stop();
            this.sdsioServer = undefined;
        }
        this.outputChannel.dispose();
        SdsRecorderPanel.instance = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


