#!/usr/bin/env npx ts-node
/*
 * Generate a test project with all kinds of SDS data forms.
 *
 * Usage:  npx ts-node test/generate-test-project.ts [output-dir]
 * Default output: test/fixtures/sample-project/
 *
 * Creates:
 *   Sensor data:
 *     accelerometer.*     — 3-axis int16 + scale/offset/unit (100 Hz)
 *     temperature.*       — single float channel (1 Hz)
 *     gyroscope.*         — 3-axis float (200 Hz)
 *     adc_raw.*           — single uint16 channel (1000 Hz)
 *     precision.*         — single double channel with custom tick-frequency
 *     gpio.*              — single uint8 channel (10 Hz)
 *     counter.*           — single uint32 channel (50 Hz)
 *     multi_frame.*       — multiple frames packed per record
 *
 *   Image data:
 *     camera_rgb888.*     — RGB888 8x8 image (1 fps)
 *     camera_raw8.*       — RAW8 grayscale 16x16 (2 fps)
 *     camera_rgb565.*     — RGB565 8x8 (1 fps)
 *     camera_nv12.*       — NV12 YUV 8x8 (1 fps)
 *
 *   Audio data:
 *     mic_16bit.*         — 16-bit mono PCM (16000 Hz, 10 fps blocks)
 *     mic_stereo.*        — 16-bit stereo PCM (44100 Hz, 10 fps blocks)
 *
 *   Video data:
 *     video_raw.*         — raw RGB888 4x4 video (10 fps)
 *
 *   Edge cases:
 *     empty.*             — valid metadata, zero records
 *     single_record.*     — only 1 record
 *     large_block.*       — few records with large payloads
 *     no_metadata.0.sds   — .sds file without metadata
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    SdsRecord,
    SdsMetadata,
} from '../src/sds/types';
import { writeSdsFile, writeMetadataFile } from '../src/sds/writer';

// ── Output directory ─────────────────────────────────────────

const outDir = process.argv[2] || path.join(__dirname, 'fixtures', 'sample-project');

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

function writePair(name: string, index: number, metadata: SdsMetadata, records: SdsRecord[]): void {
    const sdsPath = path.join(outDir, `${name}.${index}.sds`);
    const ymlPath = path.join(outDir, `${name}.sds.yml`);
    writeSdsFile(sdsPath, records);
    writeMetadataFile(ymlPath, metadata);
    console.log(`  ${name}.${index}.sds  (${records.length} records, ${metadata.sds.content.length} ch)`);
}

console.log(`Generating test project in: ${outDir}\n`);

// ════════════════════════════════════════════════════════════
//  SENSOR DATA
// ════════════════════════════════════════════════════════════

// ── Accelerometer: 3-axis int16, scale/offset/unit, 100 Hz ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'accelerometer',
            description: '3-axis MEMS accelerometer',
            frequency: 100,
            content: [
                { value: 'x', type: 'int16_t', scale: 0.001, offset: 0, unit: 'G' },
                { value: 'y', type: 'int16_t', scale: 0.001, offset: 0, unit: 'G' },
                { value: 'z', type: 'int16_t', scale: 0.001, offset: 0, unit: 'G' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 500; i++) {
        const t = i / 100;
        const data = Buffer.alloc(6);
        data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * t) * 1000), 0);
        data.writeInt16LE(Math.round(Math.cos(2 * Math.PI * t) * 1000), 2);
        data.writeInt16LE(Math.round(980 + Math.sin(4 * Math.PI * t) * 20), 4);
        records.push({ timestamp: i * 10, dataSize: 6, data });
    }
    writePair('accelerometer', 0, metadata, records);
}

// ── Temperature: single float, 1 Hz ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'temperature',
            description: 'Ambient temperature sensor',
            frequency: 1,
            content: [
                { value: 'temp', type: 'float', unit: 'degC' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 60; i++) {
        const data = Buffer.alloc(4);
        data.writeFloatLE(22.5 + Math.sin(i / 10) * 3 + (Math.random() - 0.5) * 0.2);
        records.push({ timestamp: i * 1000, dataSize: 4, data });
    }
    writePair('temperature', 0, metadata, records);
}

// ── Gyroscope: 3-axis float, 200 Hz ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'gyroscope',
            description: '3-axis MEMS gyroscope',
            frequency: 200,
            content: [
                { value: 'wx', type: 'float', unit: 'dps' },
                { value: 'wy', type: 'float', unit: 'dps' },
                { value: 'wz', type: 'float', unit: 'dps' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 1000; i++) {
        const t = i / 200;
        const data = Buffer.alloc(12);
        data.writeFloatLE(Math.sin(2 * Math.PI * 0.5 * t) * 250, 0);
        data.writeFloatLE(Math.cos(2 * Math.PI * 0.3 * t) * 180, 4);
        data.writeFloatLE(Math.sin(2 * Math.PI * 0.1 * t) * 50 + (Math.random() - 0.5) * 10, 8);
        records.push({ timestamp: i * 5, dataSize: 12, data });
    }
    writePair('gyroscope', 0, metadata, records);
}

// ── ADC raw: single uint16, 1000 Hz ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'adc_raw',
            description: 'Raw ADC channel',
            frequency: 1000,
            content: [
                { value: 'adc', type: 'uint16_t' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 2000; i++) {
        const data = Buffer.alloc(2);
        data.writeUInt16LE(Math.round(2048 + Math.sin(2 * Math.PI * i / 100) * 1500 + (Math.random() - 0.5) * 100));
        records.push({ timestamp: i, dataSize: 2, data });
    }
    writePair('adc_raw', 0, metadata, records);
}

// ── Precision: double, custom tick-frequency ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'precision',
            description: 'High-precision measurement with custom tick-frequency',
            frequency: 10,
            'tick-frequency': 1000000,
            content: [
                { value: 'measurement', type: 'double', unit: 'V' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 100; i++) {
        const data = Buffer.alloc(8);
        data.writeDoubleLE(3.3 + Math.sin(2 * Math.PI * i / 50) * 0.001);
        records.push({ timestamp: i * 100000, dataSize: 8, data });
    }
    writePair('precision', 0, metadata, records);
}

// ── GPIO: uint8, 10 Hz ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'gpio',
            description: 'Digital GPIO state',
            frequency: 10,
            content: [
                { value: 'state', type: 'uint8_t' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 100; i++) {
        const data = Buffer.alloc(1);
        data.writeUInt8(i % 3 === 0 ? 1 : 0);
        records.push({ timestamp: i * 100, dataSize: 1, data });
    }
    writePair('gpio', 0, metadata, records);
}

// ── Counter: uint32, 50 Hz ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'counter',
            description: 'Hardware event counter',
            frequency: 50,
            content: [
                { value: 'count', type: 'uint32_t' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    let count = 0;
    for (let i = 0; i < 250; i++) {
        count += Math.floor(Math.random() * 5);
        const data = Buffer.alloc(4);
        data.writeUInt32LE(count);
        records.push({ timestamp: i * 20, dataSize: 4, data });
    }
    writePair('counter', 0, metadata, records);
}

// ── Multi-frame: multiple samples packed per record ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'multi_frame',
            description: 'Sensor with multiple frames per record',
            frequency: 100,
            content: [
                { value: 'ch1', type: 'int32_t' },
                { value: 'ch2', type: 'int32_t' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    const framesPerRecord = 10;
    const frameSize = 8; // 2 * int32
    for (let r = 0; r < 50; r++) {
        const data = Buffer.alloc(framesPerRecord * frameSize);
        for (let f = 0; f < framesPerRecord; f++) {
            const idx = r * framesPerRecord + f;
            data.writeInt32LE(Math.round(Math.sin(idx / 10) * 100000), f * frameSize);
            data.writeInt32LE(Math.round(Math.cos(idx / 10) * 100000), f * frameSize + 4);
        }
        records.push({ timestamp: r * 100, dataSize: framesPerRecord * frameSize, data });
    }
    writePair('multi_frame', 0, metadata, records);
}

// ════════════════════════════════════════════════════════════
//  IMAGE DATA
// ════════════════════════════════════════════════════════════

// ── Camera RGB888: 160x120, 1 fps ──
{
    const W = 160, H = 120;
    const metadata: SdsMetadata = {
        sds: {
            name: 'camera_rgb888',
            description: 'RGB888 test pattern',
            frequency: 1,
            content: [{
                value: 'frame',
                type: 'uint8_t',
                image: { pixel_format: 'RGB888', width: W, height: H },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let f = 0; f < 5; f++) {
        const data = Buffer.alloc(W * H * 3);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 3;
                // Color bars pattern that shifts per frame
                const bar = Math.floor(((x + f * 20) % W) / (W / 8));
                data[i + 0] = (bar & 1) ? 255 : 0;        // R
                data[i + 1] = (bar & 2) ? 255 : 0;        // G
                data[i + 2] = (bar & 4) ? 255 : 0;        // B
                // Add vertical gradient for visual interest
                const fade = Math.round(y / H * 128);
                data[i + 0] = Math.min(255, data[i + 0] + fade);
                data[i + 1] = Math.min(255, data[i + 1] + fade);
                data[i + 2] = Math.min(255, data[i + 2] + fade);
            }
        }
        records.push({ timestamp: f * 1000, dataSize: data.length, data });
    }
    writePair('camera_rgb888', 0, metadata, records);
}

// ── Camera RAW8: 128x96 grayscale, 2 fps ──
{
    const W = 128, H = 96;
    const metadata: SdsMetadata = {
        sds: {
            name: 'camera_raw8',
            description: 'RAW8 grayscale test pattern',
            frequency: 2,
            content: [{
                value: 'frame',
                type: 'uint8_t',
                image: { pixel_format: 'RAW8', width: W, height: H },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let f = 0; f < 10; f++) {
        const data = Buffer.alloc(W * H);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                // Circular gradient from center, pulsing with frame index
                const dx = x - W / 2, dy = y - H / 2;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const maxDist = Math.sqrt((W / 2) ** 2 + (H / 2) ** 2);
                const bright = (1 - dist / maxDist) * 255 * (0.5 + 0.5 * Math.sin(f * 0.6));
                data[y * W + x] = Math.max(0, Math.min(255, Math.round(bright)));
            }
        }
        records.push({ timestamp: f * 500, dataSize: data.length, data });
    }
    writePair('camera_raw8', 0, metadata, records);
}

// ── Camera RGB565: 128x96, 1 fps ──
{
    const W = 128, H = 96;
    const metadata: SdsMetadata = {
        sds: {
            name: 'camera_rgb565',
            description: 'RGB565 test pattern',
            frequency: 1,
            content: [{
                value: 'frame',
                type: 'uint8_t',
                image: { pixel_format: 'RGB565', width: W, height: H },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let f = 0; f < 3; f++) {
        const data = Buffer.alloc(W * H * 2);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                // Color ramp: R varies with x, G with y, B with diagonal
                const r5 = Math.round((x / W) * 31 + f * 5) & 0x1F;
                const g6 = Math.round((y / H) * 63 + f * 10) & 0x3F;
                const b5 = Math.round(((x + y) / (W + H)) * 31) & 0x1F;
                const pixel = (r5 << 11) | (g6 << 5) | b5;
                data.writeUInt16LE(pixel, (y * W + x) * 2);
            }
        }
        records.push({ timestamp: f * 1000, dataSize: data.length, data });
    }
    writePair('camera_rgb565', 0, metadata, records);
}

// ── Camera NV12: 128x96, 1 fps ──
{
    const W = 128, H = 96;
    const ySize = W * H;
    const uvSize = (W * H) / 2;
    const metadata: SdsMetadata = {
        sds: {
            name: 'camera_nv12',
            description: 'NV12 YUV test pattern',
            frequency: 1,
            content: [{
                value: 'frame',
                type: 'uint8_t',
                image: { pixel_format: 'NV12', width: W, height: H },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let f = 0; f < 3; f++) {
        const data = Buffer.alloc(ySize + uvSize);
        // Y plane: horizontal brightness gradient shifting per frame
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                data[y * W + x] = Math.min(235, Math.round(((x + f * 20) % W) / W * 200 + 16));
            }
        }
        // UV plane: interleaved U,V — color sweep
        for (let y = 0; y < H / 2; y++) {
            for (let x = 0; x < W / 2; x++) {
                const idx = ySize + y * W + x * 2;
                data[idx] = 128 + Math.round(Math.sin((f * 0.5) + x / 10) * 50);     // U
                data[idx + 1] = 128 + Math.round(Math.cos((f * 0.5) + y / 10) * 50); // V
            }
        }
        records.push({ timestamp: f * 1000, dataSize: data.length, data });
    }
    writePair('camera_nv12', 0, metadata, records);
}

// ════════════════════════════════════════════════════════════
//  AUDIO DATA
// ════════════════════════════════════════════════════════════

// ── Microphone 16-bit mono, 16000 Hz sample rate, 10 blocks/sec ──
{
    const sampleRate = 16000;
    const blocksPerSec = 10;
    const samplesPerBlock = sampleRate / blocksPerSec;
    const metadata: SdsMetadata = {
        sds: {
            name: 'mic_16bit',
            description: 'Mono 16-bit PCM microphone',
            frequency: blocksPerSec,
            content: [{
                value: 'audio',
                type: 'int16_t',
                audio: {
                    sample_rate: sampleRate,
                    bit_depth: 16,
                    audio_channels: 1,
                    codec: 'pcm',
                },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let b = 0; b < 30; b++) {
        const data = Buffer.alloc(samplesPerBlock * 2);
        for (let s = 0; s < samplesPerBlock; s++) {
            const t = (b * samplesPerBlock + s) / sampleRate;
            // 440 Hz sine (A4 note) + 880 Hz harmonic
            const val = Math.sin(2 * Math.PI * 440 * t) * 16000
                      + Math.sin(2 * Math.PI * 880 * t) * 4000
                      + (Math.random() - 0.5) * 500;
            data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(val))), s * 2);
        }
        records.push({ timestamp: b * 100, dataSize: data.length, data });
    }
    writePair('mic_16bit', 0, metadata, records);
}

// ── Stereo 16-bit, 44100 Hz, 10 blocks/sec ──
{
    const sampleRate = 44100;
    const blocksPerSec = 10;
    const samplesPerBlock = Math.floor(sampleRate / blocksPerSec);
    const channels = 2;
    const metadata: SdsMetadata = {
        sds: {
            name: 'mic_stereo',
            description: 'Stereo 16-bit PCM',
            frequency: blocksPerSec,
            content: [{
                value: 'audio',
                type: 'int16_t',
                audio: {
                    sample_rate: sampleRate,
                    bit_depth: 16,
                    audio_channels: channels,
                    codec: 'pcm',
                },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let b = 0; b < 10; b++) {
        const data = Buffer.alloc(samplesPerBlock * channels * 2);
        for (let s = 0; s < samplesPerBlock; s++) {
            const t = (b * samplesPerBlock + s) / sampleRate;
            // Left: 440 Hz, Right: 660 Hz (perfect fifth)
            const left = Math.sin(2 * Math.PI * 440 * t) * 20000;
            const right = Math.sin(2 * Math.PI * 660 * t) * 20000;
            data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left))), (s * channels) * 2);
            data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right))), (s * channels + 1) * 2);
        }
        records.push({ timestamp: b * 100, dataSize: data.length, data });
    }
    writePair('mic_stereo', 0, metadata, records);
}

// ════════════════════════════════════════════════════════════
//  VIDEO DATA
// ════════════════════════════════════════════════════════════

// ── Raw RGB888 video: 160x120, 10 fps ──
{
    const W = 160, H = 120;
    const metadata: SdsMetadata = {
        sds: {
            name: 'video_raw',
            description: 'Raw RGB888 video stream',
            frequency: 10,
            content: [{
                value: 'frame',
                type: 'uint8_t',
                video: {
                    pixel_format: 'RGB888',
                    width: W,
                    height: H,
                    fps: 10,
                    codec: 'raw',
                },
            }],
        },
    };
    const records: SdsRecord[] = [];
    for (let f = 0; f < 30; f++) {
        const data = Buffer.alloc(W * H * 3);
        // Moving bright spot with smooth falloff
        const cx = W / 2 + Math.cos(f * 0.3) * (W / 3);
        const cy = H / 2 + Math.sin(f * 0.3) * (H / 3);
        const radius = 30;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 3;
                const dx = x - cx, dy = y - cy;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const brightness = Math.max(0, Math.min(255, Math.round((1 - dist / radius) * 255)));
                data[i + 0] = brightness;
                data[i + 1] = Math.round(brightness * 0.7);
                data[i + 2] = Math.round(brightness * 0.3);
            }
        }
        records.push({ timestamp: f * 100, dataSize: data.length, data });
    }
    writePair('video_raw', 0, metadata, records);
}

// ════════════════════════════════════════════════════════════
//  EDGE CASES
// ════════════════════════════════════════════════════════════

// ── Empty: metadata but no records ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'empty',
            description: 'Empty recording — zero records',
            frequency: 100,
            content: [
                { value: 'x', type: 'float' },
                { value: 'y', type: 'float' },
            ],
        },
    };
    writePair('empty', 0, metadata, []);
}

// ── Single record ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'single_record',
            description: 'Recording with exactly one record',
            frequency: 100,
            content: [
                { value: 'value', type: 'float' },
            ],
        },
    };
    const data = Buffer.alloc(4);
    data.writeFloatLE(42.0);
    writePair('single_record', 0, metadata, [{ timestamp: 0, dataSize: 4, data }]);
}

// ── Large blocks: few records with big payloads ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'large_block',
            description: 'Large payload records (1 KB each)',
            frequency: 1,
            content: [
                { value: 'payload', type: 'uint8_t' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 5; i++) {
        const data = Buffer.alloc(1024);
        for (let j = 0; j < 1024; j++) {
            data[j] = (i * 37 + j) & 0xFF;
        }
        records.push({ timestamp: i * 1000, dataSize: 1024, data });
    }
    writePair('large_block', 0, metadata, records);
}

// ── No metadata: bare .sds file ──
{
    const records: SdsRecord[] = [];
    for (let i = 0; i < 20; i++) {
        const data = Buffer.alloc(8);
        data.writeFloatLE(Math.sin(i / 5) * 100, 0);
        data.writeFloatLE(Math.cos(i / 5) * 100, 4);
        records.push({ timestamp: i * 100, dataSize: 8, data });
    }
    const sdsPath = path.join(outDir, 'no_metadata.0.sds');
    writeSdsFile(sdsPath, records);
    console.log(`  no_metadata.0.sds  (${records.length} records, no .sds.yml)`);
}

// ── Multiple recordings of the same stream ──
{
    const metadata: SdsMetadata = {
        sds: {
            name: 'accelerometer',
            description: '3-axis MEMS accelerometer',
            frequency: 100,
            content: [
                { value: 'x', type: 'int16_t', scale: 0.001, offset: 0, unit: 'G' },
                { value: 'y', type: 'int16_t', scale: 0.001, offset: 0, unit: 'G' },
                { value: 'z', type: 'int16_t', scale: 0.001, offset: 0, unit: 'G' },
            ],
        },
    };
    const records: SdsRecord[] = [];
    for (let i = 0; i < 200; i++) {
        const t = i / 100;
        const data = Buffer.alloc(6);
        data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 2 * t) * 500), 0);
        data.writeInt16LE(Math.round(Math.cos(2 * Math.PI * 2 * t) * 500), 2);
        data.writeInt16LE(Math.round(980), 4);
        records.push({ timestamp: i * 10, dataSize: 6, data });
    }
    const sdsPath = path.join(outDir, 'accelerometer.1.sds');
    writeSdsFile(sdsPath, records);
    console.log(`  accelerometer.1.sds  (${records.length} records, shares metadata with .0)`);
}

console.log(`\nDone. ${fs.readdirSync(outDir).length} files generated.`);
