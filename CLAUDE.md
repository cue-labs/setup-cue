# setup-cue

A GitHub Action which installs CUE by CUE Labs, the official distribution of
CUE, on a runner and adds it to `PATH`. The action is TypeScript, bundled into a single JavaScript
file which GitHub runs directly from this repository. It is derived from
cue-lang/setup-cue, which installs the open-source build, and keeps exactly
that action's input and output so that switching between them changes only
the `uses:` line.

## Layout

    src/run.ts                 the action's implementation
    __tests__/run.test.ts      unit tests
    __tests__/install.test.ts  end-to-end tests against a local release host
    __tests__/fixture.ts       that local release host
    dist/index.js              the bundle GitHub actually runs; generated, committed
    action.cue                 the action definition; generates action.yml
    workflows.cue              the CI workflow definitions; generate .github/workflows/
    *_tool.cue                 the cue commands which write the generated files

`dist/index.js`, `action.yml` and `.github/workflows/*.yml` are all generated.
Never edit them by hand; change the source and re-run the generator below.

## Developing

    npm ci
    npm test
    npm run dist                # regenerate dist/index.js
    cue cmd genaction           # regenerate action.yml from action.cue
    cue cmd genworkflows        # regenerate .github/workflows from workflows.cue

CI runs the tests on Linux, macOS and Windows, then runs the generators once
and fails if the tree is dirty, so any commit touching `src/` or a `.cue` file
must include its regenerated output.

Inputs and outputs are declared in `action.cue` and consumed by name in
`src/run.ts`. A test reads them back out of `action.yml` and requires them to
be exactly `version` (defaulting to `latest`) and `cue-path`. Do not add,
rename or remove either: that would break the one-line switch.

## Where releases come from

`releaseHost` in `src/run.ts` is the only place the download host is named,
and a test checks that it stays that way. Every URL is that host joined with
one of the paths the release downloads are laid out under: `latest.txt`,
`index.json`, `<version>/cue_<version>_checksums.txt`, and
`<version>/cue_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows). Moving to
another host changes that one line.

Every version is looked up in `index.json` before anything is downloaded, and
every archive is checked against its line in the checksum file before it is
unpacked. Keep it so: nothing may reach the tool cache or `PATH` unverified.
Installations are cached under the tool name `cue-labs-cue`, never `cue`, so
that binaries cached by cue-lang/setup-cue are never picked up.

The tests serve a local copy of that layout (`__tests__/fixture.ts`) and run
real downloads, verification, extraction and caching against it.

## Writing for this repository

The repository is public. Commit messages, comments and documents must stand
on their own, without reference to private repositories or internal process.
Describe the action as installing CUE by CUE Labs.

## Versioning

Follow semver, and bump the major version whenever a workflow which worked on
the previous tag might stop working:

* raising the node runtime in `action.cue`, since it requires a newer Actions
  Runner than some self-hosted and Enterprise Server installations have
* renaming or removing an input or output
* dropping support for a CUE version or platform

Moving `releaseHost` is not a breaking change on its own.

Each major version has a moving tag, such as `v2`, pointing at the newest
release of that major. Users are expected to reference those rather than
exact tags.

## Releasing

1. Check CI is green on `main`.
2. Run the "smoke test" workflow on `main` with an exact version listed in
   `index.json`, and again with `version` left as `latest`, and check both
   pass on all three operating systems. They install from the real release
   host. `latest.txt` exists only once a stable release is listed; until
   then, a listed pre-release is the only check possible.
3. Update the README's `uses:` line and `package.json`'s version.
4. Tag the release and move the major tag:

       git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
       git tag -f vX vX.Y.Z && git push -f origin vX

5. Publish a GitHub release whose notes lead with anything breaking, naming
   the runner version required if the node runtime changed.
