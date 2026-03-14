# SDS Tools

VS Code extension for Arm Synchronous Data Stream (SDS) — record, view, and export sensor data.

Part of the [OpenCMSIS](https://github.com/Open-CMSIS-Pack) ecosystem.

## Features

- **SDS Recorder** — Record data via serial, USB, socket, or demo (sinewave) transports
- **SDS Viewer** — Waveform visualization for sensor data streams
- **Media Viewer** — View image, audio, and video SDS data
- **CSV Export** — Export SDS binary data to CSV
- **Metadata Editor** — Create and edit SDS metadata (YAML)
- **Diagnostics** — Validate SDS files and inspect server/recording events

## Getting Started

1. Install from VSIX: `code --install-extension cmsis-sds-0.9.0.vsix`
2. Open a folder containing `.sds` files
3. Use the **SDS Tools** sidebar to browse and interact with your data

## Building

```bash
npm install
npm run compile      # TypeScript compilation (development)
npm run package      # Build VSIX (bundled + minified)
```

## Testing

```bash
npm run test:unit          # Unit tests (Vitest)
npm run test:integration   # Integration tests (Vitest)
npm run test:e2e           # E2E tests (Playwright)
```

## License

Apache-2.0
