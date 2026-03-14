/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDSIO USB Bulk Transport
 *
 * Discovers a USB device with product string "SDSIO Client",
 * claims its bulk endpoints, and processes SDSIO protocol frames.
 */

import { EventEmitter } from 'events';
import { usb, Device, InEndpoint, OutEndpoint, Interface, getDeviceList } from 'usb';
import {
    SdsioManager,
    FrameAccumulator,
    HEADER_SIZE,
} from './protocol';

const USB_PRODUCT_STRING = 'SDSIO Client';
const POLL_TRANSFERS = 8;           // number of concurrent IN transfers
const TRANSFER_SIZE  = 8 * 1024;    // 8 KiB per transfer
const DISCOVERY_INTERVAL_MS = 500;

/**
 * Events:
 *   'log'          (message: string)
 *   'error'        (message: string)
 *   'connected'    ()
 *   'disconnected' ()
 *   'stopped'      ()
 */
export class UsbTransport extends EventEmitter {
    private manager: SdsioManager;
    private device: Device | undefined;
    private iface: Interface | undefined;
    private inEndpoint: InEndpoint | undefined;
    private outEndpoint: OutEndpoint | undefined;
    private accumulator = new FrameAccumulator();
    private running = false;
    private discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    private detachListener: ((device: Device) => void) | undefined;
    /** True once the device has been physically detached — prevents native calls on dead handles */
    private detached = false;

    constructor(manager: SdsioManager) {
        super();
        this.manager = manager;
    }

    /** Start the USB transport — discovers device, claims endpoints, and begins polling. */
    async start(): Promise<void> {
        this.running = true;
        this.emit('log', 'Starting USB Server...');

        while (this.running) {
            try {
                await this._discoverAndRun();
            } catch (err: any) {
                if (!this.running) { break; }
                this.emit('log', `USB error: ${err.message}. Reconnecting...`);
                this._cleanup();
                await this._sleep(1000);
            }
        }

        this.emit('stopped');
    }

    /** Stop the USB transport gracefully. */
    stop(): void {
        this.running = false;
        if (this.discoveryTimer) {
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = undefined;
        }
        this._cleanup();
    }

    /** Emit that never throws — prevents listener errors from escaping into callers. */
    private _safeEmit(event: string, ...args: unknown[]): void {
        try { this.emit(event, ...args); } catch { /* listener error */ }
    }

    // ── Internal ────────────────────────────────────────────

    private async _discoverAndRun(): Promise<void> {
        // Find SDSIO Client device
        const device = await this._findDevice();
        if (!device || !this.running) { return; }

        this.device = device;
        this.detached = false;

        try {
            device.open();
        } catch (err: any) {
            throw new Error(`Cannot open USB device: ${err.message}`);
        }

        // Try auto-detach kernel driver
        try {
            device.setAutoDetachKernelDriver(true);
        } catch { /* not supported on all platforms */ }

        // Find and claim first interface with bulk endpoints
        const iface = device.interfaces?.[0];
        if (!iface) { throw new Error('No interfaces found on USB device'); }

        try {
            iface.claim();
        } catch (err: any) {
            throw new Error(`Cannot claim interface: ${err.message}`);
        }
        this.iface = iface;

        // Discover bulk IN/OUT endpoints
        let inEp: InEndpoint | undefined;
        let outEp: OutEndpoint | undefined;

        for (const ep of iface.endpoints) {
            if (ep.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK) {
                if (ep.direction === 'in') {
                    inEp = ep as InEndpoint;
                } else if (ep.direction === 'out') {
                    outEp = ep as OutEndpoint;
                }
            }
        }

        if (!inEp || !outEp) {
            throw new Error('Bulk IN/OUT endpoints not found');
        }

        this.inEndpoint = inEp;
        this.outEndpoint = outEp;
        this.accumulator.reset();

        this.emit('log', 'SDSIO Client USB device connected.');
        this.emit('connected');

        // Listen for detach — mark as detached FIRST, then clean up without
        // calling native USB functions on a dead device handle.
        this.detachListener = (detached: Device) => {
            if (detached === device) {
                this.detached = true;
                this._safeEmit('log', 'USB device disconnected.');
                this._safeEmit('disconnected');
                try { this.manager.closeAll(); } catch { /* ignore */ }
                this._cleanup();
            }
        };
        usb.on('detach', this.detachListener);

        // Start polling IN endpoint
        inEp.on('data', (data: Buffer) => {
            if (this.detached) { return; }
            try {
                this._onData(data);
            } catch (err: any) {
                this._safeEmit('log', `USB data processing error: ${err.message}`);
            }
        });

        inEp.on('error', (err: Error) => {
            if (!this.running || this.detached) { return; }
            this._safeEmit('log', `USB IN error: ${err.message}`);
        });

        inEp.on('end', () => {
            if (!this.running || this.detached) { return; }
            this._safeEmit('log', 'USB polling ended.');
            this._safeEmit('disconnected');
            try { this.manager.closeAll(); } catch { /* ignore */ }
        });

        // Safety: ensure the OUT endpoint also has an error handler so that
        // late-arriving transfer errors don't crash via ERR_UNHANDLED_ERROR.
        outEp.on('error', (err: Error) => {
            if (!this.running || this.detached) { return; }
            this._safeEmit('log', `USB OUT endpoint error: ${err.message}`);
        });

        // Start polling with multiple transfers
        inEp.startPoll(POLL_TRANSFERS, TRANSFER_SIZE);

        // Wait until stopped or disconnected
        await new Promise<void>((resolve) => {
            const check = () => {
                if (!this.running || !this.inEndpoint || this.detached) {
                    resolve();
                    return;
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    private async _findDevice(): Promise<Device | undefined> {
        let firstAttempt = true;

        while (this.running) {
            const devices = getDeviceList();

            for (const dev of devices) {
                try {
                    dev.open();
                    const productStr = await this._getProductString(dev);
                    if (productStr === USB_PRODUCT_STRING) {
                        dev.close();
                        return dev;
                    }
                    dev.close();
                } catch {
                    try { dev.close(); } catch { /* ignore */ }
                }
            }

            if (firstAttempt) {
                this.emit('log', 'Waiting for SDSIO Client USB device...');
                firstAttempt = false;
            }

            await this._sleep(DISCOVERY_INTERVAL_MS);
        }

        return undefined;
    }

    private _getProductString(dev: Device): Promise<string> {
        return new Promise((resolve, reject) => {
            const idx = dev.deviceDescriptor.iProduct;
            if (!idx) { return reject(new Error('No product string descriptor')); }

            dev.getStringDescriptor(idx, (err, val) => {
                if (err) { return reject(err); }
                resolve(val || '');
            });
        });
    }

    private _onData(data: Buffer): void {
        if (this.detached) { return; }

        const frames = this.accumulator.push(data);

        for (const { header, payload } of frames) {
            const response = this.manager.processMessage(header, payload);
            if (response && response.length > 0 && this.outEndpoint && !this.detached) {
                try {
                    this.outEndpoint.transfer(response, (err) => {
                        if (err && this.running && !this.detached) {
                            this._safeEmit('log', `USB OUT error: ${err.message}`);
                        }
                    });
                } catch (err: any) {
                    if (!this.detached) {
                        this._safeEmit('log', `USB OUT transfer error: ${err.message}`);
                    }
                }
            }
        }
    }

    private _cleanup(): void {
        if (this.detachListener) {
            try { usb.off('detach', this.detachListener); } catch { /* ignore */ }
            this.detachListener = undefined;
        }

        // When the device has been physically detached, do NOT call ANY
        // native USB functions (stopPoll, release, close).  These operate on
        // dead libusb handles and can segfault the process.  Pending IN
        // transfers will complete asynchronously with LIBUSB_TRANSFER_NO_DEVICE;
        // the 'error' / 'data' handlers we left attached absorb those safely.
        if (!this.detached) {
            if (this.inEndpoint) {
                try { this.inEndpoint.stopPoll(); } catch { /* ignore */ }
            }

            if (this.iface) {
                try { this.iface.release(); } catch { /* ignore */ }
            }

            if (this.device) {
                try { this.device.close(); } catch { /* ignore */ }
            }
        }

        // Do NOT call removeAllListeners() on endpoints — pending transfer
        // completions may still emit 'error' events asynchronously, and
        // removing the error listener causes Node.js to throw
        // ERR_UNHANDLED_ERROR, which crashes the entire process.
        // The existing handlers check this.detached and no-op safely.
        this.inEndpoint = undefined;
        this.outEndpoint = undefined;
        this.iface = undefined;
        this.device = undefined;
        this.accumulator.reset();
    }

    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            // Allow early exit when stopping
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
