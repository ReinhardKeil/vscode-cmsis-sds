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

import { ChartSample } from "./baseChartViewer";

export type DecimationPreset = 'accuracy' | 'performance';

export function decimateExtremaSeries(data: ChartSample[], maxPoints: number): ChartSample[] {
    if (data.length <= maxPoints || maxPoints <= 8) {
        return data;
    }

    const bucketSize = Math.max(2, Math.ceil(data.length / Math.max(1, Math.floor(maxPoints / 4))));
    const reduced: ChartSample[] = [];

    for (let i = 0; i < data.length; i += bucketSize) {
        const end = Math.min(i + bucketSize, data.length);
        const bucket = data.slice(i, end);
        if (bucket.length === 0) {
            continue;
        }

        let min = bucket[0];
        let max = bucket[0];
        for (const point of bucket) {
            if (point.y < min.y) {
                min = point;
            }
            if (point.y > max.y) {
                max = point;
            }
        }

        const first = bucket[0];
        const last = bucket[bucket.length - 1];
        const selected = [first, min, max, last]
            .filter((point, idx, arr) => arr.findIndex((p) => p.x === point.x && p.y === point.y) === idx)
            .sort((a, b) => a.x - b.x);

        reduced.push(...selected);
    }

    return reduced;
}
