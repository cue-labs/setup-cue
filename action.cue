package action

import "cue.dev/x/githubactions"

action: githubactions.#Action & {
	name:        "Setup CUE by CUE Labs"
	description: "Install CUE by CUE Labs, the official distribution of CUE, and add it to the PATH."
	inputs: version: {
		description: #"The CUE version to setup. Must be a valid version string like "v0.18.0", or "latest""#
		required:    true
		default:     "latest"
	}
	outputs: "cue-path": description: "Path to the cached CUE binary"
	branding: {
		icon:  "terminal"
		color: "blue"
	}
	runs: {
		using: "node24"
		main:  "dist/index.js"
	}
}
