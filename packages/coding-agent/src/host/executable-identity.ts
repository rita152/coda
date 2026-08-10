import { posix, win32 } from "node:path";
import type { ExecutableIdentityResolver, ExecutableResolutionRequest } from "../permissions/permission-engine.ts";
import type { FileSystem } from "./file-system.ts";

export interface ExecutableIdentityResolverOptions {
	readonly fileSystem: FileSystem;
	readonly path?: string;
	readonly pathExtensions?: string;
	readonly platform: NodeJS.Platform;
}

function candidates(
	request: ExecutableResolutionRequest,
	options: ExecutableIdentityResolverOptions,
): readonly string[] {
	const windows = options.platform === "win32";
	const paths = windows ? win32 : posix;
	const hasDirectory = request.executable.includes("/") || (windows && request.executable.includes("\\"));
	const bases = hasDirectory
		? [paths.isAbsolute(request.executable) ? request.executable : paths.resolve(request.cwd, request.executable)]
		: options.path === undefined
			? []
			: options.path.split(paths.delimiter).map((directory) => {
					const base = directory.length === 0 ? request.cwd : directory;
					return paths.join(paths.isAbsolute(base) ? base : paths.resolve(request.cwd, base), request.executable);
				});
	if (!windows || paths.extname(request.executable)) return Object.freeze(bases);
	const extensions = (options.pathExtensions ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim())
		.filter(Boolean);
	return Object.freeze(bases.flatMap((base) => extensions.map((extension) => `${base}${extension}`)));
}

export function createExecutableIdentityResolver(
	options: ExecutableIdentityResolverOptions,
): ExecutableIdentityResolver {
	return async (request) => {
		for (const candidate of candidates(request, options)) {
			try {
				const path = await options.fileSystem.realpath(candidate);
				const status = await options.fileSystem.stat(path);
				if (
					status.kind !== "file" ||
					(options.platform !== "win32" && (status.mode & 0o111) === 0) ||
					status.device === undefined ||
					status.inode === undefined
				) {
					continue;
				}
				return Object.freeze({
					path,
					device: status.device,
					inode: status.inode,
					size: status.size,
					modifiedAt: status.modifiedAt,
				});
			} catch {
				// PATH lookup is best effort; an unresolved executable cannot receive a Session Approval.
			}
		}
		return undefined;
	};
}
