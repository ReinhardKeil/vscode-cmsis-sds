/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDSIO Socket (TCP) Transport
 *
 * Listens on a TCP port for an SDSIO client connection.
 * Processes protocol frames and sends responses.
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as os from 'os';
import {
    SdsioManager,
    FrameAccumulator,
} from './protocol';

export interface SocketTransportOptions {
    ipAddress?: string;
    port?: number;
    networkInterface?: string;
}

const DEFAULT_PORT = 5050;

/**
 * Events:
 *   'log'          (message: string)
 *   'error'        (message: string)
 *   'connected'    ()
 *   'disconnected' ()
 *   'stopped'      ()
 */
export class SocketTransport extends EventEmitter {
    private manager: SdsioManager;
    private opts: SocketTransportOptions;
    private server: net.Server | undefined;
    private client: net.Socket | undefined;
    private accumulator = new FrameAccumulator();
    private running = false;

    constructor(manager: SdsioManager, opts: SocketTransportOptions) {
        super();
        this.manager = manager;
        this.opts = opts;
    }

    /** Start the socket transport — opens TCP server, waits for client. */
    async start(): Promise<void> {
        this.running = true;

        const ip = this._resolveIp();
        const port = this.opts.port ?? DEFAULT_PORT;

        while (this.running) {
            try {
                await this._listenAndServe(ip, port);
            } catch (err: any) {
                if (!this.running) { break; }
                this.emit('log', `Socket error: ${err.message}. Restarting...`);
                this._cleanup();
                await this._sleep(1000);
            }
        }

        this.emit('stopped');
    }

    /** Stop the socket transport gracefully. */
    stop(): void {
        this.running = false;
        this._cleanup();
    }

    /** Emit that never throws — prevents listener errors from escaping into callers. */
    private _safeEmit(event: string, ...args: unknown[]): void {
        try { this.emit(event, ...args); } catch { /* listener error */ }
    }

    // ── Internal ────────────────────────────────────────────

    private _resolveIp(): string {
        // Explicit IP address
        if (this.opts.ipAddress) { return this.opts.ipAddress; }

        // Resolve from network interface name
        if (this.opts.networkInterface) {
            const ifaces = os.networkInterfaces();
            const entries = ifaces[this.opts.networkInterface];
            if (entries) {
                const ipv4 = entries.find(e => e.family === 'IPv4' && !e.internal);
                if (ipv4) { return ipv4.address; }
            }
        }

        // Default to first non-internal IPv4 address
        const ifaces = os.networkInterfaces();
        for (const entries of Object.values(ifaces)) {
            if (!entries) { continue; }
            const ipv4 = entries.find(e => e.family === 'IPv4' && !e.internal);
            if (ipv4) { return ipv4.address; }
        }

        return '127.0.0.1';
    }

    private _listenAndServe(ip: string, port: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.server = net.createServer((socket) => {
                this._handleClient(socket);
            });

            this.server.on('error', (err: Error) => {
                if (!this.running) { return resolve(); }
                reject(err);
            });

            this.server.listen(port, ip, () => {
                this.emit('log', `Socket server listening on ${ip}:${port}`);
            });

            // Wait until stopped
            const check = () => {
                if (!this.running) {
                    this._cleanup();
                    resolve();
                    return;
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    private _handleClient(socket: net.Socket): void {
        // Only accept one client at a time
        if (this.client) {
            socket.destroy();
            return;
        }

        this.client = socket;
        this.accumulator.reset();

        const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
        this.emit('log', `SDSIO Client connected from ${remoteAddr}.`);
        this.emit('connected');

        socket.on('data', (data: Buffer) => {
            try {
                this._onData(data, socket);
            } catch (err: any) {
                this._safeEmit('log', `Socket data processing error: ${err.message}`);
            }
        });

        socket.on('error', (err: Error) => {
            this._safeEmit('log', `Socket client error: ${err.message}`);
        });

        socket.on('close', () => {
            this._safeEmit('log', 'SDSIO Client disconnected.');
            this._safeEmit('disconnected');
            try { this.manager.closeAll(); } catch { /* ignore */ }
            this.client = undefined;

            if (this.running) {
                this._safeEmit('log', 'Waiting for SDSIO Client to reconnect...');
            }
        });
    }

    private _onData(data: Buffer, socket: net.Socket): void {
        const frames = this.accumulator.push(data);

        for (const { header, payload } of frames) {
            const response = this.manager.processMessage(header, payload);
            if (response && response.length > 0 && !socket.destroyed) {
                try {
                    socket.write(response);
                } catch (err: any) {
                    this._safeEmit('log', `Socket write error: ${err.message}`);
                }
            }
        }
    }

    private _cleanup(): void {
        if (this.client) {
            try {
                this.client.destroy();
                this.client.removeAllListeners();
            } catch { /* ignore */ }
            this.client = undefined;
        }

        if (this.server) {
            try {
                this.server.close();
                this.server.removeAllListeners();
            } catch { /* ignore */ }
            this.server = undefined;
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
