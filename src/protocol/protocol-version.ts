// Canonical identity-bearing Runtime wire and journal protocol.
// 2.0 defines the sole canonical Runtime operation and event-envelope protocol.
export const PROTOCOL_VERSION = '2.0.0';

export type ProtocolVersionCompatibility =
  | { readonly compatible: true }
  | {
      readonly compatible: false;
      readonly code: 'malformed_protocol_version';
    }
  | {
      readonly compatible: false;
      readonly code: 'retired_protocol_major' | 'unsupported_protocol_major';
      readonly major: string;
    }
  | {
      readonly compatible: false;
      readonly code: 'unsupported_protocol_minor';
      readonly major: string;
      readonly minor: string;
    };

const CORE_SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const READABLE_PROTOCOL_MAJOR = 2n;
const READABLE_PROTOCOL_MINOR = 0n;

/** Classify a Runtime protocol version against this strict recovery reader's 2.0.x range. */
export function classifyProtocolVersion(value: unknown): ProtocolVersionCompatibility {
  if (typeof value !== 'string') {
    return { compatible: false, code: 'malformed_protocol_version' };
  }
  const match = CORE_SEMVER_PATTERN.exec(value);
  if (match === null) return { compatible: false, code: 'malformed_protocol_version' };
  const majorText = match[1]!;
  const minorText = match[2]!;
  const major = BigInt(majorText);
  const minor = BigInt(minorText);
  if (major < READABLE_PROTOCOL_MAJOR) {
    return { compatible: false, code: 'retired_protocol_major', major: majorText };
  }
  if (major > READABLE_PROTOCOL_MAJOR) {
    return { compatible: false, code: 'unsupported_protocol_major', major: majorText };
  }
  if (minor > READABLE_PROTOCOL_MINOR) {
    return {
      compatible: false,
      code: 'unsupported_protocol_minor',
      major: majorText,
      minor: minorText,
    };
  }
  return { compatible: true };
}
