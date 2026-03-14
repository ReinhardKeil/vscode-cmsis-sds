/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDSIO Server — self-contained Node.js implementation.
 *
 * Replaces the external Python sdsio-server.py with a native TypeScript
 * implementation using the `usb` and `serialport` npm packages.
 *
 * Supports USB (bulk), Serial (UART), and Socket (TCP) transports.
 */

export { SdsioManager, FrameAccumulator } from './protocol';
export {
    parseHeader,
    buildHeader,
    buildResponse,
    HEADER_SIZE,
    CMD_OPEN,
    CMD_CLOSE,
    CMD_WRITE,
    CMD_READ,
    CMD_PING,
    MODE_READ,
    MODE_WRITE,
} from './protocol';
export type { SdsioHeader } from './protocol';

// UsbTransport is intentionally NOT re-exported here.
// It is only used by the child-process worker (usbWorker.ts).
// Importing it would eagerly load the native `usb` addon and its
// background libusb thread into the Extension Host, which can segfault
// when a USB device disconnects.
export { SerialTransport } from './serialTransport';
export type { SerialTransportOptions } from './serialTransport';
export { SocketTransport } from './socketTransport';
export type { SocketTransportOptions } from './socketTransport';

import { EventEmitter } from 'events';
import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SdsioManager } from './protocol';
import { SerialTransport, SerialTransportOptions } from './serialTransport';
import { SocketTransport, SocketTransportOptions } from './socketTransport';

// ── Server config ───────────────────────────────────────────

export interface SdsioServerConfig {
    mode: 'usb' | 'serial' | 'socket';
    workDir: string;
    /** Serial-specific options */
    serial?: SerialTransportOptions;
    /** Socket-specific options */
    socket?: SocketTransportOptions;
}

export type SdsioServerState =
    | 'stopped'
    | 'starting'
    | 'waiting'
    | 'connected'
    | 'recording'
    | 'error';

/**
 * High-level SDSIO server.
 *
 * Events:
 *   'stateChange'  (state: SdsioServerState)
 *   'log'          (message: string)
 *   'record'       (name: string, filePath: string)
 *   'play'         (name: string, filePath: string)
 *   'close'        (name: string, filePath: string)
 *   'error'        (message: string)
 *   'filesChanged' ()
 */
export class SdsioServer extends EventEmitter {
    private manager: SdsioManager;
    private transport: SerialTransport | SocketTransport | undefined;
    private _state: SdsioServerState = 'stopped';
    private _config: SdsioServerConfig | undefined;
    private _running = false;
    private _knownFiles = new Set<string>();
    private _preExistingFiles = new Set<string>();
    private _watcher: fs.FSWatcher | undefined;
    private _pollTimer: ReturnType<typeof setInterval> | undefined;
    private _totalBytes = 0;
    /** USB child process (isolates native libusb from Extension Host). */
    private _usbWorker: ChildProcess | undefined;

    constructor(workDir: string) {
        super();
        this.manager = new SdsioManager(workDir);
        this._wireManagerEvents();
    }

    // ── Public API ──────────────────────────────────────────

    get state(): SdsioServerState { return this._state; }
    get config(): SdsioServerConfig | undefined { return this._config; }
    get openStreams(): Map<string, string> { return this.manager.openStreams; }
    get totalBytes(): number { return this._totalBytes; }
    get fileCount(): number { return this._knownFiles.size; }

    async start(config: SdsioServerConfig): Promise<void> {
        if (this.transport || this._usbWorker) {
            throw new Error('Server is already running.');
        }

        this._config = config;
        this._running = true;
        this._knownFiles.clear();
        this._preExistingFiles.clear();
        this._totalBytes = 0;

        // Ensure work dir exists
        if (!fs.existsSync(config.workDir)) {
            fs.mkdirSync(config.workDir, { recursive: true });
        }

        // Snapshot existing files
        this._snapshotExistingFiles(config.workDir);

        this._setState('starting');
        this._log('Press Ctrl+C to exit.');

        // Create transport
        switch (config.mode) {
            case 'usb':
                // USB runs in a child process to isolate the Extension Host
                // from native libusb segfaults on device disconnect.
                this._startUsbWorker(config.workDir);
                break;
            case 'serial':
                if (!config.serial) { throw new Error('Serial configuration required.'); }
                this.transport = new SerialTransport(this.manager, config.serial);
                this._wireTransportEvents(this.transport);
                this.transport.start().catch((err: Error) => {
                    this._log(`Transport error: ${err.message}`);
                    this._setState('error');
                });
                break;
            case 'socket':
                this.transport = new SocketTransport(this.manager, config.socket ?? {});
                this._wireTransportEvents(this.transport);
                this.transport.start().catch((err: Error) => {
                    this._log(`Transport error: ${err.message}`);
                    this._setState('error');
                });
                break;
            default:
                throw new Error(`Unknown mode: ${config.mode}`);
        }

        // Start file watcher
        this._startWatcher(config.workDir);
        this._startSizePoll(config.workDir);
    }

    async stop(): Promise<void> {
        this._running = false;
        this._stopWatcher();
        this._stopSizePoll();

        // Stop USB child process
        if (this._usbWorker) {
            const worker = this._usbWorker;
            this._usbWorker = undefined;
            try { worker.send({ type: 'stop' }); } catch { /* ignore */ }
            // Give the worker a moment to exit gracefully, then force-kill
            const killTimer = setTimeout(() => {
                try { worker.kill('SIGKILL'); } catch { /* ignore */ }
            }, 2000);
            worker.once('exit', () => clearTimeout(killTimer));
        }

        // Stop in-process transport (serial / socket)
        if (this.transport) {
            this.transport.stop();
            this.transport = undefined;
        }

        this.manager.closeAll();
        this._setState('stopped');
    }

    dispose(): void {
        this.stop();
    }

    // ── Internal ────────────────────────────────────────────

    private _wireManagerEvents(): void {
        this.manager.on('log', (msg: string) => this._log(msg));
        this.manager.on('error', (msg: string) => {
            this._log(`ERROR: ${msg}`);
            this._safeEmit('error', msg);
        });
        this.manager.on('record', (name: string, filePath: string) => {
            this._setState('recording');
            this._safeEmit('record', name, filePath);
        });
        this.manager.on('play', (name: string, filePath: string) => {
            this._safeEmit('play', name, filePath);
        });
        this.manager.on('close', (name: string, filePath: string) => {
            this._safeEmit('close', name, filePath);
            // If no more open streams, go back to connected
            if (this.manager.openStreams.size === 0 && this._state === 'recording') {
                this._setState('connected');
            }
        });
        this.manager.on('ping', () => { /* logged by manager */ });
    }

    private _wireTransportEvents(transport: EventEmitter): void {
        transport.on('log', (msg: string) => this._log(msg));
        transport.on('error', (msg: string) => {
            this._log(`ERROR: ${msg}`);
            this._safeEmit('error', msg);
        });
        transport.on('connected', () => {
            this._setState('connected');
        });
        transport.on('disconnected', () => {
            this._setState('waiting');
        });
        transport.on('stopped', () => {
            if (this._state !== 'stopped') {
                this._setState('stopped');
            }
        });
    }

    // ── USB worker process ──────────────────────────────────

    /**
     * Start USB transport in a child process.  If the child process crashes
     * (e.g. native segfault from libusb), it is automatically restarted so
     * the user can reconnect the device.  The Extension Host is never affected.
     */
    private _startUsbWorker(workDir: string): void {
        const workerPath = path.join(__dirname, 'usbWorker.js');

        const spawnWorker = () => {
            if (!this._running) { return; }

            this._log('Starting USB worker process…');

            const worker = fork(workerPath, [workDir], {
                // Don't inherit --inspect / --inspect-brk from the debug
                // session — the child would try to bind the same debug port.
                execArgv: [],
            });
            this._usbWorker = worker;

            worker.on('message', (msg: any) => {
                if (!msg || typeof msg.type !== 'string') { return; }
                switch (msg.type) {
                    case 'log':
                        this._log(msg.msg);
                        break;
                    case 'error':
                        this._log(`ERROR: ${msg.msg}`);
                        this._safeEmit('error', msg.msg);
                        break;
                    case 'connected':
                        this._setState('connected');
                        break;
                    case 'disconnected':
                        this._setState('waiting');
                        break;
                    case 'stopped':
                        if (this._state !== 'stopped') {
                            this._setState('stopped');
                        }
                        break;
                    case 'record':
                        this._setState('recording');
                        this._safeEmit('record', msg.name, msg.filePath);
                        break;
                    case 'play':
                        this._safeEmit('play', msg.name, msg.filePath);
                        break;
                    case 'close':
                        this._safeEmit('close', msg.name, msg.filePath);
                        if (msg.openStreamCount === 0 && this._state === 'recording') {
                            this._setState('connected');
                        }
                        break;
                }
            });

            worker.on('error', (err) => {
                this._log(`USB worker error: ${err.message}`);
            });

            worker.on('exit', (code, signal) => {
                this._usbWorker = undefined;
                if (!this._running) { return; }

                if (signal) {
                    this._log(`USB worker crashed (signal ${signal}) — restarting…`);
                } else if (code !== 0) {
                    this._log(`USB worker exited (code ${code}) — restarting…`);
                }

                this._setState('waiting');
                // Brief delay before respawning to avoid tight loops
                setTimeout(() => spawnWorker(), 1000);
            });
        };

        spawnWorker();
    }

    /** Emit that never throws — prevents listener errors from escaping into callers. */
    private _safeEmit(event: string, ...args: unknown[]): void {
        try { this.emit(event, ...args); } catch { /* listener error */ }
    }

    private _setState(s: SdsioServerState): void {
        if (this._state === s) { return; }
        this._state = s;
        this._safeEmit('stateChange', s);
    }

    private _log(msg: string): void {
        this._safeEmit('log', msg);
    }

    // ── File watching ───────────────────────────────────────

    private _snapshotExistingFiles(dir: string): void {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (f.endsWith('.sds')) {
                    this._preExistingFiles.add(f);
                }
            }
        } catch { /* ignore */ }
    }

    private _startWatcher(dir: string): void {
        try {
            this._watcher = fs.watch(dir, (_, filename) => {
                if (!filename || !filename.endsWith('.sds')) { return; }
                if (this._preExistingFiles.has(filename)) { return; }
                if (!this._knownFiles.has(filename)) {
                    this._knownFiles.add(filename);
                    this._safeEmit('filesChanged');
                }
            });
        } catch { /* ignore */ }
    }

    private _stopWatcher(): void {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = undefined;
        }
    }

    private _startSizePoll(dir: string): void {
        this._pollTimer = setInterval(() => {
            try {
                let total = 0;
                for (const f of fs.readdirSync(dir)) {
                    if (!f.endsWith('.sds')) { continue; }
                    if (this._preExistingFiles.has(f)) { continue; }
                    try {
                        total += fs.statSync(path.join(dir, f)).size;
                    } catch { /* file in progress */ }
                }
                if (total !== this._totalBytes) {
                    this._totalBytes = total;
                    this._safeEmit('filesChanged');
                }
            } catch { /* ignore */ }
        }, 500);
    }

    private _stopSizePoll(): void {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = undefined;
        }
    }
}
