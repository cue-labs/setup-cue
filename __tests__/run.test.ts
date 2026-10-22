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

import * as run from '../src/run'
import * as fs from 'fs';
import * as path from 'path';

// action.yml declares the interface workflows rely on. It must stay exactly
// that of cue-lang/setup-cue, so that switching changes only the uses: line.
const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

function section(name: string): string {
    return actionYml.match(new RegExp(`^${name}:\\n(?:[ ].*\\n)*`, 'm'))![0];
}

function keys(block: string): string[] {
    return [...block.matchAll(/^  ([\w-]+):$/gm)].map(m => m[1]);
}

describe('action.yml', () => {
    test('declares one input, version, required and defaulting to latest', () => {
        const inputs = section('inputs');
        expect(keys(inputs)).toEqual(['version']);
        expect(inputs).toMatch(/^    required: true$/m);
        expect(inputs).toMatch(/^    default: latest$/m);
    });

    test('declares one output, cue-path', () => {
        expect(keys(section('outputs'))).toEqual(['cue-path']);
    });

    test('runs on node24', () => {
        expect(actionYml).toMatch(/^  using: node24$/m);
    });
});

describe('releaseHost', () => {
    test('is an https URL ending in a slash', () => {
        const u = new URL(run.releaseHost);
        expect(u.protocol).toBe('https:');
        expect(run.releaseHost.endsWith('/')).toBe(true);
    });

    test('is the only place the source names the host', () => {
        const host = new URL(run.releaseHost).host;
        const srcDir = path.join(__dirname, '..', 'src');
        const count = fs.readdirSync(srcDir)
            .map(f => fs.readFileSync(path.join(srcDir, f), 'utf8').split(host).length - 1)
            .reduce((a, b) => a + b, 0);
        expect(count).toBe(1);
    });
});

describe('platforms', () => {
    test.each([
        ['linux', 'linux'],
        ['darwin', 'darwin'],
        ['win32', 'windows'],
        ['freebsd', 'freebsd'],
    ])('getGoOS(%s) is %s', (platform, goos) => {
        expect(run.getGoOS(platform as NodeJS.Platform)).toBe(goos);
    });

    test.each([
        ['x64', 'amd64'],
        ['arm64', 'arm64'],
        ['ia32', '386'],
        ['arm', 'arm'],
        ['s390x', 's390x'],
    ])('getGoArch(%s) is %s', (arch, goarch) => {
        expect(run.getGoArch(arch)).toBe(goarch);
    });

    test.each([
        ['linux', 'amd64', 'cue_v0.18.0_linux_amd64.tar.gz'],
        ['darwin', 'arm64', 'cue_v0.18.0_darwin_arm64.tar.gz'],
        ['windows', 'amd64', 'cue_v0.18.0_windows_amd64.zip'],
        ['windows', 'arm64', 'cue_v0.18.0_windows_arm64.zip'],
    ])('archiveName for %s/%s is %s', (goos, goarch, name) => {
        expect(run.archiveName('v0.18.0', goos, goarch)).toBe(name);
    });

    test('binaryName', () => {
        expect(run.binaryName('windows')).toBe('cue.exe');
        expect(run.binaryName('linux')).toBe('cue');
        expect(run.binaryName('darwin')).toBe('cue');
    });

    test('publishedPlatforms lists the archives in a checksum file', () => {
        const sums = new Map([
            ['cue_v0.18.0_windows_amd64.zip', 'a'],
            ['cue_v0.18.0_linux_amd64.tar.gz', 'b'],
            ['cue_v0.18.0_darwin_all.pkg', 'c'],
            ['cue_v0.18.0_windows_amd64.msi', 'd'],
            ['cue_v0.18.0_darwin_arm64.tar.gz', 'e'],
        ]);
        expect(run.publishedPlatforms(sums, 'v0.18.0')).toEqual(['darwin/arm64', 'linux/amd64', 'windows/amd64']);
    });
});

describe('version input', () => {
    test.each(['', '  ', 'latest', 'Latest', 'LATEST '])('isLatest(%j)', (input) => {
        expect(run.isLatest(input)).toBe(true);
    });

    test.each(['v0.18.0', 'v0.18.0-rc.1', 'lates'])('not isLatest(%j)', (input) => {
        expect(run.isLatest(input)).toBe(false);
    });

    test.each(['v0.18.0', 'v0.19.0-rc.1', 'v1.2.3-alpha.1.x-y', 'v10.20.30'])('isExactVersion(%j)', (v) => {
        expect(run.isExactVersion(v)).toBe(true);
    });

    test.each(['0.18.0', 'V0.18.0', 'v0.18', 'v01.2.3', '>=v0.18.0', 'v0.18.0+build', 'latest', ''])('not isExactVersion(%j)', (v) => {
        expect(run.isExactVersion(v)).toBe(false);
    });

    test('compareVersions orders by semantic version precedence', () => {
        const sorted = ['v0.19.0-rc.1', 'v0.18.1', 'v0.18.0', 'v0.18.0-rc.1', 'v0.18.0-alpha.2', 'v0.18.0-alpha.10', 'v0.9.0']
            .sort(run.compareVersions);
        expect(sorted).toEqual(['v0.9.0', 'v0.18.0-alpha.2', 'v0.18.0-alpha.10', 'v0.18.0-rc.1', 'v0.18.0', 'v0.18.1', 'v0.19.0-rc.1']);
    });

    test.each([
        ['0.18.0', 'v0.18.0'],
        ['V0.18.0', 'v0.18.0'],
        ['V0.19.0-RC.1', 'v0.19.0-rc.1'],
        ['v9.9.9', undefined],
        ['0.17.1', undefined],
    ])('suggestVersion(%j) is %j', (input, want) => {
        expect(run.suggestVersion(input, ['v0.18.0', 'v0.18.1', 'v0.19.0-rc.1'])).toBe(want);
    });
});

describe('parsing', () => {
    const url = 'https://example.com/x';

    test.each([
        ['v0.18.0\n', 'v0.18.0'],
        ['v0.18.0', 'v0.18.0'],
        [' v0.18.0 \r\nmore\n', 'v0.18.0'],
    ])('parseLatest(%j)', (text, want) => {
        expect(run.parseLatest(text, url)).toBe(want);
    });

    test.each(['', '\n', '  \n'])('parseLatest(%j) fails naming the URL', (text) => {
        expect(() => run.parseLatest(text, url)).toThrow(url);
    });

    test('parseIndex reads versions and ignores other fields', () => {
        const text = JSON.stringify({
            versions: [
                { version: 'v0.18.0', prerelease: false, added: 1 },
                { version: 'v0.19.0-rc.1', prerelease: true },
            ],
            other: true,
        });
        expect(run.parseIndex(text, url)).toEqual(['v0.18.0', 'v0.19.0-rc.1']);
    });

    test.each(['not json', '{}', '{"versions": {}}', '{"versions": [{"prerelease": true}]}'])('parseIndex(%j) fails naming the URL', (text) => {
        expect(() => run.parseIndex(text, url)).toThrow(url);
    });

    test('parseChecksums reads sha256sum output', () => {
        const a = 'a'.repeat(64);
        const b = 'B'.repeat(64);
        const sums = run.parseChecksums(`${a}  cue_v0.18.0_linux_amd64.tar.gz\n\n${b} *cue_v0.18.0_windows_amd64.zip\n`, url);
        expect([...sums.entries()]).toEqual([
            ['cue_v0.18.0_linux_amd64.tar.gz', a],
            ['cue_v0.18.0_windows_amd64.zip', 'b'.repeat(64)],
        ]);
    });

    test.each([
        'garbage',
        'abc  cue_v0.18.0_linux_amd64.tar.gz',
        `${'a'.repeat(64)}cue_v0.18.0_linux_amd64.tar.gz`,
    ])('parseChecksums fails on %j, naming the line and URL', (line) => {
        expect(() => run.parseChecksums(`${line}\n`, url)).toThrow(url);
        expect(() => run.parseChecksums(`${line}\n`, url)).toThrow(line);
    });
});
