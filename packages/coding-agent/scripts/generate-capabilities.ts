import { checkCapabilityArtifacts, writeCapabilityArtifacts } from "./capabilities.ts";

const mode = process.argv[2];

if (mode === "--write") {
	await writeCapabilityArtifacts();
	process.stdout.write("Updated capabilities.v1.json and generated README sections.\n");
} else if (mode === "--check") {
	const mismatches = await checkCapabilityArtifacts();
	if (mismatches.length > 0) {
		throw new Error(
			`Generated capability documentation is stale: ${mismatches.join(", ")}\nRun npm run capabilities:update and commit the result.`,
		);
	}
	process.stdout.write("Capability manifest and README sections are current.\n");
} else {
	throw new Error("Usage: generate-capabilities.ts --write | --check");
}
