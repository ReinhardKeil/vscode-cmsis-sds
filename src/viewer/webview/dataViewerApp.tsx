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

import './components/viewer.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebviewMessenger, getInitialState } from '../../webview/bridge';
import { SdsFileStats, SdsMetadata } from '../../sds';
import { Button, Col, ConfigProvider, Row, Slider, Space, theme } from 'antd';
import { ExpandOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { BroadcastMessage, getIndexedSdsSuffix, Message, WebviewMessage } from '../../webview/protocol';
import { broadcastMessage } from '../../webview/vscode-api';
import { decimateExtremaSeries, DecimationPreset } from './components/decimation';
import { getIsDarkTheme } from '../../webview/utilities';
import { BaseChartViewer, ChartSample } from './components/baseChartViewer';
import { useViewportRange } from './components/useViewportRange';

type Sample = { timestamp: number; timeSeconds: number; values: Record<string, number> };

type InitialState = {
    samples?: Sample[];
    channelNames?: string[];
    stats?: SdsFileStats;
    metadata?: SdsMetadata;
    domainStart?: number;
    domainEnd?: number;
    decimationPreset?: DecimationPreset;
    fileName?: string;
    error?: string;
};

type VisibleRangeRequestMessage = {
    command: 'requestVisibleRangeData';
    requestId: number;
    payload: {
        rangeStart: number;
        rangeEnd: number;
        plotWidth: number;
        quality: 'low' | 'high';
    };
};

type VisibleRangeResponseMessage = {
    command: 'visibleRangeData';
    requestId: number;
    payload: {
        rangeStart: number;
        rangeEnd: number;
        quality: 'low' | 'high';
        samples: Sample[];
    };
};

type OutboundMessage = ({ command: 'exportCsv' } & WebviewMessage) | VisibleRangeRequestMessage | WebviewMessage;

const messenger = new WebviewMessenger<WebviewMessage, OutboundMessage>();

function DataViewerApp() {
    const initial = getInitialState<InitialState>({});
    const [activeChannels, setActiveChannels] = useState(() => new Set(initial.channelNames));
    const [samples, setSamples] = useState<Sample[]>(() => initial.samples ?? []);
    const channelNames = useMemo(() => initial.channelNames ?? [], [initial.channelNames]);
    const stats = initial.stats ?? ({} as SdsFileStats);
    const metadata = initial.metadata ?? null;
    const filename = initial.fileName ?? 'SDS Viewer';

    const domainStart = initial.domainStart ?? (samples.length > 0 ? samples[0].timeSeconds : 0);
    const domainEnd = initial.domainEnd ?? (samples.length > 0 ? samples[samples.length - 1].timeSeconds : 1);
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
    } = useViewportRange({ domainStart, domainEnd });

    const [highlightedTime, setHighlightedTime] = useState<number | null>(null);
    const [viewWidth, setViewWidth] = useState<number>(() => Math.max(640, window.innerWidth));
    const [decimationPreset, setDecimationPreset] = useState<DecimationPreset>(() => initial.decimationPreset ?? 'accuracy');
    const requestSeqRef = useRef(0);
    const latestAppliedSeqRef = useRef(0);

    const onExport = () => messenger.send({ command: 'exportCsv' });

    const requestVisibleRangeData = useCallback((start: number, end: number, quality: 'low' | 'high') => {
        const rangeStart = Math.min(start, end);
        const rangeEnd = Math.max(start, end);
        const requestId = ++requestSeqRef.current;

        messenger.send({
            command: 'requestVisibleRangeData',
            requestId,
            payload: {
                rangeStart,
                rangeEnd,
                // Keep plotWidth stable enough for backend decimation.
                plotWidth: Math.max(1, Math.floor(window.innerWidth * 0.8)),
                quality,
            },
        });
    }, []);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const msg = event.data as Message;

            if (msg.type === 'broadcast') {
                const payload = msg as BroadcastMessage;
                if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix(payload.fileName)) {
                    return;
                }

                if (typeof payload.timeStamp !== 'number') {
                    return;
                }

                setHighlightedTime(payload.timeStamp);
                return;
            }

            const response = msg as unknown as Partial<VisibleRangeResponseMessage>;
            if (response.command !== 'visibleRangeData' || typeof response.requestId !== 'number') {
                return;
            }

            if (response.requestId < latestAppliedSeqRef.current) {
                return;
            }
            latestAppliedSeqRef.current = response.requestId;

            if (!response.payload || !Array.isArray(response.payload.samples)) {
                return;
            }

            setSamples(response.payload.samples);
        };

        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [filename]);

    useEffect(() => {
        if (initial.error) {
            return;
        }

        const quality: 'low' | 'high' = isDragging ? 'low' : 'high';

        const handle = window.setTimeout(() => {
            requestVisibleRangeData(viewRange[0], viewRange[1], quality);
        }, isDragging ? 10 : 100);

        return () => {
            window.clearTimeout(handle);
        };
    }, [initial.error, isDragging, requestVisibleRangeData, viewRange]);

    useEffect(() => {
        if (initial.error) {
            return;
        }

        const onResize = () => {
            const quality: 'low' | 'high' = isDragging ? 'low' : 'high';
            requestVisibleRangeData(viewRange[0], viewRange[1], quality);
        };

        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [initial.error, isDragging, requestVisibleRangeData, viewRange]);

    useEffect(() => {
        const onResize = () => {
            setViewWidth(Math.max(640, window.innerWidth));
        };

        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, []);

    if (initial.error) {
        return (
            <div style={{ background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontFamily: 'var(--vscode-font-family)', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
                <div style={{ textAlign: 'center' }}>
                    <h2 style={{ color: 'var(--vscode-errorForeground)', marginBottom: 16 }}>Failed to load SDS Viewer</h2>
                    <p>{initial.error}</p>
                </div>
            </div>
        );
    }

    const toggleChannel = (name: string) => {
        setActiveChannels((prev) => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
            } else {
                next.add(name);
            }
            return next;
        });
    };

    const statsTitleStyle: React.CSSProperties = {
        opacity: 0.5,
        fontSize: '80%',
    };

    const statsValueStyle: React.CSSProperties = {
        paddingRight: 32,
        fontSize: '80%',
    };

    const sliderStyle: React.CSSProperties = {
        flex: 1,
        margin: 0,
    };

    const colors = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#fff176', '#f06292', '#90a4ae', '#aed581'];

    const chartData = useMemo<ChartSample[]>(() => {
        const [start, end] = viewRange;
        const active = channelNames.filter((name) => activeChannels.has(name));
        const dataByChannel = new Map<string, ChartSample[]>();

        for (const ch of active) {
            dataByChannel.set(ch, []);
        }

        for (const sample of samples) {
            if (sample.timeSeconds < start || sample.timeSeconds > end) {
                continue;
            }

            for (const ch of active) {
                const value = sample.values[ch];
                if (value !== undefined) {
                    dataByChannel.get(ch)?.push({
                        x: sample.timeSeconds,
                        y: value,
                        channel: ch,
                    });
                }
            }
        }

        const presetFactor = decimationPreset === 'accuracy' ? 2.4 : 1.1;
        const presetFloor = decimationPreset === 'accuracy' ? 1800 : 900;
        const dragFactor = isDragging ? 0.7 : 1;
        const maxPointsPerChannel = Math.max(
            presetFloor,
            Math.floor(viewWidth * presetFactor * dragFactor)
        );
        const reduced: ChartSample[] = [];
        for (const series of dataByChannel.values()) {
            reduced.push(...decimateExtremaSeries(series, maxPointsPerChannel));
        }

        return reduced.sort((a, b) => a.x - b.x);
    }, [activeChannels, channelNames, decimationPreset, isDragging, samples, viewRange, viewWidth]);

    const onCursorChange = useCallback((time: number) => {
        setHighlightedTime(time);
        broadcastMessage({
            type: 'broadcast',
            timeStamp: time,
            fileName: filename,
        });
    }, [filename]);

    const windowLength = Math.max(0, viewRange[1] - viewRange[0]);

    return (
        <div style={{ background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 13, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <Row>
                <Col span={14}></Col>
                <Col span={10} style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Space.Compact block>
                            {channelNames.map((name, i) => {
                                const cColor = colors[i % colors.length];
                                const active = activeChannels.has(name);
                                return (
                                    <Button
                                        key={name}
                                        size='small'
                                        style={{ borderColor: cColor, backgroundColor: active ? cColor : 'transparent' }}
                                        ghost
                                        onClick={() => toggleChannel(name)}
                                    >
                                        {name}
                                    </Button>
                                );
                            })}
                        </Space.Compact>
                        <Button type='text' title='Export CSV' onClick={onExport}>Export</Button>
                    </div>
                </Col>
            </Row>
            <Row gutter={8} className='info-bar'>
                <Col style={statsTitleStyle}>Records</Col><Col style={statsValueStyle}>{stats.totalRecords}</Col>
                <Col style={statsTitleStyle}>Duration</Col><Col style={statsValueStyle}>{(stats.recordingTimeSeconds ?? 0).toFixed(3)} s</Col>
                <Col style={statsTitleStyle}>Interval</Col><Col style={statsValueStyle}>{(stats.recordingIntervalMs || 0).toFixed(1)} ms</Col>
                <Col style={statsTitleStyle}>Data Rate</Col><Col style={statsValueStyle}>{stats.dataRate ?? 0} B/s</Col>
                <Col style={statsTitleStyle}>Avg Block</Col><Col style={statsValueStyle}>{stats.avgBlockSize ?? 0} B</Col>
                {metadata && (
                    <>
                        <Col style={statsTitleStyle}>Frequency</Col><Col style={statsValueStyle}>{metadata.sds?.frequency} Hz</Col>
                        <Col style={statsTitleStyle}>Stream</Col><Col style={statsValueStyle}>{metadata.sds?.name}</Col>
                    </>
                )}
            </Row>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <BaseChartViewer
                    data={chartData}
                    xField='x'
                    yField='y'
                    seriesField='channel'
                    color={colors}
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
                            name: datum?.channel ?? 'value',
                            value: typeof datum?.y === 'number' ? datum.y.toFixed(4) : String(datum?.y ?? ''),
                        }),
                        title: (value: any) => {
                            const t = typeof value === 'number' ? value : Number(value.x);
                            return Number.isFinite(t) ? `Time: ${t.toFixed(4)} s` : t;
                        },
                    }}
                />
            </div>
            <Row className='controls' gutter={12}>
                <Col flex='auto'>
                    <Slider
                        range={{ draggableTrack: true }}
                        min={domainStart}
                        max={domainEnd}
                        step={sliderStep}
                        value={viewRange}
                        onChange={onSliderChange}
                        onChangeComplete={onSliderAfterChange}
                        style={sliderStyle}
                        tooltip={{ formatter: (v) => `${(v ?? 0).toFixed(3)}s` }}
                        disabled={domainEnd <= domainStart}
                    />
                </Col>
                <Col flex='none'>
                    <Button icon={<ZoomInOutlined />} type='text' title='Zoom In' onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type='text' title='Zoom Out' onClick={onZoomOut} disabled={domainSpan === windowLength}></Button>
                    <Button icon={<ExpandOutlined />} type='text' title='Fit to Window' onClick={onFit}></Button>
                </Col>
            </Row>
        </div>
    );
}

function ThemedViewerApp() {
    const [isDarkTheme, setIsDarkTheme] = useState(getIsDarkTheme);

    useEffect(() => {
        const updateTheme = () => setIsDarkTheme(getIsDarkTheme());
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        updateTheme();

        return () => {
            observer.disconnect();
        };
    }, []);

    return (
        <ConfigProvider theme={{ algorithm: isDarkTheme ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
            <DataViewerApp />
        </ConfigProvider>
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ThemedViewerApp />);
}
