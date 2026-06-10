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

import { ImageFrame } from "./protocol";

// Regex matching:
//   <stream>.<index>.sds
//   <stream>.<index>.p.sds
//   <stream>.<label>.<index>.sds
//   <stream>.<label>.<index>.p.sds
// where <label> may contain one or more dot-separated segments.
export const SDS_FILE_MATCHER = /^([^.]+)((?:\.[^.]+)*)\.(\d+)(\.p)?\.sds$/i;

export function isSdsFile(fileName: string): boolean {
    return SDS_FILE_MATCHER.test(fileName);
}

const decodedFrameCache = new WeakMap<ImageFrame, Map<string, ImageData>>();

export function decodeFrame(frame: ImageFrame, width: number, height: number): ImageData {
    const cacheKey = `${width}x${height}`;
    const cachedFrames = decodedFrameCache.get(frame);
    const cachedImage = cachedFrames?.get(cacheKey);
    if (cachedImage) {
        return cachedImage;
    }

    const raw = atob(frame.rgbaBase64);
    const rawLength = raw.length;
    const arr = new Uint8ClampedArray(rawLength);
    for (let i = 0; i < rawLength; i++) {
        arr[i] = raw.charCodeAt(i);
    }

    const imageData = new ImageData(arr, width, height);
    const nextCachedFrames = cachedFrames ?? new Map<string, ImageData>();
    nextCachedFrames.set(cacheKey, imageData);
    if (!cachedFrames) {
        decodedFrameCache.set(frame, nextCachedFrames);
    }

    return imageData;
}

export const getIsDarkTheme = () => {
    const classList = document.body.classList;
    return classList.contains('vscode-dark') || classList.contains('vscode-high-contrast');
};