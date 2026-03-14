/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Arm SDS (Synchronous Data Stream) Type Definitions
 *
 * Based on the official SDS Framework specification:
 * https://arm-software.github.io/SDS-Framework/main/theory.html
 */

/** Supported SDS data types as used in .sds.yml metadata */
export type SdsDataType =
    | 'uint8_t'
    | 'uint16_t'
    | 'uint32_t'
    | 'int8_t'
    | 'int16_t'
    | 'int32_t'
    | 'float'
    | 'double';

/** Pixel format identifiers for image streams */
export type SdsPixelFormat =
    | 'RAW8' | 'RAW10'
    | 'RGB565' | 'RGB888'
    | 'NV12' | 'NV21' | 'I420'
    | 'NV16' | 'NV61'
    | 'YUYV' | 'UYVY' | 'YUV422P'
    | 'YUV444' | 'YUV444P';

/** Image metadata within a content value */
export interface SdsImageMeta {
    pixel_format: SdsPixelFormat;
    width: number;
    height: number;
    stride_bytes?: number;
    planes?: { stride_bytes: number }[];
}

/** Audio metadata within a content value */
export interface SdsAudioMeta {
    sample_rate: number;         // Sample rate in Hz (e.g., 44100)
    bit_depth: number;           // Bits per sample (e.g., 16, 24, 32)
    audio_channels: number;      // Number of audio channels (1=mono, 2=stereo)
    codec?: string;              // Codec identifier (e.g., 'pcm', 'wav', 'opus')
    frame_size?: number;         // Samples per frame (for block-based codecs)
}

/** Video metadata — extends image with temporal info */
export interface SdsVideoMeta {
    pixel_format: SdsPixelFormat;
    width: number;
    height: number;
    fps: number;                 // Frames per second
    codec?: string;              // e.g., 'raw', 'mjpeg'
    keyframe_interval?: number;  // Keyframe interval in frames
    stride_bytes?: number;
}

/** Media type classifier for SDS streams */
export type SdsMediaType = 'sensor' | 'image' | 'video' | 'audio';

/**
 * A single value descriptor inside sds.content[].
 * Describes one channel of the data stream.
 */
export interface SdsContentValue {
    value: string;           // Name of the value (e.g., "x", "y", "z")
    type: SdsDataType;       // Data type (e.g., "int16_t")
    offset?: number;         // Offset, default 0
    scale?: number;          // Scale factor, default 1.0
    unit?: string;           // Physical unit (e.g., "dps", "G")
    image?: SdsImageMeta;    // Optional image metadata
    audio?: SdsAudioMeta;    // Optional audio metadata
    video?: SdsVideoMeta;    // Optional video metadata
}

/**
 * Top-level SDS YAML metadata structure (from .sds.yml files).
 * Conforms to schema/sds.schema.json in the SDS-Framework.
 */
export interface SdsMetadata {
    sds: {
        name: string;                // Name of the stream
        description?: string;        // Optional description
        frequency: number;           // Capture frequency in Hz
        'tick-frequency'?: number;   // Timestamp tick frequency, default 1000 Hz
        content: SdsContentValue[];  // List of values/channels
    };
}

/**
 * A single record in an SDS binary data file.
 * Each record contains:
 *  - timestamp: 32-bit unsigned integer (little-endian)
 *  - dataSize:  32-bit unsigned integer (little-endian)
 *  - data:      raw binary payload
 */
export interface SdsRecord {
    timestamp: number;
    dataSize: number;
    data: Buffer;
}

/**
 * Parsed representation of an SDS data file with all records in memory.
 */
export interface SdsParsedFile {
    filePath: string;
    records: SdsRecord[];
    totalDataSize: number;
    totalRecords: number;
    durationMs: number;
}

/**
 * Decoded data point — one value from one record, after applying
 * scale and offset from the metadata.
 */
export interface SdsDecodedSample {
    timestamp: number;
    timeSeconds: number;
    values: { [channelName: string]: number };
}

/**
 * Connection configuration for the SDS Recorder.
 */
export interface SdsRecorderConfig {
    mode: 'serial' | 'socket' | 'usb' | 'demo';
    serialPort?: string;
    baudRate?: number;
    parity?: 'N' | 'E' | 'O' | 'M' | 'S';
    stopBits?: 1 | 1.5 | 2;
    ipAddress?: string;
    tcpPort?: number;
    outputDirectory: string;
    streamName: string;
}

/**
 * Recording session state.
 */
export interface SdsRecordingSession {
    id: string;
    config: SdsRecorderConfig;
    startTime: Date;
    recordCount: number;
    totalBytes: number;
    isRecording: boolean;
    outputFile: string;
}

/**
 * Returns the byte size of a given SDS data type.
 */
export function sdsDataTypeSize(type: SdsDataType): number {
    switch (type) {
        case 'uint8_t':
        case 'int8_t':
            return 1;
        case 'uint16_t':
        case 'int16_t':
            return 2;
        case 'uint32_t':
        case 'int32_t':
        case 'float':
            return 4;
        case 'double':
            return 8;
        default:
            return 4;
    }
}

/**
 * Compute the byte size of a single sample frame from metadata content.
 */
export function sdsFrameSize(content: SdsContentValue[]): number {
    let size = 0;
    for (const ch of content) {
        // Handle bit-field types like "uint32_t:1"
        const baseType = ch.type.split(':')[0] as SdsDataType;
        size += sdsDataTypeSize(baseType);
    }
    return size;
}

/** Known SDS file extension */
export const SDS_FILE_EXTENSION = '.sds';
/** Known metadata file extension */
export const SDS_METADATA_EXTENSION = '.sds.yml';

/**
 * Detect the media type of an SDS stream from its metadata.
 */
export function detectMediaType(metadata: SdsMetadata): SdsMediaType {
    const content = metadata.sds.content;
    if (!content || content.length === 0) { return 'sensor'; }
    for (const ch of content) {
        if (ch.video) { return 'video'; }
        if (ch.image) { return 'image'; }
        if (ch.audio) { return 'audio'; }
    }
    return 'sensor';
}

/**
 * Decoded frame — raw binary data from an image/video/audio record.
 */
export interface SdsDecodedFrame {
    timestamp: number;
    timeSeconds: number;
    frameIndex: number;
    data: Buffer;
    mediaType: SdsMediaType;
}

/**
 * Metadata conflict description for warning when YAML settings differ.
 */
export interface SdsMetadataConflict {
    field: string;
    existingValue: string | number;
    newValue: string | number;
}

/**
 * Compare two metadata objects and return list of conflicting fields.
 */
export function compareMetadata(existing: SdsMetadata, incoming: SdsMetadata): SdsMetadataConflict[] {
    const conflicts: SdsMetadataConflict[] = [];
    const e = existing.sds;
    const n = incoming.sds;

    if (e.name !== n.name) {
        conflicts.push({ field: 'name', existingValue: e.name, newValue: n.name });
    }
    if (e.frequency !== n.frequency) {
        conflicts.push({ field: 'frequency', existingValue: e.frequency, newValue: n.frequency });
    }
    const eTick = e['tick-frequency'] ?? 1000;
    const nTick = n['tick-frequency'] ?? 1000;
    if (eTick !== nTick) {
        conflicts.push({ field: 'tick-frequency', existingValue: eTick, newValue: nTick });
    }
    // Compare content channels
    if (e.content.length !== n.content.length) {
        conflicts.push({ field: 'content.length', existingValue: e.content.length, newValue: n.content.length });
    } else {
        for (let i = 0; i < e.content.length; i++) {
            if (e.content[i].value !== n.content[i].value) {
                conflicts.push({ field: `content[${i}].value`, existingValue: e.content[i].value, newValue: n.content[i].value });
            }
            if (e.content[i].type !== n.content[i].type) {
                conflicts.push({ field: `content[${i}].type`, existingValue: e.content[i].type, newValue: n.content[i].type });
            }
        }
    }
    return conflicts;
}
