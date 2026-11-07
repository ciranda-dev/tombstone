const fs = require('fs')
const path = require('path')
const test = require('brittle')
const b4a = require('b4a')
const tombstone = require('..')

const AAD = 'room/0001-ana'

test('seal and open: only the key, the same box and the same aad open it', (t) => {
  const secret = tombstone.secret()
  t.ok(tombstone.isSecret(secret))
  t.absent(tombstone.isSecret(b4a.alloc(16)))
  t.absent(tombstone.isSecret('x'.repeat(32)))
  const key = tombstone.keyOf(secret, 'app/text')
  t.is(key.byteLength, 32)
  t.unlike(key, secret, 'not the secret')
  t.unlike(tombstone.keyOf(secret, 'app/file'), key, 'one key per use')
  t.alike(tombstone.keyOf(secret, 'app/text'), key, 'the same every time')

  const data = b4a.from('the budget is 42')
  const box = tombstone.seal(data, key, AAD)
  t.is(box.byteLength, 12 + data.byteLength + 16, 'iv, ciphertext, tag')
  t.is(b4a.indexOf(box, b4a.from('budget')), -1, 'the text is not in the box')
  t.alike(tombstone.open(box, key, AAD), data)
  t.alike(tombstone.open(box, key, b4a.from(AAD)), data, 'the aad as a buffer')
  t.unlike(tombstone.seal(data, key, AAD), box, 'a fresh iv each time')
  t.is(tombstone.open(box, tombstone.keyOf(tombstone.secret(), 'app/text'), AAD), null)
  t.is(tombstone.open(box, key, AAD + 'x'), null, 'nor under another aad')
  t.is(tombstone.open(box, key), null, 'nor without it')
  const changed = b4a.from(box)
  changed[20] ^= 1
  t.is(tombstone.open(changed, key, AAD), null, 'nor changed')
  t.is(tombstone.open(box.subarray(0, 27), key, AAD), null, 'nor cut')
  t.is(tombstone.open('box', key, AAD), null)
  t.is(tombstone.open(box, b4a.alloc(3), AAD), null, 'a key of the wrong size opens nothing')
  t.alike(tombstone.open(tombstone.seal(data, key), key), data, 'no aad')
  t.alike(tombstone.open(tombstone.seal(b4a.alloc(0), key), key), b4a.alloc(0))
})

test('the construction: AES-256-GCM under BLAKE2b-256(name, secret)', (t) => {
  const secret = b4a.from('11'.repeat(16) + '22'.repeat(16), 'hex')
  const key = tombstone.keyOf(secret, 'capy/message-text')
  const box = b4a.from(
    '58730c7c7746523df4ec3547b0d6c52a90416bd57e71875a53b564401d6c5d147840e30c3b84224f71fca525' +
      '792d08d427d668cfdae46c29e7db78a01dcd7334ced9e4792d6dd6361692b2d276bf2dd1debe045cb8775987a8258d',
    'hex'
  )
  const aad = 'capy/box\n' + 'ab'.repeat(32) + '\n000000000000001-0a0b0c0d'
  t.is(
    b4a.toString(tombstone.open(box, key, aad)),
    '{"text":"the budget is 42","files":[{"name":"a.png","size":7}]}',
    'a box Capy 1.0.22 sealed'
  )
  t.is(
    b4a.toString(tombstone.keyOf(secret, 'capy/message-media'), 'hex'),
    '27afa66f86d43c4ce0797cfe21b7238e0340e09876792d440ec8302a38e3f4b4'
  )
})

test('KeyStore: a file of its own, the first secret stays, a drop zeroes and forgets', async (t) => {
  const file = path.join(await t.tmp(), 'keys', 'room.json')
  const keys = new tombstone.KeyStore(file)
  t.is(await keys.load(), null, 'none yet')
  t.alike(keys.ids(), [])
  const [one, two] = [tombstone.secret(), tombstone.secret()]
  t.ok(await keys.set('one', one))
  t.absent(await keys.set('one', two), 'the first one stays')
  t.absent(await keys.set('bad', b4a.alloc(3)))
  t.absent(await keys.set('', two))
  t.absent(await keys.set(7, two))
  await Promise.all([keys.set('two', two), keys.set('three', tombstone.secret())])
  t.alike(keys.get('one'), one)
  t.not(keys.get('one'), one, 'a copy is kept')
  t.is(keys.get('none'), null)
  t.ok(keys.has('two'))
  t.is((fs.statSync(file).mode & 0o777).toString(8), '600', 'only this user reads it')
  t.ok(fs.readFileSync(file, 'utf8').includes(b4a.toString(one, 'hex')))

  const held = keys.get('one')
  await keys.drop(['one'])
  t.absent(keys.has('one'))
  t.absent(keys.isShredded('one'), 'dropped, not yet shredded for good')
  t.ok(await keys.set('one', one), 'so it can come back')
  await keys.drop(['one', 'two', 'never'], { done: true })
  t.ok(keys.isShredded('one') && keys.isShredded('two') && keys.isShredded('never'))
  t.absent(await keys.set('two', two), 'never again once shredded')
  const saved = fs.readFileSync(file, 'utf8')
  t.absent(saved.includes(b4a.toString(one, 'hex')), 'gone from the file')
  t.absent(saved.includes(b4a.toString(two, 'hex')))
  t.absent(fs.existsSync(file + '.tmp'), 'no older copy beside it')
  t.alike(held, b4a.alloc(32), 'and zeroed in memory')
  await keys.close()

  const again = new tombstone.KeyStore(file)
  t.alike(await again.load(), JSON.parse(saved), 'what the file held')
  t.alike(again.ids(), ['three'], 'what a restart finds')
  t.ok(again.isShredded('one') && again.isShredded('two'))

  fs.writeFileSync(file, '{broken')
  t.is(await new tombstone.KeyStore(file).load(), null)
  const odd = {
    keys: {
      ok: 'cd'.repeat(32),
      bad: 'x',
      short: 'cd',
      upper: 'CD'.repeat(32),
      ['x'.repeat(1025)]: 'cd'.repeat(32)
    },
    shredded: [1, 'gone', '']
  }
  fs.writeFileSync(file, JSON.stringify(odd))
  const kept = new tombstone.KeyStore(file)
  await kept.load()
  t.alike(kept.ids(), ['ok'], 'only what is the shape of one')
  t.alike([...kept.shredded], ['gone'])
  for (const text of ['null', '"keys"', JSON.stringify({ keys: 'abc', shredded: 'nope' })]) {
    fs.writeFileSync(file, text)
    const none = new tombstone.KeyStore(file)
    await none.load()
    t.alike(none.ids(), [])
    t.is(none.shredded.size, 0)
  }
})

test('KeyStore: a subclass keeps more of each id in the same file', async (t) => {
  class Notes extends tombstone.KeyStore {
    constructor(file) {
      super(file)
      this.notes = new Map()
    }

    async load() {
      const saved = await super.load()
      for (const [id, note] of Object.entries(saved?.notes || {})) this.notes.set(id, note)
      return saved
    }

    note(id, text) {
      this.notes.set(id, text)
      return this.save()
    }

    _forget(id) {
      super._forget(id)
      this.notes.delete(id)
    }

    toJSON() {
      return { ...super.toJSON(), notes: Object.fromEntries(this.notes) }
    }
  }
  const file = path.join(await t.tmp(), 'keys.json')
  const keys = new Notes(file)
  await keys.load()
  await keys.set('one', tombstone.secret())
  await keys.note('one', 'kept')
  const again = new Notes(file)
  await again.load()
  t.is(again.notes.get('one'), 'kept')
  await again.drop(['one'], { done: true })
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), {
    v: 1,
    keys: {},
    shredded: ['one'],
    notes: {}
  })
})

test('KeyStore: without a file, in memory only', async (t) => {
  const keys = new tombstone.KeyStore()
  t.is(await keys.load(), null)
  t.ok(await keys.set('one', tombstone.secret()))
  await keys.drop(['one'], { done: true })
  t.ok(keys.isShredded('one'))
  t.alike(keys.toJSON(), { v: 1, keys: {}, shredded: ['one'] })
  await keys.close()
})

test('KeyStore: a write that fails says so, every time', async (t) => {
  const blocker = path.join(await t.tmp(), 'a-file')
  fs.writeFileSync(blocker, 'not a folder')
  const keys = new tombstone.KeyStore(path.join(blocker, 'keys.json'))
  await t.exception(keys.set('one', tombstone.secret()))
  await t.exception(keys.drop(['one']))
  await keys.close()
})

test('WholeFile: one write at a time, each with every change made before it starts', async (t) => {
  const file = path.join(await t.tmp(), 'state.json')
  let n = 0
  let release = null
  const data = () => new Promise((resolve) => (release = () => resolve(String(++n))))
  const whole = new tombstone.WholeFile(file, data)
  const first = whole.save()
  t.is(whole.save(), first, 'not started yet: the same write')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = whole.save()
  t.not(second, first, 'started: the next one waits for it')
  t.is(whole.save(), second)
  release()
  await first
  t.is(fs.readFileSync(file, 'utf8'), '1')
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  await second
  t.is(fs.readFileSync(file, 'utf8'), '2')
  await whole.close()
  await new tombstone.WholeFile(null, data).save()
  t.is(n, 2, 'no file: nothing written')
})

test('decide: wait, delete or ignore', async (t) => {
  const entry = { id: 'a', author: 'ana', deleted: null }
  const byAuthor = (record, target) => record.by === target.author
  const asked = []
  const counting = (record, target) => {
    asked.push(record.by)
    return byAuthor(record, target)
  }
  t.is(await tombstone.decide({ id: 'a', by: 'ana' }, entry, counting), tombstone.DELETE)
  t.is(await tombstone.decide({ id: 'a', by: 'cris' }, entry, counting), tombstone.IGNORE)
  t.alike(asked, ['ana', 'cris'])
  const async = (record, target) => Promise.resolve(byAuthor(record, target))
  t.is(await tombstone.decide({ id: 'a', by: 'ana' }, entry, async), tombstone.DELETE)
  t.is(await tombstone.decide({ id: 'a', by: 'cris' }, entry, async), tombstone.IGNORE)

  const deleted = { ...entry, deleted: { by: 'ana' } }
  t.is(await tombstone.decide({ id: 'a', by: 'ana' }, deleted, counting), tombstone.IGNORE)
  t.is(asked.length, 2, 'a deleted entry asks nothing')

  t.is(await tombstone.decide({ id: 'b', by: 'ana' }, null, counting), tombstone.WAIT)
  t.is(await tombstone.decide({ id: 'b', by: 'ana' }, undefined, counting), tombstone.WAIT)
  t.is(
    await tombstone.decide({ id: 'b' }, null, counting, { waiting: tombstone.MAX_WAITING - 1 }),
    tombstone.WAIT
  )
  t.is(
    await tombstone.decide({ id: 'b' }, null, counting, { waiting: tombstone.MAX_WAITING }),
    tombstone.IGNORE,
    'no more than max wait'
  )
  t.is(
    await tombstone.decide({ id: 'b' }, null, counting, { waiting: 3, max: 3 }),
    tombstone.IGNORE
  )
  t.is(asked.length, 2, 'a missing entry asks nothing')
})

test('settle: the first tombstone allowed counts, and the rest are not asked', async (t) => {
  const entry = { id: 'a', author: 'ana', deleted: null }
  const asked = []
  const allowed = (record, target) => {
    asked.push(record.by)
    return Promise.resolve(record.by === target.author || record.by === 'mod')
  }
  const waiting = [{ by: 'cris' }, { by: 'mod' }, { by: 'ana' }]
  t.is(await tombstone.settle(entry, waiting, allowed), waiting[1])
  t.alike(asked, ['cris', 'mod'])
  t.is(await tombstone.settle(entry, [{ by: 'cris' }], allowed), null)
  t.is(await tombstone.settle(entry, [], allowed), null)
})

test('rows: live entries, markers where something points, and one row per purge at its time', (t) => {
  const live = (id, at) => ({ id, at, deleted: null })
  const gone = (id, at, purge = null) => ({ id, at, deleted: { purge } })
  const purges = { p: 25, q: 5, r: 50 }
  const entries = [
    live('1', 10),
    gone('2', 11), // no purge, nothing points at it: nothing
    gone('3', 12, 'p'),
    live('4', 20),
    gone('5', 21, 'p'), // pointed at: a marker, and still one of p's
    gone('6', 22, 'q'),
    live('7', 30),
    gone('8', 31, 'p'),
    gone('9', 32), // pointed at
    live('10', 50), // as old as r: r comes after it
    gone('11', 51, 'r')
  ]
  const pointed = (entry) => entry.id === '5' || entry.id === '9'
  const group = ({ deleted }) => deleted.purge && { id: deleted.purge, at: purges[deleted.purge] }
  const shown = tombstone.rows(entries, { pointed, group })
  t.alike(
    shown.map((row) =>
      row.type === 'purge'
        ? ['purge', row.group, row.count, row.at, row.entry.id]
        : [row.type, row.entry.id]
    ),
    [
      ['purge', 'q', 1, 5, '6'],
      ['entry', '1'],
      ['entry', '4'],
      ['deleted', '5'],
      ['purge', 'p', 3, 25, '3'],
      ['entry', '7'],
      ['deleted', '9'],
      ['entry', '10'],
      ['purge', 'r', 1, 50, '11']
    ],
    'wherever its entries were, a purge is one row, before the first row written after it'
  )
  const later = tombstone.rows(entries, { pointed, group, time: (entry) => entry.at - 10 })
  t.is(later[0].type, 'entry', 'time: when an entry was written, for where a purge stands')
  t.alike(
    tombstone.rows(entries).map((row) => row.entry.id),
    ['1', '4', '7', '10'],
    'by default every deleted entry disappears'
  )
  t.alike(tombstone.rows([gone('1', 1)], { group: () => undefined }), [], 'no group, no row')
  t.alike(tombstone.rows([]), [])
})
