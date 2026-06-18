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

import { ExpandOutlined, PauseCircleOutlined, PlayCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BroadcastMessage, getIndexedSdsSuffix, Message, SampleFrame } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';
import { BaseChartViewer, ChartSample } from './baseChartViewer';
import { decimateExtremaSeries, DecimationPreset } from './decimation';
import { getIsDarkTheme, sliderStyle, statsTitleStyle, statsValueStyle } from '../../../webview/utilities';
import { useViewportRange } from './useViewportRange';
import { SdsFileStats } from '../../../sds';

export type AudioState = {
    samples: SampleFrame[];
    rangeStart?: number;
    rangeEnd?: number;
    domainStart?: number;
    domainEnd?: number;
    decimationPreset?: DecimationPreset;
    sampleRate: number;
    bitDepth: number;
    channels: number;
    totalSamples: number;
    totalRecords: number;
    fileStats: SdsFileStats;
};

type AudioViewerProps = {
    state: AudioState;
    filename?: string;
};

export function AudioViewer({ state, filename }: AudioViewerProps) {
    const {
        samples,
        sampleRate,
        bitDepth,
        channels,
        totalSamples,
        totalRecords,
        domainStart,
        domainEnd,
        decimationPreset: initialDecimationPreset,
    } = state;

    const [isPlaying, setIsPlaying] = useState(false);
    const [highlightedTime, setHighlightedTime] = useState<number | null>(null);
    const [viewWidth, setViewWidth] = useState<number>(() => Math.max(640, window.innerWidth));
    const [decimationPreset, setDecimationPreset] = useState<DecimationPreset>(initialDecimationPreset ?? 'accuracy');
    const [currentBlock, setCurrentBlock] = useState<number | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);

    const totalDurationSeconds = Math.max(0, (domainEnd ?? 0) - (domainStart ?? 0));

    const sampleDomain = useMemo<[number, number]>(() => {
        if (sampleRate <= 0 || samples.length === 0) {
            return [0, 1];
        }

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        for (const frame of samples) {
            if (!Array.isArray(frame.samples) || frame.samples.length === 0) {
                continue;
            }

            const startX = frame.timestamp;
            const endX = frame.timestamp + ((frame.samples.length - 1) / sampleRate);
            if (Number.isFinite(startX) && startX < minX) {
                minX = startX;
            }
            if (Number.isFinite(endX) && endX > maxX) {
                maxX = endX;
            }
        }

        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || minX === maxX) {
            return [0, 1];
        }

        return [minX, maxX];
    }, [sampleRate, samples]);

    const resolvedDomainStart = domainStart ?? sampleDomain[0];
    const resolvedDomainEnd = domainEnd ?? sampleDomain[1];
    const {
        viewRange,
        setViewRange,
        setViewRangeClamped,
        clampRange,
        domainSpan,
        sliderStep,
        isDragging,
        onZoomIn,
        onZoomOut,
        onFit,
        onSliderChange,
        onSliderAfterChange,
    } = useViewportRange({ domainStart: resolvedDomainStart, domainEnd: resolvedDomainEnd });

    const loadedSampleCount = useMemo(
        () => samples.reduce((sum, frame) => sum + frame.samples.length, 0),
        [samples]
    );

    const chartData = useMemo<ChartSample[]>(() => {
        const data: ChartSample[] = [];
        if (sampleRate <= 0) {
            return data;
        }

        const [start, end] = viewRange;

        for (const frame of samples) {
            for (let i = 0; i < frame.samples.length; i++) {
                const x = frame.timestamp + (i / sampleRate);
                if (x < start || x > end) {
                    continue;
                }

                data.push({
                    x,
                    y: frame.samples[i],
                    channel: 'audio',
                });
            }
        }
        const presetFactor = decimationPreset === 'accuracy' ? 2.8 : 1.3;
        const presetFloor = decimationPreset === 'accuracy' ? 2400 : 1200;
        const dragFactor = isDragging ? 0.7 : 1;
        const maxPoints = Math.max(presetFloor, Math.floor(viewWidth * presetFactor * dragFactor));
        return decimateExtremaSeries(data, maxPoints);
    }, [decimationPreset, isDragging, sampleRate, samples, viewRange, viewWidth]);

    const onCursorChange = useCallback((time: number, block: number | null) => {
        setHighlightedTime(time);
        setCurrentBlock(block);
        broadcastMessage({
            type: 'broadcast',
            timeStamp: time,
            fileName: filename,
        });
    }, [filename]);

    const stopPlayback = () => {
        const source = sourceRef.current;
        if (source) {
            try {
                source.stop();
            } catch {
                // Source can already be stopped.
            }
            source.disconnect();
            sourceRef.current = null;
        }
        setIsPlaying(false);
    };

    const playLoadedSamples = async () => {
        if (sampleRate <= 0 || samples.length === 0) {
            return;
        }

        const pcm: number[] = [];
        for (const frame of samples) {
            for (const value of frame.samples) {
                pcm.push(value);
            }
        }

        if (pcm.length === 0) {
            return;
        }

        if (!audioCtxRef.current) {
            audioCtxRef.current = new AudioContext({ sampleRate });
        }

        const audioCtx = audioCtxRef.current;
        if (!audioCtx) {
            return;
        }

        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        stopPlayback();

        const buffer = audioCtx.createBuffer(1, pcm.length, sampleRate);
        buffer.copyToChannel(Float32Array.from(pcm), 0);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.onended = () => {
            if (sourceRef.current === source) {
                sourceRef.current = null;
                setIsPlaying(false);
            }
        };

        sourceRef.current = source;
        setIsPlaying(true);
        source.start();
    };

    useEffect(() => {
        return () => {
            stopPlayback();
            const audioCtx = audioCtxRef.current;
            if (audioCtx) {
                void audioCtx.close();
                audioCtxRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const msg = event.data as Message;
            if (msg.type !== 'broadcast') {
                return;
            }

            const payload = msg as BroadcastMessage;
            if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix(payload.fileName)) {
                return;
            }

            if (typeof payload.timeStamp !== 'number') {
                return;
            }

            setHighlightedTime(payload.timeStamp);
        };

        window.addEventListener('message', onMessage);
        return () => {
            window.removeEventListener('message', onMessage);
        };
    }, [filename]);

    useEffect(() => {
        const onResize = () => {
            setViewWidth(Math.max(640, window.innerWidth));
        };

        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, []);

    return (
        <div className="media-page">
            <Row className="info-bar">
                <Col style={statsTitleStyle}>Block</Col>
                <Col style={statsValueStyle}>{currentBlock ?? 0} of {totalSamples}</Col>
                <Col style={statsTitleStyle}>Size</Col>
                <Col style={statsValueStyle}>{state.fileStats.avgBlockSize}B</Col>
                <Col style={statsTitleStyle}>Time</Col>
                <Col style={statsValueStyle}>{(highlightedTime ?? 0).toFixed(4)}s</Col>
                <Col style={statsTitleStyle}>Interval</Col>
                <Col style={statsValueStyle}>{state.fileStats.recordingIntervalMs}ms / {sampleRate.toFixed(2)}Hz</Col>
            </Row>
            <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                <BaseChartViewer
                    data={chartData}
                    xField="x"
                    yField="y"
                    seriesField="channel"
                    totalBlocks={totalSamples}
                    smooth={false}
                    highlightedX={highlightedTime}
                    xRange={viewRange}
                    onCursorChange={onCursorChange}
                    onZoomRangeChange={(range) => setViewRangeClamped(range[0], range[1])}
                    theme={getIsDarkTheme() ? 'classicDark' : 'classic'}
                    tooltip={{
                        showMarkers: true,
                        shared: true,
                        crosshairs: {
                            line: {
                                style: {
                                    stroke: 'rgba(150,150,150,0.45)',
                                    lineWidth: 1,
                                },
                            },
                        },
                        formatter: (datum: any) => ({
                            name: 'audio',
                            value: typeof datum?.y === 'number' ? datum.y.toFixed(5) : String(datum?.y ?? ''),
                        }),
                        title: (value: any) => {
                            const t = typeof value === 'number' ? value : Number(value.x);
                            return Number.isFinite(t) ? `Time: ${t.toFixed(4)} s` : t;
                        },
                    }}
                />
            </div>
            <Row className="controls" gutter={12}>
                <Col flex="none">
                    <Button
                        icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                        type="text"
                        title={isPlaying ? 'Stop Playback' : 'Play Visible Range'}
                        onClick={() => {
                            if (isPlaying) {
                                stopPlayback();
                            } else {
                                void playLoadedSamples();
                            }
                        }}
                        disabled={samples.length === 0}
                    ></Button>
                </Col>
                <Col flex="auto">
                    <Slider
                        range={{ draggableTrack: true }}
                        min={resolvedDomainStart}
                        max={resolvedDomainEnd}
                        step={sliderStep}
                        value={viewRange}
                        onChange={onSliderChange}
                        onChangeComplete={onSliderAfterChange}
                        style={sliderStyle}
                        tooltip={{ formatter: (v) => `${(v ?? 0).toFixed(3)}s` }}
                        disabled={resolvedDomainEnd <= resolvedDomainStart}
                    />
                </Col>
                <Col flex="none">
                    <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={onZoomOut} disabled={domainSpan === (viewRange[1] - viewRange[0])}></Button>
                    <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={onFit}></Button>
                </Col>
            </Row>
        </div>
    );
}
