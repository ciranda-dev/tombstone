# Examples

## `autobase.js`

Three people talk in one [Autobase](https://github.com/holepunchto/autobase) room. Each person has
their own Corestore in a temp dir, and the three bases replicate in the same process, as in
Autobase's own tests. The view is a [Hyperbee](https://github.com/holepunchto/hyperbee).

Each message is sealed with a secret of its own (`tombstone.seal()` under
`tombstone.keyOf(secret, 'tombstone-example/text')`, the message's id as additional data), and the
secret goes to each person's `KeyStore`, never into the log. An attachment goes in a Hypercore of
its own, sealed under another key of the same secret. `apply` takes:

- a writer only from the room's creator, who is also its moderator;
- a message, unless the view holds one with its id already: the first copy wins;
- a delete through `tombstone.decide()`, allowed for the message's author and the moderator. One
  that comes before its message waits, and `tombstone.settle()` checks it when the message comes;
- a purge only from the moderator: a tombstone for each of the target's messages the view holds,
  all with the purge's id as their group.

After apply, each device drops the secrets of the deleted messages, clears the attachments it
holds and lets its `Reclaim` compact the store. `tombstone.rows()` gives the screen, with a
message a reply quotes as a marker and a purge's messages in a row as one line.

```sh
npm install
node examples/autobase.js
bare examples/autobase.js   # with Bare installed: npm install -g bare
```

The output:

```text
ana, bruno and cris in one room
  ana: Hi all
  cris: Hello!
  bruno: Buy now
  bruno: Cheap pills
  cris: is this a bot? (replying to bruno)
  bruno: Limited offer (with a file)
  bruno: Click here

cris deletes ana's message: refused, it is still on 3 of 3 peers
ana deletes her own message, and purges bruno: one record for all of his

what the room shows now, the same on 3 of 3 peers
  cris: Hello!
  ana deleted 1 of bruno's messages
  Message deleted
  cris: is this a bot? (replying to a deleted message)
  ana deleted 2 of bruno's messages

"Buy now" is still in every log, sealed: e682194b2c9bbf8c30a9ab9c…
its secret is on 0 of 3 peers
bruno's file: 2.0 MB cleared, 2.3 MB back on the disk
```

The disk gets back more than the file: what the store's database compacted with it.

[`test/autobase.js`](../test/autobase.js) runs the same code and checks the outcome, also when the
writers append without seeing each other and then replicate in different orders, when a
tombstone comes before its message, and when someone reuses an id.

The Holepunch modules here (`autobase`, `corestore`, `hyperbee`, `autobase-test-helpers`,
`test-tmp`) are dev dependencies.
