const fs = require('fs')
const path = require('path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { Reclaim, sizeOf } = require('..')

const MARKER = b4a.from('TOMBSTONE-RECLAIM-MARKER')
const BLOCK = 64 * 1024 // past the database's minimum for a blob file

function block() {
  const data = crypto.randomBytes(BLOCK)
  data.set(MARKER, 1024)
  return data
}

// How many files under the folder still hold the marker
async function markers(dir) {
  let found = 0
  for (const name of await fs.promises.readdir(dir)) {
    const file = path.join(dir, name)
    const stat = await fs.promises.lstat(file)
    if (stat.isDirectory()) found += await markers(file)
    else if (b4a.indexOf(await fs.promises.readFile(file), MARKER) !== -1) found++
  }
  return found
}

async function storeIn(t) {
  const dir = await t.tmp()
  const store = new Corestore(dir)
  t.teardown(() => store.close(), { order: 1 })
  await store.ready()
  return { dir, store }
}

async function cores(store, ...names) {
  const all = names.map((name) => store.get({ name }))
  for (const core of all) await core.ready()
  return all
}

function settled(reclaim) {
  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => reclaim.running)
}

// Hypercore's clear and Corestore's purge leave the bytes in the database's files: this fails the
// day a version of Corestore, Hypercore or rocksdb-native changes that, either way
test('a clear and a purge leave the bytes on the disk, and the compaction takes them', async (t) => {
  const { dir, store } = await storeIn(t)
  const freed = []
  const reclaim = new Reclaim(store, { dir, wait: 0, margin: 0, onfreed: (r) => freed.push(r) })
  const [file, kept] = await cores(store, 'file', 'kept')
  for (let i = 0; i < 4; i++) await kept.append(crypto.randomBytes(BLOCK))
  for (let i = 0; i < 128; i++) await file.append(block())
  await reclaim.run()
  t.ok(await markers(dir), 'the bytes are on the disk')
  const written = await sizeOf(dir)

  await file.clear(0, file.length)
  t.ok(await markers(dir), 'a clear leaves them there')
  t.ok((await sizeOf(dir)) >= written, 'and gives nothing back')
  reclaim.soon(128 * BLOCK)
  await settled(reclaim)
  t.is(await markers(dir), 0, 'the compaction takes them off the disk')
  t.ok((await sizeOf(dir)) < written - 4 * 1024 * 1024, 'and the space comes back')
  t.ok(freed.at(-1).freed > 4 * 1024 * 1024, 'measured')
  t.ok(freed.at(-1).complete)
  t.is(
    reclaim.freedAll,
    freed.reduce((sum, one) => sum + one.freed, 0)
  )
  t.is(reclaim.owed, 0)
  t.is((await kept.get(3, { wait: false })).byteLength, BLOCK, 'the rest stays')

  const [purged] = await cores(store, 'purged')
  for (let i = 0; i < 64; i++) await purged.append(block())
  await reclaim.run()
  t.ok(await markers(dir))
  await store.purge({ discoveryKey: purged.discoveryKey }, { force: true })
  t.ok(await markers(dir), 'a purge leaves them there too')
  await reclaim.run()
  t.is(await markers(dir), 0, 'until the compaction')
  await reclaim.close()
})

test('deleted blocks that share files with live ones: the live data is rewritten', async (t) => {
  const { dir, store } = await storeIn(t)
  const reclaim = new Reclaim(store, { dir, wait: 0, margin: 0 })
  const [file, live] = await cores(store, 'file', 'live')
  // written at the same moment: their blocks share the database's blob files
  for (let i = 0; i < 64; i++) {
    await file.append(block())
    await live.append(crypto.randomBytes(BLOCK))
  }
  await reclaim.run()
  await file.clear(0, file.length)
  reclaim.owed = 64 * BLOCK
  const result = await reclaim.run()
  t.is(await markers(dir), 0, 'no file keeps a deleted block')
  t.ok(result.complete)
  t.is((await live.get(63, { wait: false })).byteLength, BLOCK, 'the live data is all there')
  await reclaim.close()
})

test('no room on the disk for a copy: what is left is kept for the next start', async (t) => {
  const { dir, store } = await storeIn(t)
  const file = path.join(await t.tmp(), 'reclaim', 'left.json')
  const results = []
  const full = new Reclaim(store, {
    dir,
    file,
    wait: 0,
    margin: Number.MAX_SAFE_INTEGER,
    retry: 60 * 1000,
    onfreed: (one) => results.push(one)
  })
  const [gone, stays] = await cores(store, 'gone', 'stays')
  for (let i = 0; i < 16; i++) {
    await gone.append(block())
    await stays.append(crypto.randomBytes(BLOCK))
  }
  await full.run()
  await gone.clear(0, gone.length)
  full.soon(16 * BLOCK)
  t.is(full.owed, 16 * BLOCK)
  await settled(full)
  await full.keeping
  t.absent(results.at(-1).complete, 'not all of it')
  t.ok(await markers(dir), 'its garbage waits')
  t.ok(full.owed > 0)
  t.alike(JSON.parse(await fs.promises.readFile(file, 'utf8')), {
    v: 1,
    owed: full.owed,
    full: false
  })
  await full.close()
  full.soon(5)
  t.is(full.owed, JSON.parse(await fs.promises.readFile(file, 'utf8')).owed, 'closed: nothing')

  const again = new Reclaim(store, { dir, file, wait: 0, margin: 0 })
  await again.ready()
  t.ok(again.starting)
  await settled(again)
  await again.keeping
  t.is(again.owed, 0)
  t.is(await markers(dir), 0)
  await t.exception(fs.promises.stat(file), /ENOENT/, 'nothing left to free')
  await again.close()
})

test('a disk that can not be measured gets no full pass', async (t) => {
  const { dir, store } = await storeIn(t)
  const blind = new Reclaim(store, { dir: path.join(dir, 'not-here'), wait: 0, retry: 60 * 1000 })
  const [gone, stays] = await cores(store, 'gone', 'stays')
  for (let i = 0; i < 16; i++) {
    await gone.append(block())
    await stays.append(crypto.randomBytes(BLOCK))
  }
  await blind.run()
  await gone.clear(0, gone.length)
  blind.soon(0, { full: true })
  t.ok(blind.full)
  await settled(blind)
  t.ok(blind.full, 'still owed')
  t.ok(await markers(dir), 'its garbage waits')
  t.is(await sizeOf(path.join(dir, 'not-here')), 0)
  await blind.close()
})

test('a delete of unknown size, what a quit left, and files that say nothing', async (t) => {
  const { dir, store } = await storeIn(t)
  const file = path.join(await t.tmp(), 'left.json')
  const reclaim = new Reclaim(store, { dir, file, wait: 10000 })
  reclaim.soon(0, { full: true })
  reclaim.soon(-1)
  reclaim.soon(0.5)
  await reclaim.keeping
  t.alike(JSON.parse(await fs.promises.readFile(file, 'utf8')), { v: 1, owed: 0, full: true })
  await reclaim.close()
  t.ok(await fs.promises.stat(file), 'the timer goes, the file stays')

  const next = new Reclaim(store, { dir, file, wait: 0, margin: 0 })
  await next.ready()
  t.ok(next.full)
  const result = await next.run()
  t.ok(result.complete)
  t.absent(next.full)
  await next.close()
  t.is(await next.run(), null, 'closed: nothing runs')

  for (const text of ['not json', JSON.stringify({ v: 1, owed: 0, full: false }), 'null']) {
    await fs.promises.writeFile(file, text)
    const quiet = new Reclaim(store, { dir, file, wait: 0 })
    await quiet.ready()
    t.is(quiet.timer, null, 'nothing to start')
    await quiet.close()
  }
  const none = new Reclaim(store, { dir })
  await none.ready()
  none.full = true
  const [one, two] = [none.run(), none.run()]
  t.is(one, two, 'two asked at once are one run')
  t.ok((await one).complete, 'with the default margin, this disk had room')
  await none.close()
})

test('a compaction that fails, and a file that can not be written, are said', async (t) => {
  const { dir, store } = await storeIn(t)
  const [core] = await cores(store, 'core')
  await core.append('one')
  await store.close()

  const errors = []
  const told = []
  const blocker = path.join(await t.tmp(), 'a-file')
  await fs.promises.writeFile(blocker, 'not a folder')
  const readOnly = new Corestore(dir, { readOnly: true })
  await readOnly.ready()
  const failing = new Reclaim(readOnly, {
    dir,
    file: path.join(blocker, 'left.json'),
    wait: 0,
    onfreed: (one) => told.push(one),
    onerror: (err) => errors.push(err.message)
  })
  failing.soon(5)
  await settled(failing)
  await failing.keeping
  t.alike(told, [{ freed: 0, complete: false, size: null, failed: true }])
  t.is(failing.owed, 5, 'what was owed stays')
  t.is(errors.length, 2, 'the compaction, and the file')
  t.ok(errors.some((message) => /read only/.test(message)))
  await failing.close()
  await readOnly.close()

  const again = new Corestore(dir, { readOnly: true })
  await again.ready()
  const silent = new Reclaim(again, { dir, wait: 0 })
  silent.soon(5)
  await settled(silent)
  t.is(silent.owed, 5, 'no onerror: nothing thrown')
  await silent.close()
  await again.close()
})

// A snapshot taken after the blocks were written and before the delete still sees them, and no
// compaction drops what a snapshot sees: it is asked again, and the bytes go once it closes
test('a snapshot keeps what was deleted until it closes: asked again', async (t) => {
  const { dir, store } = await storeIn(t)
  const results = []
  const reclaim = new Reclaim(store, {
    dir,
    wait: 0,
    retry: 20,
    margin: 0,
    onfreed: (one) => results.push(one)
  })
  const [file, kept] = await cores(store, 'file', 'kept')
  for (let i = 0; i < 64; i++) {
    await file.append(block())
    await kept.append(crypto.randomBytes(BLOCK))
  }
  await reclaim.run()
  const snapshot = kept.snapshot()
  await snapshot.ready()
  await file.clear(0, file.length)
  reclaim.owed = 64 * BLOCK
  const pinned = await reclaim.run()
  t.absent(pinned.complete, 'what a snapshot sees stays')
  t.ok(await markers(dir), 'its bytes too')
  t.ok(reclaim.owed > 60 * BLOCK, 'owed still')
  t.is(reclaim.tries, 1, 'asked again later')

  await snapshot.close()
  while (reclaim.owed > 0) await new Promise((resolve) => setTimeout(resolve, 10))
  t.ok(reclaim.last.complete)
  t.is(reclaim.tries, 0)
  t.is(await markers(dir), 0, 'and now it is gone')
  await reclaim.close()
})

test('asked again only so often, then left to a start, which takes it whole', async (t) => {
  const { dir, store } = await storeIn(t)
  const file = path.join(await t.tmp(), 'left.json')
  const reclaim = new Reclaim(store, { dir, file, wait: 0, retry: 1, margin: 0 })
  reclaim.soon(5 * 1024 * 1024) // bytes that never show as freed
  while (reclaim.tries < 12) await new Promise((resolve) => setTimeout(resolve, 20))
  while (reclaim.again) await new Promise((resolve) => setTimeout(resolve, 20))
  await reclaim.running
  t.is(reclaim.tries, 12, 'asked again 12 times')
  t.absent(reclaim.again, 'and no more')
  await reclaim.keeping
  t.is(JSON.parse(await fs.promises.readFile(file, 'utf8')).owed, 5 * 1024 * 1024, 'still owed')
  await reclaim.close()

  const start = new Reclaim(store, { dir, file, wait: 0, margin: 0 })
  await start.ready()
  await settled(start)
  await start.keeping
  t.ok(start.last.complete, 'no snapshot is older than a start')
  t.is(start.owed, 0)
  await t.exception(fs.promises.stat(file), /ENOENT/)
  await start.close()
})
