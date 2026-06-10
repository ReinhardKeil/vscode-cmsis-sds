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

import { describe, expect, it } from 'vitest';
import { ChartSample } from '../../src/viewer/webview/components/baseChartViewer';
import { decimateExtremaSeries } from '../../src/viewer/webview/components/decimation';

function createSeries(values: number[]): ChartSample[] {
    return values.map((y, x) => ({ x, y }));
}

describe('decimateExtremaSeries', () => {
    it('returns original array when data length is <= maxPoints', () => {
        const data = createSeries([1, 3, 2, 5, 4]);

        const result = decimateExtremaSeries(data, 5);

        expect(result).toBe(data);
    });

    it('returns original array when maxPoints is very small (<= 8)', () => {
        const data = createSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        const result = decimateExtremaSeries(data, 8);

        expect(result).toBe(data);
    });

    it('keeps bucket boundaries and extrema in x-order', () => {
        const data = createSeries([5, 1, 4, 2, 8, 0, 6, 3]);

        const result = decimateExtremaSeries(data, 4);

        expect(result).toEqual(data);
    });

    it('reduces large dataset while preserving first and last points', () => {
        const data = createSeries(Array.from({ length: 200 }, (_, i) => Math.sin(i / 8) * 10 + (i % 9)));

        const result = decimateExtremaSeries(data, 20);

        expect(result.length).toBeLessThan(data.length);
        expect(result[0]).toEqual(data[0]);
        expect(result[result.length - 1]).toEqual(data[data.length - 1]);
        expect(result.every((point, idx, arr) => idx === 0 || arr[idx - 1].x <= point.x)).toBe(true);
    });

    it('deduplicates identical points selected multiple times in a bucket', () => {
        const data = createSeries([7, 7, 7, 7, 9, 9, 9, 9, 2, 2, 2, 2]);

        const result = decimateExtremaSeries(data, 9);

        const duplicates = result.filter((point, idx, arr) =>
            arr.findIndex((p) => p.x === point.x && p.y === point.y) !== idx
        );

        expect(duplicates).toHaveLength(0);
        expect(result.every((point, idx, arr) => idx === 0 || arr[idx - 1].x <= point.x)).toBe(true);
    });

    it('captures local minima and maxima per bucket', () => {
        const data = createSeries([
            5, 1, 4, 2,
            9, 3, 8, 2,
            7, 0, 6, 1,
            10, 4, 9, 3,
        ]);

        const result = decimateExtremaSeries(data, 6);

        const byX = new Map(result.map((p) => [p.x, p.y]));

        // bucket 0 (x:0-2): min at x=1, max at x=0
        expect(byX.get(1)).toBe(1);
        expect(byX.get(0)).toBe(5);

        // bucket 1 (x:3-5): min at x=3 or x=5 depending on split; max at x=4
        expect(byX.get(4)).toBe(9);

        // bucket 2 (x:6-8): min at x=7, max at x=6
        expect(byX.get(7)).toBe(2);
        expect(byX.get(6)).toBe(8);
    });
});
