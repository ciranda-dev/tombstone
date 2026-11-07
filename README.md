<div align="center">

# @ciranda/tombstone

Delete in a replicated, append-only log.

![status: experimental](https://img.shields.io/badge/status-experimental-orange)
![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![runtime: Node | Bare](https://img.shields.io/badge/runtime-Node%20%7C%20Bare-6e56cf)

</div>

Nothing can be removed from an append-only log that every peer keeps a copy of, such as a
[Hypercore](https://github.com/holepunchto/hypercore) or an
[Autobase](https://github.com/holepunchto/autobase). `@ciranda/tombstone` is what deleting can be
there: each entry sealed with a secret of its own that never goes in the log and is destroyed on
delete, a tombstone every peer applies the same way, the blocks cleared and the store compacted
so the bytes leave the disk, and a screen that shows a deleted entry only where something still
points at it. It is extracted from [Capy](https://capy.ciranda.dev), whose rooms run on it. Made
by [Ciranda](https://ciranda.dev).

## Features

- A secret per entry, AES-256-GCM, and a key file outside the log that a delete zeroes and rewrites.
- One rule for tombstones that ends the same on every peer, whatever order things arrive in.
- Cleared blocks taken off the disk by compacting Corestore's storage, with what a snapshot keeps
  asked for again.
- What a screen shows: no column of "Message deleted", and a purge as one line.
- Works in Node and Bare.

## Install

```sh
npm install @ciranda/tombstone
```

## Usage

```js
const b4a = require('b4a')
const tombstone = require('@ciranda/tombstone')

const keys = new tombstone.KeyStore('./keys.json') // this device's, never in the log
await keys.load()

// An entry sealed with a secret of its own: the box goes in the log, the secret doesn't
const id = '0001-ana'
const secret = tombstone.secret()
const box = tombstone.seal(b4a.from('hi'), tombstone.keyOf(secret, 'chat/text'), id)
await keys.set(id, secret) // and to the other peers, over encrypted connections

tombstone.open(box, tombstone.keyOf(keys.get(id), 'chat/text'), id) // <Buffer 68 69>

// Its tombstone counted: the secret goes, and the box left in every log is noise
await keys.drop([id], { done: true })
keys.get(id) // null

// What the screen shows
const entries = [
  { id: '0001-ana', deleted: { by: 'ana' } },
  { id: '0002-bruno', deleted: { by: 'ana', purge: 'p1' } },
  { id: '0003-bruno', deleted: { by: 'ana', purge: 'p1' } },
  { id: '0004-cris', deleted: null, reply: '0002-bruno' }
]
tombstone.rows(entries, {
  pointed: (entry) => entry.id === '0002-bruno', // the reply quotes it
  group: (entry) => entry.deleted.purge
})
// [
//   { type: 'deleted', entry: <0002-bruno> },              a small "Message deleted"
//   { type: 'run', group: 'p1', entries: [<0003-bruno>] }, "ana deleted 1 of bruno's messages"
//   { type: 'entry', entry: <0004-cris> }
// ]                                                        and 0001-ana shows nothing
```

How a view applies tombstones is under [Autobase apps](#autobase-apps), and how the disk gets
the bytes back under `Reclaim` in the API.

## How it works

| Problem                                      | What the package does                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A log can't remove anything                  | A delete is a new record, a tombstone, that marks its target. The entry stays in every log.                                                        |
| The entry is still readable in every copy    | Crypto-shredding: each entry is sealed with a secret of its own, kept outside the log, and destroyed on delete. The box left in the logs is noise. |
| A dropped secret could stay on the disk      | The key file is written whole, a temporary file renamed over it, and the secret's buffer is zeroed.                                                |
| A tombstone can arrive before its entry      | It waits, bounded, and counts when the entry arrives if its sender may delete it then.                                                             |
| A late copy could bring a deleted entry back | The first copy of an id wins: a view never replaces an entry it holds.                                                                             |
| A cleared block's bytes stay in the database | A compaction of Corestore's storage takes them off the disk.                                                                                       |
| A snapshot still sees what was deleted       | What didn't come back is asked again, with a backoff, and at the next start.                                                                       |
| A cleanup fills the room with "deleted"      | A deleted entry shows only where something points at it, and the entries one purge took show as one line.                                          |

Each choice follows what the established implementations do:

- **Crypto-shredding** is NIST SP 800-88's cryptographic erase: destroy the key, and the data it
  encrypted can't be read. The cipher is AES-256-GCM (NIST SP 800-38D) with a random 96-bit iv per
  box and the box's place as additional data, so a box copied elsewhere doesn't open. The key of
  each use of a secret is BLAKE2b-256 of a name and the secret, through
  [hypercore-crypto](https://github.com/holepunchto/hypercore-crypto) (libsodium's generic hash),
  so the text and the files of one entry never share a key.
- **Tombstones** are remove-wins, as in a two-phase set: once deleted, an entry stays deleted. Who
  may delete is your function, checked on every peer when the tombstone is applied, since no
  server refuses it. In an Autobase an honest writer's tombstone comes after the entry it saw, so
  one that waits came from a writer that never saw it; the list is bounded (`MAX_WAITING`, 256) so a
  flood of them can't grow the view.
- **Reclaim** is how an LSM store deletes: a delete writes a tombstone in RocksDB, and the bytes
  leave at compaction. `Reclaim` compacts in two passes. The first takes the last level too
  (`bottommostLevelCompaction: FORCE`) and rewrites no blob, which drops the blob files that held
  nothing but deleted blocks. If blob files still count garbage
  (`rocksdb.live-blob-file-garbage-size`), the second rewrites every live blob
  (`blobGarbageCollectionPolicy: FORCE`, age cutoff 1), only when the disk has room for a copy of
  the live data. No compaction drops what a database snapshot sees, so what didn't come back is
  asked again up to 12 times, then kept for the next start.
- **The screen** keeps a marker only where something points at the deleted entry, as Slack keeps
  "This message was deleted." only for a message with thread replies. The rest disappear.

## Security

On every honest peer that drops an entry's secret once its tombstone counts, clears what it held
and lets `Reclaim` run, as the example does: the secret is gone from memory and from the key file,
nothing can open the box left in the logs, and the cleared blocks leave the database's files once
no snapshot sees them and the disk has room for the compaction.

What it can't do:

- Reach a copy. A peer that read an entry, saved its secret or ran a modified app keeps what it
  has. In peer-to-peer nothing can be removed from someone else's computer.
- Secure-erase a disk. A file system or an SSD may keep old blocks of a rewritten file until they
  are reused. Full-disk encryption is what covers that; keep the key file out of backups too.
- Protect a secret in transit. Send secrets only over connections that are encrypted end to end,
  such as Hyperswarm's.
- Decide who may delete. Your `allowed` function does, and every peer must run the same one.

## API

#### `secret()`

32 random bytes, one entry's secret. `isSecret(buffer)` says whether a buffer is one.

#### `keyOf(secret, name)`

The key of one use of a secret: BLAKE2b-256 of `name`, then `secret`. Use one name per use.

#### `box = seal(data, key[, aad])`

AES-256-GCM: `iv | ciphertext | tag`, a buffer. `aad` (a string or a buffer) binds the box to its
place, such as the room and the entry's id.

#### `data = open(box, key[, aad])`

The data, or `null` when the key or the aad is not the one it was sealed with, or the box was
changed.

#### `keys = new KeyStore([file])`

The secrets of a log's entries on this device: id to secret, in a JSON file of its own (mode
0600), or in memory only without one.

- `await keys.load()`: reads the file, and resolves with what it held, or `null`.
- `await keys.set(id, secret)`: keeps a secret, resolving with whether it did. The first one of an
  id stays, and an id shredded for good takes none.
- `keys.get(id)`, `keys.has(id)`, `keys.ids()`, `keys.isShredded(id)`.
- `await keys.drop(ids[, { done }])`: zeroes and forgets their secrets, here and in the file.
  `done: true` marks them shredded for good. Drop first, clear what the entries held, then drop
  again with `done`, so a crash in between finishes at the next start.
- `await keys.save()`: writes the file again, whole, with what `keys.toJSON()` says. A subclass
  that keeps more for each id overrides `toJSON()`, `load()` (which resolves with the parsed file),
  `_keep(id, secret)` and `_forget(id)`, and calls `save()`.
- `await keys.close()`.

#### `file = new WholeFile(path, data)`

The writer `KeyStore` uses: `await file.save()` writes `await data()` to a temporary file and
renames it over `path`, one write at a time.

#### `verdict = await decide(tombstone, target, allowed[, { waiting, max }])`

What a view does with a tombstone. `target` is the entry the view holds under its id, or `null`.
`allowed(tombstone, target)` is yours, and may return a promise. `waiting` is how many tombstones
your view keeps waiting, `max` how many it may (`MAX_WAITING`).

| `verdict` | When                                                      | Your view                      |
| --------- | --------------------------------------------------------- | ------------------------------ |
| `DELETE`  | the target is there, not deleted, and `allowed` says yes  | marks the target deleted       |
| `WAIT`    | there is no target yet, and fewer than `max` wait         | keeps the tombstone for its id |
| `IGNORE`  | the target is deleted already, `allowed` says no, or full | nothing                        |

An entry is deleted when its `deleted` field is truthy.

#### `counted = await settle(target, waiting, allowed)`

The entry `target` arrived: of the tombstones that waited for it, in the order they came, the first
`allowed` one, or `null`. Remove all of them from the view either way.

#### `reclaim = new Reclaim(store[, options])`

Gives the disk back after a clear or a purge, for a Corestore.

| Option    | Default | Description                                                                |
| --------- | ------- | -------------------------------------------------------------------------- |
| `dir`     |         | Where the store is on disk, to measure what was freed.                     |
| `file`    | `null`  | Where what is left to free is kept across a quit.                          |
| `wait`    | `3000`  | Ms after the last `soon()` before it compacts.                             |
| `slack`   | `0`     | Garbage bytes the first pass may leave before the second one runs.         |
| `margin`  | 1 GiB   | Free bytes the second pass keeps on the disk past the copy of the data.    |
| `retry`   | `10000` | Ms before what didn't come back is asked again, doubled each time.         |
| `onfreed` |         | Called after each run with `{ freed, complete, size }`, or `failed: true`. |
| `onerror` |         | Called with what failed: a compaction, or the file.                        |

- `await reclaim.ready()`: picks up what a quit left.
- `reclaim.soon(bytes[, { full }])`: `bytes` were cleared; `full: true` when how many isn't known.
- `await reclaim.run()`: compacts now, resolving with what `onfreed` is told.
- `reclaim.owed`, `reclaim.freedAll`, `reclaim.last`, and `await reclaim.close()`.

`sizeOf(dir)` resolves with the bytes of every file under a folder.

`Reclaim` uses Corestore's `storage` (the hypercore-storage it opened), whose `compact(options)`
hands rocksdb-native's `compactRange` options through, and rocksdb-native's `getProperty` on its
database. None of the three READMEs documents them yet; `test/reclaim.js` fails the day a version
stops giving the disk back.

#### `rows(entries[, { pointed, group }])`

What a screen shows of `entries`, in their order:

- `{ type: 'entry', entry }` for each live one;
- `{ type: 'deleted', entry }`, a marker, for a deleted one `pointed(entry)` says something points
  at (a reply that quotes it, a thread under it, a pin);
- `{ type: 'run', group, entries }`, one line, for deleted ones in a row with the same
  `group(entry)`: the ones one delete took together, such as a purge. Hidden entries don't break a
  run; a live entry or a marker does.

Any other deleted entry shows nothing.

#### Constants

`DELETE`, `WAIT`, `IGNORE`, `MAX_WAITING`.

## Autobase apps

[`examples/autobase.js`](examples/autobase.js) is a room with three writers and a Hyperbee view:
messages sealed with a secret each, a delete, a moderator's purge that takes a spammer's messages
in one record, an attachment cleared and compacted away, and what the screen shows after. Its
delete handler:

```js
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
```

Keep everything the rule reads in the view, never in memory: Autobase may undo and apply again
what it already applied. Drop secrets, clear blocks and compact after apply, outside it. The
example and its tests run in Node and Bare; see [`examples/README.md`](examples/README.md).

## Development

```sh
npm install
npm test                      # npm run test:node (with coverage) and npm run test:bare
npm run lint
node examples/autobase.js     # the Autobase example
```

`npm run test:bare` and `bare examples/autobase.js` need [Bare](https://github.com/holepunchto/bare)
(`npm install -g bare`). The examples and tests use Holepunch modules as dev dependencies.

Changes must keep every rule the same on every peer and every format Capy wrote opening.
Issues and pull requests are welcome.

## License

Apache-2.0. Copyright 2026 [Ciranda](https://ciranda.dev). See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
