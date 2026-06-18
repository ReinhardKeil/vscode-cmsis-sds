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

// Shared base for time-series chart viewers using Ant Design Charts
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartEvent, Line } from '@ant-design/charts';

export interface ChartSample {
    x: number;
    y: number;
    [key: string]: any;
}

export interface BaseChartViewerProps {
    data: ChartSample[];
    xField?: string;
    yField?: string;
    seriesField?: string;
    title?: string;
    color?: string[];
    highlightedX?: number | null;
    xRange?: [number, number];
    totalBlocks?: number;
    blockIndexFromX?: (x: number) => number | null;
    onCursorChange?: (x: number, block: number | null) => void;
    onZoomRangeChange?: (range: [number, number]) => void;
    [key: string]: any;
}

export const BaseChartViewer: React.FC<BaseChartViewerProps> = ({
    data,
    xField = 'x',
    yField = 'y',
    seriesField,
    title,
    color,
    highlightedX,
    xRange,
    totalBlocks,
    blockIndexFromX: blockIndexFromXProp,
    onCursorChange,
    onZoomRangeChange,
    ...rest
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const plotRef = useRef<any>(null);
    const detachCanvasListenersRef = useRef<(() => void) | null>(null);
    const resolveXRangeRef = useRef<[number, number] | null>(null);
    const onCursorChangeRef = useRef<typeof onCursorChange>(onCursorChange);
    const plotRegionRef = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
    const [plotRegion, setPlotRegion] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
    const height = 400;

    const resolveXRange = useMemo<[number, number] | null>(() => {
        if (xRange && Number.isFinite(xRange[0]) && Number.isFinite(xRange[1]) && xRange[1] > xRange[0]) {
            return xRange;
        }

        if (data.length === 0) {
            return null;
        }

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        for (const point of data) {
            const x = point?.[xField];
            if (typeof x !== 'number' || !Number.isFinite(x)) {
                continue;
            }
            if (x < minX) {
                minX = x;
            }
            if (x > maxX) {
                maxX = x;
            }
        }

        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
            return null;
        }

        return [minX, maxX];
    }, [data, xField, xRange]);

    const cursorPercent = useMemo(() => {
        if (highlightedX === null || highlightedX === undefined || !resolveXRange) {
            return null;
        }

        const span = resolveXRange[1] - resolveXRange[0];
        if (!Number.isFinite(span) || span <= 0) {
            return null;
        }

        const relative = (highlightedX - resolveXRange[0]) / span;
        const clamped = Math.max(0, Math.min(1, relative));
        return clamped * 100;
    }, [highlightedX, resolveXRange]);

    const resolvePlotRegion = useCallback((plot: any, canvasEl: HTMLCanvasElement | null) => {
        if (!canvasEl) {
            return null;
        }

        const coordinate = plot?.chart?.getCoordinate?.();

        const start = coordinate?.start;
        const end = coordinate?.end;

        if (start && end) {
            return {
                left: Math.min(start.x, end.x),
                right: Math.max(start.x, end.x),
                top: Math.min(start.y, end.y),
                bottom: Math.max(start.y, end.y),
            };
        }
        return { left: 0, right: canvasEl.clientWidth, top: 0, bottom: canvasEl.clientHeight };
    }, []);

    const cursorTimeFromClientPoint = useCallback((clientX: number, clientY: number) => {
        const activeRange = resolveXRangeRef.current;
        if (!activeRange) {
            return null;
        }

        const rect = canvasRef.current?.getBoundingClientRect() ?? containerRef.current?.getBoundingClientRect();
        const region = plotRegionRef.current;
        if (!rect) {
            return null;
        }

        if (!region) {
            return null;
        }

        const regionWidth = region.right - region.left;
        const regionHeight = region.bottom - region.top;
        if (regionWidth <= 0 || regionHeight <= 0) {
            return null;
        }
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        // Ignore clicks above/below the plotted data region (axes, legend, padding).
        if (localY < region.top || localY > region.bottom) {
            return null;
        }

        if (localX < region.left || localX > region.right) {
            return null;
        }

        const relative = (localX - region.left) / regionWidth;
        return activeRange[0] + (activeRange[1] - activeRange[0]) * relative;
    }, []);

    const cursorLeftPx = useMemo(() => {
        if (cursorPercent === null || !plotRegion) {
            return null;
        }

        return plotRegion.left + ((plotRegion.right - plotRegion.left) * (cursorPercent / 100));
    }, [cursorPercent, plotRegion]);

    const computeBlockIndexFromX = useCallback((value: unknown): number | null => {
        const x = typeof value === 'number'
            ? value
            : Number((value as any)?.x ?? value);
        if (!Number.isFinite(x)) {
            return null;
        }

        if (typeof blockIndexFromXProp === 'function') {
            return blockIndexFromXProp(x);
        }

        if (!resolveXRange) {
            return null;
        }

        const effectiveTotalBlocks = Math.max(1, totalBlocks ?? data.length);

        const [minX, maxX] = resolveXRange;
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
            return 1;
        }

        const relative = (x - minX) / (maxX - minX);
        const clamped = Math.max(0, Math.min(1, relative));
        const blockIndex = Math.round(clamped * Math.max(0, effectiveTotalBlocks - 1)) + 1;
        return Math.max(1, Math.min(effectiveTotalBlocks, blockIndex));
    }, [blockIndexFromXProp, data.length, resolveXRange, totalBlocks]);

    const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        if (!onZoomRangeChange || !resolveXRange) {
            return;
        }

        event.preventDefault();

        const currentRange = xRange && Number.isFinite(xRange[0]) && Number.isFinite(xRange[1]) && xRange[1] > xRange[0]
            ? xRange
            : resolveXRange;
        const currentSpan = currentRange[1] - currentRange[0];
        if (!Number.isFinite(currentSpan) || currentSpan <= 0) {
            return;
        }

        if (event.shiftKey) {
            const wheelDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (wheelDelta === 0) {
                return;
            }

            const direction = wheelDelta > 0 ? 1 : -1;
            const panAmount = currentSpan * 0.08 * direction;
            onZoomRangeChange([currentRange[0] + panAmount, currentRange[1] + panAmount]);
            return;
        }

        const focusTime = cursorTimeFromClientPoint(event.clientX, event.clientY);
        const anchorTime = focusTime === null ? (currentRange[0] + currentRange[1]) / 2 : focusTime;
        const relativeAnchor = (anchorTime - currentRange[0]) / currentSpan;
        const zoomFactor = Math.exp(event.deltaY * 0.0015);
        const nextSpan = currentSpan * zoomFactor;

        const nextStart = anchorTime - (nextSpan * relativeAnchor);
        const nextEnd = nextStart + nextSpan;
        onZoomRangeChange([nextStart, nextEnd]);
    }, [cursorTimeFromClientPoint, onZoomRangeChange, resolveXRange, xRange]);

    useEffect(() => {
        resolveXRangeRef.current = resolveXRange;
    }, [resolveXRange]);

    useEffect(() => {
        onCursorChangeRef.current = onCursorChange;
    }, [onCursorChange]);

    useEffect(() => {
        return () => {
            if (detachCanvasListenersRef.current) {
                detachCanvasListenersRef.current();
                detachCanvasListenersRef.current = null;
            }
        };
    }, []);

    const {
        tooltip: restTooltip,
        axis: restAxis,
        onReady: userOnReady,
        ...otherRest
    } = rest as {
        tooltip?: { title?: unknown;[key: string]: unknown };
        axis?: { x?: { labelFormatter?: unknown;[key: string]: unknown };[key: string]: unknown };
        onReady?: (plot: any) => void;
        [key: string]: unknown;
    };

    const userTooltip = restTooltip as { title?: unknown } | undefined;
    const tooltipTitle = (value: unknown) => {
        const blockIndex = computeBlockIndexFromX(value);
        const blockTitle = blockIndex !== null ? `Block: ${blockIndex}` : 'Block';

        if (userTooltip?.title && typeof userTooltip.title === 'function') {
            const userTitle = userTooltip.title(value);
            if (typeof userTitle === 'string' && userTitle.length > 0) {
                return `${blockTitle} | ${userTitle}`;
            }
        }

        return blockTitle;
    };

    const config = {
        data,
        xField,
        yField,
        seriesField,
        // Ensure multi-series line colors follow the provided palette.
        colorField: seriesField,
        color,
        scale: color && color.length > 0
            ? {
                color: {
                    range: color,
                },
            }
            : undefined,
        ...otherRest,
        axis: {
            ...(restAxis ?? {}),
            x: {
                ...(restAxis?.x ?? {}),
                labelFormatter: (value: string) => {
                    const blockIndex = computeBlockIndexFromX(value);
                    return blockIndex !== null ? String(blockIndex) : value;
                },
            },
        },
        animate: false,
        legend: { position: 'top' },
        tooltip: {
            showMarkers: true,
            ...(userTooltip ?? {}),
            title: tooltipTitle,
        },
        slider: { x: false, y: false },
    };

    const mergedOnReady = (plot: any) => {
        plotRef.current = plot;
        if (detachCanvasListenersRef.current) {
            detachCanvasListenersRef.current();
            detachCanvasListenersRef.current = null;
        }

        const canvasEl = containerRef.current?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        canvasRef.current = canvasEl;
        const region = resolvePlotRegion(plot, canvasEl);
        plotRegionRef.current = region;
        setPlotRegion(region);

        if (onCursorChange && resolveXRange && canvasEl) {
            const emitCursor = (event: MouseEvent) => {
                const time = cursorTimeFromClientPoint(event.clientX, event.clientY);
                const time2 = cursorTimeFromClientPoint(event.clientX - 20, event.clientY);
                if (time === null) {
                    return;
                }
                onCursorChangeRef.current?.(time, computeBlockIndexFromX(time2));
            };

            const pointerMoveEvent = `plot:${ChartEvent.POINTER_MOVE}`;
            const pointerDownEvent = `plot:${ChartEvent.POINTER_DOWN}`;

            const handlePointerEvent = (e: any) => {
                if (e?.target?.attributes?.class === 'plot' && e?.buttons === 1 && e?.nativeEvent) {
                    emitCursor(e.nativeEvent as MouseEvent);
                }
            };

            plot.chart.on(pointerMoveEvent, handlePointerEvent);
            plot.chart.on(pointerDownEvent, handlePointerEvent);

            detachCanvasListenersRef.current = () => {
                plot.chart.off(pointerMoveEvent, handlePointerEvent);
                plot.chart.off(pointerDownEvent, handlePointerEvent);
                canvasRef.current = null;
                plotRef.current = null;
            };
        }

        if (typeof userOnReady === 'function') {
            userOnReady(plot);
        }
    };

    return (
        <div ref={containerRef} style={{ position: 'relative', height: '100%' }} onWheel={handleWheel}>
            <div id='chart' style={{ height: '100%' }}>
                <Line {...config} onReady={mergedOnReady} />
            </div>
            {cursorLeftPx !== null && (
                <div
                    style={{
                        position: 'absolute',
                        top: plotRegion?.top ?? 0,
                        height: plotRegion ? Math.max(0, plotRegion.bottom - plotRegion.top) : height,
                        left: `${cursorLeftPx - 0.5}px`,
                        borderLeft: '1px dashed rgba(220, 80, 80, 0.95)',
                        pointerEvents: 'none',
                        zIndex: 5,
                    }}
                />
            )}
        </div>
    );
};
