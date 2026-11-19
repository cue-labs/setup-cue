// Copyright 2021 The CUE Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as toolCache from '@actions/tool-cache';
import * as core from '@actions/core';

// releaseHost is where releases of CUE by CUE Labs are downloaded from.
// Every URL the action fetches is this host joined with one of these paths:
//
//	latest.txt                          the newest stable version, on one line
//	index.json                          {"versions": [{"version": "v0.18.0", ...}, ...]}
//	<version>/cue_<version>_checksums.txt  sha256sum output for the version's files
//	<version>/cue_<version>_<os>_<arch>.tar.gz  (.zip for windows)
//
// It is the only place the host is named.
export const releaseHost = 'https://dl.cue.dev/';

// toolCacheName is the name under which installations are recorded in the
// runner's tool cache. It differs from the name cue-lang/setup-cue uses, so
// that neither action ever picks up a binary the other installed.
const toolCacheName = 'cue-labs-cue';

export function getGoOS(platform: NodeJS.Platform = os.platform()): string {
    return platform === 'win32' ? 'windows' : platform;
}

export function getGoArch(arch: string = os.arch()): string {
    switch (arch) {
        case 'x64':
            return 'amd64';
        case 'ia32':
            return '386';
        default:
            return arch;
    }
}

export function archiveName(version: string, goos: string, goarch: string): string {
    const ext = goos === 'windows' ? 'zip' : 'tar.gz';
    return `cue_${version}_${goos}_${goarch}.${ext}`;
}

export function binaryName(goos: string): string {
    return goos === 'windows' ? 'cue.exe' : 'cue';
}

export function isLatest(input: string): boolean {
    const v = input.trim().toLowerCase();
    return v === '' || v === 'latest';
}

// exactVersion matches a version as releases name it: a leading "v" and a
// semantic version without build metadata.
const exactVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function isExactVersion(v: string): boolean {
    return exactVersion.test(v);
}

// compareVersions orders exact versions by semantic version precedence.
export function compareVersions(a: string, b: string): number {
    const pa = a.match(exactVersion)!;
    const pb = b.match(exactVersion)!;
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d !== 0) {
            return d;
        }
    }
    if (pa[4] === undefined || pb[4] === undefined) {
        // A release sorts after its pre-releases.
        return (pa[4] === undefined ? 1 : 0) - (pb[4] === undefined ? 1 : 0);
    }
    const xa = pa[4].split('.');
    const xb = pb[4].split('.');
    for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
        const na = /^\d+$/.test(xa[i]);
        const nb = /^\d+$/.test(xb[i]);
        if (na && nb) {
            const d = Number(xa[i]) - Number(xb[i]);
            if (d !== 0) {
                return d;
            }
        } else if (na !== nb) {
            return na ? -1 : 1;
        } else if (xa[i] !== xb[i]) {
            return xa[i] < xb[i] ? -1 : 1;
        }
    }
    return xa.length - xb.length;
}

// suggestVersion returns the listed version that input most likely meant,
// when it differs only by a missing "v" or by letter case.
export function suggestVersion(input: string, listed: string[]): string | undefined {
    const want = (input.startsWith('v') || input.startsWith('V') ? input : 'v' + input).toLowerCase();
    return listed.find(v => v.toLowerCase() === want);
}

// firstRelease returns the lowest stable version listed, or the lowest
// pre-release if no stable version is listed yet.
export function firstRelease(listed: string[]): string | undefined {
    const exact = listed.filter(isExactVersion).sort(compareVersions);
    return exact.find(v => !v.includes('-')) ?? exact[0];
}

export function parseLatest(text: string, url: string): string {
    const v = text.split('\n')[0].trim();
    if (v === '') {
        throw new Error(`the latest version file ${url} is empty`);
    }
    return v;
}

export function parseIndex(text: string, url: string): string[] {
    let index: any;
    try {
        index = JSON.parse(text);
    } catch (e) {
        throw new Error(`the release index ${url} is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(index?.versions) || !index.versions.every((v: any) => typeof v?.version === 'string')) {
        throw new Error(`the release index ${url} has no list of versions`);
    }
    return index.versions.map((v: any) => v.version);
}

// parseChecksums reads sha256sum output into a map from file name to digest.
export function parseChecksums(text: string, url: string): Map<string, string> {
    const sums = new Map<string, string>();
    for (const line of text.split('\n').map(l => l.replace(/\r$/, ''))) {
        if (line.trim() === '') {
            continue;
        }
        const m = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
        if (!m) {
            throw new Error(`the checksum file ${url} has a malformed line: ${line}`);
        }
        sums.set(m[2], m[1].toLowerCase());
    }
    return sums;
}

// publishedPlatforms lists the os/arch pairs a checksum file has archives for.
export function publishedPlatforms(sums: Map<string, string>, version: string): string[] {
    const prefix = `cue_${version}_`;
    const platforms: string[] = [];
    for (const name of sums.keys()) {
        if (!name.startsWith(prefix)) {
            continue;
        }
        const m = name.slice(prefix.length).match(/^([^_]+)_([^_.]+)\.(?:tar\.gz|zip)$/);
        if (m) {
            platforms.push(`${m[1]}/${m[2]}`);
        }
    }
    return platforms.sort();
}

async function download(url: string, what: string, dest?: string): Promise<string> {
    try {
        return await toolCache.downloadTool(url, dest);
    } catch (e) {
        throw new Error(`cannot download the ${what} ${url}: ${(e as Error).message}`);
    }
}

async function fetchText(url: string, what: string): Promise<string> {
    const file = await download(url, what);
    try {
        return fs.readFileSync(file, 'utf8');
    } finally {
        fs.rmSync(file, { force: true });
    }
}

async function sha256File(file: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

// install makes the requested version available in the tool cache and
// returns the path of its cue binary. Nothing is extracted or recorded in
// the cache until the archive matches its published checksum.
export async function install(input: string, host: string = releaseHost): Promise<string> {
    const url = (p: string) => new URL(p, host).href;
    const goos = getGoOS();
    const goarch = getGoArch();
    const exe = binaryName(goos);

    let version = input.trim();
    if (isLatest(version)) {
        const latestURL = url('latest.txt');
        version = parseLatest(await fetchText(latestURL, 'latest version file'), latestURL);
        core.info(`Latest version of CUE by CUE Labs: ${version} (from ${latestURL})`);
    }

    if (isExactVersion(version)) {
        const cached = toolCache.find(toolCacheName, version);
        if (cached) {
            core.info(`Using CUE ${version} from the tool cache`);
            return path.join(cached, exe);
        }
    }

    const indexURL = url('index.json');
    const listed = parseIndex(await fetchText(indexURL, 'release index'), indexURL);
    if (!listed.includes(version)) {
        let msg = `${version} is not a version of CUE by CUE Labs listed in ${indexURL}`;
        const suggestion = suggestVersion(version, listed);
        if (suggestion) {
            msg += ` (did you mean ${suggestion}?)`;
        }
        msg += '.';
        const first = firstRelease(listed);
        if (first) {
            msg += ` CUE by CUE Labs starts at ${first};`;
        }
        msg += ' earlier open-source releases are installed by cue-lang/setup-cue.';
        throw new Error(msg);
    }

    const name = archiveName(version, goos, goarch);
    const sumsURL = url(`${version}/cue_${version}_checksums.txt`);
    const sums = parseChecksums(await fetchText(sumsURL, 'checksum file'), sumsURL);
    const want = sums.get(name);
    if (want === undefined) {
        throw new Error(`CUE ${version} has no build for ${goos}/${goarch}; it publishes ${publishedPlatforms(sums, version).join(', ')} (from ${sumsURL})`);
    }

    const work = fs.mkdtempSync(path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 'cue-labs-setup-cue-'));
    try {
        const archiveURL = url(`${version}/${name}`);
        // Keep the archive's own name: extraction on Windows may need the .zip extension.
        const file = await download(archiveURL, 'archive', path.join(work, name));
        const got = await sha256File(file);
        if (got !== want) {
            throw new Error(`${name} from ${archiveURL} does not match ${sumsURL}: expected ${want}, got ${got}`);
        }
        core.info(`Verified ${name}: sha256 ${got}`);

        const dir = path.join(work, 'extracted');
        if (goos === 'windows') {
            await toolCache.extractZip(file, dir);
        } else {
            await toolCache.extractTar(file, dir);
        }
        if (!fs.existsSync(path.join(dir, exe))) {
            throw new Error(`${name} has no ${exe} at its root`);
        }
        const cached = await toolCache.cacheDir(dir, toolCacheName, version);
        const cuePath = path.join(cached, exe);
        fs.chmodSync(cuePath, 0o755);
        return cuePath;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

export async function run(host: string = releaseHost) {
    // An empty version means latest, as the input's default does.
    const input = core.getInput('version');
    const cuePath = await install(input, host);
    core.addPath(path.dirname(cuePath));
    core.setOutput('cue-path', cuePath);
    core.info(`CUE by CUE Labs installed at ${cuePath}`);
}

if (require.main === module) {
    run().catch(core.setFailed);
}
