// Optional Node test reporter: bounded failure evidence, not a test/acceptance verdict.
// Run alongside the normal reporter. No filesystem, subprocess, network or task access.
const MAX_BYTES = 32 * 1024, MAX_FAILURES = 12;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// A string is a reason, including an empty one; false/undefined are not marks.
const marked = value => value === true || typeof value === 'string';

export default async function* testFeedback(source) {
  let retainedFailures = 0, observedFailures = 0, omittedFailures = 0, bytes = 0;
  for await (const { type, data } of source) {
    // TODO/skip outcomes do not fail Node's run. Never infer successful execution
    // from their presence, or from an empty report (the process may have crashed).
    if (type !== 'test:fail' || marked(data.todo) || marked(data.skip)) continue;
    observedFailures++;
    if (retainedFailures >= MAX_FAILURES) { omittedFailures++; continue; }
    let truncated = false;
    const text = (value, limit) => {
      if (typeof value !== 'string') return null;
      if (value.length > limit) truncated = true;
      return value.slice(0, limit).toWellFormed();
    };
    const wrapper = data.details?.error;
    const error = wrapper?.cause ?? wrapper;
    const failure = {
      name: text(data.name, 256), file: text(data.file, 512),
      line: integer(data.line), column: integer(data.column),
      failureType: text(wrapper?.failureType, 128),
      code: text(error?.code, 128), message: text(error?.message ?? wrapper?.message, 1024),
      stack: text(error?.stack, 1536), truncated,
    };
    const serialized = JSON.stringify(failure), size = Buffer.byteLength(serialized) + 1;
    // Reserve room for fixed metadata/counters. Do not accumulate stdout/stderr,
    // diagnostic payloads, arbitrary Error properties or passing test events.
    if (bytes + size > MAX_BYTES - 1024) { omittedFailures++; continue; }
    // Stream one bounded JSON document. A later hang must not withhold evidence
    // already received. Only normal exhaustion appends final counters and closes
    // the document; an interrupted prefix is deliberately not a complete report.
    const prefix = retainedFailures++ ? ',' : '{"failures":[';
    bytes += size;
    yield prefix + serialized;
  }
  if (observedFailures) yield (retainedFailures ? '' : '{"failures":[') + '],' + JSON.stringify({
    version: 1, evidence: 'node-test-failure-events', node: process.version,
    platform: process.platform, arch: process.arch, observedFailures, omittedFailures,
    processExitCode: null, revision: null,
  }).slice(1) + '\n';
}
