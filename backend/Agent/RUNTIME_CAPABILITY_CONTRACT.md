# Runtime capability transport contract

The browser sends available host Copilot action descriptors to Agent on each
turn. Agent contract version 1 accepts a bounded subset that preserves the
host's execution-time argument schema exactly. A descriptor outside this
subset rejects the request with `InvalidRuntimeCapabilities`; Agent never
silently truncates a descriptor or removes a validation keyword.

The transported `name` is the host-generated public action ID (at most 64
characters), not the plugin's source action name. The request may contain at
most 128 actions. Schemas may be 12 levels deep, contain at most 256 properties
per object with 128-character property names, occupy at most 32 KiB, and use at
most 128 enum values. Analytics lists may contain at most 32 values of at most
64 characters each.

Supported schema keywords are:

- `type`, `description`, `properties`, `required`, `additionalProperties`
- `items`, `minItems`, `maxItems`, `uniqueItems`
- `enum`, `const`, `default`
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
- `minLength`, `maxLength`, `minProperties`, `maxProperties`

Every schema node must declare one string `type`; the root must be an object.
`additionalProperties` may be a boolean or another supported schema. Enum,
constant, and default values are bounded primitives. This deliberately excludes
host annotation-only keywords (`$schema`, `$comment`, `title`, `examples`) and
Agent-only legacy keywords (`oneOf`, `anyOf`, `allOf`, `format`). Descriptors
using either group are rejected so model planning cannot use a different schema
than host execution.

The executable handler and availability callback never cross this boundary.
Agent always rewrites execution to its client adapter and correlates the result
with the pending model call before accepting continuation data.

The machine-readable contract fixture used by tests is
`tests/fixtures/runtime-capability-transport.v1.json`.
