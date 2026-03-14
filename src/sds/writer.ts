/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Binary File Writer
 *
 * Writes .sds binary files according to the SDS Framework specification.
 * Also provides YAML metadata file creation and CSV export/import.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    SdsRecord,
    SdsMetadata,
    SdsContentValue,
    SdsDataType,
    SdsDecodedSample,
    sdsDataTypeSize,
    SDS_METADATA_EXTENSION,
    SdsImageMeta,
    SdsAudioMeta,
    SdsVideoMeta,
} from './types';

/**
 * Write a value to a buffer at the given offset according to data type.
 */
function writeValue(buf: Buffer, offset: number, value: number, type: SdsDataType): void {
    switch (type) {
        case 'uint8_t':
            buf.writeUInt8(Math.max(0, Math.min(255, Math.round(value))), offset);
            break;
        case 'int8_t':
            buf.writeInt8(Math.max(-128, Math.min(127, Math.round(value))), offset);
            break;
        case 'uint16_t':
            buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(value))), offset);
            break;
        case 'int16_t':
            buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), offset);
            break;
        case 'uint32_t':
            buf.writeUInt32LE(Math.max(0, Math.round(value)) >>> 0, offset);
            break;
        case 'int32_t':
            buf.writeInt32LE(Math.round(value), offset);
            break;
        case 'float':
            buf.writeFloatLE(value, offset);
            break;
        case 'double':
            buf.writeDoubleLE(value, offset);
            break;
    }
}

/**
 * Write a set of SDS records to a binary file.
 */
export function writeSdsFile(filePath: string, records: SdsRecord[]): void {
    // Calculate total buffer size
    let totalSize = 0;
    for (const rec of records) {
        totalSize += 8 + rec.dataSize; // header (8 bytes) + data
    }

    const buffer = Buffer.alloc(totalSize);
    let offset = 0;

    for (const rec of records) {
        buffer.writeUInt32LE(rec.timestamp, offset);
        buffer.writeUInt32LE(rec.dataSize, offset + 4);
        rec.data.copy(buffer, offset + 8);
        offset += 8 + rec.dataSize;
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);
}

/**
 * Create SDS records from decoded samples and metadata.
 */
export function encodeRecords(
    samples: SdsDecodedSample[],
    content: SdsContentValue[],
    tickFrequency: number = 1000
): SdsRecord[] {
    const records: SdsRecord[] = [];

    // Calculate frame size
    let frameSize = 0;
    for (const ch of content) {
        const baseType = ch.type.split(':')[0] as SdsDataType;
        frameSize += sdsDataTypeSize(baseType);
    }

    for (const sample of samples) {
        const data = Buffer.alloc(frameSize);
        let byteOffset = 0;

        for (const ch of content) {
            const baseType = ch.type.split(':')[0] as SdsDataType;
            const typeSize = sdsDataTypeSize(baseType);
            const rawValue = sample.values[ch.value] ?? 0;

            // Reverse scale and offset: raw = (value - offset) / scale
            const scale = ch.scale ?? 1.0;
            const offset = ch.offset ?? 0;
            const encodedValue = scale !== 0 ? (rawValue - offset) / scale : 0;

            writeValue(data, byteOffset, encodedValue, baseType);
            byteOffset += typeSize;
        }

        records.push({
            timestamp: sample.timestamp,
            dataSize: frameSize,
            data,
        });
    }

    return records;
}

/**
 * Write an SDS YAML metadata file.
 * Supports image, audio, and video metadata blocks.
 */
export function writeMetadataFile(filePath: string, metadata: SdsMetadata): void {
    const yaml = serializeMetadataToYaml(metadata);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, yaml, 'utf-8');
}

/**
 * Serialize SdsMetadata to a YAML string.
 */
export function serializeMetadataToYaml(metadata: SdsMetadata): string {
    const sds = metadata.sds;
    let yaml = `sds:
`;
    yaml += `  name: ${sds.name}
`;
    if (sds.description) {
        yaml += `  description: ${sds.description}
`;
    }
    yaml += `  frequency: ${sds.frequency}
`;
    if (sds['tick-frequency'] !== undefined) {
        yaml += `  tick-frequency: ${sds['tick-frequency']}
`;
    }
    yaml += `  content:
`;

    for (const ch of sds.content) {
        yaml += `  - value: ${ch.value}
`;
        yaml += `    type: ${ch.type}
`;
        if (ch.offset !== undefined && ch.offset !== 0) {
            yaml += `    offset: ${ch.offset}
`;
        }
        if (ch.scale !== undefined && ch.scale !== 1.0) {
            yaml += `    scale: ${ch.scale}
`;
        }
        if (ch.unit) {
            yaml += `    unit: ${ch.unit}
`;
        }
        // Image metadata block
        if (ch.image) {
            yaml += `    image:
`;
            yaml += `      pixel_format: ${ch.image.pixel_format}
`;
            yaml += `      width: ${ch.image.width}
`;
            yaml += `      height: ${ch.image.height}
`;
            if (ch.image.stride_bytes !== undefined) {
                yaml += `      stride_bytes: ${ch.image.stride_bytes}
`;
            }
        }
        // Audio metadata block
        if (ch.audio) {
            yaml += `    audio:
`;
            yaml += `      sample_rate: ${ch.audio.sample_rate}
`;
            yaml += `      bit_depth: ${ch.audio.bit_depth}
`;
            yaml += `      audio_channels: ${ch.audio.audio_channels}
`;
            if (ch.audio.codec) {
                yaml += `      codec: ${ch.audio.codec}
`;
            }
            if (ch.audio.frame_size !== undefined) {
                yaml += `      frame_size: ${ch.audio.frame_size}
`;
            }
        }
        // Video metadata block
        if (ch.video) {
            yaml += `    video:
`;
            yaml += `      pixel_format: ${ch.video.pixel_format}
`;
            yaml += `      width: ${ch.video.width}
`;
            yaml += `      height: ${ch.video.height}
`;
            yaml += `      fps: ${ch.video.fps}
`;
            if (ch.video.codec) {
                yaml += `      codec: ${ch.video.codec}
`;
            }
            if (ch.video.stride_bytes !== undefined) {
                yaml += `      stride_bytes: ${ch.video.stride_bytes}
`;
            }
            if (ch.video.keyframe_interval !== undefined) {
                yaml += `      keyframe_interval: ${ch.video.keyframe_interval}
`;
            }
        }
    }
    return yaml;
}

/**
 * Parse an SDS YAML metadata file (simple parser, no YAML library dependency).
 */
export function parseMetadataFile(filePath: string): SdsMetadata {
    const text = fs.readFileSync(filePath, 'utf-8');
    return parseMetadataString(text);
}

/**
 * Parse YAML metadata from a string.
 * Supports nested image, audio, and video metadata blocks.
 */
export function parseMetadataString(text: string): SdsMetadata {
    const lines = text.split('\n');
    const metadata: SdsMetadata = {
        sds: {
            name: '',
            frequency: 0,
            content: [],
        },
    };

    let currentContent: SdsContentValue | null = null;
    let inContent = false;
    let inImage = false;
    let inAudio = false;
    let inVideo = false;

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }

        // Detect indentation level (number of leading spaces)
        const indent = line.length - line.trimStart().length;

        // Check for content array
        if (trimmed === 'content:') {
            inContent = true;
            inImage = false;
            inAudio = false;
            inVideo = false;
            continue;
        }

        if (inContent) {
            // New content item (starts with "- value:")
            if (trimmed.startsWith('- value:')) {
                if (currentContent) {
                    metadata.sds.content.push(currentContent);
                }
                currentContent = {
                    value: extractYamlValue(trimmed.replace('- value:', '').trim()),
                    type: 'float',
                };
                inImage = false;
                inAudio = false;
                inVideo = false;
                continue;
            }

            if (currentContent) {
                // Entering sub-blocks
                if (trimmed === 'image:') {
                    inImage = true;
                    inAudio = false;
                    inVideo = false;
                    currentContent.image = { pixel_format: 'RGB888', width: 0, height: 0 };
                    continue;
                }
                if (trimmed === 'audio:') {
                    inAudio = true;
                    inImage = false;
                    inVideo = false;
                    currentContent.audio = { sample_rate: 0, bit_depth: 16, audio_channels: 1 };
                    continue;
                }
                if (trimmed === 'video:') {
                    inVideo = true;
                    inImage = false;
                    inAudio = false;
                    currentContent.video = { pixel_format: 'RGB888', width: 0, height: 0, fps: 0 };
                    continue;
                }

                // Parse image sub-fields
                if (inImage && currentContent.image) {
                    if (trimmed.startsWith('pixel_format:')) {
                        currentContent.image.pixel_format = extractYamlValue(trimmed.replace('pixel_format:', '').trim()) as any;
                    } else if (trimmed.startsWith('width:')) {
                        currentContent.image.width = parseInt(trimmed.replace('width:', '').trim(), 10);
                    } else if (trimmed.startsWith('height:')) {
                        currentContent.image.height = parseInt(trimmed.replace('height:', '').trim(), 10);
                    } else if (trimmed.startsWith('stride_bytes:')) {
                        currentContent.image.stride_bytes = parseInt(trimmed.replace('stride_bytes:', '').trim(), 10);
                    }
                    continue;
                }

                // Parse audio sub-fields
                if (inAudio && currentContent.audio) {
                    if (trimmed.startsWith('sample_rate:')) {
                        currentContent.audio.sample_rate = parseInt(trimmed.replace('sample_rate:', '').trim(), 10);
                    } else if (trimmed.startsWith('bit_depth:')) {
                        currentContent.audio.bit_depth = parseInt(trimmed.replace('bit_depth:', '').trim(), 10);
                    } else if (trimmed.startsWith('audio_channels:')) {
                        currentContent.audio.audio_channels = parseInt(trimmed.replace('audio_channels:', '').trim(), 10);
                    } else if (trimmed.startsWith('codec:')) {
                        currentContent.audio.codec = extractYamlValue(trimmed.replace('codec:', '').trim());
                    } else if (trimmed.startsWith('frame_size:')) {
                        currentContent.audio.frame_size = parseInt(trimmed.replace('frame_size:', '').trim(), 10);
                    }
                    continue;
                }

                // Parse video sub-fields
                if (inVideo && currentContent.video) {
                    if (trimmed.startsWith('pixel_format:')) {
                        currentContent.video.pixel_format = extractYamlValue(trimmed.replace('pixel_format:', '').trim()) as any;
                    } else if (trimmed.startsWith('width:')) {
                        currentContent.video.width = parseInt(trimmed.replace('width:', '').trim(), 10);
                    } else if (trimmed.startsWith('height:')) {
                        currentContent.video.height = parseInt(trimmed.replace('height:', '').trim(), 10);
                    } else if (trimmed.startsWith('fps:')) {
                        currentContent.video.fps = parseFloat(trimmed.replace('fps:', '').trim());
                    } else if (trimmed.startsWith('codec:')) {
                        currentContent.video.codec = extractYamlValue(trimmed.replace('codec:', '').trim());
                    } else if (trimmed.startsWith('stride_bytes:')) {
                        currentContent.video.stride_bytes = parseInt(trimmed.replace('stride_bytes:', '').trim(), 10);
                    } else if (trimmed.startsWith('keyframe_interval:')) {
                        currentContent.video.keyframe_interval = parseInt(trimmed.replace('keyframe_interval:', '').trim(), 10);
                    }
                    continue;
                }

                // Standard content value fields (not in a sub-block)
                if (trimmed.startsWith('type:')) {
                    currentContent.type = extractYamlValue(trimmed.replace('type:', '').trim()) as SdsDataType;
                    inImage = false; inAudio = false; inVideo = false;
                } else if (trimmed.startsWith('offset:')) {
                    currentContent.offset = parseFloat(trimmed.replace('offset:', '').trim());
                    inImage = false; inAudio = false; inVideo = false;
                } else if (trimmed.startsWith('scale:')) {
                    currentContent.scale = parseFloat(trimmed.replace('scale:', '').trim());
                    inImage = false; inAudio = false; inVideo = false;
                } else if (trimmed.startsWith('unit:')) {
                    currentContent.unit = extractYamlValue(trimmed.replace('unit:', '').trim());
                    inImage = false; inAudio = false; inVideo = false;
                }
                continue;
            }
        }

        // Top-level sds properties
        if (trimmed.startsWith('name:')) {
            metadata.sds.name = extractYamlValue(trimmed.replace('name:', '').trim());
        } else if (trimmed.startsWith('description:')) {
            metadata.sds.description = extractYamlValue(trimmed.replace('description:', '').trim());
        } else if (trimmed.startsWith('frequency:')) {
            metadata.sds.frequency = parseFloat(trimmed.replace('frequency:', '').trim());
        } else if (trimmed.startsWith('tick-frequency:')) {
            metadata.sds['tick-frequency'] = parseFloat(trimmed.replace('tick-frequency:', '').trim());
        }
    }

    // Push last content item
    if (currentContent) {
        metadata.sds.content.push(currentContent);
    }

    return metadata;
}

function extractYamlValue(val: string): string {
    // Remove quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
        return val.slice(1, -1);
    }
    return val;
}

/**
 * Export decoded SDS samples to CSV format.
 */
export function exportToCsv(
    samples: SdsDecodedSample[],
    content: SdsContentValue[],
    outputPath: string,
    normalize: boolean = true
): void {
    if (samples.length === 0) {
        fs.writeFileSync(outputPath, '', 'utf-8');
        return;
    }

    const channelNames = content.map(c => c.value);
    const header = ['timestamp_s', ...channelNames].join(',');
    const startTime = normalize ? samples[0].timeSeconds : 0;

    const rows = samples.map(s => {
        const t = (s.timeSeconds - startTime).toFixed(6);
        const vals = channelNames.map(name => {
            const v = s.values[name];
            return v !== undefined ? v.toFixed(6) : '0';
        });
        return [t, ...vals].join(',');
    });

    const csv = [header, ...rows].join('\n') + '\n';
    fs.writeFileSync(outputPath, csv, 'utf-8');
}

/**
 * Import CSV data and create SDS records + metadata.
 * Expects CSV with header row: timestamp_s, ch1, ch2, ...
 */
export function importFromCsv(
    csvPath: string,
    streamName: string,
    frequency: number,
    dataType: SdsDataType = 'float',
    tickFrequency: number = 1000
): { records: SdsRecord[]; metadata: SdsMetadata } {
    const text = fs.readFileSync(csvPath, 'utf-8');
    const lines = text.trim().split('\n');

    if (lines.length < 2) {
        throw new Error('CSV file must contain at least a header row and one data row');
    }

    const headerParts = lines[0].split(',').map(h => h.trim());
    const channelNames = headerParts.slice(1); // skip timestamp column

    const content: SdsContentValue[] = channelNames.map(name => ({
        value: name,
        type: dataType,
    }));

    const metadata: SdsMetadata = {
        sds: {
            name: streamName,
            frequency,
            content,
        },
    };

    const samples: SdsDecodedSample[] = [];

    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        if (parts.length < 2) { continue; }

        const timeSeconds = parseFloat(parts[0]);
        const timestamp = Math.round(timeSeconds * tickFrequency);
        const values: { [key: string]: number } = {};

        for (let j = 0; j < channelNames.length && j + 1 < parts.length; j++) {
            values[channelNames[j]] = parseFloat(parts[j + 1]) || 0;
        }

        samples.push({ timestamp, timeSeconds, values });
    }

    const records = encodeRecords(samples, content, tickFrequency);

    return { records, metadata };
}

/**
 * Find the next available file index for a given stream name in a directory.
 * Follows the SDS naming convention: <name>.<index>.sds
 */
export function findNextFileIndex(directory: string, streamName: string): number {
    if (!fs.existsSync(directory)) {
        return 0;
    }

    const files = fs.readdirSync(directory);
    const pattern = new RegExp(`^${escapeRegex(streamName)}\\.(\\d+)\\.sds$`);
    let maxIndex = -1;

    for (const file of files) {
        const match = file.match(pattern);
        if (match) {
            const idx = parseInt(match[1], 10);
            if (idx > maxIndex) {
                maxIndex = idx;
            }
        }
    }

    return maxIndex + 1;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
