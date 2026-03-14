/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Integration test — Socket loopback.
 *
 * Spins up a SocketTransport (TCP server), connects a raw TCP client,
 * speaks the SDSIO protocol, and verifies that:
 *  - Ping gets a response
 *  - Open + Write + Close creates a valid .sds file
 *  - The recorded file can be parsed back
 *  - Open for read returns previously written data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SdsioManager, FrameAccumulator } from '../../src/recorder/sdsio/protocol';
import { SocketTransport } from '../../src/recorder/sdsio/socketTransport';
import {
    CMD_OPEN,
    CMD_CLOSE,
    CMD_WRITE,
    CMD_READ,
    CMD_PING,
    MODE_READ,
    MODE_WRITE,
    buildHeader,
} from '../../src/recorder/sdsio/protocol';
import { parseSdsFile } from '../../src/sds/parser';

let tmpDir: string;
let manager: SdsioManager;
let transport: SocketTransport;

const TEST_PORT = 15050; // high port to avoid conflicts

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Connect a raw TCP client, returning it once connected. */
function connectClient(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ host: '127.0.0.1', port }, () => {
            resolve(client);
        });
        client.on('error', reject);
    });
}

/** Send a frame and wait for a response (with timeout). */
function sendAndReceive(
    client: net.Socket,
    cmd: number,
    sid: number,
    arg: number,
    payload?: Buffer
): Promise<{ header: ReturnType<typeof parseHeader>; payload: Buffer }> {
    return new Promise((resolve, reject) => {
        const acc = new FrameAccumulator();
        const timeout = setTimeout(() => reject(new Error('Response timeout')), 5000);

        const onData = (data: Buffer) => {
            const frames = acc.push(data);
            if (frames.length > 0) {
                clearTimeout(timeout);
                client.removeListener('data', onData);
                resolve(frames[0]);
            }
        };
        client.on('data', onData);

        const sz = payload?.length ?? 0;
        const header = buildHeader(cmd, sid, arg, sz);
        if (payload && payload.length > 0) {
            client.write(Buffer.concat([header, payload]));
        } else {
            client.write(header);
        }
    });
}

/** Send a frame without waiting for a response (e.g. Write, Close). */
function sendNoResponse(
    client: net.Socket,
    cmd: number,
    sid: number,
    arg: number,
    payload?: Buffer
): void {
    const sz = payload?.length ?? 0;
    const header = buildHeader(cmd, sid, arg, sz);
    if (payload && payload.length > 0) {
        client.write(Buffer.concat([header, payload]));
    } else {
        client.write(header);
    }
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-socket-test-'));
    manager = new SdsioManager(tmpDir);
    transport = new SocketTransport(manager, {
        ipAddress: '127.0.0.1',
        port: TEST_PORT,
    });

    // Start transport in background
    transport.start();

    // Wait for server to be listening
    await sleep(300);
});

afterEach(async () => {
    transport.stop();
    manager.closeAll();
    await sleep(200);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Socket loopback', () => {
    it('responds to Ping', async () => {
        const client = await connectClient(TEST_PORT);
        await sleep(100);

        const resp = await sendAndReceive(client, CMD_PING, 0, 0);
        expect(resp.header.cmd).toBe(CMD_PING);
        expect(resp.header.arg).toBe(1); // pong

        client.destroy();
    });

    it('records data via Open + Write + Close and creates a valid .sds file', async () => {
        const client = await connectClient(TEST_PORT);
        await sleep(100);

        // Open stream for writing
        const namePayload = Buffer.from('SocketTest\0');
        const openResp = await sendAndReceive(client, CMD_OPEN, 0, MODE_WRITE, namePayload);
        expect(openResp.header.cmd).toBe(CMD_OPEN);
        const sid = openResp.header.sid;
        expect(sid).toBeGreaterThan(0);

        // Write 3 SDS records
        for (let i = 0; i < 3; i++) {
            const recBuf = Buffer.alloc(8 + 4);
            recBuf.writeUInt32LE(i * 10, 0);       // timestamp
            recBuf.writeUInt32LE(4, 4);             // data size
            recBuf.writeFloatLE(i * 1.5, 8);        // data
            sendNoResponse(client, CMD_WRITE, sid, 0, recBuf);
        }

        // Small delay to ensure writes are flushed
        await sleep(100);

        // Close stream
        sendNoResponse(client, CMD_CLOSE, sid, 0);
        await sleep(100);

        // Verify file
        const filePath = path.join(tmpDir, 'SocketTest.0.sds');
        expect(fs.existsSync(filePath)).toBe(true);

        const parsed = parseSdsFile(filePath);
        expect(parsed.totalRecords).toBe(3);
        expect(parsed.records[0].timestamp).toBe(0);
        expect(parsed.records[1].timestamp).toBe(10);
        expect(parsed.records[2].timestamp).toBe(20);

        // Verify data values
        expect(parsed.records[0].data.readFloatLE(0)).toBeCloseTo(0);
        expect(parsed.records[1].data.readFloatLE(0)).toBeCloseTo(1.5);
        expect(parsed.records[2].data.readFloatLE(0)).toBeCloseTo(3.0);

        client.destroy();
    });

    it('reads back previously written data via Open(read) + Read', async () => {
        // First, create a file to read
        const sdsData = Buffer.alloc(8 + 4);
        sdsData.writeUInt32LE(42, 0);       // timestamp
        sdsData.writeUInt32LE(4, 4);        // data size
        sdsData.writeFloatLE(99.9, 8);
        fs.writeFileSync(path.join(tmpDir, 'ReadMe.0.sds'), sdsData);

        const client = await connectClient(TEST_PORT);
        await sleep(100);

        // Open for reading
        const namePayload = Buffer.from('ReadMe\0');
        const openResp = await sendAndReceive(client, CMD_OPEN, 0, MODE_READ, namePayload);
        const sid = openResp.header.sid;
        expect(sid).toBeGreaterThan(0);

        // Read data
        const readResp = await sendAndReceive(client, CMD_READ, sid, 1024);
        expect(readResp.payload.length).toBe(12);
        expect(readResp.payload.readUInt32LE(0)).toBe(42);      // timestamp
        expect(readResp.payload.readFloatLE(8)).toBeCloseTo(99.9);

        // Read again — should be EOF
        const eofResp = await sendAndReceive(client, CMD_READ, sid, 1024);
        expect(eofResp.header.arg).toBe(1); // eof flag

        client.destroy();
    });

    it('handles client disconnect and reconnect', async () => {
        const client1 = await connectClient(TEST_PORT);
        await sleep(100);

        // Open and close a stream
        const name = Buffer.from('Reconnect\0');
        const resp1 = await sendAndReceive(client1, CMD_OPEN, 0, MODE_WRITE, name);
        expect(resp1.header.sid).toBeGreaterThan(0);

        sendNoResponse(client1, CMD_CLOSE, resp1.header.sid, 0);
        await sleep(50);

        // Disconnect
        client1.destroy();
        await sleep(500); // wait for server to detect disconnect

        // Reconnect
        const client2 = await connectClient(TEST_PORT);
        await sleep(100);

        // Should be able to open the same stream again (new file index)
        const resp2 = await sendAndReceive(client2, CMD_OPEN, 0, MODE_WRITE, name);
        expect(resp2.header.sid).toBeGreaterThan(0);

        sendNoResponse(client2, CMD_CLOSE, resp2.header.sid, 0);
        await sleep(50);

        // Both files should exist
        expect(fs.existsSync(path.join(tmpDir, 'Reconnect.0.sds'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'Reconnect.1.sds'))).toBe(true);

        client2.destroy();
    });
});
