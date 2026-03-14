/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Diagnostics — Output Channel for Server & System Messages
 *
 * Provides a centralized diagnostics window (VS Code Output Channel)
 * that displays timestamped log messages from SDS subsystems:
 * recording sessions, viewer operations, export, and general system events.
 */

import * as vscode from 'vscode';

export enum DiagnosticLevel {
    Info = 'INFO',
    Warn = 'WARN',
    Error = 'ERROR',
    Debug = 'DEBUG',
    Trace = 'TRACE',
}

export enum DiagnosticSource {
    Extension = 'Extension',
    Recorder = 'Recorder',
    Viewer = 'Viewer',
    Exporter = 'Exporter',
    Server = 'Server',
}

interface DiagnosticEntry {
    timestamp: Date;
    level: DiagnosticLevel;
    source: DiagnosticSource;
    message: string;
}

/**
 * Singleton diagnostics manager that provides a VS Code Output Channel
 * for CMSIS SDS server and system messages.
 */
export class SdsDiagnostics {
    private static _instance: SdsDiagnostics | undefined;

    private _outputChannel: vscode.OutputChannel;
    private _logHistory: DiagnosticEntry[] = [];
    private _maxHistory: number = 5000;
    private _minLevel: DiagnosticLevel = DiagnosticLevel.Info;

    private readonly _levelPriority: Record<DiagnosticLevel, number> = {
        [DiagnosticLevel.Trace]: 0,
        [DiagnosticLevel.Debug]: 1,
        [DiagnosticLevel.Info]: 2,
        [DiagnosticLevel.Warn]: 3,
        [DiagnosticLevel.Error]: 4,
    };

    private constructor() {
        this._outputChannel = vscode.window.createOutputChannel('CMSIS SDS Diagnostics');
    }

    /** Get the singleton instance */
    static getInstance(): SdsDiagnostics {
        if (!SdsDiagnostics._instance) {
            SdsDiagnostics._instance = new SdsDiagnostics();
        }
        return SdsDiagnostics._instance;
    }

    /** Set the minimum log level to display */
    setMinLevel(level: DiagnosticLevel): void {
        this._minLevel = level;
        this.info(DiagnosticSource.Extension, `Diagnostics log level set to ${level}`);
    }

    /** Show the diagnostics output channel */
    show(): void {
        this._outputChannel.show(true);
    }

    /** Hide the diagnostics output channel */
    hide(): void {
        this._outputChannel.hide();
    }

    /** Get the underlying output channel for disposal */
    get outputChannel(): vscode.OutputChannel {
        return this._outputChannel;
    }

    /** Get log history (most recent entries) */
    getHistory(count?: number): DiagnosticEntry[] {
        if (count) {
            return this._logHistory.slice(-count);
        }
        return [...this._logHistory];
    }

    /** Clear the output channel and history */
    clear(): void {
        this._outputChannel.clear();
        this._logHistory = [];
        this._writeRaw('═══════════════════════════════════════════════════════════════');
        this._writeRaw('  CMSIS SDS Diagnostics — Log cleared');
        this._writeRaw('═══════════════════════════════════════════════════════════════');
    }

    // ── Convenience Methods ────────────────────────────────────

    trace(source: DiagnosticSource, message: string): void {
        this._log(DiagnosticLevel.Trace, source, message);
    }

    debug(source: DiagnosticSource, message: string): void {
        this._log(DiagnosticLevel.Debug, source, message);
    }

    info(source: DiagnosticSource, message: string): void {
        this._log(DiagnosticLevel.Info, source, message);
    }

    warn(source: DiagnosticSource, message: string): void {
        this._log(DiagnosticLevel.Warn, source, message);
    }

    error(source: DiagnosticSource, message: string, err?: Error | unknown): void {
        let fullMessage = message;
        if (err instanceof Error) {
            fullMessage += ` — ${err.message}`;
            if (err.stack) {
                fullMessage += `\n  Stack: ${err.stack.split('\n').slice(1, 4).join('\n  ')}`;
            }
        } else if (err !== undefined) {
            fullMessage += ` — ${String(err)}`;
        }
        this._log(DiagnosticLevel.Error, source, fullMessage);
    }

    // ── Structured Logging Helpers ─────────────────────────────

    /** Log a server connection event */
    serverConnection(host: string, status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?: string): void {
        const statusIcons: Record<string, string> = {
            connecting: '⟳',
            connected: '✓',
            disconnected: '✕',
            error: '✗',
        };
        const icon = statusIcons[status] || '?';
        const msg = `[${icon}] ${host} — ${status}${detail ? ': ' + detail : ''}`;

        if (status === 'error') {
            this.error(DiagnosticSource.Server, msg);
        } else if (status === 'disconnected') {
            this.warn(DiagnosticSource.Server, msg);
        } else {
            this.info(DiagnosticSource.Server, msg);
        }
    }

    /** Log a recording session event */
    recordingEvent(event: 'start' | 'stop' | 'data' | 'error', detail: string): void {
        const level = event === 'error' ? DiagnosticLevel.Error
            : event === 'data' ? DiagnosticLevel.Debug
            : DiagnosticLevel.Info;
        this._log(level, DiagnosticSource.Recorder, `[${event.toUpperCase()}] ${detail}`);
    }


    /** Write the startup banner */
    writeBanner(): void {
        this._writeRaw('');
        this._writeRaw('╔═══════════════════════════════════════════════════════════════╗');
        this._writeRaw('║                  CMSIS SDS Diagnostics                        ║');
        this._writeRaw('║  Server & System Messages                                 ║');
        this._writeRaw('╚═══════════════════════════════════════════════════════════════╝');
        this._writeRaw('');
        this._writeRaw(`  Started: ${new Date().toISOString()}`);
        this._writeRaw(`  VS Code: ${vscode.version}`);
        this._writeRaw(`  Platform: ${process.platform} (${process.arch})`);
        this._writeRaw('');
        this._writeRaw('───────────────────────────────────────────────────────────────');
        this._writeRaw('');
    }

    // ── Internal ───────────────────────────────────────────────

    private _log(level: DiagnosticLevel, source: DiagnosticSource, message: string): void {
        // Check minimum level
        if (this._levelPriority[level] < this._levelPriority[this._minLevel]) {
            return;
        }

        const entry: DiagnosticEntry = {
            timestamp: new Date(),
            level,
            source,
            message,
        };

        // Store in history
        this._logHistory.push(entry);
        if (this._logHistory.length > this._maxHistory) {
            this._logHistory = this._logHistory.slice(-this._maxHistory);
        }

        // Format and write
        const ts = entry.timestamp.toISOString().replace('T', ' ').replace('Z', '');
        const levelPad = level.padEnd(5);
        const sourcePad = source.padEnd(12);
        const line = `[${ts}] ${levelPad} [${sourcePad}] ${message}`;

        this._outputChannel.appendLine(line);

        // Also mirror errors/warnings to the VS Code console
        if (level === DiagnosticLevel.Error) {
            console.error(`[CMSIS SDS] ${source}: ${message}`);
        } else if (level === DiagnosticLevel.Warn) {
            console.warn(`[CMSIS SDS] ${source}: ${message}`);
        }
    }

    private _writeRaw(text: string): void {
        this._outputChannel.appendLine(text);
    }

    /** Dispose resources */
    dispose(): void {
        this._outputChannel.dispose();
        SdsDiagnostics._instance = undefined;
    }
}

/**
 * Shortcut: get the global diagnostics instance.
 * Usage: `diag().info(DiagnosticSource.Recorder, 'Recording started');`
 */
export function diag(): SdsDiagnostics {
    return SdsDiagnostics.getInstance();
}
