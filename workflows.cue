package action

import "cue.dev/x/githubactions"

workflows: [...{
	filename: string
	workflow: githubactions.#Workflow
}]
workflows: [
	{
		filename: "build-and-test.yml"
		workflow: buildAndTest
	},
	{
		filename: "smoke-test.yml"
		workflow: smokeTest
	},
]

_checkout: {
	name: "Checkout"
	uses: "actions/checkout@v7"
}

_setupNode: {
	name: "Use node.js 24.x"
	uses: "actions/setup-node@v7"
	with: "node-version": 24
}

buildAndTest: githubactions.#Workflow & {
	name: "build and test"
	on: {
		pull_request: types: [
			"opened",
			"synchronize",
		]
		push: branches: [
			"main",
		]
	}
	permissions: contents: "read"

	jobs: {
		test: {
			strategy: {
				"fail-fast": false
				matrix: os: ["ubuntu-latest", "macos-latest", "windows-latest"]
			}
			"runs-on": "${{ matrix.os }}"
			steps: [
				_checkout,
				_setupNode,
				{
					name: "Run tests"
					run: """
						npm ci
						npm test

						"""
				},
			]
		}
		generate: {
			"runs-on": "ubuntu-latest"
			steps: [
				_checkout,
				_setupNode,
				{
					// The generators below only need some cue; install it with
					// this action as checked out.
					name: "Use CUE"
					uses: "./"
					with: version: "v0.18.0"
				},
				{
					name: "Build"
					run: """
						npm ci
						npm run dist

						"""
				},
				{
					name: "Re-gen GitHub Action schema"
					run:  "cue cmd genaction"
				},
				{
					name: "Re-gen GitHub Actions workflows"
					run:  "cue cmd genworkflows"
				},
				{
					name: "Check commit clean"
					run:  "test -z \"$(git status --porcelain)\" || (git status; git diff; false)"
				},
			]
		}
	}
}

// smokeTest installs from the real release host. Run it before every release.
smokeTest: githubactions.#Workflow & {
	name: "smoke test"
	on: workflow_dispatch: inputs: version: {
		description: "The CUE version to install: an exact version, or latest"
		required:    true
		default:     "latest"
	}
	permissions: contents: "read"

	jobs: smoke: {
		strategy: {
			"fail-fast": false
			matrix: os: ["ubuntu-latest", "macos-latest", "windows-latest"]
		}
		"runs-on": "${{ matrix.os }}"
		steps: [
			_checkout,
			{
				name: "Use CUE"
				id:   "install"
				uses: "./"
				with: version: "${{ inputs.version }}"
			},
			{
				name:  "Check cue on PATH is the one installed"
				shell: "bash"
				env: {
					CUE_PATH: "${{ steps.install.outputs.cue-path }}"
					WANT:     "${{ inputs.version }}"
				}
				run: """
					set -eu
					onpath=$(cue version)
					output=$("$CUE_PATH" version)
					echo "$onpath"
					test "$onpath" = "$output"
					if [ "$WANT" != latest ]; then
						echo "$onpath" | head -n 1 | grep -Fx "cue version $WANT"
					fi

					"""
			},
		]
	}
}
