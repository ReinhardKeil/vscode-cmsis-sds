/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * USB Transport Worker Process
 *
 * Runs the USB transport and SdsioManager in a **separate child process**
 * to isolate the VS Code Extension Host from native libusb crashes (SIGSEGV)
 * that occur when a USB device powers off or resets during active transfers.
 *
 * Communication with the parent (SdsioServer) is via Node.js IPC:
 *   Parent → Worker:  { type: 'stop' }
 *   Worker → Parent:  { type: 'log'|'error'|'connected'|... , ... }
 *
 * Usage:  fork('usbWorker.js', [workDir])
 */

import { SdsioManager } from './protocol';
import { UsbTransport } from './usbTransport';

// ── Validate arguments ──────────────────────────────────────

const workDir = process.argv[2];
if (!workDir || !process.send) {
    // eslint-disable-next-line no-console
    console.error('usbWorker: must be spawned via fork(path, [workDir])');
    process.exit(1);
}

// ── Create manager & transport ──────────────────────────────

const manager   = new SdsioManager(workDir);
const transport = new UsbTransport(manager);
let   running   = true;

/** Send an IPC message to the parent — swallows errors if parent is gone. */
function send(msg: Record<string, unknown>): void {
    try { process.send?.(msg); } catch { /* parent disconnected */ }
}

// ── Forward transport events ────────────────────────────────

transport.on('log', (msg: string) => send({ type: 'log', msg }));

transport.on('error', (msg: string) => {
    send({ type: 'error', msg });
});

transport.on('connected', () => send({ type: 'connected' }));

transport.on('disconnected', () => send({ type: 'disconnected' }));

transport.on('stopped', () => {
    send({ type: 'stopped' });
    if (!running) {
        process.exit(0);
    }
});

// ── Forward manager events ──────────────────────────────────

manager.on('log',   (msg: string) => send({ type: 'log', msg }));
manager.on('error', (msg: string) => send({ type: 'error', msg }));

manager.on('record', (name: string, filePath: string) => {
    send({ type: 'record', name, filePath });
});

manager.on('play', (name: string, filePath: string) => {
    send({ type: 'play', name, filePath });
});

manager.on('close', (name: string, filePath: string) => {
    send({
        type: 'close',
        name,
        filePath,
        openStreamCount: manager.openStreams.size,
    });
});

// ── Handle commands from parent ─────────────────────────────

process.on('message', (msg: any) => {
    if (msg?.type === 'stop') {
        running = false;
        try { transport.stop(); } catch { /* ignore */ }
        try { manager.closeAll(); } catch { /* ignore */ }
    }
});

// ── Start transport ─────────────────────────────────────────

transport.start().catch((err: Error) => {
    send({ type: 'error', msg: err.message });
});

// ── Crash safety ────────────────────────────────────────────
// These catch JS-level errors only.  Native segfaults are caught by the
// parent process via the 'exit' event (that's the whole point of running
// USB in a child process).

process.on('uncaughtException', (err) => {
    send({ type: 'log', msg: `[usbWorker] uncaughtException: ${err.stack ?? err.message}` });
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    send({ type: 'log', msg: `[usbWorker] unhandledRejection: ${msg}` });
});
