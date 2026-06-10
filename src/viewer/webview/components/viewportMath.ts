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

export type ViewRange = [number, number];

export type ViewportClampOptions = {
    domainStart: number;
    domainEnd: number;
    minViewSpan: number;
};

export function clampViewRange(start: number, end: number, options: ViewportClampOptions): ViewRange {
    const { domainStart, domainEnd, minViewSpan } = options;

    if (domainEnd <= domainStart) {
        return [0, 1];
    }

    if (start > end) {
        [start, end] = [end, start];
    }

    let span = end - start;
    if (span < minViewSpan) {
        const center = (start + end) / 2;
        start = center - minViewSpan / 2;
        end = center + minViewSpan / 2;
        span = end - start;
    }

    if (start < domainStart) {
        end += domainStart - start;
        start = domainStart;
    }
    if (end > domainEnd) {
        start -= end - domainEnd;
        end = domainEnd;
    }

    start = Math.max(domainStart, start);
    end = Math.min(domainEnd, end);

    if (span <= 0) {
        return [domainStart, domainEnd];
    }

    return [start, end];
}

export function zoomInRange(viewRange: ViewRange, options: ViewportClampOptions): ViewRange {
    const center = (viewRange[0] + viewRange[1]) / 2;
    const range = (viewRange[1] - viewRange[0]) * 0.5;
    return clampViewRange(center - range / 2, center + range / 2, options);
}

export function zoomOutRange(viewRange: ViewRange, options: ViewportClampOptions): ViewRange {
    const center = (viewRange[0] + viewRange[1]) / 2;
    const range = (viewRange[1] - viewRange[0]) * 2;
    return clampViewRange(center - range / 2, center + range / 2, options);
}

export function fitRange(domainStart: number, domainEnd: number): ViewRange {
    if (domainEnd <= domainStart) {
        return [0, 1];
    }

    return [domainStart, domainEnd];
}
