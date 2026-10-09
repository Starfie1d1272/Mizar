import { strict as assert } from 'node:assert';

export function browserIdentities(report) {
  const identities = [];
  function visit(suite, parents = []) {
    const names = suite.column === 0 ? parents : [...parents, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        identities.push({
          id: JSON.stringify([test.projectName, spec.file, ...names, spec.title]),
          results: test.results ?? [],
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, names);
  }
  for (const suite of report.suites ?? []) visit(suite);
  return identities;
}

export function verifyBrowserEvidence(full, selected, actual) {
  assert.equal(full.errors?.length ?? 0, 0, 'FULL discovery failed');
  assert.equal(selected.errors?.length ?? 0, 0, 'selected discovery failed');
  assert.equal(actual.errors?.length ?? 0, 0, 'browser runner errors');
  const fullIds = browserIdentities(full).map((test) => test.id);
  const selectedIds = browserIdentities(selected).map((test) => test.id);
  const actualTests = browserIdentities(actual);
  for (const [label, ids] of [
    ['FULL', fullIds],
    ['selected', selectedIds],
    ['actual', actualTests.map((t) => t.id)],
  ]) {
    assert(ids.length > 0, `${label}: zero tests`);
    assert.equal(new Set(ids).size, ids.length, `${label}: duplicate identities`);
  }
  const fullSet = new Set(fullIds);
  for (const id of selectedIds)
    assert(fullSet.has(id), `selected identity absent from FULL: ${id}`);
  assert.deepEqual(
    actualTests.map((t) => t.id).sort(),
    [...selectedIds].sort(),
    'discovered and actual identities differ',
  );
  for (const test of actualTests) {
    assert.equal(test.results.length, 1, `missing or repeated attempt: ${test.id}`);
    assert.equal(test.results[0].status, 'passed', `non-passing test: ${test.id}`);
    assert.equal(test.results[0].retry, 0, `retry: ${test.id}`);
  }
  return {
    full: fullIds.length,
    selected: selectedIds.length,
    passed: actualTests.length,
    identities: selectedIds.sort(),
  };
}
