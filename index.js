const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')

// Secrets

const SECRET = 32
const IV = 12
const TAG = 16
const HEX = /^[0-9a-f]{64}$/
const MAX_ID = 1024
const EMPTY = b4a.alloc(0)

function secret() {
  return hcrypto.randomBytes(SECRET)
}

function isSecret(secret) {
  return b4a.isBuffer(secret) && secret.byteLength === SECRET
}

// The key of one use of a secret: BLAKE2b-256 of the name, then the secret
function keyOf(secret, name) {
  return hcrypto.hash([b4a.from(name), secret])
}

// AES-256-GCM: iv | ciphertext | tag
function seal(data, key, aad = EMPTY) {
  const iv = hcrypto.randomBytes(IV)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(b4a.from(aad))
  const body = cipher.update(data)
  return b4a.concat([iv, body, cipher.final(), cipher.getAuthTag()])
}

function open(box, key, aad = EMPTY) {
  if (!b4a.isBuffer(box) || box.byteLength < IV + TAG) return null
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, box.subarray(0, IV))
    decipher.setAAD(b4a.from(aad))
    decipher.setAuthTag(box.subarray(box.byteLength - TAG))
    const body = decipher.update(box.subarray(IV, box.byteLength - TAG))
    return b4a.concat([body, decipher.final()])
  } catch {
    return null
  }
}

// A small file written whole: a temporary file renamed over it, so nothing dropped stays in an
// older copy. Writes are serialized, and one waiting picks up every change made before it starts.
// data() gives the text, or a promise of it. No file: nothing is written
class WholeFile {
  constructor(file, data) {
    this.file = file
    this.data = data
    this._writing = Promise.resolve()
    this._queued = null
  }

  save() {
    if (!this.file) return Promise.resolve()
    if (!this._queued) {
      this._queued = this._writing.then(() => {
        this._queued = null
        return this._write()
      })
      this._writing = this._queued.catch(noop)
    }
    return this._queued
  }

  async _write() {
    const temp = this.file + '.tmp'
    const data = await this.data()
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
    await fs.promises.writeFile(temp, data, { mode: 0o600 })
    await fs.promises.rename(temp, this.file)
  }

  async close() {
    await this._writing
  }
}

// The secrets of a log's entries on this device, outside the log: id -> secret, and the ids
// shredded for good, whose secret is refused from then on. In memory only without a file
class KeyStore {
  constructor(file = null) {
    this.file = file
    this.keys = new Map()
    this.shredded = new Set()
    this._saver = new WholeFile(file, () => JSON.stringify(this))
  }

  // Resolves with what the file held, or null
  async load() {
    if (!this.file) return null
    let saved = null
    try {
      saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8'))
    } catch {
      return null
    }
    for (const [id, key] of Object.entries(saved?.keys || {})) {
      if (isId(id) && HEX.test(key)) this._keep(id, b4a.from(key, 'hex'))
    }
    for (const id of Array.isArray(saved?.shredded) ? saved.shredded : []) {
      if (isId(id)) this.shredded.add(id)
    }
    return saved
  }

  has(id) {
    return this.keys.has(id)
  }

  get(id) {
    return this.keys.get(id) || null
  }

  ids() {
    return [...this.keys.keys()]
  }

  isShredded(id) {
    return this.shredded.has(id)
  }

  // The first secret of an id stays. Resolves with whether it was kept, once it's on disk
  set(id, secret) {
    if (!isId(id) || this.keys.has(id) || this.shredded.has(id) || !isSecret(secret)) {
      return Promise.resolve(false)
    }
    this._keep(id, b4a.from(secret))
    return this._saver.save().then(() => true)
  }

  // Zeroes and forgets their secrets, here and on disk. done: shredded for good
  drop(ids, { done = false } = {}) {
    for (const id of ids) {
      this._forget(id)
      if (done) this.shredded.add(id)
    }
    return this._saver.save()
  }

  _keep(id, secret) {
    this.keys.set(id, secret)
  }

  _forget(id) {
    const secret = this.keys.get(id)
    if (secret) secret.fill(0)
    this.keys.delete(id)
  }

  toJSON() {
    const keys = {}
    for (const [id, secret] of this.keys) keys[id] = b4a.toString(secret, 'hex')
    return { v: 1, keys, shredded: [...this.shredded] }
  }

  close() {
    return this._saver.close()
  }
}

function isId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID
}

// The rule

const DELETE = 'delete'
const WAIT = 'wait'
const IGNORE = 'ignore'
const MAX_WAITING = 256

// What a view does with a tombstone for `target`, the entry it holds (null while it hasn't
// arrived). allowed(tombstone, target) is the host's
async function decide(tombstone, target, allowed, { waiting = 0, max = MAX_WAITING } = {}) {
  if (!target) return waiting < max ? WAIT : IGNORE
  if (target.deleted) return IGNORE
  return (await allowed(tombstone, target)) ? DELETE : IGNORE
}

// The entry arrived: of the tombstones that waited for it, in order, the first allowed counts
async function settle(target, waiting, allowed) {
  for (const tombstone of waiting) {
    if (await allowed(tombstone, target)) return tombstone
  }
  return null
}

// Reclaim

const GC_FORCE = 1 // rocksdb-native's garbageCollectionPolicy.FORCE
const GC_DISABLE = 2 // garbageCollectionPolicy.DISABLE
const BOTTOM_FORCE = 2 // bottommostLevelCompaction.FORCE
const GARBAGE = 'rocksdb.live-blob-file-garbage-size'
const WAIT_MS = 3000
const MARGIN = 1024 * 1024 * 1024
const NOISE = 0.1
const RETRY = 10 * 1000
const MAX_RETRY = 10 * 60 * 1000
const TRIES = 12

class Reclaim {
  constructor(
    store,
    {
      dir,
      file = null,
      wait = WAIT_MS,
      slack = 0,
      margin = MARGIN,
      retry = RETRY,
      onfreed = noop,
      onerror = noop
    } = {}
  ) {
    this.store = store
    this.dir = dir
    this.file = file
    this.wait = wait
    this.slack = slack
    this.margin = margin
    this.retry = retry
    this.onfreed = onfreed
    this.onerror = onerror
    this.owed = 0
    this.full = false
    this.timer = null
    this.running = Promise.resolve()
    this.queued = null
    this.keeping = Promise.resolve()
    this.closed = false
    this.starting = false // no snapshot is older than this run
    this.tries = 0
    this.again = null
    this.last = null
    this.freedAll = 0
  }

  async ready() {
    if (!this.file) return
    let saved = null
    try {
      saved = JSON.parse(await fs.promises.readFile(this.file, 'utf8'))
    } catch {
      return
    }
    const owed = Number(saved?.owed)
    const full = saved?.full === true
    if ((Number.isSafeInteger(owed) && owed > 0) || full) {
      this.starting = true
      this.soon(owed, { full })
    }
  }

  // `bytes` were cleared or purged; full: how many isn't known
  soon(bytes = 0, { full = false } = {}) {
    if (this.closed) return
    if (Number.isSafeInteger(bytes) && bytes > 0) this.owed += bytes
    if (full) this.full = true
    this._keep()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.run().catch((err) => this._failed(err))
    }, this.wait)
    this.timer.unref()
  }

  run() {
    if (this.queued) return this.queued
    const next = this.running.then(() => {
      this.queued = null
      return this._run()
    })
    this.queued = next
    this.running = next.catch(noop)
    return next
  }

  async _run() {
    clearTimeout(this.again)
    this.again = null
    if (this.closed) return null
    const owed = this.owed
    const full = this.full
    const starting = this.starting
    this.starting = false
    const before = await sizeOf(this.dir)
    await this.store.storage.compact({
      blobGarbageCollectionPolicy: GC_DISABLE,
      bottommostLevelCompaction: BOTTOM_FORCE
    })
    let size = await sizeOf(this.dir)
    let garbage = await this._garbage()
    if (garbage > this.slack && !this.closed && (await this._room(size))) {
      await this.store.storage.compact({
        blobGarbageCollectionPolicy: GC_FORCE,
        blobGarbageCollectionAgeCutoff: 1,
        bottommostLevelCompaction: BOTTOM_FORCE
      })
      size = await sizeOf(this.dir)
      garbage = await this._garbage()
    }
    const freed = Math.max(0, before - size)
    this.freedAll += freed
    const short = !starting && owed - freed > owed * NOISE
    const complete = garbage <= this.slack && !short
    if (complete) {
      this.owed = Math.max(0, this.owed - owed)
      if (full) this.full = false
      this.tries = 0
    } else {
      this.owed = Math.max(0, this.owed - freed)
      this._askAgain()
    }
    await this._keep()
    const result = { freed, complete, size }
    this.last = result
    this.onfreed(result)
    return result
  }

  _askAgain() {
    if (this.closed || this.tries >= TRIES) return
    const wait = Math.min(this.retry * 2 ** this.tries, MAX_RETRY)
    this.tries++
    this.again = setTimeout(() => {
      this.again = null
      this.run().catch((err) => this._failed(err))
    }, wait)
    this.again.unref()
  }

  async _garbage() {
    return Number(await this.store.storage.db.getProperty(GARBAGE)) || 0
  }

  _failed(err) {
    this.onerror(err)
    this.onfreed({ freed: 0, complete: false, size: null, failed: true })
  }

  // Room on the disk for a copy of the live data, and the margin
  async _room(size) {
    try {
      const stats = await fs.promises.statfs(this.dir)
      return Number(stats.bavail) * Number(stats.bsize) >= size + this.margin
    } catch {
      return false
    }
  }

  _keep() {
    const write = async () => {
      if (!this.file) return
      if (this.owed === 0 && !this.full) return await fs.promises.rm(this.file, { force: true })
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
      await fs.promises.writeFile(
        this.file,
        JSON.stringify({ v: 1, owed: this.owed, full: this.full })
      )
    }
    this.keeping = this.keeping.then(write).catch((err) => this.onerror(err))
    return this.keeping
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = null
    clearTimeout(this.again)
    this.again = null
    await this.running
    await this.keeping
  }
}

async function sizeOf(dir) {
  let names = null
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return 0
  }
  let size = 0
  for (const name of names) {
    const file = path.join(dir, name)
    const stat = await fs.promises.lstat(file).catch(() => null) // gone while it was read
    if (stat?.isDirectory()) size += await sizeOf(file)
    else if (stat?.isFile()) size += stat.size
  }
  return size
}

// What a screen shows

// Entries in order. A live one shows; a deleted one only as a marker where something points at
// it; a run of deleted ones one delete took together (the same group) as one line; the rest, not
function rows(entries, { pointed = no, group = none } = {}) {
  const shown = []
  let run = null
  for (const entry of entries) {
    if (!entry.deleted) {
      shown.push({ type: 'entry', entry })
      run = null
    } else if (pointed(entry)) {
      shown.push({ type: 'deleted', entry })
      run = null
    } else {
      const key = group(entry)
      if (key === null || key === undefined) continue
      if (run !== null && run.group === key) {
        run.entries.push(entry)
        continue
      }
      run = { type: 'run', group: key, entries: [entry] }
      shown.push(run)
    }
  }
  return shown
}

function no() {
  return false
}

function none() {
  return null
}

function noop() {}

module.exports = {
  secret,
  isSecret,
  keyOf,
  seal,
  open,
  WholeFile,
  KeyStore,
  DELETE,
  WAIT,
  IGNORE,
  MAX_WAITING,
  decide,
  settle,
  Reclaim,
  sizeOf,
  rows
}
