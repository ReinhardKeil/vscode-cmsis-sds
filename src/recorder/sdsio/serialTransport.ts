/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDSIO Serial Transport
 *
 * Opens a serial port, reads SDSIO protocol frames,
 * and sends responses back.
 */

import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import {
    SdsioManager,
    FrameAccumulator,
} from './protocol';

export interface SerialTransportOptions {
    port: string;
    baudRate?: number;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits?: 1 | 1.5 | 2;
    connectTimeout?: number; // ms, undefined = retry forever
}

/**
 * Events:
 *   'log'          (message: string)
 *   'error'        (message: string)
 *   'connected'    ()
 *   'disconnected' ()
 *   'stopped'      ()
 */
export class SerialTransport extends EventEmitter {
    private manager: SdsioManager;
    private opts: SerialTransportOptions;
    private serialPort: SerialPort | undefined;
    private accumulator = new FrameAccumulator();
    private running = false;

    constructor(manager: SdsioManager, opts: SerialTransportOptions) {
        super();
        this.manager = manager;
        this.opts = opts;
    }

    /** Start the serial transport — opens port, processes frames. */
    async start(): Promise<void> {
        this.running = true;
        this.emit('log', 'Starting Serial Server...');

        while (this.running) {
            try {
                await this._connectAndRun();
            } catch (err: any) {
                if (!this.running) { break; }
                this.emit('log', `Serial error: ${err.message}. Reconnecting...`);
                this._cleanup();
                await this._sleep(1000);
            }
        }

        this.emit('stopped');
    }

    /** Stop the serial transport gracefully. */
    stop(): void {
        this.running = false;
        this._cleanup();
    }

    /** List available serial ports. */
    static async listPorts(): Promise<string[]> {
        const ports = await SerialPort.list();
        return ports.map(p => p.path);
    }

    /** Emit that never throws — prevents listener errors from escaping into callers. */
    private _safeEmit(event: string, ...args: unknown[]): void {
        try { this.emit(event, ...args); } catch { /* listener error */ }
    }

    // ── Internal ────────────────────────────────────────────

    private async _connectAndRun(): Promise<void> {
        const port = await this._openPort();
        if (!port || !this.running) { return; }

        this.serialPort = port;
        this.accumulator.reset();

        this.emit('log', `Serial port opened successfully: ${this.opts.port}`);
        this.emit('connected');

        port.on('data', (data: Buffer) => {
            try {
                this._onData(data);
            } catch (err: any) {
                this._safeEmit('log', `Serial data processing error: ${err.message}`);
            }
        });

        port.on('error', (err: Error) => {
            if (!this.running) { return; }
            this._safeEmit('log', `Serial error: ${err.message}`);
        });

        port.on('close', () => {
            if (!this.running) { return; }
            this._safeEmit('log', 'Serial port closed.');
            this._safeEmit('disconnected');
            try { this.manager.closeAll(); } catch { /* ignore */ }
        });

        // Wait until stopped or port closed
        await new Promise<void>((resolve) => {
            const check = () => {
                if (!this.running || !this.serialPort?.isOpen) {
                    resolve();
                    return;
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    private _openPort(): Promise<SerialPort | undefined> {
        const startTime = Date.now();
        let firstAttempt = true;

        return new Promise((resolve) => {
            const tryOpen = () => {
                if (!this.running) { return resolve(undefined); }

                // Check timeout
                if (this.opts.connectTimeout !== undefined) {
                    const elapsed = Date.now() - startTime;
                    if (elapsed > this.opts.connectTimeout) {
                        this.emit('error', `Connection timeout after ${this.opts.connectTimeout}ms`);
                        return resolve(undefined);
                    }
                }

                try {
                    const port = new SerialPort({
                        path: this.opts.port,
                        baudRate: this.opts.baudRate ?? 115200,
                        parity: this.opts.parity ?? 'none',
                        stopBits: this.opts.stopBits ?? 1,
                        autoOpen: false,
                    });

                    port.open((err) => {
                        if (err) {
                            if (firstAttempt) {
                                this.emit('log', `Waiting for serial port ${this.opts.port}...`);
                                firstAttempt = false;
                            }
                            setTimeout(tryOpen, 500);
                        } else {
                            resolve(port);
                        }
                    });
                } catch (err: any) {
                    if (firstAttempt) {
                        this.emit('log', `Waiting for serial port ${this.opts.port}...`);
                        firstAttempt = false;
                    }
                    setTimeout(tryOpen, 500);
                }
            };

            tryOpen();
        });
    }

    private _onData(data: Buffer): void {
        const frames = this.accumulator.push(data);

        for (const { header, payload } of frames) {
            const response = this.manager.processMessage(header, payload);
            if (response && response.length > 0 && this.serialPort?.isOpen) {
                try {
                    this.serialPort.write(response, (err) => {
                        if (err && this.running) {
                            this._safeEmit('log', `Serial write error: ${err.message}`);
                        }
                    });
                } catch (err: any) {
                    this._safeEmit('log', `Serial write error: ${err.message}`);
                }
            }
        }
    }

    private _cleanup(): void {
        if (this.serialPort) {
            try {
                this.serialPort.removeAllListeners();
                if (this.serialPort.isOpen) {
                    this.serialPort.close();
                }
            } catch { /* ignore — port may already be gone */ }
            this.serialPort = undefined;
        }
        this.accumulator.reset();
    }

    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            const check = setInterval(() => {
                if (!this.running) {
                    clearTimeout(timer);
                    clearInterval(check);
                    resolve();
                }
            }, 100);
        });
    }
}
