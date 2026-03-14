/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Unit tests for SDSIO protocol: header parsing/building,
 * FrameAccumulator, and SdsioManager command processing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
    HEADER_SIZE,
    CMD_OPEN,
    CMD_CLOSE,
    CMD_WRITE,
    CMD_READ,
    CMD_PING,
    MODE_READ,
    MODE_WRITE,
    parseHeader,
    buildHeader,
    buildResponse,
    SdsioManager,
    FrameAccumulator,
    SdsioHeader,
} from '../../src/recorder/sdsio/protocol';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsio-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Header helpers ──────────────────────────────────────────

describe('parseHeader / buildHeader roundtrip', () => {
    it('roundtrips header values', () => {
        const buf = buildHeader(CMD_OPEN, 42, MODE_WRITE, 128);
        expect(buf.length).toBe(HEADER_SIZE);

        const h = parseHeader(buf);
        expect(h.cmd).toBe(CMD_OPEN);
        expect(h.sid).toBe(42);
        expect(h.arg).toBe(MODE_WRITE);
        expect(h.sz).toBe(128);
    });

    it('handles zero values', () => {
        const buf = buildHeader(0, 0, 0, 0);
        const h = parseHeader(buf);
        expect(h.cmd).toBe(0);
        expect(h.sid).toBe(0);
        expect(h.arg).toBe(0);
        expect(h.sz).toBe(0);
    });

    it('handles max uint32 values', () => {
        const max = 0xFFFFFFFF;
        const buf = buildHeader(max, max, max, max);
        const h = parseHeader(buf);
        expect(h.cmd).toBe(max);
        expect(h.sid).toBe(max);
        expect(h.arg).toBe(max);
        expect(h.sz).toBe(max);
    });

    it('parses at non-zero offset', () => {
        const prefix = Buffer.alloc(10, 0xAA);
        const header = buildHeader(CMD_PING, 7, 1, 0);
        const combined = Buffer.concat([prefix, header]);

        const h = parseHeader(combined, 10);
        expect(h.cmd).toBe(CMD_PING);
        expect(h.sid).toBe(7);
    });
});

describe('buildResponse', () => {
    it('builds header-only response when no payload', () => {
        const resp = buildResponse(CMD_PING, 1, 1);
        expect(resp.length).toBe(HEADER_SIZE);
        const h = parseHeader(resp);
        expect(h.cmd).toBe(CMD_PING);
        expect(h.sz).toBe(0);
    });

    it('builds header + payload response', () => {
        const payload = Buffer.from('hello');
        const resp = buildResponse(CMD_READ, 5, 0, payload);
        expect(resp.length).toBe(HEADER_SIZE + 5);

        const h = parseHeader(resp);
        expect(h.cmd).toBe(CMD_READ);
        expect(h.sz).toBe(5);

        const data = resp.subarray(HEADER_SIZE);
        expect(data.toString()).toBe('hello');
    });
});

// ── FrameAccumulator ────────────────────────────────────────

describe('FrameAccumulator', () => {
    it('extracts complete frames', () => {
        const acc = new FrameAccumulator();
        const payload = Buffer.from('test');
        const frame = Buffer.concat([
            buildHeader(CMD_WRITE, 1, 0, payload.length),
            payload,
        ]);

        const frames = acc.push(frame);
        expect(frames.length).toBe(1);
        expect(frames[0].header.cmd).toBe(CMD_WRITE);
        expect(frames[0].payload.toString()).toBe('test');
    });

    it('accumulates partial data across multiple pushes', () => {
        const acc = new FrameAccumulator();
        const payload = Buffer.from('hello world');
        const frame = Buffer.concat([
            buildHeader(CMD_WRITE, 1, 0, payload.length),
            payload,
        ]);

        // Send in two chunks
        const half = Math.floor(frame.length / 2);
        const part1 = frame.subarray(0, half);
        const part2 = frame.subarray(half);

        expect(acc.push(part1).length).toBe(0); // incomplete
        const frames = acc.push(part2);
        expect(frames.length).toBe(1);
        expect(frames[0].payload.toString()).toBe('hello world');
    });

    it('extracts multiple frames from a single push', () => {
        const acc = new FrameAccumulator();
        const f1 = Buffer.concat([buildHeader(CMD_PING, 1, 0, 0)]);
        const f2 = Buffer.concat([buildHeader(CMD_PING, 2, 0, 0)]);
        const f3 = Buffer.concat([buildHeader(CMD_PING, 3, 0, 0)]);

        const frames = acc.push(Buffer.concat([f1, f2, f3]));
        expect(frames.length).toBe(3);
        expect(frames[0].header.sid).toBe(1);
        expect(frames[1].header.sid).toBe(2);
        expect(frames[2].header.sid).toBe(3);
    });

    it('discards buffer on impossibly large payload (>16MB)', () => {
        const acc = new FrameAccumulator();
        const bad = buildHeader(CMD_WRITE, 1, 0, 20 * 1024 * 1024); // 20MB
        const frames = acc.push(bad);
        expect(frames.length).toBe(0);

        // After discard, can still process valid frames
        const good = buildHeader(CMD_PING, 1, 0, 0);
        const frames2 = acc.push(good);
        expect(frames2.length).toBe(1);
    });

    it('reset clears accumulated data', () => {
        const acc = new FrameAccumulator();
        // Push partial frame
        acc.push(Buffer.alloc(8, 0));
        acc.reset();

        // Now push a valid complete frame
        const frames = acc.push(buildHeader(CMD_PING, 1, 0, 0));
        expect(frames.length).toBe(1);
    });
});

// ── SdsioManager ────────────────────────────────────────────

describe('SdsioManager', () => {
    let mgr: SdsioManager;

    beforeEach(() => {
        mgr = new SdsioManager(tmpDir);
    });

    afterEach(() => {
        mgr.closeAll();
    });

    it('handles Ping command', () => {
        const events: string[] = [];
        mgr.on('ping', () => events.push('ping'));

        const header: SdsioHeader = { cmd: CMD_PING, sid: 0, arg: 0, sz: 0 };
        const resp = mgr.processMessage(header, Buffer.alloc(0));

        expect(resp).toBeDefined();
        const rh = parseHeader(resp!);
        expect(rh.cmd).toBe(CMD_PING);
        expect(rh.arg).toBe(1); // pong
        expect(events).toContain('ping');
    });

    it('opens a stream for writing, writes data, and closes', () => {
        const events: Array<{ type: string; name: string }> = [];
        mgr.on('record', (name: string) => events.push({ type: 'record', name }));
        mgr.on('close', (name: string) => events.push({ type: 'close', name }));

        // Open
        const namePayload = Buffer.from('TestStream\0');
        const openHeader: SdsioHeader = {
            cmd: CMD_OPEN, sid: 0, arg: MODE_WRITE, sz: namePayload.length,
        };
        const openResp = mgr.processMessage(openHeader, namePayload);
        expect(openResp).toBeDefined();

        const openRH = parseHeader(openResp!);
        expect(openRH.cmd).toBe(CMD_OPEN);
        const sid = openRH.sid;
        expect(sid).toBeGreaterThan(0);

        // Write some data (an SDS record: timestamp + size + data)
        const recBuf = Buffer.alloc(8 + 4);
        recBuf.writeUInt32LE(0, 0);     // timestamp
        recBuf.writeUInt32LE(4, 4);     // data size
        recBuf.writeFloatLE(3.14, 8);   // data
        const writeHeader: SdsioHeader = {
            cmd: CMD_WRITE, sid, arg: 0, sz: recBuf.length,
        };
        mgr.processMessage(writeHeader, recBuf);

        // Close
        const closeHeader: SdsioHeader = { cmd: CMD_CLOSE, sid, arg: 0, sz: 0 };
        mgr.processMessage(closeHeader, Buffer.alloc(0));

        // Verify file was created
        const expectedFile = path.join(tmpDir, 'TestStream.0.sds');
        expect(fs.existsSync(expectedFile)).toBe(true);
        const fileData = fs.readFileSync(expectedFile);
        expect(fileData.length).toBe(12);

        // Verify events
        expect(events).toEqual([
            { type: 'record', name: 'TestStream' },
            { type: 'close', name: 'TestStream' },
        ]);
    });

    it('returns sid=0 for invalid stream names', () => {
        const invalidNames = ['', 'bad/name', 'bad:name', 'bad*name'];

        for (const name of invalidNames) {
            const payload = Buffer.from(name + '\0');
            const header: SdsioHeader = {
                cmd: CMD_OPEN, sid: 0, arg: MODE_WRITE, sz: payload.length,
            };
            const resp = mgr.processMessage(header, payload);
            const rh = parseHeader(resp!);
            expect(rh.sid).toBe(0); // rejected
        }
    });

    it('rejects opening the same stream name twice', () => {
        const payload = Buffer.from('Dup\0');
        const header: SdsioHeader = {
            cmd: CMD_OPEN, sid: 0, arg: MODE_WRITE, sz: payload.length,
        };

        const resp1 = mgr.processMessage(header, payload);
        expect(parseHeader(resp1!).sid).toBeGreaterThan(0);

        const resp2 = mgr.processMessage(header, payload);
        expect(parseHeader(resp2!).sid).toBe(0); // rejected
    });

    it('opens a stream for reading existing data', () => {
        // Create a file to read
        const sdsData = Buffer.alloc(8 + 4);
        sdsData.writeUInt32LE(100, 0);  // timestamp
        sdsData.writeUInt32LE(4, 4);    // data size
        sdsData.writeFloatLE(42.0, 8);
        fs.writeFileSync(path.join(tmpDir, 'Sensor.0.sds'), sdsData);

        const payload = Buffer.from('Sensor\0');
        const header: SdsioHeader = {
            cmd: CMD_OPEN, sid: 0, arg: MODE_READ, sz: payload.length,
        };
        const resp = mgr.processMessage(header, payload);
        const rh = parseHeader(resp!);
        expect(rh.sid).toBeGreaterThan(0);

        // Read data back
        const readHeader: SdsioHeader = {
            cmd: CMD_READ, sid: rh.sid, arg: 1024, sz: 0,
        };
        const readResp = mgr.processMessage(readHeader, Buffer.alloc(0));
        expect(readResp).toBeDefined();
        expect(readResp!.length).toBeGreaterThan(HEADER_SIZE);

        const data = readResp!.subarray(HEADER_SIZE);
        expect(data.length).toBe(12);
    });

    it('returns EOF on read past end', () => {
        // Create a small file
        fs.writeFileSync(path.join(tmpDir, 'Small.0.sds'), Buffer.from([0x01]));

        const payload = Buffer.from('Small\0');
        const openResp = mgr.processMessage(
            { cmd: CMD_OPEN, sid: 0, arg: MODE_READ, sz: payload.length },
            payload
        );
        const sid = parseHeader(openResp!).sid;

        // First read gets the data
        mgr.processMessage({ cmd: CMD_READ, sid, arg: 100, sz: 0 }, Buffer.alloc(0));

        // Second read should signal EOF (arg=1)
        const eofResp = mgr.processMessage(
            { cmd: CMD_READ, sid, arg: 100, sz: 0 }, Buffer.alloc(0)
        );
        const eofH = parseHeader(eofResp!);
        expect(eofH.arg).toBe(1); // eof
    });

    it('increments file index for multiple write sessions', () => {
        for (let i = 0; i < 3; i++) {
            const payload = Buffer.from('Multi\0');
            const openResp = mgr.processMessage(
                { cmd: CMD_OPEN, sid: 0, arg: MODE_WRITE, sz: payload.length },
                payload
            );
            const sid = parseHeader(openResp!).sid;

            // Write a byte
            mgr.processMessage(
                { cmd: CMD_WRITE, sid, arg: 0, sz: 1 },
                Buffer.from([i])
            );

            // Close
            mgr.processMessage(
                { cmd: CMD_CLOSE, sid, arg: 0, sz: 0 },
                Buffer.alloc(0)
            );
        }

        // Should have 3 files
        expect(fs.existsSync(path.join(tmpDir, 'Multi.0.sds'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'Multi.1.sds'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'Multi.2.sds'))).toBe(true);
    });

    it('closeAll closes all open streams', () => {
        const closed: string[] = [];
        mgr.on('close', (name: string) => closed.push(name));

        // Open two streams
        mgr.processMessage(
            { cmd: CMD_OPEN, sid: 0, arg: MODE_WRITE, sz: 3 },
            Buffer.from('A\0')
        );
        mgr.processMessage(
            { cmd: CMD_OPEN, sid: 0, arg: MODE_WRITE, sz: 3 },
            Buffer.from('B\0')
        );

        expect(mgr.openStreams.size).toBe(2);

        mgr.closeAll();
        expect(mgr.openStreams.size).toBe(0);
        expect(closed).toContain('A');
        expect(closed).toContain('B');
    });

    it('emits error for unknown command', () => {
        const errors: string[] = [];
        mgr.on('error', (msg: string) => errors.push(msg));

        mgr.processMessage(
            { cmd: 99, sid: 0, arg: 0, sz: 0 },
            Buffer.alloc(0)
        );

        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('Unknown command');
    });
});
