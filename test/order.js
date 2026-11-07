const test = require('brittle')
const tombstone = require('..')

// A view in memory that takes entries and tombstones in whatever order they come
class Host {
  constructor({ max } = {}) {
    this.entries = new Map()
    this.waiting = new Map()
    this.count = 0
    this.max = max
  }

  async apply(op) {
    if (op.type === 'entry') {
      if (this.entries.has(op.id)) return // the first copy wins
      const entry = { id: op.id, author: op.author, deleted: null }
      this.entries.set(op.id, entry)
      const waiting = this.waiting.get(op.id) || []
      this.waiting.delete(op.id)
      this.count -= waiting.length
      const counted = await tombstone.settle(entry, waiting, allowed)
      if (counted) entry.deleted = { by: counted.by, group: counted.group }
      return
    }
    const target = this.entries.get(op.id) || null
    const opts = { waiting: this.count, max: this.max }
    const verdict = await tombstone.decide(op, target, allowed, opts)
    if (verdict === tombstone.DELETE) target.deleted = { by: op.by, group: op.group }
    if (verdict !== tombstone.WAIT) return
    this.waiting.set(op.id, [...(this.waiting.get(op.id) || []), op])
    this.count++
  }

  state() {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  }
}

function allowed(record, entry) {
  return record.by === entry.author || record.by === 'mod'
}

const OPS = [
  { type: 'entry', id: 'a1', author: 'ana' },
  { type: 'entry', id: 'b1', author: 'bruno' },
  { type: 'entry', id: 'b2', author: 'bruno' },
  { type: 'entry', id: 'a1', author: 'ana' }, // the same entry, again
  { type: 'delete', id: 'a1', by: 'ana', group: null },
  { type: 'delete', id: 'b1', by: 'cris', group: null }, // not allowed
  { type: 'delete', id: 'b1', by: 'mod', group: 'purge' },
  { type: 'delete', id: 'b2', by: 'mod', group: 'purge' }
]

function* orders(items) {
  if (items.length <= 1) {
    yield items
    return
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const order of orders(rest)) yield [items[i], ...order]
  }
}

test('any order of the same ops ends the same', { timeout: 120_000 }, async (t) => {
  const expected = [
    { id: 'a1', author: 'ana', deleted: { by: 'ana', group: null } },
    { id: 'b1', author: 'bruno', deleted: { by: 'mod', group: 'purge' } },
    { id: 'b2', author: 'bruno', deleted: { by: 'mod', group: 'purge' } }
  ]
  let n = 0
  let differ = 0
  let waited = 0
  for (const order of orders(OPS)) {
    const host = new Host()
    for (const op of order) {
      await host.apply(op)
      if (host.count > 0) waited++
    }
    n++
    if (JSON.stringify(host.state()) !== JSON.stringify(expected) || host.count !== 0) differ++
  }
  t.is(n, 40320, 'all 8! orders')
  t.is(differ, 0, 'one result')
  t.ok(waited > 0, 'tombstones came first in some')

  const host = new Host()
  for (const op of OPS) await host.apply(op)
  const shown = tombstone.rows(host.state(), {
    pointed: (entry) => entry.id === 'b2', // a reply quotes it
    group: ({ deleted }) => deleted.group && { id: deleted.group, at: 100 },
    time: () => 0 // every entry written before the purge
  })
  t.alike(
    shown.map((row) => [row.type, row.entry.id, row.count]),
    [
      ['deleted', 'b2', undefined],
      ['purge', 'b1', 2]
    ],
    'the purge is one row, the one quoted a marker, the rest nothing'
  )
})

test('what waits is bounded: past max, a tombstone that came first is dropped', async (t) => {
  const host = new Host({ max: 1 })
  await host.apply({ type: 'delete', id: 'x', by: 'mod', group: null })
  await host.apply({ type: 'delete', id: 'y', by: 'mod', group: null })
  await host.apply({ type: 'entry', id: 'x', author: 'ana' })
  await host.apply({ type: 'entry', id: 'y', author: 'ana' })
  t.ok(host.entries.get('x').deleted, 'the one that waited counts')
  t.is(host.entries.get('y').deleted, null, 'the one past the bound never waited')
  t.is(host.count, 0)
})
