/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Playwright E2E tests for the SDS Recorder webview panel.
 *
 * Tests UI behavior: mode switching, button states, config panels,
 * message sending, and status updates via injected messages.
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

/** Navigate to the recorder panel and wait for the script to initialize. */
async function openRecorder(page: Page): Promise<void> {
    await page.goto(`${baseUrl}/recorder`);
    await page.waitForSelector('#mode');
}

/** Get the list of captured outbound messages from the webview. */
async function getMessages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__messages);
}

/** Simulate an extension→webview message. */
async function postToWebview(page: Page, msg: any): Promise<void> {
    await page.evaluate((m) => (window as any).__postToWebview(m), msg);
}

// ── Default State ───────────────────────────────────────────

test.describe('Recorder Panel — Default State', () => {
    test('USB mode selected by default, start enabled, stop disabled', async ({ page }) => {
        await openRecorder(page);

        const mode = await page.locator('#mode').inputValue();
        expect(mode).toBe('usb');

        await expect(page.locator('#btnStart')).toBeEnabled();
        await expect(page.locator('#btnStop')).toBeDisabled();
    });

    test('status panel is hidden initially', async ({ page }) => {
        await openRecorder(page);
        await expect(page.locator('#statusPanel')).not.toHaveClass(/active/);
    });

    test('server state shows "Stopped"', async ({ page }) => {
        await openRecorder(page);
        await expect(page.locator('#serverStateText')).toHaveText('Stopped');
        await expect(page.locator('#serverState')).toHaveClass(/stopped/);
    });
});

// ── Mode Switching ──────────────────────────────────────────

test.describe('Recorder Panel — Mode Switching', () => {
    test('selecting Serial shows serial config, hides others', async ({ page }) => {
        await openRecorder(page);
        await page.selectOption('#mode', 'serial');

        await expect(page.locator('#serialConfig')).toBeVisible();
        await expect(page.locator('#socketConfig')).not.toBeVisible();
        await expect(page.locator('#demoConfig')).not.toBeVisible();
    });

    test('selecting Socket shows socket config, hides others', async ({ page }) => {
        await openRecorder(page);
        await page.selectOption('#mode', 'socket');

        await expect(page.locator('#socketConfig')).toBeVisible();
        await expect(page.locator('#serialConfig')).not.toBeVisible();
        await expect(page.locator('#demoConfig')).not.toBeVisible();
    });

    test('selecting Demo shows demo config, hides others', async ({ page }) => {
        await openRecorder(page);
        await page.selectOption('#mode', 'demo');

        await expect(page.locator('#demoConfig')).toBeVisible();
        await expect(page.locator('#serialConfig')).not.toBeVisible();
        await expect(page.locator('#socketConfig')).not.toBeVisible();
    });

    test('selecting USB hides all config panels', async ({ page }) => {
        await openRecorder(page);
        await page.selectOption('#mode', 'serial');
        await expect(page.locator('#serialConfig')).toBeVisible();

        await page.selectOption('#mode', 'usb');
        await expect(page.locator('#serialConfig')).not.toBeVisible();
        await expect(page.locator('#socketConfig')).not.toBeVisible();
        await expect(page.locator('#demoConfig')).not.toBeVisible();
    });

    test('switching to Serial triggers getSerialPorts message', async ({ page }) => {
        await openRecorder(page);
        // Clear initial messages (getServerState fires on load)
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.selectOption('#mode', 'serial');

        const msgs = await getMessages(page);
        const portMsg = msgs.find((m: any) => m.command === 'getSerialPorts');
        expect(portMsg).toBeDefined();
    });
});

// ── Start Recording ─────────────────────────────────────────

test.describe('Recorder Panel — Start Recording', () => {
    test('clicking Start sends startRecording with correct config', async ({ page }) => {
        await openRecorder(page);
        await page.fill('#outputDir', './my_output');
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.click('#btnStart');

        const msgs = await getMessages(page);
        const startMsg = msgs.find((m: any) => m.command === 'startRecording');
        expect(startMsg).toBeDefined();
        expect(startMsg.config.mode).toBe('usb');
        expect(startMsg.config.streamName).toBeUndefined();
        expect(startMsg.config.outputDirectory).toBe('./my_output');
    });

    test('clicking Start in demo mode sends demo config', async ({ page }) => {
        await openRecorder(page);
        await page.selectOption('#mode', 'demo');
        await page.fill('#frequency', '200');
        await page.fill('#channels', 'a, b');
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.click('#btnStart');

        const msgs = await getMessages(page);
        const startMsg = msgs.find((m: any) => m.command === 'startRecording');
        expect(startMsg.config.mode).toBe('demo');
        expect(startMsg.config.streamName).toBe('Sensors');
        expect(startMsg.config.frequency).toBe(200);
        expect(startMsg.config.channels).toEqual(['a', 'b']);
    });
});

// ── Extension Messages (Inbound) ────────────────────────────

test.describe('Recorder Panel — Inbound Messages', () => {
    test('recordingStarted shows status panel and disables start', async ({ page }) => {
        await openRecorder(page);
        await postToWebview(page, {
            command: 'recordingStarted',
            isHardwareMode: false,
        });

        await expect(page.locator('#statusPanel')).toHaveClass(/active/);
        await expect(page.locator('#btnStart')).toBeDisabled();
        await expect(page.locator('#btnStop')).toBeEnabled();
    });

    test('recordingStopped hides status panel and resets buttons', async ({ page }) => {
        await openRecorder(page);
        // Start first
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: false });
        await expect(page.locator('#statusPanel')).toHaveClass(/active/);

        // Then stop
        await postToWebview(page, { command: 'recordingStopped' });

        await expect(page.locator('#statusPanel')).not.toHaveClass(/active/);
        await expect(page.locator('#btnStart')).toBeEnabled();
        await expect(page.locator('#btnStop')).toBeDisabled();
    });

    test('serverStateChanged updates state indicator', async ({ page }) => {
        await openRecorder(page);

        await postToWebview(page, { command: 'serverStateChanged', state: 'waiting' });
        await expect(page.locator('#serverState')).toHaveClass(/waiting/);
        await expect(page.locator('#serverStateText')).toHaveText('Waiting for device...');

        await postToWebview(page, { command: 'serverStateChanged', state: 'connected' });
        await expect(page.locator('#serverState')).toHaveClass(/connected/);
        await expect(page.locator('#serverStateText')).toHaveText('Device connected');

        await postToWebview(page, { command: 'serverStateChanged', state: 'recording' });
        await expect(page.locator('#serverState')).toHaveClass(/recording/);
        await expect(page.locator('#serverStateText')).toHaveText('Recording data');
    });

    test('serialPorts populates port dropdown', async ({ page }) => {
        await openRecorder(page);
        await page.selectOption('#mode', 'serial');

        await postToWebview(page, {
            command: 'serialPorts',
            ports: ['/dev/ttyACM0', '/dev/ttyUSB1', 'COM3'],
        });

        const options = await page.locator('#serialPort option').allTextContents();
        expect(options).toContain('/dev/ttyACM0');
        expect(options).toContain('/dev/ttyUSB1');
        expect(options).toContain('COM3');
    });

    test('serverEvent appends log entries', async ({ page }) => {
        await openRecorder(page);
        // Show log panel by starting a hardware recording
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: true });
        await expect(page.locator('#logPanel')).toBeVisible();

        await postToWebview(page, {
            command: 'serverEvent',
            event: { type: 'log', message: 'Server started on port 5050' },
        });
        await postToWebview(page, {
            command: 'serverEvent',
            event: { type: 'error', message: 'Connection failed' },
        });

        const logLines = page.locator('#logPanel .log-line');
        await expect(logLines).toHaveCount(2);
        await expect(logLines.nth(0)).toHaveText('Server started on port 5050');
        await expect(logLines.nth(1)).toHaveText('Connection failed');
        await expect(logLines.nth(1)).toHaveClass(/error/);
    });

    test('recordingStatus updates stats display', async ({ page }) => {
        await openRecorder(page);
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: false });

        await postToWebview(page, {
            command: 'recordingStatus',
            recordCount: 42,
            totalBytes: 2048,
            elapsed: 5000,
        });

        await expect(page.locator('#statRecords')).toHaveText('42');
        await expect(page.locator('#statSize')).toHaveText('2.0 KB');
        await expect(page.locator('#statElapsed')).toHaveText('5.0s');
    });
});

// ── Stop Recording ──────────────────────────────────────────

test.describe('Recorder Panel — Stop Recording', () => {
    test('clicking Stop sends stopRecording message', async ({ page }) => {
        await openRecorder(page);
        // Enable stop button via recordingStarted
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: false });
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.click('#btnStop');

        const msgs = await getMessages(page);
        expect(msgs.some((m: any) => m.command === 'stopRecording')).toBe(true);
    });
});
