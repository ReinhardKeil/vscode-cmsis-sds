/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Unit tests for SDS binary parser and writer.
 *
 * Covers:
 *  - Writing records to binary, parsing them back (roundtrip)
 *  - Empty file handling
 *  - Truncated / malformed file handling
 *  - Multi-frame records
 *  - Metadata YAML serialization and parsing (roundtrip)
 *  - CSV export and import (roundtrip)
 *  - findNextFileIndex logic
 *  - All SDS data types (uint8..double)
 *  - Scale/offset encoding and decoding
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
    parseSdsFile,
    parseSdsBuffer,
    decodeRecord,
    decodeAllRecords,
    getSdsFileStats,
    writeSdsFile,
    encodeRecords,
    writeMetadataFile,
    parseMetadataFile,
    parseMetadataString,
    serializeMetadataToYaml,
    exportToCsv,
    importFromCsv,
    findNextFileIndex,
    SdsRecord,
    SdsMetadata,
    SdsContentValue,
    SdsDecodedSample,
    sdsDataTypeSize,
    sdsFrameSize,
} from '../../src/sds';

// ── Helpers ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(timestamp: number, floats: number[]): SdsRecord {
    const data = Buffer.alloc(floats.length * 4);
    floats.forEach((v, i) => data.writeFloatLE(v, i * 4));
    return { timestamp, dataSize: data.length, data };
}

function make3AxisMetadata(name = 'Accel', freq = 100): SdsMetadata {
    return {
        sds: {
            name,
            frequency: freq,
            content: [
                { value: 'x', type: 'float', unit: 'mG' },
                { value: 'y', type: 'float', unit: 'mG' },
                { value: 'z', type: 'float', unit: 'mG' },
            ],
        },
    };
}

// ── Tests ───────────────────────────────────────────────────

describe('sdsDataTypeSize', () => {
    it('returns correct sizes for all types', () => {
        expect(sdsDataTypeSize('uint8_t')).toBe(1);
        expect(sdsDataTypeSize('int8_t')).toBe(1);
        expect(sdsDataTypeSize('uint16_t')).toBe(2);
        expect(sdsDataTypeSize('int16_t')).toBe(2);
        expect(sdsDataTypeSize('uint32_t')).toBe(4);
        expect(sdsDataTypeSize('int32_t')).toBe(4);
        expect(sdsDataTypeSize('float')).toBe(4);
        expect(sdsDataTypeSize('double')).toBe(8);
    });
});

describe('sdsFrameSize', () => {
    it('sums up channel sizes', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
            { value: 'z', type: 'float' },
        ];
        expect(sdsFrameSize(content)).toBe(12);
    });

    it('handles mixed types', () => {
        const content: SdsContentValue[] = [
            { value: 'a', type: 'uint8_t' },
            { value: 'b', type: 'double' },
        ];
        expect(sdsFrameSize(content)).toBe(9);
    });

    it('handles bit-field notation (uint32_t:1)', () => {
        const content: SdsContentValue[] = [
            { value: 'flags', type: 'uint32_t:1' as any },
        ];
        expect(sdsFrameSize(content)).toBe(4);
    });
});

describe('writeSdsFile / parseSdsFile roundtrip', () => {
    it('writes and reads back identical records', () => {
        const records = [
            makeRecord(0, [1.0, 2.0, 3.0]),
            makeRecord(10, [4.0, 5.0, 6.0]),
            makeRecord(20, [7.0, 8.0, 9.0]),
        ];

        const filePath = path.join(tmpDir, 'test.0.sds');
        writeSdsFile(filePath, records);

        const parsed = parseSdsFile(filePath);
        expect(parsed.totalRecords).toBe(3);
        expect(parsed.records.length).toBe(3);

        for (let i = 0; i < records.length; i++) {
            expect(parsed.records[i].timestamp).toBe(records[i].timestamp);
            expect(parsed.records[i].dataSize).toBe(records[i].dataSize);
            expect(parsed.records[i].data).toEqual(records[i].data);
        }
    });

    it('computes correct duration', () => {
        const records = [
            makeRecord(0, [1.0]),
            makeRecord(500, [2.0]),
            makeRecord(1000, [3.0]),
        ];
        const filePath = path.join(tmpDir, 'dur.0.sds');
        writeSdsFile(filePath, records);

        const parsed = parseSdsFile(filePath);
        expect(parsed.durationMs).toBe(1000);
    });

    it('creates output directory if missing', () => {
        const nested = path.join(tmpDir, 'deep', 'nested', 'dir');
        const filePath = path.join(nested, 'test.0.sds');
        writeSdsFile(filePath, [makeRecord(0, [1.0])]);
        expect(fs.existsSync(filePath)).toBe(true);
    });
});

describe('parseSdsBuffer', () => {
    it('handles empty buffer', () => {
        const parsed = parseSdsBuffer(Buffer.alloc(0));
        expect(parsed.totalRecords).toBe(0);
        expect(parsed.records).toEqual([]);
    });

    it('handles buffer shorter than header', () => {
        const parsed = parseSdsBuffer(Buffer.alloc(4));
        expect(parsed.totalRecords).toBe(0);
    });

    it('handles truncated record (header present, data cut off)', () => {
        // Header says 100 bytes of data, but only 10 bytes follow
        const buf = Buffer.alloc(8 + 10);
        buf.writeUInt32LE(0, 0);    // timestamp
        buf.writeUInt32LE(100, 4);  // dataSize = 100 (but only 10 bytes available)
        const parsed = parseSdsBuffer(buf);
        expect(parsed.totalRecords).toBe(0); // truncated record skipped
    });

    it('parses multiple records correctly', () => {
        const rec1Data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const rec2Data = Buffer.from([0xAA, 0xBB]);

        const buf = Buffer.alloc(8 + 4 + 8 + 2);
        let off = 0;
        // Record 1
        buf.writeUInt32LE(100, off); off += 4;
        buf.writeUInt32LE(4, off); off += 4;
        rec1Data.copy(buf, off); off += 4;
        // Record 2
        buf.writeUInt32LE(200, off); off += 4;
        buf.writeUInt32LE(2, off); off += 4;
        rec2Data.copy(buf, off);

        const parsed = parseSdsBuffer(buf);
        expect(parsed.totalRecords).toBe(2);
        expect(parsed.records[0].timestamp).toBe(100);
        expect(parsed.records[0].data).toEqual(rec1Data);
        expect(parsed.records[1].timestamp).toBe(200);
        expect(parsed.records[1].data).toEqual(rec2Data);
    });
});

describe('decodeRecord', () => {
    it('decodes float channels with default scale/offset', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const record = makeRecord(1000, [3.14, 2.71]);
        const sample = decodeRecord(record, content);

        expect(sample.timestamp).toBe(1000);
        expect(sample.timeSeconds).toBe(1.0);
        expect(sample.values['x']).toBeCloseTo(3.14, 2);
        expect(sample.values['y']).toBeCloseTo(2.71, 2);
    });

    it('applies scale and offset', () => {
        const content: SdsContentValue[] = [
            { value: 'temp', type: 'int16_t', scale: 0.01, offset: -40 },
        ];
        const data = Buffer.alloc(2);
        data.writeInt16LE(6500, 0); // raw=6500, decoded = 6500*0.01 + (-40) = 25.0
        const record: SdsRecord = { timestamp: 0, dataSize: 2, data };
        const sample = decodeRecord(record, content);

        expect(sample.values['temp']).toBeCloseTo(25.0, 4);
    });

    it('handles custom tick frequency', () => {
        const record = makeRecord(32768, [1.0]);
        const content: SdsContentValue[] = [{ value: 'v', type: 'float' }];
        const sample = decodeRecord(record, content, 32768);

        expect(sample.timeSeconds).toBeCloseTo(1.0, 4);
    });
});

describe('decodeAllRecords', () => {
    it('decodes all records from a parsed file', () => {
        const records = [
            makeRecord(0, [1.0, 2.0, 3.0]),
            makeRecord(10, [4.0, 5.0, 6.0]),
        ];
        const filePath = path.join(tmpDir, 'all.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const metadata = make3AxisMetadata();

        const samples = decodeAllRecords(parsed, metadata);
        expect(samples.length).toBe(2);
        expect(samples[0].values['x']).toBeCloseTo(1.0);
        expect(samples[1].values['z']).toBeCloseTo(6.0);
    });

    it('expands multi-frame records into separate samples', () => {
        // One record containing 2 frames (6 floats = 2 * 3-channel)
        const data = Buffer.alloc(24);
        [10, 20, 30, 40, 50, 60].forEach((v, i) => data.writeFloatLE(v, i * 4));
        const records: SdsRecord[] = [{ timestamp: 0, dataSize: 24, data }];

        const filePath = path.join(tmpDir, 'multi.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const metadata = make3AxisMetadata();

        const samples = decodeAllRecords(parsed, metadata);
        expect(samples.length).toBe(2);
        expect(samples[0].values['x']).toBeCloseTo(10);
        expect(samples[1].values['x']).toBeCloseTo(40);
    });
});

describe('encodeRecords / decodeAllRecords roundtrip', () => {
    it('encodes samples to records and decodes back identically', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const metadata: SdsMetadata = {
            sds: { name: 'Test', frequency: 100, content },
        };

        const originalSamples: SdsDecodedSample[] = [
            { timestamp: 0, timeSeconds: 0, values: { x: 1.5, y: -2.5 } },
            { timestamp: 10, timeSeconds: 0.01, values: { x: 3.0, y: 4.0 } },
        ];

        const records = encodeRecords(originalSamples, content);
        const filePath = path.join(tmpDir, 'rt.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const decoded = decodeAllRecords(parsed, metadata);

        expect(decoded.length).toBe(2);
        expect(decoded[0].values['x']).toBeCloseTo(1.5, 4);
        expect(decoded[0].values['y']).toBeCloseTo(-2.5, 4);
        expect(decoded[1].values['x']).toBeCloseTo(3.0, 4);
        expect(decoded[1].values['y']).toBeCloseTo(4.0, 4);
    });

    it('roundtrips with scale and offset', () => {
        const content: SdsContentValue[] = [
            { value: 'temp', type: 'int16_t', scale: 0.01, offset: -40 },
        ];
        const metadata: SdsMetadata = {
            sds: { name: 'Temp', frequency: 10, content },
        };

        const original: SdsDecodedSample[] = [
            { timestamp: 0, timeSeconds: 0, values: { temp: 25.0 } },
        ];

        const records = encodeRecords(original, content);
        const filePath = path.join(tmpDir, 'scale.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const decoded = decodeAllRecords(parsed, metadata);

        // int16 roundtrip: 25.0 → raw=(25+40)/0.01=6500 → decode=6500*0.01-40=25.0
        expect(decoded[0].values['temp']).toBeCloseTo(25.0, 1);
    });
});

describe('data type roundtrip', () => {
    const testCases: Array<{ type: string; value: number; tolerance: number }> = [
        { type: 'uint8_t',  value: 200,       tolerance: 0 },
        { type: 'int8_t',   value: -50,        tolerance: 0 },
        { type: 'uint16_t', value: 50000,      tolerance: 0 },
        { type: 'int16_t',  value: -10000,     tolerance: 0 },
        { type: 'uint32_t', value: 3000000000,  tolerance: 0 },
        { type: 'int32_t',  value: -100000,    tolerance: 0 },
        { type: 'float',    value: 3.14159,    tolerance: 0.001 },
        { type: 'double',   value: 3.141592653589793, tolerance: 1e-10 },
    ];

    for (const tc of testCases) {
        it(`roundtrips ${tc.type} (value=${tc.value})`, () => {
            const content: SdsContentValue[] = [{ value: 'v', type: tc.type as any }];
            const metadata: SdsMetadata = {
                sds: { name: 'T', frequency: 1, content },
            };
            const samples: SdsDecodedSample[] = [
                { timestamp: 0, timeSeconds: 0, values: { v: tc.value } },
            ];

            const records = encodeRecords(samples, content);
            const filePath = path.join(tmpDir, `type-${tc.type}.0.sds`);
            writeSdsFile(filePath, records);
            const parsed = parseSdsFile(filePath);
            const decoded = decodeAllRecords(parsed, metadata);

            expect(decoded[0].values['v']).toBeCloseTo(tc.value, -Math.log10(tc.tolerance || 1));
        });
    }
});

describe('getSdsFileStats', () => {
    it('returns zeros for empty file', () => {
        const filePath = path.join(tmpDir, 'empty.0.sds');
        writeSdsFile(filePath, []);
        const parsed = parseSdsFile(filePath);
        const stats = getSdsFileStats(parsed);
        expect(stats.totalRecords).toBe(0);
        expect(stats.fileSize).toBe(0);
    });

    it('computes correct stats', () => {
        const records = [
            makeRecord(0, [1.0, 2.0]),      // 8 bytes data
            makeRecord(100, [3.0, 4.0, 5.0]), // 12 bytes data
            makeRecord(200, [6.0]),            // 4 bytes data
        ];
        const filePath = path.join(tmpDir, 'stats.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const stats = getSdsFileStats(parsed);

        expect(stats.totalRecords).toBe(3);
        expect(stats.minBlockSize).toBe(4);
        expect(stats.maxBlockSize).toBe(12);
        expect(stats.recordingTimeSeconds).toBeCloseTo(0.2); // 200ms / 1000
    });
});

describe('metadata YAML roundtrip', () => {
    it('writes and reads back sensor metadata', () => {
        const original = make3AxisMetadata('Gyro', 200);
        original.sds.description = 'Test gyroscope';
        original.sds['tick-frequency'] = 32768;

        const filePath = path.join(tmpDir, 'Gyro.sds.yml');
        writeMetadataFile(filePath, original);
        const parsed = parseMetadataFile(filePath);

        expect(parsed.sds.name).toBe('Gyro');
        expect(parsed.sds.description).toBe('Test gyroscope');
        expect(parsed.sds.frequency).toBe(200);
        expect(parsed.sds['tick-frequency']).toBe(32768);
        expect(parsed.sds.content.length).toBe(3);
        expect(parsed.sds.content[0].value).toBe('x');
        expect(parsed.sds.content[0].type).toBe('float');
        expect(parsed.sds.content[0].unit).toBe('mG');
    });

    it('roundtrips image metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Camera',
                frequency: 30,
                content: [{
                    value: 'frame',
                    type: 'uint8_t',
                    image: { pixel_format: 'RGB888', width: 320, height: 240 },
                }],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].image).toBeDefined();
        expect(parsed.sds.content[0].image!.pixel_format).toBe('RGB888');
        expect(parsed.sds.content[0].image!.width).toBe(320);
        expect(parsed.sds.content[0].image!.height).toBe(240);
    });

    it('roundtrips audio metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Mic',
                frequency: 1,
                content: [{
                    value: 'audio',
                    type: 'int16_t',
                    audio: { sample_rate: 16000, bit_depth: 16, audio_channels: 1 },
                }],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].audio).toBeDefined();
        expect(parsed.sds.content[0].audio!.sample_rate).toBe(16000);
        expect(parsed.sds.content[0].audio!.bit_depth).toBe(16);
        expect(parsed.sds.content[0].audio!.audio_channels).toBe(1);
    });

    it('roundtrips video metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Video',
                frequency: 30,
                content: [{
                    value: 'frame',
                    type: 'uint8_t',
                    video: { pixel_format: 'NV12', width: 640, height: 480, fps: 30 },
                }],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].video).toBeDefined();
        expect(parsed.sds.content[0].video!.pixel_format).toBe('NV12');
        expect(parsed.sds.content[0].video!.width).toBe(640);
        expect(parsed.sds.content[0].video!.fps).toBe(30);
    });

    it('handles scale and offset in metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Scaled',
                frequency: 10,
                content: [
                    { value: 'temp', type: 'int16_t', scale: 0.01, offset: -40, unit: 'C' },
                ],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].scale).toBe(0.01);
        expect(parsed.sds.content[0].offset).toBe(-40);
    });
});

describe('CSV export / import roundtrip', () => {
    it('exports and imports back identical data', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const metadata: SdsMetadata = {
            sds: { name: 'Test', frequency: 100, content },
        };

        const samples: SdsDecodedSample[] = [
            { timestamp: 0, timeSeconds: 0, values: { x: 1.5, y: 2.5 } },
            { timestamp: 10, timeSeconds: 0.01, values: { x: 3.0, y: 4.0 } },
        ];

        const csvPath = path.join(tmpDir, 'export.csv');
        exportToCsv(samples, content, csvPath);

        expect(fs.existsSync(csvPath)).toBe(true);
        const csvText = fs.readFileSync(csvPath, 'utf-8');
        expect(csvText).toContain('timestamp_s,x,y');

        const imported = importFromCsv(csvPath, 'Test', 100, 'float');
        expect(imported.records.length).toBe(2);
        expect(imported.metadata.sds.content.length).toBe(2);
        expect(imported.metadata.sds.content[0].value).toBe('x');
    });

    it('writes empty CSV for no samples', () => {
        const csvPath = path.join(tmpDir, 'empty.csv');
        exportToCsv([], [], csvPath);
        const text = fs.readFileSync(csvPath, 'utf-8');
        expect(text).toBe('');
    });
});

describe('findNextFileIndex', () => {
    it('returns 0 for empty directory', () => {
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(0);
    });

    it('returns 0 for non-existent directory', () => {
        expect(findNextFileIndex(path.join(tmpDir, 'nope'), 'Accel')).toBe(0);
    });

    it('returns next index after existing files', () => {
        fs.writeFileSync(path.join(tmpDir, 'Accel.0.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Accel.1.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Accel.2.sds'), '');
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(3);
    });

    it('handles gaps (returns max+1)', () => {
        fs.writeFileSync(path.join(tmpDir, 'Accel.0.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Accel.5.sds'), '');
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(6);
    });

    it('ignores files with different stream names', () => {
        fs.writeFileSync(path.join(tmpDir, 'Gyro.0.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Gyro.3.sds'), '');
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(0);
    });

    it('handles special regex characters in stream name', () => {
        fs.writeFileSync(path.join(tmpDir, 'My.Sensor.0.sds'), '');
        expect(findNextFileIndex(tmpDir, 'My.Sensor')).toBe(1);
    });
});
