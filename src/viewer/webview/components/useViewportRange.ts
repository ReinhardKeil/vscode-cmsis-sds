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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clampViewRange, fitRange, ViewRange, zoomInRange, zoomOutRange } from './viewportMath';

export type UseViewportRangeOptions = {
    domainStart: number;
    domainEnd: number;
    minSpanDivisor?: number;
};

export function useViewportRange({ domainStart, domainEnd, minSpanDivisor = 1000 }: UseViewportRangeOptions) {
    const domainSpan = Math.max(domainEnd - domainStart, 0.001);
    const minViewSpan = Math.max(domainSpan / minSpanDivisor, 0.001);
    const sliderStep = Math.max(domainSpan / minSpanDivisor, 0.0001);

    const clampOptions = useMemo(
        () => ({ domainStart, domainEnd, minViewSpan }),
        [domainEnd, domainStart, minViewSpan]
    );

    const [viewRange, setViewRange] = useState<ViewRange>(() => [domainStart, domainEnd]);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        setViewRange([domainStart, domainEnd]);
    }, [domainEnd, domainStart]);

    const clampRange = useCallback(
        (start: number, end: number): ViewRange => clampViewRange(start, end, clampOptions),
        [clampOptions]
    );

    const setViewRangeClamped = useCallback(
        (start: number, end: number) => {
            setViewRange(clampRange(start, end));
        },
        [clampRange]
    );

    const onZoomIn = useCallback(() => {
        setViewRange((prev) => zoomInRange(prev, clampOptions));
    }, [clampOptions]);

    const onZoomOut = useCallback(() => {
        setViewRange((prev) => zoomOutRange(prev, clampOptions));
    }, [clampOptions]);

    const onFit = useCallback(() => {
        setViewRange(fitRange(domainStart, domainEnd));
    }, [domainEnd, domainStart]);

    const onSliderChange = useCallback(
        (value: number[]) => {
            if (value.length !== 2) {
                return;
            }

            setIsDragging(true);
            setViewRangeClamped(value[0], value[1]);
        },
        [setViewRangeClamped]
    );

    const onSliderAfterChange = useCallback(() => {
        setIsDragging(false);
    }, []);

    return {
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
    };
}
