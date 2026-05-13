[![License Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-green?label=LICENSE)](https://github.com/Open-CMSIS-Pack/vscode-cmsis-sds/blob/main/LICENSE)
[![CI Build and Test](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/vscode-cmsis-sds/ci.yml?logo=arm&logoColor=0091bd&label=CI%20Build%20and%20Test)](https://github.com/Open-CMSIS-Pack/vscode-cmsis-sds/actions/workflows/ci.yml?query=branch:main)
[![Markdown Lint](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/vscode-cmsis-sds/markdown.yml?logo=arm&logoColor=0091bd&label=Markdown%20Lint)](https://github.com/Open-CMSIS-Pack/vscode-cmsis-sds/actions/workflows/markdown.yml?query=branch:main)
[![CodeQL Analysis](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/vscode-cmsis-sds/codeql.yml?logo=arm&logoColor=0091bd&label=CodeQL%20Analysis)](https://github.com/Open-CMSIS-Pack/vscode-cmsis-sds/actions/workflows/codeql.yml?query=branch:main)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/Open-CMSIS-Pack/vscode-cmsis-sds/badge)](https://securityscorecards.dev/viewer/?uri=github.com/Open-CMSIS-Pack/vscode-cmsis-sds)
[![Dependency Review](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/vscode-cmsis-sds/dependency-review.yml?logo=arm&logoColor=0091bd&label=Dependency%20Review)](https://github.com/Open-CMSIS-Pack/vscode-cmsis-sds/actions/workflows/dependency-review.yml?query=branch:main)

# Arm SDS for VS Code

The Arm SDS extension for VS Code simplifies data capturing and regression testing with the [SDS-Framework](https://www.keil.arm.com/packs/sds-arm).
The extension is an user interface for the [SDSIO-Server](https://arm-software.github.io/SDS-Framework/main/utilities.html#sdsio-server) that is configured using an `*.sdsio.yml` control file.

## SDS View

The **SDS View** shows SDS data files in the directories that are configured in the `*.sdsio.yml` control file.
At start it allows to create or open a `*.sdsio.yml` control file.

![SDS View context menu](media/screenshots/sds-context-menu.png "SDS View context menu")

Action Buttons:

- **Record** captures new SDS data files from the target.
- **Playback** starts the regression test using the `play:` steps defined in the `*.sdsio.yml` control file.

When a SDS data file is opened a corresponding [metadata file](https://arm-software.github.io/SDS-Framework/main/theory.html#yaml-metadata-format) provides information for formatting.
The data viewer provide a cursor that synchronies multiple data streams.

Example Video Stream:

![sds data view](./media/screenshots/data-video-telemtry.png)

Example Audio Stream:

![sds data audio](./media/screenshots/data-audio.png)

## Usage

### 1. Create a Control File

![file explorer if showing create and select buttons if no sdsio project is opened](./media/screenshots/file-explorer-empty.png)

Open the SDS Tools sidebar (Activity Bar icon). Click **New SDS Configuration** and enter a name for your project (e.g., `target-a`). This creates a `target-a.sdsio.yml` file in your workspace root with a template.

The file looks like:

```yaml
sdsio:
  interface:
    usb:
  workdir: .
  metadir: .
  # flag-info:
  #   - 0: Flag 0
  #   - 1: Flag 1
```

### 2. Configure Paths & Flags

Edit your `.sdsio.yml` to set:

- `workdir` — directory where SDS recording files are saved (`.sds` files)
- `metadir` — directory containing metadata files (`.sds.yml` files)
- `flag-info` — custom labels for flags 0–7 (optional)

Example:

```yaml
workdir: ./recordings
metadir: ./metadata
flag-info:
  - 0: Start
  - 1: Trigger
  - 2: Error
```

### 3. Open a Recorder Session

![sdsio flags view without active connection](./media/screenshots/sdsio-flags-connect.png)

Click the **Connect** button in the SDSIO Interface view (sidebar). If `tools/sdsio-server` is available, the extension launches it with your active `.sdsio.yml` as the control file. Once connected:

- **Record** — Start recording SDS data from the device
- **Play** — Play back previously recorded data
- **Flags** — Toggle flags 0–7 to control behavior on the device

Renamed flag labels appear immediately and persist in your `.sdsio.yml`.

![alt text](media/screenshots/sdsio-flags-rename.png)

### 4. View & Export Your Data

The SDS File explorer shows the SDS data files. 
## Links

- [SDS-Framework](https://arm-software.github.io/SDS-Framework/main/index.html)

## License

Apache-2.0
