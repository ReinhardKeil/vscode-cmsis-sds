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
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getInitialState } from '../../webview/bridge';
import { ConfigProvider, theme } from 'antd';
import { AudioViewer } from './components/audioViewer';
import { ImageViewer } from './components/imageViewer';
import { VideoViewer } from './components/videoViewer';
import { ImageFrame, SampleFrame } from '../../webview/protocol';
import { getIsDarkTheme } from '../../webview/utilities';


type InitialState = {
    mediaType?: 'image' | 'audio' | 'video';
    image?: { frames: ImageFrame[]; rangeStart?: number; width: number; height: number; totalFrames: number };
    audio?: {
        samples: SampleFrame[];
        rangeStart?: number;
        rangeEnd?: number;
        domainStart?: number;
        domainEnd?: number;
        decimationPreset?: 'accuracy' | 'performance';
        sampleRate: number;
        bitDepth: number;
        channels: number;
        totalSamples: number;
        totalRecords: number;
    };
    video?: { frames: ImageFrame[]; rangeStart?: number; width: number; height: number; fps: number; totalFrames: number };
    fileName?: string;
    error?: string;
};

function MediaViewerApp() {
    const initial = getInitialState<InitialState>({});

    if (initial.error) {
        return (
            <div className="error-page">
                <div className="error">
                    <h2>Media Viewer Error</h2>
                    <p>{initial.error}</p>
                </div>
            </div>
        );
    }

    let applet: React.ReactNode = null;
    if (initial.mediaType === 'image' && initial.image) { applet = <ImageViewer state={initial.image} filename={initial.fileName} />; }
    else if (initial.mediaType === 'audio' && initial.audio) { applet = <AudioViewer state={initial.audio} filename={initial.fileName} />; }
    else if (initial.mediaType === 'video' && initial.video) { applet = <VideoViewer state={initial.video} filename={initial.fileName} />; }
    else { applet = <div style={{ padding: 16 }}>No media content available.</div>; }

    return (
        <div className="page">
            {applet}
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
            <MediaViewerApp />
        </ConfigProvider>
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ThemedViewerApp />);
}
