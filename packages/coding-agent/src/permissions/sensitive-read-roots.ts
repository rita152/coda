import { delimiter, join } from "node:path";
import type { Workspace } from "../workspace.ts";

const SENSITIVE_HOME_PATHS = Object.freeze([
	".ssh",
	".aws",
	".gnupg",
	".kube",
	".azure",
	".docker",
	".terraform.d",
	".oci",
	".password-store",
	join(".local", "share", "keyrings"),
	join("Library", "Keychains"),
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	join(".cargo", "credentials"),
	join(".cargo", "credentials.toml"),
]);

const SENSITIVE_CONFIG_PATHS = Object.freeze([
	"gcloud",
	"gh",
	"doctl",
	"oci",
	"ibmcloud",
	join("pulumi", "credentials.json"),
	join("containers", "auth.json"),
	join("git", "credentials"),
	join("rclone", "rclone.conf"),
	join("sops", "age"),
]);

const SENSITIVE_ENVIRONMENT_PATHS = Object.freeze([
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"PGPASSFILE",
	"REGISTRY_AUTH_FILE",
	"NPM_CONFIG_USERCONFIG",
	"OCI_CLI_CONFIG_FILE",
	"TF_CLI_CONFIG_FILE",
] as const);

const SENSITIVE_ENVIRONMENT_ROOTS = Object.freeze([
	"AZURE_CONFIG_DIR",
	"CLOUDSDK_CONFIG",
	"DOCKER_CONFIG",
	"GNUPGHOME",
] as const);

function configuredCredentialPaths(
	homeDirectory: string,
	environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
	const paths = [
		...SENSITIVE_HOME_PATHS.map((path) => join(homeDirectory, path)),
		...SENSITIVE_CONFIG_PATHS.map((path) => join(homeDirectory, ".config", path)),
	];
	const xdgConfigHome = environment.XDG_CONFIG_HOME;
	if (xdgConfigHome) paths.push(...SENSITIVE_CONFIG_PATHS.map((path) => join(xdgConfigHome, path)));
	const xdgDataHome = environment.XDG_DATA_HOME;
	if (xdgDataHome) paths.push(join(xdgDataHome, "keyrings"));
	for (const name of SENSITIVE_ENVIRONMENT_PATHS) {
		const path = environment[name];
		if (path) paths.push(path);
	}
	for (const name of SENSITIVE_ENVIRONMENT_ROOTS) {
		const path = environment[name];
		if (path) paths.push(path);
	}
	for (const path of environment.KUBECONFIG?.split(delimiter) ?? []) {
		if (path) paths.push(path);
	}
	return Object.freeze([...new Set(paths)]);
}

/** Resolves default Credential roots without reading their contents or trusting lexical symlinks. */
export async function resolveDefaultDeniedReadRoots(
	homeDirectory: string,
	workspace: Pick<Workspace, "resolvePath">,
	environment: Readonly<Record<string, string | undefined>> = {},
): Promise<readonly string[]> {
	const roots = await Promise.all(
		configuredCredentialPaths(homeDirectory, environment).map(
			async (path) => (await workspace.resolvePath(path, "read")).canonicalPath,
		),
	);
	return Object.freeze([...new Set(roots)]);
}
