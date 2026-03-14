/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Playwright E2E tests for the SDS Viewer webview panel.
 *
 * Tests toolbar buttons, canvas rendering, channel toggles,
 * and message sending (export, etc).
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

async function openViewer(page: Page): Promise<void> {
    await page.goto(`${baseUrl}/viewer`);
    await page.waitForSelector('#chart');
}

async function getMessages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__messages);
}

// ── Structure ───────────────────────────────────────────────

test.describe('Viewer Panel — Structure', () => {
    test('toolbar buttons exist', async ({ page }) => {
        await openViewer(page);

        await expect(page.locator('#btnZoomIn')).toBeVisible();
        await expect(page.locator('#btnZoomOut')).toBeVisible();
        await expect(page.locator('#btnFit')).toBeVisible();
        await expect(page.locator('#btnExport')).toBeVisible();
    });

    test('chart canvas is rendered', async ({ page }) => {
        await openViewer(page);

        const canvas = page.locator('#chart');
        await expect(canvas).toBeVisible();

        // Canvas should have non-zero dimensions
        const box = await canvas.boundingBox();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);
    });

    test('channel toggle buttons are created from data', async ({ page }) => {
        await openViewer(page);

        const toggleContainer = page.locator('#channelToggles');
        await expect(toggleContainer).toBeVisible();

        // Should have 3 toggles for x, y, z channels
        const toggles = toggleContainer.locator('.channel-toggle');
        await expect(toggles).toHaveCount(3);

        // Check labels contain channel names
        const texts = await toggles.allTextContents();
        expect(texts.some(t => t.includes('x'))).toBe(true);
        expect(texts.some(t => t.includes('y'))).toBe(true);
        expect(texts.some(t => t.includes('z'))).toBe(true);
    });

    test('stats bar displays file info', async ({ page }) => {
        await openViewer(page);

        const statsBar = page.locator('#statsBar');
        await expect(statsBar).toBeVisible();

        const text = await statsBar.textContent();
        expect(text).toBeTruthy();
        // Should contain record count or file info
        expect(text!.length).toBeGreaterThan(0);
    });
});

// ── Interactions ────────────────────────────────────────────

test.describe('Viewer Panel — Interactions', () => {
    test('Export button sends exportCsv message', async ({ page }) => {
        await openViewer(page);
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.click('#btnExport');

        const msgs = await getMessages(page);
        expect(msgs.some((m: any) => m.command === 'exportCsv')).toBe(true);
    });

    test('channel toggle buttons can be clicked', async ({ page }) => {
        await openViewer(page);

        const firstToggle = page.locator('#channelToggles .channel-toggle').first();
        await expect(firstToggle).toBeVisible();

        // Click to toggle off — should remove 'active' class
        await firstToggle.click();
        await expect(firstToggle).not.toHaveClass(/active/);

        // Click again to toggle on — should re-add 'active' class
        await firstToggle.click();
        await expect(firstToggle).toHaveClass(/active/);
    });

    test('zoom buttons are clickable without errors', async ({ page }) => {
        await openViewer(page);

        // These should not throw — just verify no console errors
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        await page.click('#btnZoomIn');
        await page.click('#btnZoomIn');
        await page.click('#btnZoomOut');
        await page.click('#btnFit');

        expect(errors).toEqual([]);
    });
});

// ── Experimental features hidden by default ─────────────────

test.describe('Viewer Panel — Experimental', () => {
    test('filter and FFT buttons are hidden when experimental=false', async ({ page }) => {
        await openViewer(page);

        // These buttons should not exist when experimental is false
        const filterBtn = page.locator('#btnFilter');
        const fftBtn = page.locator('#btnFFT');
        const statsBtn = page.locator('#btnStats');

        await expect(filterBtn).toHaveCount(0);
        await expect(fftBtn).toHaveCount(0);
        await expect(statsBtn).toHaveCount(0);
    });
});
