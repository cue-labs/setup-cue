// Copyright 2026 CUE Labs
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

// A local stand-in for the release host: a directory laid out as the release
// downloads are, served over loopback HTTP, with per-path overrides so that
// tests can serve a broken or missing file in place of the real one.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';

import { archiveName, binaryName, getGoArch, getGoOS } from '../src/run';

// The first listed version is a pre-release of the first stable one, as the
// release downloads list the release candidates published before v0.18.0.
export const versions = ['v0.18.0-rc.3', 'v0.18.0', 'v0.18.1', 'v0.19.0-rc.1'];
export const latest = 'v0.18.1';

export const platforms: [string, string][] = [
    ['darwin', 'amd64'],
    ['darwin', 'arm64'],
    ['linux', 'amd64'],
    ['linux', 'arm64'],
    ['windows', 'amd64'],
    ['windows', 'arm64'],
];

export function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// The contents of the placeholder binary in the runner's archive, so that a
// test can tell which version and platform it installed.
export function binaryContents(version: string, goos: string, goarch: string): string {
    return `placeholder cue ${version} ${goos}/${goarch}\n`;
}

// makeArchive writes an archive at dest holding the given files at its root,
// using the same tools the action's extraction relies on.
export function makeArchive(dest: string, files: { [name: string]: string }) {
    const stage = tempDir('stage-');
    for (const [name, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(stage, name), contents, { mode: 0o755 });
    }
    const names = Object.keys(files);
    if (dest.endsWith('.zip')) {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `Compress-Archive -Path ${names.map(n => `'${path.join(stage, n)}'`).join(',')} -DestinationPath '${dest}'`]);
    } else {
        execFileSync('tar', ['-czf', dest, '-C', stage, ...names]);
    }
    fs.rmSync(stage, { recursive: true, force: true });
}

export function sha256(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// buildFixture lays out every version in a fresh directory and returns its
// path. Each version directory holds what a release's does: an archive per
// platform, the installers, source.json, and the checksum file listing them
// all. Only the archive for the runner's own platform is a real archive; the
// other files are never downloaded, so they hold placeholder bytes.
export function buildFixture(): string {
    const root = tempDir('releases-');
    const goos = getGoOS();
    const goarch = getGoArch();
    fs.writeFileSync(path.join(root, 'latest.txt'), latest + '\n');
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({
        versions: versions.map(v => ({ version: v, prerelease: v.includes('-') })),
    }, null, 2) + '\n');
    for (const v of versions) {
        const dir = path.join(root, v);
        fs.mkdirSync(dir);
        for (const [o, a] of platforms) {
            const name = archiveName(v, o, a);
            if (o === goos && a === goarch) {
                makeArchive(path.join(dir, name), {
                    [binaryName(o)]: binaryContents(v, o, a),
                    'NOTICES.txt': 'placeholder notices\n',
                });
            } else {
                fs.writeFileSync(path.join(dir, name), `placeholder ${name}\n`);
            }
        }
        for (const name of [`cue_${v}_darwin_all.pkg`, `cue_${v}_windows_amd64.msi`, `cue_${v}_windows_arm64.msi`, 'source.json']) {
            fs.writeFileSync(path.join(dir, name), `placeholder ${name}\n`);
        }
        writeChecksums(dir, v);
    }
    return root;
}

export function writeChecksums(dir: string, version: string) {
    const sums = path.join(dir, `cue_${version}_checksums.txt`);
    const lines = fs.readdirSync(dir)
        .filter(n => n !== path.basename(sums))
        .sort()
        .map(n => `${sha256(fs.readFileSync(path.join(dir, n)))}  ${n}\n`);
    fs.writeFileSync(sums, lines.join(''));
}

export interface Override {
    status?: number;
    body?: string | Buffer;
    // times limits how many requests the override answers; unlimited if unset.
    times?: number;
}

export class FixtureHost {
    readonly requests: string[] = [];
    private readonly overrides = new Map<string, Override>();

    private constructor(readonly root: string, private readonly server: http.Server, readonly url: string) { }

    static async start(root: string): Promise<FixtureHost> {
        let host: FixtureHost;
        const server = http.createServer((req, res) => host.serve(req, res));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        host = new FixtureHost(root, server, `http://127.0.0.1:${port}/`);
        return host;
    }

    override(relPath: string, o: Override) {
        this.overrides.set(relPath, o);
    }

    async stop() {
        this.server.closeAllConnections();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private serve(req: http.IncomingMessage, res: http.ServerResponse) {
        const rel = decodeURIComponent(new URL(req.url!, this.url).pathname).replace(/^\//, '');
        this.requests.push(rel);
        const o = this.overrides.get(rel);
        if (o) {
            if (o.times !== undefined && --o.times <= 0) {
                this.overrides.delete(rel);
            }
            res.writeHead(o.status ?? 200);
            res.end(o.body ?? '');
            return;
        }
        const file = path.resolve(this.root, rel);
        if (!file.startsWith(this.root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200);
        res.end(fs.readFileSync(file));
    }
}

// RunnerEnv points the variables the Actions toolkit reads at fresh
// temporary paths, as a runner would set them for a job.
export class RunnerEnv {
    readonly toolCache = tempDir('toolcache-');
    readonly temp = tempDir('runnertemp-');
    readonly githubPath = path.join(tempDir('github-'), 'path');
    readonly githubOutput = path.join(path.dirname(this.githubPath), 'output');
    private readonly saved: { [k: string]: string | undefined } = {};

    constructor(version: string) {
        fs.writeFileSync(this.githubPath, '');
        fs.writeFileSync(this.githubOutput, '');
        this.set('RUNNER_TOOL_CACHE', this.toolCache);
        this.set('RUNNER_TEMP', this.temp);
        this.set('GITHUB_PATH', this.githubPath);
        this.set('GITHUB_OUTPUT', this.githubOutput);
        this.set('INPUT_VERSION', version);
        this.set('PATH', process.env['PATH']);
        const g = global as any;
        g.TEST_DOWNLOAD_TOOL_RETRY_MIN_SECONDS = 0;
        g.TEST_DOWNLOAD_TOOL_RETRY_MAX_SECONDS = 0;
    }

    private set(k: string, v: string | undefined) {
        this.saved[k] = process.env[k];
        process.env[k] = v;
    }

    restore() {
        for (const [k, v] of Object.entries(this.saved)) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    }

    // paths lists the directories the action added to PATH.
    paths(): string[] {
        return fs.readFileSync(this.githubPath, 'utf8').split(/\r?\n/).filter(l => l !== '');
    }

    // outputs parses the outputs the action set, in the runner's file format.
    outputs(): { [name: string]: string } {
        const out: { [name: string]: string } = {};
        const lines = fs.readFileSync(this.githubOutput, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^([^<]+)<<(.+)$/);
            if (!m) {
                continue;
            }
            const value: string[] = [];
            for (i++; i < lines.length && lines[i] !== m[2]; i++) {
                value.push(lines[i]);
            }
            out[m[1]] = value.join('\n');
        }
        return out;
    }

    // cacheEntries lists what the tool cache holds, relative to its root.
    cacheEntries(): string[] {
        const walk = (dir: string, depth: number): string[] => fs.readdirSync(dir).flatMap(n => {
            const p = path.join(dir, n);
            return depth > 1 || !fs.statSync(p).isDirectory() ? [path.relative(this.toolCache, p)] : walk(p, depth + 1);
        });
        return walk(this.toolCache, 0).map(p => p.split(path.sep).join('/')).sort();
    }
}
