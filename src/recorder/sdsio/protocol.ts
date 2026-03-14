/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDSIO Protocol — constants, header parsing/building, and stream manager.
 *
 * Protocol uses a 16-byte little-endian header:
 *   cmd (u32) | sid (u32) | arg (u32) | sz (u32)
 * followed by `sz` bytes of payload.
 *
 * Commands:
 *   1 = Open   (client→server)  arg=mode (0=read, 1=write), payload=stream name
 *   2 = Close  (client→server)  no payload, no response
 *   3 = Write  (client→server)  payload=data,  no response
 *   4 = Read   (client→server)  arg=requested size, response=header+data
 *   5 = Ping   (client→server)  response with arg=1
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// ── Protocol constants ──────────────────────────────────────

export const HEADER_SIZE = 16;

export const CMD_OPEN  = 1;
export const CMD_CLOSE = 2;
export const CMD_WRITE = 3;
export const CMD_READ  = 4;
export const CMD_PING  = 5;

export const MODE_READ  = 0;
export const MODE_WRITE = 1;

/** Characters forbidden in stream names (mirrors Python validation). */
const INVALID_NAME_CHARS = new Set([
    '"', '*', '/', ':', '<', '>', '?', '\\', '|',
]);

// ── Header helpers ──────────────────────────────────────────

export interface SdsioHeader {
    cmd: number;
    sid: number;
    arg: number;
    sz: number;
}

/** Parse a 16-byte LE header from the buffer at `offset`. */
export function parseHeader(buf: Buffer, offset = 0): SdsioHeader {
    return {
        cmd: buf.readUInt32LE(offset),
        sid: buf.readUInt32LE(offset + 4),
        arg: buf.readUInt32LE(offset + 8),
        sz:  buf.readUInt32LE(offset + 12),
    };
}

/** Build a 16-byte LE header buffer. */
export function buildHeader(cmd: number, sid: number, arg: number, sz: number): Buffer {
    const buf = Buffer.alloc(HEADER_SIZE);
    buf.writeUInt32LE(cmd, 0);
    buf.writeUInt32LE(sid, 4);
    buf.writeUInt32LE(arg, 8);
    buf.writeUInt32LE(sz, 12);
    return buf;
}

/** Build a full response (header + optional payload). */
export function buildResponse(cmd: number, sid: number, arg: number, payload?: Buffer): Buffer {
    const sz = payload ? payload.length : 0;
    const header = buildHeader(cmd, sid, arg, sz);
    if (payload && payload.length > 0) {
        return Buffer.concat([header, payload]);
    }
    return header;
}

// ── Name validation ─────────────────────────────────────────

function isValidStreamName(name: string): boolean {
    if (!name || name.length === 0) { return false; }
    for (const ch of name) {
        const code = ch.charCodeAt(0);
        if (code <= 0x0F || code === 0x7F) { return false; }
        if (INVALID_NAME_CHARS.has(ch)) { return false; }
    }
    return true;
}

// ── Stream info ─────────────────────────────────────────────

interface StreamInfo {
    sid: number;
    name: string;
    mode: number; // MODE_READ or MODE_WRITE
    filePath: string;
    fd: number; // file descriptor
    /** For read mode: data read from file into memory. */
    readBuf?: Buffer;
    readOffset?: number;
    eof?: boolean;
}

// ── SDSIO Manager ───────────────────────────────────────────

/**
 * Manages open streams and processes SDSIO protocol messages.
 *
 * Events:
 *   'log'    (message: string)
 *   'record' (name: string, filePath: string)
 *   'play'   (name: string, filePath: string)
 *   'close'  (name: string, filePath: string)
 *   'error'  (message: string)
 *   'ping'   ()
 *   'connected' ()
 *   'disconnected' ()
 */
export class SdsioManager extends EventEmitter {
    private workDir: string;
    private nextSid = 1;
    private streams = new Map<number, StreamInfo>();
    private nameToSid = new Map<string, number>();

    constructor(workDir: string) {
        super();
        this.workDir = workDir;
        if (!fs.existsSync(workDir)) {
            fs.mkdirSync(workDir, { recursive: true });
        }
    }

    /** Get list of currently open streams. */
    get openStreams(): Map<string, string> {
        const result = new Map<string, string>();
        for (const s of this.streams.values()) {
            result.set(s.name, s.filePath);
        }
        return result;
    }

    /**
     * Process a complete SDSIO message (header already parsed).
     * Returns the response buffer to send back, or undefined if no response.
     */
    processMessage(header: SdsioHeader, payload: Buffer): Buffer | undefined {
        switch (header.cmd) {
            case CMD_OPEN:  return this._handleOpen(header, payload);
            case CMD_CLOSE: return this._handleClose(header);
            case CMD_WRITE: return this._handleWrite(header, payload);
            case CMD_READ:  return this._handleRead(header);
            case CMD_PING:  return this._handlePing(header);
            default:
                this.emit('error', `Unknown command: ${header.cmd}`);
                return undefined;
        }
    }

    /** Close all open streams (cleanup on disconnect). */
    closeAll(): void {
        for (const [sid, stream] of this.streams.entries()) {
            try {
                fs.closeSync(stream.fd);
            } catch { /* ignore */ }
            this.emit('close', stream.name, stream.filePath);
        }
        this.streams.clear();
        this.nameToSid.clear();
    }

    /** Reset SID counter (e.g. on reconnect). */
    resetSids(): void {
        this.nextSid = 1;
    }

    // ── Command handlers ────────────────────────────────────

    private _handleOpen(header: SdsioHeader, payload: Buffer): Buffer {
        const mode = header.arg;
        // Strip trailing NUL bytes and decode UTF-8
        const name = payload.toString('utf-8').replace(/\0$/, '');

        if (!isValidStreamName(name)) {
            this.emit('log', `Invalid stream name: "${name}"`);
            return buildResponse(CMD_OPEN, 0, mode);
        }

        if (this.nameToSid.has(name)) {
            this.emit('log', `Stream "${name}" is already open, cannot open again.`);
            return buildResponse(CMD_OPEN, 0, mode);
        }

        if (mode === MODE_WRITE) {
            return this._openForWrite(name, mode);
        } else {
            return this._openForRead(name, mode);
        }
    }

    private _openForWrite(name: string, mode: number): Buffer {
        // Find next available file index
        let idx = 0;
        let filePath: string;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            filePath = path.join(this.workDir, `${name}.${idx}.sds`);
            if (!fs.existsSync(filePath)) { break; }
            idx++;
        }

        try {
            const fd = fs.openSync(filePath, 'w');
            const sid = this.nextSid++;
            const stream: StreamInfo = { sid, name, mode, filePath, fd };
            this.streams.set(sid, stream);
            this.nameToSid.set(name, sid);

            this.emit('log', `Record:   ${name} (${filePath}).`);
            this.emit('record', name, filePath);

            return buildResponse(CMD_OPEN, sid, mode);
        } catch (err: any) {
            this.emit('error', `Failed to open file "${filePath}": ${err.message}`);
            return buildResponse(CMD_OPEN, 0, mode);
        }
    }

    private _openForRead(name: string, mode: number): Buffer {
        // Read index file
        const indexPath = path.join(this.workDir, `${name}.index.txt`);
        let idx = 0;
        try {
            const content = fs.readFileSync(indexPath, 'utf-8').trim();
            const parsed = parseInt(content, 10);
            if (!isNaN(parsed) && parsed >= 0) { idx = parsed; }
        } catch { /* default to 0 */ }

        const filePath = path.join(this.workDir, `${name}.${idx}.sds`);

        if (!fs.existsSync(filePath)) {
            // Reset index to 0
            try { fs.writeFileSync(indexPath, '0', 'utf-8'); } catch { /* ignore */ }
            this.emit('log', `Stream open failed: "${name}". File \`${filePath}\` does not exist.`);
            return buildResponse(CMD_OPEN, 0, mode);
        }

        try {
            // Read entire file into memory for playback
            const fileData = fs.readFileSync(filePath);
            const fd = 0; // not needed for read — we use the buffer
            const sid = this.nextSid++;
            const stream: StreamInfo = {
                sid, name, mode, filePath, fd,
                readBuf: fileData, readOffset: 0, eof: false,
            };
            this.streams.set(sid, stream);
            this.nameToSid.set(name, sid);

            // Update index file to next
            try { fs.writeFileSync(indexPath, String(idx + 1), 'utf-8'); } catch { /* ignore */ }

            this.emit('log', `Playback: ${name} (${filePath}).`);
            this.emit('play', name, filePath);

            return buildResponse(CMD_OPEN, sid, mode);
        } catch (err: any) {
            this.emit('error', `Failed to open file "${filePath}": ${err.message}`);
            return buildResponse(CMD_OPEN, 0, mode);
        }
    }

    private _handleClose(header: SdsioHeader): undefined {
        const stream = this.streams.get(header.sid);
        if (!stream) { return undefined; }

        try {
            if (stream.mode === MODE_WRITE && stream.fd) {
                fs.closeSync(stream.fd);
            }
        } catch { /* ignore */ }

        this.emit('log', `Closed:   ${stream.name} (${stream.filePath}).`);
        this.emit('close', stream.name, stream.filePath);

        this.nameToSid.delete(stream.name);
        this.streams.delete(header.sid);

        return undefined; // No response for close
    }

    private _handleWrite(header: SdsioHeader, payload: Buffer): undefined {
        const stream = this.streams.get(header.sid);
        if (!stream) {
            this.emit('log', `Not opened for write: ${header.sid}`);
            return undefined;
        }

        if (stream.mode !== MODE_WRITE) {
            this.emit('log', `Stream ${header.sid} not opened for write`);
            return undefined;
        }

        try {
            fs.writeSync(stream.fd, payload);
        } catch (err: any) {
            this.emit('error', `Write error on stream ${header.sid}: ${err.message}`);
        }

        return undefined; // No response for write
    }

    private _handleRead(header: SdsioHeader): Buffer {
        const stream = this.streams.get(header.sid);
        if (!stream || stream.mode !== MODE_READ) {
            return buildResponse(CMD_READ, header.sid, 0); // eof=0, sz=0
        }

        const requested = header.arg;
        const remaining = (stream.readBuf?.length ?? 0) - (stream.readOffset ?? 0);

        if (remaining <= 0) {
            // EOF
            return buildResponse(CMD_READ, header.sid, 1); // eof=1, sz=0
        }

        const toRead = Math.min(requested, remaining);
        const data = stream.readBuf!.subarray(stream.readOffset!, stream.readOffset! + toRead);
        stream.readOffset! += toRead;

        const eof = (stream.readOffset! >= stream.readBuf!.length) ? 1 : 0;

        return buildResponse(CMD_READ, header.sid, eof, data);
    }

    private _handlePing(header: SdsioHeader): Buffer {
        this.emit('log', 'Ping received.');
        this.emit('ping');
        return buildResponse(CMD_PING, header.sid, 1);
    }
}

// ── Frame accumulator ───────────────────────────────────────

/**
 * Accumulates incoming bytes and extracts complete SDSIO frames.
 * Used by all transports to handle partial reads.
 */
export class FrameAccumulator {
    private buf = Buffer.alloc(0);

    /** Push new data. Returns an array of complete frames (header + payload). */
    push(data: Buffer): Array<{ header: SdsioHeader; payload: Buffer }> {
        this.buf = Buffer.concat([this.buf, data]);
        const frames: Array<{ header: SdsioHeader; payload: Buffer }> = [];

        while (this.buf.length >= HEADER_SIZE) {
            const header = parseHeader(this.buf);

            // Sanity check: reject impossibly large payloads (> 16MB)
            if (header.sz > 16 * 1024 * 1024) {
                // Protocol error — discard buffer
                this.buf = Buffer.alloc(0);
                break;
            }

            const frameLen = HEADER_SIZE + header.sz;
            if (this.buf.length < frameLen) {
                break; // Wait for more data
            }

            const payload = this.buf.subarray(HEADER_SIZE, frameLen);
            frames.push({ header, payload: Buffer.from(payload) });

            // Advance past this frame
            this.buf = this.buf.subarray(frameLen);
        }

        return frames;
    }

    /** Reset the accumulator (e.g. on disconnect). */
    reset(): void {
        this.buf = Buffer.alloc(0);
    }
}
