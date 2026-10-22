# `setup-cue`

***Install CUE by CUE Labs, the official distribution of [CUE](https://cue.dev),
on your GitHub Actions runner***

Use this action in your GitHub Actions workflow to install a version of the
`cue` command from CUE by CUE Labs. The input `version` is a
[version](https://go.dev/ref/mod#versions) string like `v0.18.0` or
`v0.19.0-rc.1`, or `latest` (the default) for the newest stable release.

```
- uses: cue-labs/setup-cue@v2
  with:
    version: '<version>' # default is latest
  id: install
```

Every download is checked against the SHA-256 checksums published with its
release before it is unpacked; a download that does not match fails the step
and installs nothing. Releases are downloaded from the release downloads of CUE
by CUE Labs, not from GitHub.

## Switching from `cue-lang/setup-cue`

`cue-lang/setup-cue` installs the open-source build of CUE. This action takes
the same input and sets the same output, so switching to CUE by CUE Labs
changes one line:

```diff
-- uses: cue-lang/setup-cue@v2
+- uses: cue-labs/setup-cue@v2
```

CUE by CUE Labs starts at v0.18.0. A workflow that asks for an earlier version
fails with a message saying so; earlier open-source releases are installed by
`cue-lang/setup-cue`.

## Inputs and outputs

The input and output schemas are best described using CUE itself:

```cue
#inputs: {
	// Version of CUE: an exact version such as "v0.18.0", or "latest"
	version: *"latest" | string
}

#outputs: {
	// Path to the cached CUE binary
	"cue-path": string
}
```

Please refer to [`action.yml`](action.yml) for more details.

The directory holding the `cue` binary is prepended to the `PATH` environment
variable, so `cue` can be run directly in later workflow steps. Its path is
also stored in the `cue-path` output. A version installed once is reused by
later jobs on the same runner without downloading it again.

This action runs on Node 24, which requires Actions Runner v2.327.1 or later.
GitHub-hosted runners are new enough; self-hosted runners and GitHub
Enterprise Server installations may need updating. Linux, macOS, and Windows
runners on amd64 and arm64 are supported.

## Issues

Please raise issues with this action in this repository's
[issue tracker](https://github.com/cue-labs/setup-cue/issues).

## Contributing

Changes are made as pull requests against this repository.

## Thanks

This action is derived from
[`cue-lang/setup-cue`](https://github.com/cue-lang/setup-cue), an initial
version of which was graciously donated to the CUE project by
[Christian Bargmann](https://github.com/cbrgm) and the folks from [MOIA
GmbH](https://github.com/moia-oss).
