/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useRef, useState } from 'react';
import { ExpandOutlined, LeftCircleOutlined, RightCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider, Space } from 'antd';
import { ImageFrame } from '../../../webview/protocol';
import { decodeFrame } from '../../../webview/utilities';
import { frameWindowViewer } from './frameWindowViewer';

type ImageState = {
    frames: ImageFrame[];
    rangeStart?: number;
    width: number;
    height: number;
    totalFrames: number;
};

type ImageViewerProps = {
    state: ImageState;
    filename?: string;
};

const statsTitleStyle: React.CSSProperties = {
    opacity: 0.5,
    fontSize: '80%'
};

const statsValueStyle: React.CSSProperties = {
    paddingRight: 32,
    fontSize: '80%'
};

export function ImageViewer({ state, filename }: ImageViewerProps) {
    const { frames, rangeStart = 0, width, height, totalFrames } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [zoom, setZoom] = useState(1);
    const {
        index,
        windowFrames,
        windowStart,
        isDragMode,
        setIsDragMode,
        getLoadedFrame,
        changeIndex,
        markNeedsPostDragHighQuality,
    } = frameWindowViewer({
        state: { frames, rangeStart, totalFrames },
        filename,
        mediaType: 'image',
        getWindowSize: quality => quality === 'low' ? 32 : 160,
        getNearEdgeMargin: loadedFrameCount => Math.max(8, Math.floor(loadedFrameCount * 0.2)),
        stationaryRequestQuality: 'high',
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || windowFrames.length === 0) { return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { return; }
        const frame = getLoadedFrame(index) ?? windowFrames[Math.max(0, Math.min(windowFrames.length - 1, index - windowStart))];
        if (!frame) { return; }
        const img = decodeFrame(frame, width, height);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;
        ctx.putImageData(img, 0, 0);
    }, [height, index, width, zoom, windowFrames, windowStart]);

    return (
        <div className="media-page">
            <Row>
                <Col flex="auto" style={{ textAlign: 'right' }}>
                    <Space>
                        <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={() => setZoom(z => Math.min(8, z * 1.5))}></Button>
                        <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={() => setZoom(z => Math.max(0.25, z / 1.5))}></Button>
                        <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={() => setZoom(1)}></Button>
                    </Space>
                </Col>
            </Row>
            <Row className="info-bar">
                <Col style={statsTitleStyle}>Dimensions</Col>
                <Col style={statsValueStyle}>{width}×{height}</Col>
                <Col style={statsTitleStyle}>Frame</Col>
                <Col style={statsValueStyle}>{Math.min(index + 1, totalFrames)} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Showing</Col>
                <Col style={statsValueStyle}>{windowFrames.length} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Timestamp</Col>
                <Col style={statsValueStyle}>{(getLoadedFrame(index)?.timestamp ?? 0).toFixed(4)}s</Col>
            </Row>
            <Row className="canvas-area">
                <Col style={{ width: `${width * zoom}px`, height: `${height * zoom}px` }}>
                    <canvas ref={canvasRef} width={width * zoom} height={height * zoom}></canvas>
                </Col>
            </Row>
            <Row className="controls">
                <Col flex="none" style={{ textAlign: 'center' }}>
                    <Button icon={<LeftCircleOutlined />} type="link" title="Previous Frame" onClick={() => changeIndex(Math.max(0, index - 1))} />
                </Col>
                <Col flex="auto">
                    <Slider
                        min={0}
                        max={Math.max(0, totalFrames - 1)}
                        value={index}
                        onChange={value => {
                            setIsDragMode(true);
                            changeIndex(value);
                        }}
                        onChangeComplete={() => {
                            markNeedsPostDragHighQuality();
                            setIsDragMode(false);
                        }}
                        style={{ flex: 1, margin: 0 }}
                    />
                </Col>
                <Col flex="none" style={{ textAlign: 'center' }}>
                    <Button icon={<RightCircleOutlined />} type="link" title="Next Frame" onClick={() => changeIndex(Math.min(totalFrames - 1, index + 1))} />
                </Col>
            </Row>
        </div>
    );
}