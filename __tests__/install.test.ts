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

// These tests run the action end to end against a local copy of the release
// downloads, with real downloads, verification, extraction, and tool cache.

import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as run from '../src/run';
import {
    binaryContents, buildFixture, FixtureHost, makeArchive, platforms, RunnerEnv,
    sha256, tempDir,
} from './fixture';

// Building archives and extracting them runs external tools, which on Windows
// runners can take several seconds.
jest.setTimeout(60_000);

const goos = run.getGoOS();
const goarch = run.getGoArch();
const exe = run.binaryName(goos);

let root: string;
let host: FixtureHost | undefined;
let env: RunnerEnv | undefined;

beforeAll(() => {
    root = buildFixture();
});

beforeEach(() => {
    jest.spyOn(core, 'info').mockImplementation();
});

afterEach(async () => {
    env?.restore();
    env = undefined;
    await host?.stop();
    host = undefined;
    jest.restoreAllMocks();
});

async function setup(version: string): Promise<[FixtureHost, RunnerEnv]> {
    host = await FixtureHost.start(root);
    env = new RunnerEnv(version);
    return [host, env];
}

function archive(version: string): string {
    return `${version}/${run.archiveName(version, goos, goarch)}`;
}

function checksums(version: string): string {
    return `${version}/cue_${version}_checksums.txt`;
}

// expectInstalled checks that version was installed from the action's own
// tool-cache entry, put on PATH, and reported as cue-path.
function expectInstalled(env: RunnerEnv, version: string) {
    const dir = path.join(env.toolCache, 'cue-labs-cue', version.slice(1), os.arch());
    const cuePath = path.join(dir, exe);
    expect(env.paths()).toEqual([dir]);
    expect(env.outputs()).toEqual({ 'cue-path': cuePath });
    expect(fs.readFileSync(cuePath, 'utf8')).toBe(binaryContents(version, goos, goarch));
    expect(process.env['PATH']!.split(path.delimiter)[0]).toBe(dir);
}

// expectNothingInstalled checks that a failed run changed nothing a later
// step or run could use.
function expectNothingInstalled(env: RunnerEnv) {
    expect(env.paths()).toEqual([]);
    expect(env.outputs()).toEqual({});
    expect(env.cacheEntries().filter(e => e.startsWith('cue-labs-cue'))).toEqual([]);
}

describe('installing (User Story 1)', () => {
    test.each(['latest', 'Latest', ''])('version %j installs the latest stable version', async (input) => {
        const [host, env] = await setup(input);
        await run.run(host.url);
        expectInstalled(env, 'v0.18.1');
        expect(host.requests).toEqual(['latest.txt', 'index.json', checksums('v0.18.1'), archive('v0.18.1')]);
    });

    test.each(['v0.18.0', 'v0.19.0-rc.1'])('version %s installs that version', async (version) => {
        const [host, env] = await setup(version);
        await run.run(host.url);
        expectInstalled(env, version);
        expect(host.requests).toEqual(['index.json', checksums(version), archive(version)]);
    });
});

describe('verifying (User Story 2)', () => {
    test('an archive that does not match its checksum is not installed', async () => {
        const [host, env] = await setup('v0.18.0');
        host.override(archive('v0.18.0'), { body: 'tampered' });
        const want = sha256(fs.readFileSync(path.join(root, archive('v0.18.0'))));
        const err = run.run(host.url);
        await expect(err).rejects.toThrow(run.archiveName('v0.18.0', goos, goarch));
        await expect(err).rejects.toThrow(`expected ${want}, got ${sha256('tampered')}`);
        expectNothingInstalled(env);
    });

    test('a checksum file without the runner\'s archive fails, listing the published platforms', async () => {
        const [host, env] = await setup('v0.18.0');
        const lines = fs.readFileSync(path.join(root, checksums('v0.18.0')), 'utf8')
            .split('\n').filter(l => !l.endsWith(` ${run.archiveName('v0.18.0', goos, goarch)}`)).join('\n');
        host.override(checksums('v0.18.0'), { body: lines });
        const others = platforms.map(([o, a]) => `${o}/${a}`).filter(p => p !== `${goos}/${goarch}`).join(', ');
        const err = run.run(host.url);
        await expect(err).rejects.toThrow(`v0.18.0 has no build for ${goos}/${goarch}`);
        await expect(err).rejects.toThrow(others);
        expectNothingInstalled(env);
    });

    test('a missing checksum file fails, naming its URL', async () => {
        const [host, env] = await setup('v0.18.0');
        host.override(checksums('v0.18.0'), { status: 404 });
        const err = run.run(host.url);
        await expect(err).rejects.toThrow(host.url + checksums('v0.18.0'));
        await expect(err).rejects.toThrow('404');
        expectNothingInstalled(env);
        expect(host.requests).not.toContain(archive('v0.18.0'));
    });

    test('a malformed checksum file fails, naming the line', async () => {
        const [host, env] = await setup('v0.18.0');
        host.override(checksums('v0.18.0'), { body: 'not a checksum line\n' });
        await expect(run.run(host.url)).rejects.toThrow('not a checksum line');
        expectNothingInstalled(env);
    });

    test('an archive without cue at its root fails', async () => {
        const [host, env] = await setup('v0.18.0');
        const name = run.archiveName('v0.18.0', goos, goarch);
        const bad = path.join(tempDir('bad-'), name);
        makeArchive(bad, { 'not-cue': 'x' });
        const bytes = fs.readFileSync(bad);
        host.override(archive('v0.18.0'), { body: bytes });
        host.override(checksums('v0.18.0'), { body: `${sha256(bytes)}  ${name}\n` });
        await expect(run.run(host.url)).rejects.toThrow(`${name} has no ${exe} at its root`);
        expectNothingInstalled(env);
    });

    test('an exact version already installed by this action is reused without the network', async () => {
        const [host, env] = await setup('v0.18.0');
        await run.run(host.url);
        expectInstalled(env, 'v0.18.0');
        await host.stop();
        fs.writeFileSync(env.githubPath, '');
        fs.writeFileSync(env.githubOutput, '');
        await run.run(host.url);
        expectInstalled(env, 'v0.18.0');
        expect(host.requests).toEqual(['index.json', checksums('v0.18.0'), archive('v0.18.0')]);
    });

    test('a version cached by cue-lang/setup-cue is not reused', async () => {
        const [host, env] = await setup('v0.18.0');
        const theirs = path.join(env.toolCache, 'cue', '0.18.0', os.arch());
        fs.mkdirSync(theirs, { recursive: true });
        fs.writeFileSync(path.join(theirs, exe), 'open-source build');
        fs.writeFileSync(theirs + '.complete', '');
        await run.run(host.url);
        expectInstalled(env, 'v0.18.0');
        expect(host.requests).toContain(archive('v0.18.0'));
    });

    test('a transient server error is retried', async () => {
        const [host, env] = await setup('v0.18.0');
        host.override(archive('v0.18.0'), { status: 500, times: 1 });
        await run.run(host.url);
        expectInstalled(env, 'v0.18.0');
        expect(host.requests.filter(r => r === archive('v0.18.0'))).toHaveLength(2);
    });
});

describe('failing clearly (User Story 3)', () => {
    test('a version before CUE by CUE Labs points to cue-lang/setup-cue', async () => {
        const [host, env] = await setup('v0.17.1');
        const err = run.run(host.url);
        await expect(err).rejects.toThrow('v0.17.1 is not a version of CUE by CUE Labs');
        await expect(err).rejects.toThrow(host.url + 'index.json');
        // v0.18.0-rc.3 is listed, but v0.18.0 is the first stable release.
        await expect(err).rejects.toThrow('starts at v0.18.0;');
        await expect(err).rejects.toThrow('cue-lang/setup-cue');
        await expect(err).rejects.not.toThrow('did you mean');
        expectNothingInstalled(env);
    });

    test.each(['0.18.0', 'V0.18.0'])('%s suggests v0.18.0', async (input) => {
        const [host, env] = await setup(input);
        await expect(run.run(host.url)).rejects.toThrow('did you mean v0.18.0?');
        expectNothingInstalled(env);
    });

    test('an unknown version makes no suggestion', async () => {
        const [host] = await setup('v9.9.9');
        await expect(run.run(host.url)).rejects.toThrow(/^(?![\s\S]*did you mean)[\s\S]*v9\.9\.9 is not a version/);
    });

    test('a missing latest-stable pointer fails, naming its URL', async () => {
        const [host, env] = await setup('latest');
        host.override('latest.txt', { status: 404 });
        const err = run.run(host.url);
        await expect(err).rejects.toThrow(host.url + 'latest.txt');
        await expect(err).rejects.toThrow('404');
        expectNothingInstalled(env);
    });

    test('an empty latest-stable pointer fails, naming its URL', async () => {
        const [host, env] = await setup('latest');
        host.override('latest.txt', { body: '\n' });
        const err = run.run(host.url);
        await expect(err).rejects.toThrow(host.url + 'latest.txt');
        await expect(err).rejects.toThrow('empty');
        expectNothingInstalled(env);
    });

    test('a pointer naming an unlisted version fails', async () => {
        const [host, env] = await setup('latest');
        host.override('latest.txt', { body: 'v0.99.0\n' });
        await expect(run.run(host.url)).rejects.toThrow('v0.99.0 is not a version of CUE by CUE Labs');
        expectNothingInstalled(env);
    });

    test('a malformed index fails, naming its URL', async () => {
        const [host, env] = await setup('v0.18.0');
        host.override('index.json', { body: 'not json' });
        await expect(run.run(host.url)).rejects.toThrow(host.url + 'index.json');
        expectNothingInstalled(env);
    });

    test('an unsupported architecture fails, listing the published platforms', async () => {
        const [host, env] = await setup('v0.18.0');
        jest.spyOn(os, 'arch').mockReturnValue('s390x');
        const err = run.run(host.url);
        await expect(err).rejects.toThrow(`v0.18.0 has no build for ${goos}/s390x`);
        await expect(err).rejects.toThrow('darwin/amd64, darwin/arm64, linux/amd64, linux/arm64, windows/amd64, windows/arm64');
        expectNothingInstalled(env);
    });

    test('an unreachable host fails, naming the URL', async () => {
        const [host, env] = await setup('latest');
        const url = host.url;
        await host.stop();
        const err = run.run(url);
        await expect(err).rejects.toThrow(url + 'latest.txt');
        await expect(err).rejects.toThrow(/ECONNREFUSED/);
        expectNothingInstalled(env);
    });
});
