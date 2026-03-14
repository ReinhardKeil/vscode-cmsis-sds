/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Playwright E2E tests for the SDS Media Viewer webview panel.
 *
 * Tests image, audio, and video sub-viewers:
 *  - Canvas rendering
 *  - Frame navigation (prev/next/slider)
 *  - Play/pause for video
 *  - Toolbar buttons
 */

import { test, expect, Page } from '@playwright/test';
import { startServer } from './helpers/webview-server';
import * as http from 'http';

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
    const result = await startServer();
    server = result.server;
    baseUrl = result.baseUrl;
});

test.afterAll(async () => {
    server.close();
});

async function getMessages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__messages);
}

// ── Image Viewer ────────────────────────────────────────────

test.describe('Media Viewer — Image', () => {
    test('canvas renders at correct dimensions', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#canvas');

        const canvas = page.locator('#canvas');
        await expect(canvas).toBeVisible();

        const width = await canvas.getAttribute('width');
        const height = await canvas.getAttribute('height');
        expect(width).toBe('4');
        expect(height).toBe('4');
    });

    test('frame navigation buttons exist', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#canvas');

        await expect(page.locator('#btnPrev')).toBeVisible();
        await expect(page.locator('#btnNext')).toBeVisible();
        await expect(page.locator('#slider')).toBeVisible();
    });

    test('frame info shows current frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#frameInfo');

        const info = await page.locator('#frameInfo').textContent();
        expect(info).toContain('1/3');
    });

    test('clicking Next advances frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#canvas');

        await page.click('#btnNext');

        const info = await page.locator('#frameInfo').textContent();
        expect(info).toContain('2/3');

        // Slider should also advance
        const sliderVal = await page.locator('#slider').inputValue();
        expect(sliderVal).toBe('1');
    });

    test('clicking Prev goes back', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#canvas');

        // Go forward then back
        await page.click('#btnNext');
        await page.click('#btnPrev');

        const info = await page.locator('#frameInfo').textContent();
        expect(info).toContain('1/3');
    });

    test('slider changes frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#canvas');

        await page.fill('#slider', '2');
        await page.locator('#slider').dispatchEvent('input');

        const info = await page.locator('#frameInfo').textContent();
        expect(info).toContain('3/3');
    });

    test('toolbar zoom buttons exist', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('#canvas');

        await expect(page.locator('#btnZoomIn')).toBeVisible();
        await expect(page.locator('#btnZoomOut')).toBeVisible();
        await expect(page.locator('#btnFit')).toBeVisible();
    });
});

// ── Audio Viewer ────────────────────────────────────────────

test.describe('Media Viewer — Audio', () => {
    test('waveform canvas renders', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('#waveform');

        const canvas = page.locator('#waveform');
        await expect(canvas).toBeVisible();

        const box = await canvas.boundingBox();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);
    });

    test('toolbar buttons exist', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('#waveform');

        await expect(page.locator('#btnZoomIn')).toBeVisible();
        await expect(page.locator('#btnZoomOut')).toBeVisible();
        await expect(page.locator('#btnFit')).toBeVisible();
    });

    test('zoom buttons work without errors', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('#waveform');

        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        await page.click('#btnZoomIn');
        await page.click('#btnZoomOut');
        await page.click('#btnFit');

        expect(errors).toEqual([]);
    });
});

// ── Video Viewer ────────────────────────────────────────────

test.describe('Media Viewer — Video', () => {
    test('canvas renders at correct dimensions', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('#canvas');

        const canvas = page.locator('#canvas');
        await expect(canvas).toBeVisible();

        const width = await canvas.getAttribute('width');
        const height = await canvas.getAttribute('height');
        expect(width).toBe('4');
        expect(height).toBe('4');
    });

    test('play button exists and shows Play initially', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('#btnPlay');

        const playBtn = page.locator('#btnPlay');
        await expect(playBtn).toBeVisible();
        const text = await playBtn.textContent();
        expect(text).toContain('Play');
    });

    test('clicking Play toggles to Pause', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('#btnPlay');

        await page.click('#btnPlay');

        const text = await page.locator('#btnPlay').textContent();
        expect(text).toContain('Pause');

        // Click again to pause
        await page.click('#btnPlay');
        const text2 = await page.locator('#btnPlay').textContent();
        expect(text2).toContain('Play');
    });

    test('frame navigation works', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('#canvas');

        const info1 = await page.locator('#frameInfo').textContent();
        expect(info1).toContain('1/5');

        await page.click('#btnNext');
        const info2 = await page.locator('#frameInfo').textContent();
        expect(info2).toContain('2/5');

        await page.click('#btnNext');
        await page.click('#btnNext');
        const info4 = await page.locator('#frameInfo').textContent();
        expect(info4).toContain('4/5');

        await page.click('#btnPrev');
        const info3 = await page.locator('#frameInfo').textContent();
        expect(info3).toContain('3/5');
    });

    test('Next stops playback', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('#btnPlay');

        // Start playing
        await page.click('#btnPlay');
        const playing = await page.locator('#btnPlay').textContent();
        expect(playing).toContain('Pause');

        // Click Next — should stop playback
        await page.click('#btnNext');
        const stopped = await page.locator('#btnPlay').textContent();
        expect(stopped).toContain('Play');
    });

    test('slider updates frame display', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('#canvas');

        await page.fill('#slider', '3');
        await page.locator('#slider').dispatchEvent('input');

        const info = await page.locator('#frameInfo').textContent();
        expect(info).toContain('4/5');
    });
});
