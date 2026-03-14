/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Binary File Parser
 *
 * Reads .sds binary files according to the SDS Framework specification.
 * File format: sequence of records, each containing:
 *   - timestamp  (uint32, little-endian)
 *   - data_size  (uint32, little-endian)
 *   - data       (data_size bytes of raw binary data)
 */

import * as fs from 'fs';
import {
    SdsRecord,
    SdsParsedFile,
    SdsDecodedSample,
    SdsDecodedFrame,
    SdsMetadata,
    SdsContentValue,
    SdsDataType,
    SdsMediaType,
    sdsDataTypeSize,
    sdsFrameSize,
    detectMediaType,
} from './types';

/** Record header size: timestamp (4 bytes) + data_size (4 bytes) */
const RECORD_HEADER_SIZE = 8;

/**
 * Parse an SDS binary file into memory.
 */
export function parseSdsFile(filePath: string): SdsParsedFile {
    const buffer = fs.readFileSync(filePath);
    return parseSdsBuffer(buffer, filePath);
}

/**
 * Parse an SDS binary buffer.
 */
export function parseSdsBuffer(buffer: Buffer, filePath: string = ''): SdsParsedFile {
    const records: SdsRecord[] = [];
    let offset = 0;
    let totalDataSize = 0;

    while (offset + RECORD_HEADER_SIZE <= buffer.length) {
        const timestamp = buffer.readUInt32LE(offset);
        const dataSize = buffer.readUInt32LE(offset + 4);
        offset += RECORD_HEADER_SIZE;

        if (offset + dataSize > buffer.length) {
            // Truncated record at end of file — skip
            break;
        }

        const data = Buffer.alloc(dataSize);
        buffer.copy(data, 0, offset, offset + dataSize);
        records.push({ timestamp, dataSize, data });
        totalDataSize += dataSize;
        offset += dataSize;
    }

    let durationMs = 0;
    if (records.length >= 2) {
        durationMs = records[records.length - 1].timestamp - records[0].timestamp;
    }

    return {
        filePath,
        records,
        totalDataSize,
        totalRecords: records.length,
        durationMs,
    };
}

/**
 * Read a single value from a buffer at the given offset, according to data type.
 */
function readValue(buf: Buffer, offset: number, type: SdsDataType): number {
    switch (type) {
        case 'uint8_t':
            return buf.readUInt8(offset);
        case 'int8_t':
            return buf.readInt8(offset);
        case 'uint16_t':
            return buf.readUInt16LE(offset);
        case 'int16_t':
            return buf.readInt16LE(offset);
        case 'uint32_t':
            return buf.readUInt32LE(offset);
        case 'int32_t':
            return buf.readInt32LE(offset);
        case 'float':
            return buf.readFloatLE(offset);
        case 'double':
            return buf.readDoubleLE(offset);
        default:
            return buf.readUInt32LE(offset);
    }
}

/**
 * Decode a single SDS record into channel values using metadata.
 */
export function decodeRecord(
    record: SdsRecord,
    content: SdsContentValue[],
    tickFrequency: number = 1000
): SdsDecodedSample {
    const values: { [channelName: string]: number } = {};
    let byteOffset = 0;

    for (const ch of content) {
        const baseType = ch.type.split(':')[0] as SdsDataType;
        const typeSize = sdsDataTypeSize(baseType);

        if (byteOffset + typeSize <= record.data.length) {
            const raw = readValue(record.data, byteOffset, baseType);
            const scale = ch.scale ?? 1.0;
            const offset = ch.offset ?? 0;
            values[ch.value] = raw * scale + offset;
        }
        byteOffset += typeSize;
    }

    const timeSeconds = record.timestamp / tickFrequency;

    return {
        timestamp: record.timestamp,
        timeSeconds,
        values,
    };
}

/**
 * Decode all records in a parsed file, extracting each frame's channel values.
 * When a record contains multiple frames, they are expanded into separate samples.
 */
export function decodeAllRecords(
    parsed: SdsParsedFile,
    metadata: SdsMetadata
): SdsDecodedSample[] {
    const content = metadata.sds.content;
    const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
    const frequency = metadata.sds.frequency;
    const frameBytes = sdsFrameSize(content);
    const samples: SdsDecodedSample[] = [];

    for (const record of parsed.records) {
        // A record may contain multiple frames
        const frameCount = frameBytes > 0 ? Math.floor(record.data.length / frameBytes) : 0;

        for (let f = 0; f < frameCount; f++) {
            const values: { [channelName: string]: number } = {};
            let byteOffset = f * frameBytes;

            for (const ch of content) {
                const baseType = ch.type.split(':')[0] as SdsDataType;
                const typeSize = sdsDataTypeSize(baseType);

                if (byteOffset + typeSize <= record.data.length) {
                    const raw = readValue(record.data, byteOffset, baseType);
                    const scale = ch.scale ?? 1.0;
                    const offset = ch.offset ?? 0;
                    values[ch.value] = raw * scale + offset;
                }
                byteOffset += typeSize;
            }

            // Calculate time: base timestamp + sub-frame offset
            const subFrameOffset = frameCount > 1 ? f / frequency : 0;
            const timeSeconds = record.timestamp / tickFreq + subFrameOffset;

            samples.push({
                timestamp: record.timestamp,
                timeSeconds,
                values,
            });
        }
    }

    return samples;
}

/**
 * Get summary statistics for a parsed SDS file.
 */
export function getSdsFileStats(parsed: SdsParsedFile, tickFrequency: number = 1000) {
    const records = parsed.records;
    if (records.length === 0) {
        return {
            fileSize: 0,
            totalRecords: 0,
            recordingTimeSeconds: 0,
            avgBlockSize: 0,
            minBlockSize: 0,
            maxBlockSize: 0,
            dataRate: 0,
        };
    }

    const sizes = records.map(r => r.dataSize);
    const totalData = sizes.reduce((a, b) => a + b, 0);
    const startTs = records[0].timestamp;
    const endTs = records[records.length - 1].timestamp;
    const durationTicks = endTs - startTs;
    const durationSec = durationTicks / tickFrequency;

    return {
        fileSize: parsed.totalDataSize + records.length * RECORD_HEADER_SIZE,
        totalRecords: records.length,
        recordingTimeSeconds: durationSec,
        recordingIntervalMs: records.length > 1
            ? durationTicks / (records.length - 1)
            : 0,
        avgBlockSize: Math.round(totalData / records.length),
        minBlockSize: sizes.reduce((a, b) => Math.min(a, b), Infinity),
        maxBlockSize: sizes.reduce((a, b) => Math.max(a, b), -Infinity),
        dataRate: durationSec > 0 ? Math.round(totalData / durationSec) : 0,
    };
}

/**
 * Decode records as raw media frames (image, video, audio).
 * Each record's data buffer is preserved as-is.
 */
export function decodeMediaFrames(
    parsed: SdsParsedFile,
    metadata: SdsMetadata
): SdsDecodedFrame[] {
    const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
    const mediaType = detectMediaType(metadata);
    const frames: SdsDecodedFrame[] = [];

    for (let i = 0; i < parsed.records.length; i++) {
        const record = parsed.records[i];
        frames.push({
            timestamp: record.timestamp,
            timeSeconds: record.timestamp / tickFreq,
            frameIndex: i,
            data: record.data,
            mediaType,
        });
    }

    return frames;
}

/**
 * Decode an image frame from raw pixel data to RGBA.
 * Returns a Uint8Array of width*height*4 bytes (RGBA8888).
 */
export function decodeImageFrameToRGBA(
    data: Buffer,
    width: number,
    height: number,
    pixelFormat: string
): Uint8Array {
    const rgba = new Uint8Array(width * height * 4);

    switch (pixelFormat) {
        case 'RGB888': {
            const expectedSize = width * height * 3;
            for (let i = 0; i < width * height; i++) {
                if (i * 3 + 2 < data.length) {
                    rgba[i * 4 + 0] = data[i * 3 + 0];
                    rgba[i * 4 + 1] = data[i * 3 + 1];
                    rgba[i * 4 + 2] = data[i * 3 + 2];
                }
                rgba[i * 4 + 3] = 255;
            }
            break;
        }
        case 'RAW8': {
            for (let i = 0; i < width * height && i < data.length; i++) {
                rgba[i * 4 + 0] = data[i];
                rgba[i * 4 + 1] = data[i];
                rgba[i * 4 + 2] = data[i];
                rgba[i * 4 + 3] = 255;
            }
            break;
        }
        case 'RGB565': {
            for (let i = 0; i < width * height && i * 2 + 1 < data.length; i++) {
                const pixel = data[i * 2] | (data[i * 2 + 1] << 8);
                rgba[i * 4 + 0] = ((pixel >> 11) & 0x1F) * 255 / 31;
                rgba[i * 4 + 1] = ((pixel >> 5) & 0x3F) * 255 / 63;
                rgba[i * 4 + 2] = (pixel & 0x1F) * 255 / 31;
                rgba[i * 4 + 3] = 255;
            }
            break;
        }
        case 'NV12':
        case 'NV21': {
            // Y plane = width*height bytes, UV plane = width*height/2 bytes interleaved
            const yPlaneSize = width * height;
            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    const yIdx = row * width + col;
                    const uvRow = Math.floor(row / 2);
                    const uvCol = Math.floor(col / 2);
                    const uvIdx = yPlaneSize + uvRow * width + uvCol * 2;

                    const y = yIdx < data.length ? data[yIdx] : 0;
                    let u: number, v: number;
                    if (pixelFormat === 'NV12') {
                        u = uvIdx < data.length ? data[uvIdx] : 128;
                        v = uvIdx + 1 < data.length ? data[uvIdx + 1] : 128;
                    } else {
                        v = uvIdx < data.length ? data[uvIdx] : 128;
                        u = uvIdx + 1 < data.length ? data[uvIdx + 1] : 128;
                    }

                    const pixelIdx = (row * width + col) * 4;
                    rgba[pixelIdx + 0] = clamp(y + 1.402 * (v - 128));
                    rgba[pixelIdx + 1] = clamp(y - 0.344136 * (u - 128) - 0.714136 * (v - 128));
                    rgba[pixelIdx + 2] = clamp(y + 1.772 * (u - 128));
                    rgba[pixelIdx + 3] = 255;
                }
            }
            break;
        }
        default: {
            // Fallback: treat as grayscale
            for (let i = 0; i < width * height && i < data.length; i++) {
                rgba[i * 4 + 0] = data[i];
                rgba[i * 4 + 1] = data[i];
                rgba[i * 4 + 2] = data[i];
                rgba[i * 4 + 3] = 255;
            }
            break;
        }
    }

    return rgba;
}

/**
 * Decode PCM audio data to float arrays (one per channel, values in -1..1).
 */
export function decodeAudioBlock(
    data: Buffer,
    sampleRate: number,
    bitDepth: number,
    audioChannels: number
): Float32Array[] {
    const bytesPerSample = Math.ceil(bitDepth / 8);
    const totalSamples = Math.floor(data.length / (bytesPerSample * audioChannels));
    const channels: Float32Array[] = [];

    for (let ch = 0; ch < audioChannels; ch++) {
        channels.push(new Float32Array(totalSamples));
    }

    for (let i = 0; i < totalSamples; i++) {
        for (let ch = 0; ch < audioChannels; ch++) {
            const offset = (i * audioChannels + ch) * bytesPerSample;
            let sample: number;

            switch (bitDepth) {
                case 8:
                    sample = (data.readUInt8(offset) - 128) / 128;
                    break;
                case 16:
                    sample = offset + 1 < data.length
                        ? data.readInt16LE(offset) / 32768
                        : 0;
                    break;
                case 24:
                    if (offset + 2 < data.length) {
                        const val = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
                        sample = (val > 0x7FFFFF ? val - 0x1000000 : val) / 8388608;
                    } else {
                        sample = 0;
                    }
                    break;
                case 32:
                    sample = offset + 3 < data.length
                        ? data.readFloatLE(offset)
                        : 0;
                    break;
                default:
                    sample = 0;
            }

            channels[ch][i] = sample;
        }
    }

    return channels;
}

/**
 * Streaming record iterator — yields records one at a time without loading all into memory.
 * Useful for large video/audio files.
 */
export function* parseSdsRecordIterator(filePath: string): Generator<SdsRecord & { recordIndex: number }> {
    const fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(RECORD_HEADER_SIZE);
    let position = 0;
    let index = 0;

    try {
        const fileSize = fs.fstatSync(fd).size;

        while (position + RECORD_HEADER_SIZE <= fileSize) {
            // Read record header
            const headerRead = fs.readSync(fd, headerBuf, 0, RECORD_HEADER_SIZE, position);
            if (headerRead < RECORD_HEADER_SIZE) { break; }

            const timestamp = headerBuf.readUInt32LE(0);
            const dataSize = headerBuf.readUInt32LE(4);
            position += RECORD_HEADER_SIZE;

            if (position + dataSize > fileSize) { break; }

            // Read record data
            const dataBuf = Buffer.alloc(dataSize);
            const dataRead = fs.readSync(fd, dataBuf, 0, dataSize, position);
            if (dataRead < dataSize) { break; }

            position += dataSize;
            yield { timestamp, dataSize, data: dataBuf, recordIndex: index };
            index++;
        }
    } finally {
        fs.closeSync(fd);
    }
}

function clamp(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}
