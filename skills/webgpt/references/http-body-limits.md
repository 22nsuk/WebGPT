# HTTP JSON body limits

The worker bounds request structure before `JSON.parse`, not only HTTP wire size.
These controls apply after the existing connection checks: the MCP route capability
(or loopback `/mcp`), Origin and protocol-header checks, and the controller Bearer
key. Task tokens remain mandatory for tools, not for connection-level `ping`.

| Budget | MCP | Controller |
| --- | ---: | ---: |
| Bytes per request | 128 MiB | 2 MiB |
| Aggregate allocated body-buffer pages per listener | 128 MiB | 2 MiB |
| Concurrent body readers per listener | 4 | 4 |
| JSON container nesting depth | 64 | 64 |
| Structural characters plus string starts per request | 65,536 | 65,536 |

The incremental scanner counts `{`, `}`, `[`, `]`, `,`, `:` outside strings and
each opening string quote. Counting separators and keys also bounds shallow scalar
arrays and repeated object properties, not just deeply nested containers. String
contents and escapes are excluded, including escapes split across HTTP chunks.
Strict UTF-8 decoding and the normal JSON grammar check still run before dispatch.

The 128 MiB allowance is retained because an exact edit can contain 10 MiB each of
`oldText` and `text`, expanded to 120 MiB by JSON escaping. Decoded file limits,
revision checks, task authorization and the 1 MiB result limit are unchanged.

A request exceeding its byte/structure budget receives HTTP 413; malformed JSON or
UTF-8 receives HTTP 400. Capacity exhaustion returns HTTP 503 (MCP JSON-RPC -32000;
controller `HTTP_BODY_BUSY`, retryable). No tool mutation has begun at this point.
Incomplete rejected bodies are closed after the response rather than drained or
queued. A client still uploading may observe a transport error instead of the
refusal response; that error alone is not evidence of a capacity rejection and
must not trigger a blind retry of a mutation. Failed, aborted and completed reads release their admission and staging
budget. MCP and controller pools are independent, preserving administrative
admission when MCP clients hold incomplete bodies. Health/readiness GET requests
do not enter either body pool.

Input chunks are coalesced into at most 64 KiB pages, so tiny network fragments do
not create an unbounded list of retained Buffer wrappers. The aggregate budget
covers allocated staging pages, **not total process RSS**: final concatenation,
UTF-8 decoding, parsed values, socket buffers and stored task state also use memory.
Parsing remains synchronous. These bounds do not promise resistance to sustained
request floods, starvation of MCP's own slots, or arbitrary low heap limits.
Forwarder rate/body limits remain useful defense in depth. A disclosed MCP URL
must still be treated as a compromised capability; follow the route-key rotation
procedure in [setup](setup.md).
