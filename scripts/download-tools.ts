#!/usr/bin/env npx tsx

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

import { ArchiveFileAsset, Downloadable, Downloader, GitHubReleaseAsset, GitHubWorkflowAsset } from '@open-cmsis-pack/vsce-helper';
import { PackageJson } from 'type-fest';
import process from 'node:process';

type CmsisPackageJson = PackageJson & {
    cmsis: {
        sdsio?: string;
        sdsioNightly?: string;
    };
};

function splitGitReference(reference: string, owner: string, repo: string) {
    if (reference.includes('@')) {
        const parts = reference.split('@');
        reference = parts[1];
        const repoAndOwner = parts[0].split('/');
        repo = repoAndOwner[1]
        owner = repoAndOwner[0];
    }
    return { repo, owner, reference };
}

const sdsio: Downloadable = new Downloadable(
    'SDSIO', '',
    async (target) => {
        const { os, arch } = {
            'win32-x64': { os: 'windows', arch: '' },
            'win32-arm64': { os: 'windows', arch: '' },
            'linux-x64': { os: 'linux', arch: '' },
            'linux-arm64': { os: 'linux', arch: '-arm64' },
            'darwin-x64': { os: 'macos', arch: '' },
            'darwin-arm64': { os: 'macos', arch: '' },
        }[target];
        const json = await downloader.getPackageJson<CmsisPackageJson>();
        const reqVersion = json?.cmsis?.sdsio;
        if (reqVersion === undefined) {
            console.warn('No SDSIO version specified in package.json');
            return undefined;
        }
        // Here, reference is expected to be a release asset version
        const { repo, owner, reference } = splitGitReference(reqVersion, 'ARM-software', 'SDS-Framework');
        const releaseAsset = new GitHubReleaseAsset(
            owner, repo, reference,
            `sdsio-server-${os}${arch}-${reference}.zip`,
            { token: process.env.GITHUB_TOKEN });
        const asset = new ArchiveFileAsset(releaseAsset);
        return asset;
    },
)


const sdsioNightly: Downloadable = new Downloadable(
    'SDSIO', '',
    async (target) => {
        const { os, arch } = {
            'win32-x64': { os: 'windows', arch: '' },
            'win32-arm64': { os: 'windows', arch: '' },
            'linux-x64': { os: 'linux', arch: '' },
            'linux-arm64': { os: 'linux', arch: '-arm64' },
            'darwin-x64': { os: 'macos', arch: '' },
            'darwin-arm64': { os: 'macos', arch: '' },
        }[target];
        const json = await downloader.getPackageJson<CmsisPackageJson>();
        const workflow = json?.cmsis?.sdsioNightly;
        if (workflow === undefined) {
            console.warn('No SDSIO \'Nightly\' workflow specified in package.json (<repo>@<workflowname>)');
            return undefined;
        }
        // Here, reference is expected to be the name of the workflow yml file without file ending
        const { repo, owner, reference } = splitGitReference(workflow, 'sdsio', 'SDSIO');
        const assetPattern = (`sdsio-server-${os}${arch}-\\d+\\.\\d+\\.\\d+.*`);
        const asset = new GitHubWorkflowAsset(
            owner, repo, `${reference}.yml`,
            assetPattern,
            { token: process.env.GITHUB_TOKEN });
        return asset;
    },
)


// If no arguments are provided to the downloader script, all assets are downloaded
// in the order they are listed. In that case, 'sdsio' will overwrite 'sdsioNightly'.
const downloader = new Downloader({
    sdsioNightly,
    sdsio
});

await downloader
    .withCacheDir(await downloader.defaultCacheDir())
    .run();
