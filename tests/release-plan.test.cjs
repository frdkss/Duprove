const { test } = require('node:test')
const assert = require('node:assert/strict')

const base = { version: '1.0.0', ref: 'refs/heads/main', sha: 'a'.repeat(40) }
test('main push creates a versioned release without requiring a prior tag', async () => {
  const { planRelease } = await import('../scripts/release-plan.mjs')
  assert.deepEqual(planRelease(base), { tag: 'v1.0.0', publish: true })
  assert.deepEqual(planRelease({ ...base, ref: 'refs/tags/v1.0.0', tagSha: base.sha }), { tag: 'v1.0.0', publish: true })
})
test('published versions are immutable and repeated main pushes skip publication', async () => {
  const { planRelease } = await import('../scripts/release-plan.mjs')
  assert.deepEqual(planRelease({ ...base, tagSha: 'b'.repeat(40), release: { draft: false, prerelease: false } }), { tag: 'v1.0.0', publish: false })
  assert.throws(() => planRelease({ ...base, release: { draft: false, prerelease: true } }), /ALREADY_PRERELEASE/)
})
test('release refuses an unrelated branch, mismatched tag, invalid version, or incomplete draft', async () => {
  const { planRelease } = await import('../scripts/release-plan.mjs')
  for (const change of [
    { ref: 'refs/heads/future/duprove_v.1.0' }, { ref: 'refs/tags/v2.0.0' },
    { version: '1.0.0-rc.1' }, { version: '01.0.0' },
    { tagSha: 'b'.repeat(40) }, { release: { draft: true } },
  ]) assert.throws(() => planRelease({ ...base, ...change }))
})
