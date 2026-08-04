import { describe, expect, test } from 'bun:test';

import { classifyProtocolVersion, PROTOCOL_VERSION } from './protocol-version.js';

describe('Runtime protocol version compatibility', () => {
  test('accepts the current version and every patch in the readable 2.0 line', () => {
    expect(classifyProtocolVersion(PROTOCOL_VERSION)).toEqual({ compatible: true });
    expect(classifyProtocolVersion('2.0.999999999999999999999999999999'))
      .toEqual({ compatible: true });
  });

  test.each([
    '2',
    '2.0',
    '02.0.0',
    '2.00.0',
    '2.0.00',
    '2.0.0-alpha',
    '2.0.0+build',
    ' 2.0.0',
  ])('rejects malformed or non-canonical version %p', (version) => {
    expect(classifyProtocolVersion(version)).toEqual({
      compatible: false,
      code: 'malformed_protocol_version',
    });
  });

  test('distinguishes retired, future-major, and future-minor journals', () => {
    expect(classifyProtocolVersion('1.99.99')).toEqual({
      compatible: false,
      code: 'retired_protocol_major',
      major: '1',
    });
    expect(classifyProtocolVersion('3.0.0')).toEqual({
      compatible: false,
      code: 'unsupported_protocol_major',
      major: '3',
    });
    expect(classifyProtocolVersion('2.1.0')).toEqual({
      compatible: false,
      code: 'unsupported_protocol_minor',
      major: '2',
      minor: '1',
    });
  });
});
