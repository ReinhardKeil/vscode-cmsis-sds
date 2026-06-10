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
import React, { useMemo } from 'react';
import { BaseChartViewer, ChartSample } from './baseChartViewer';
import { Row, Col } from 'antd';

export interface DataViewerProps {
    samples: { timestamp: number; timeSeconds: number; values: Record<string, number> }[];
    channelNames: string[];
    title?: string;
}

export const DataViewer: React.FC<DataViewerProps> = ({ samples, channelNames, title }) => {
    // Flatten samples for AntD chart
    const chartData = useMemo<ChartSample[]>(() => {
        const data: ChartSample[] = [];
        for (const s of samples) {
            for (const ch of channelNames) {
                if (s.values[ch] !== undefined) {
                    data.push({
                        x: s.timeSeconds,
                        y: s.values[ch],
                        channel: ch,
                    });
                }
            }
        }
        return data;
    }, [samples, channelNames]);

    return (
        <div>
            <Row align="middle" style={{ marginBottom: 8 }}>
                <Col flex="auto">
                    <h3>{title || 'SDS Viewer'}</h3>
                </Col>
            </Row>
            <BaseChartViewer
                data={chartData}
                xField="x"
                yField="y"
                seriesField="channel"
                height={320}
                title={title}
            />
        </div>
    );
};
