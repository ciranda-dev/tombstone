// Three people in an Autobase room. Each message is sealed with a secret of its own, kept outside
// the log. A delete is a tombstone every peer's apply checks the same way, a moderator's purge
// takes a spammer's messages in one record, and the screen shows what is left.
//
//   node examples/autobase.js
//   bare examples/autobase.js

const Autobase = require('autobase')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const tmp = require('test-tmp')
const { replicateAndSync } = require('autobase-test-helpers')
const tombstone = require('..')

const TEXT = 'tombstone-example/text'
const FILE = 'tombstone-example/file'
const BLOCK = 64 * 1024

// The view, the same on every peer: writers/<writer>, entries/<id>, waiting/<id> (the tombstones
// that came before their entry) and the count of those.

function open(store) {
  return new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
    extension: false
  })
}

async function apply(nodes, view, host) {
  for (const { from, length, value } of nodes) {
    if (value === null || typeof value !== 'object') continue
    const by = hex(from.key)
    if (value.type === 'writer') await applyWriter(by, value, view, host)
    else if (value.type === 'message') await applyMessage(by, value, view, host)
    else if (value.type === 'delete') await applyDelete({ id: value.id, by }, view, host)
    else if (value.type === 'purge') await applyPurge(by, length, value, view, host)
  }
}

// Only the room's creator, its bootstrap writer, admits writers
async function applyWriter(by, { key, name }, view, host) {
  if (by !== hex(host.key) || !isKey(key) || !isName(name)) return
  if (key !== by) await host.addWriter(b4a.from(key, 'hex'), { indexer: false })
  await view.put('writers/' + key, { name })
}

async function applyMessage(by, { id, box, reply = null, file = null }, view, host) {
  if (!isId(id) || !isBox(box) || (reply !== null && !isId(reply))) return
  if (file !== null && !isKey(file)) return
  // the first copy wins, and a deleted entry stays deleted
  if (await view.get('entries/' + id)) return
  const entry = { id, author: by, box, reply, file, deleted: null }
  await view.put('entries/' + id, entry)
  const waiting = (await view.get('waiting/' + id))?.value || []
  if (waiting.length === 0) return
  await view.del('waiting/' + id)
  await view.put('count/waiting', (await waitingCount(view)) - waiting.length)
  const counted = await tombstone.settle(entry, waiting, allowed(host))
  if (counted) await markDeleted(view, entry, counted)
}

async function applyDelete(record, view, host) {
  if (!isId(record.id)) return
  const target = (await view.get('entries/' + record.id))?.value || null
  const waiting = target ? 0 : await waitingCount(view)
  const verdict = await tombstone.decide(record, target, allowed(host), { waiting })
  if (verdict === tombstone.DELETE) await markDeleted(view, target, record)
  if (verdict !== tombstone.WAIT) return
  const list = (await view.get('waiting/' + record.id))?.value || []
  await view.put('waiting/' + record.id, [...list, record])
  await view.put('count/waiting', waiting + 1)
}

// The moderator deletes every entry of `target` the view holds, as one group
async function applyPurge(by, length, { target }, view, host) {
  if (by !== hex(host.key) || !isKey(target)) return
  const group = by + '/' + length
  for (const entry of await entriesOf(view)) {
    if (entry.author !== target) continue
    const record = { id: entry.id, by, group }
    const verdict = await tombstone.decide(record, entry, allowed(host))
    if (verdict === tombstone.DELETE) await markDeleted(view, entry, record)
  }
}

// Its author, or the room's creator
function allowed(host) {
  return (record, entry) => record.by === entry.author || record.by === hex(host.key)
}

function markDeleted(view, entry, { by, group = null }) {
  return view.put('entries/' + entry.id, { ...entry, deleted: { by, group } })
}

async function waitingCount(view) {
  return (await view.get('count/waiting'))?.value || 0
}

async function entriesOf(view) {
  const entries = []
  for await (const { value } of view.createReadStream({ gt: 'entries/', lt: 'entries/~' })) {
    entries.push(value)
  }
  return entries // in key order: by id
}

// What a person does. A message's secret goes to the others over the room's encrypted
// connections; here, the people share a process.

async function say(room, person, text, { reply = null, file = null } = {}) {
  const id = String(++room.sent).padStart(4, '0') + '-' + person.name
  const secret = tombstone.secret()
  const box = tombstone.seal(b4a.from(text), tombstone.keyOf(secret, TEXT), id)
  let core = null
  if (file !== null) {
    core = person.store.get({ name: 'file/' + id })
    await core.ready()
    for (let i = 0; i < file.byteLength; i += BLOCK) {
      const block = file.subarray(i, i + BLOCK)
      await core.append(tombstone.seal(block, tombstone.keyOf(secret, FILE), id + '/' + i))
    }
    person.files.set(id, core)
  }
  for (const one of room.people) await one.keys.set(id, secret)
  await person.base.append({
    type: 'message',
    id,
    box: hex(box),
    reply,
    file: core && hex(core.key)
  })
  return id
}

function remove(person, id) {
  return person.base.append({ type: 'delete', id })
}

function purge(person, target) {
  return person.base.append({ type: 'purge', target: hex(target.base.local.key) })
}

// After apply, outside it: every deleted entry's secret goes, then what it held is cleared
async function shred(person) {
  const deleted = (await entriesOf(person.base.view)).filter((entry) => entry.deleted)
  const ids = deleted.map((entry) => entry.id).filter((id) => !person.keys.isShredded(id))
  await person.keys.drop(ids)
  let bytes = 0
  for (const id of ids) {
    const core = person.files.get(id)
    if (!core) continue
    bytes += core.byteLength
    await core.clear(0, core.length)
    await core.close()
    person.files.delete(id)
  }
  await person.keys.drop(ids, { done: true })
  if (bytes > 0) person.reclaim.soon(bytes)
  return bytes
}

function textOf(person, entry) {
  const secret = person.keys.get(entry.id)
  const box = b4a.from(entry.box, 'hex')
  return b4a.toString(tombstone.open(box, tombstone.keyOf(secret, TEXT), entry.id))
}

// What each person's screen shows
async function screenOf(person) {
  const entries = await entriesOf(person.base.view)
  const replied = new Set(entries.filter((e) => !e.deleted && e.reply).map((e) => e.reply))
  return tombstone.rows(entries, {
    pointed: (entry) => replied.has(entry.id),
    group: (entry) => entry.deleted.group
  })
}

async function linesOf(room, person) {
  const names = new Map(room.people.map((p) => [hex(p.base.local.key), p.name]))
  const byId = new Map((await entriesOf(person.base.view)).map((e) => [e.id, e]))
  const lines = []
  for (const row of await screenOf(person)) {
    if (row.type === 'deleted') {
      lines.push('Message deleted')
    } else if (row.type === 'run') {
      const { by } = row.entries[0].deleted
      const n = row.entries.length
      const whose = names.get(row.entries[0].author)
      lines.push(`${names.get(by)} deleted ${n} of ${whose}'s messages`)
    } else {
      const { entry } = row
      let line = `${names.get(entry.author)}: ${textOf(person, entry)}`
      const quoted = entry.reply && byId.get(entry.reply)
      if (quoted?.deleted) line += ' (replying to a deleted message)'
      else if (quoted) line += ` (replying to ${names.get(quoted.author)})`
      if (entry.file) line += ' (with a file)'
      lines.push(line)
    }
  }
  return lines
}

// A person is { name, store, keys, files, reclaim, base }. The first one creates the room
async function createRoom(people, options = {}) {
  let bootstrap = null
  for (const person of people) {
    person.base = new Autobase(person.store, bootstrap, {
      ...options,
      open,
      apply,
      valueEncoding: 'json'
    })
    await person.base.ready()
    bootstrap = person.base.key
  }
  const [owner] = people
  for (const person of people) {
    await owner.base.append({
      type: 'writer',
      key: hex(person.base.local.key),
      name: person.name
    })
  }
  const room = {
    people,
    sent: 0,
    sync: () => replicateAndSync(people.map((p) => p.base)),
    async close() {
      for (const person of people) {
        await person.reclaim.close()
        await person.keys.close()
        await person.base.close()
        await person.store.close()
      }
    }
  }
  await room.sync()
  return room
}

async function personIn(name, removals) {
  // test-tmp makes a temp dir in Node and Bare alike, and hands back what removes it
  const dir = await tmp({ teardown: (remove) => removals.push(remove) })
  const store = new Corestore(dir)
  return {
    name,
    store,
    keys: new tombstone.KeyStore(),
    files: new Map(),
    reclaim: new tombstone.Reclaim(store, { dir, wait: 0 }),
    base: null
  }
}

async function main(log = console.log) {
  const removals = []
  const people = []
  for (const name of ['ana', 'bruno', 'cris']) people.push(await personIn(name, removals))
  const room = await createRoom(people)
  const [ana, bruno, cris] = people
  const show = (lines) => {
    for (const line of lines) log('  ' + line)
  }

  try {
    const hi = await say(room, ana, 'Hi all')
    await say(room, cris, 'Hello!')
    const spam = await say(room, bruno, 'Buy now')
    const pills = await say(room, bruno, 'Cheap pills')
    await room.sync()
    await say(room, cris, 'is this a bot?', { reply: pills })
    await say(room, bruno, 'Limited offer', { file: crypto.randomBytes(2 * 1024 * 1024) })
    await say(room, bruno, 'Click here')
    await room.sync()
    log('ana, bruno and cris in one room')
    show(await linesOf(room, cris))

    await remove(cris, hi)
    await room.sync()
    const kept = []
    for (const person of people) {
      if (!(await person.base.view.get('entries/' + hi)).value.deleted) kept.push(person)
    }
    log(`\ncris deletes ana's message: refused, it is still on ${kept.length} of 3 peers`)

    await remove(ana, hi)
    await purge(ana, bruno)
    await room.sync()
    log('ana deletes her own message, and purges bruno: one record for all of his')

    const freed = []
    bruno.reclaim.onfreed = (result) => freed.push(result)
    const cleared = []
    for (const person of people) cleared.push(await shred(person))
    await bruno.reclaim.run()

    const screens = []
    for (const person of people) screens.push(await linesOf(room, person))
    const same = screens.filter((lines) => JSON.stringify(lines) === JSON.stringify(screens[0]))
    log(`\nwhat the room shows now, the same on ${same.length} of 3 peers`)
    show(screens[0])

    const box = (await cris.base.view.get('entries/' + spam)).value.box
    const left = people.filter((person) => person.keys.has(spam) || person.keys.has(hi))
    log(`\n"Buy now" is still in every log, sealed: ${box.slice(0, 24)}…`)
    log(`its secret is on ${left.length} of 3 peers`)
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB'
    log(`bruno's file: ${mb(cleared[1])} cleared, ${mb(bruno.reclaim.freedAll)} back on the disk`)
    return { screens, cleared, freed, reclaimed: bruno.reclaim.freedAll, left: left.length }
  } finally {
    await room.close()
    for (const remove of removals) await remove()
  }
}

function hex(buf) {
  return b4a.toString(buf, 'hex')
}

function isId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id)
}

function isKey(key) {
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)
}

function isBox(box) {
  return typeof box === 'string' && /^([0-9a-f]{2}){28,4096}$/.test(box)
}

function isName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64
}

module.exports = {
  open,
  apply,
  entriesOf,
  createRoom,
  personIn,
  say,
  remove,
  purge,
  shred,
  screenOf,
  linesOf,
  main
}

if (require.main === module) main()
