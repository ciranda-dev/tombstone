# Capy: drawing deleted messages with `rows()`

What the desktop (`capy`) and the phone (`capy-mobile`) call and read so that a deleted message
shows nothing unless something points at it, and a purge shows as one line. The design comes
first (Fable): this says what the data is and where it goes, not how it looks.

Nothing changes between peers. The tombstone stays in the log, every device still drops the
message's key and gives the space back, and a Capy before this one keeps drawing one bubble per
deleted message, in the same room.

## What the worker gives (capy-worker `feat/tombstone`)

Every message view of a deleted message (`messages`, `messages-changed`, `getOlder`), as before:
`{ id, text: '', at, from, mine, verified, deleted: true, thread? }`, and now also:

| Field       | Always | What it is                                                                                                                                                                  |
| ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deletedBy` | yes    | The identity (hex) that deleted it: its author, the room's owner, an admin or a moderator. A name through the members list, as `from` is.                                   |
| `purge`     | no     | Only when a purge of its author's messages took it (a mute, 16bb): a string, the same for every message that purge took. An opaque key: compare it, never parse or show it. |
| `purgedAt`  | no     | With `purge`: when that purge was made, ms since the epoch (the purge record's own `at`), the same for every message it took. The time a purge's line shows.                |

`from` is still whose message it was. `capy-worker/lib/tombstone` exports `rows`, the function
below, for the apps' tests.

One limit, said here so no text claims more: a purge that a later purge of the same person
replaced (unmuted, then muted again) is not in the room's view any more, so its messages come
without `purge` or `purgedAt` and show nothing, like any message deleted on its own.

## The rule: `rows(entries, { pointed, group })`

Pure, no imports: `rows()` and its two one-line defaults `no()` and `none()` at the end of
capy-worker's `workers/lib/tombstone.js` (`// What a screen shows`). Its tests are in capy-worker's
`test/tombstone.js` (`rows: live entries, markers where something points, …`).

- `entries`: the messages the main chat shows, oldest first, after what it leaves out today
  (someone blocked, a thread's replies that weren't sent to the room).
- `pointed(message)`: something on screen still points at it. In Capy:
  - a reply: a message in `room.history` that isn't deleted and whose `reply` is its id;
  - a thread: `threadsOf(room).has(message.id)` (it counts only replies that aren't deleted);
  - a pin: `room.pins` has its id. The worker's `getPins` already leaves deleted messages out, so
    today this adds nothing; it stays in so a pin can never lose its place.
- `group(message)`: `message.purge`.

It returns, in order:

| Row                               | What the window draws                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: 'entry', entry }`        | The message, as today.                                                                                                                                                                                                  |
| `{ type: 'deleted', entry }`      | Today's small "Message deleted" (`bubble__gone`), so the reply's quote, the thread line or the pin still has its place.                                                                                                 |
| `{ type: 'run', group, entries }` | One line for the messages of one purge that are next to each other on screen: `nameOf(room, entries[0].deletedBy)` deleted `entries.length` of `authorOf(room, entries[0])`'s messages · `timeOf(entries[0].purgedAt)`. |

Every other deleted message is not drawn. A hidden one doesn't break a run; a message, a marker or
a line does, so one purge can be two lines when someone wrote in between. Say only what the run
holds: "Ana deleted 3 of Bruno's messages" is true of that line, "all of Bruno's messages" is not.
The count needs plural forms (`{count}`, and Arabic's six).

## Desktop (`capy`)

The renderer is ES modules with no bundler, so the function is copied, as `renderer/js/limits.js`
is:

1. `renderer/js/tombstones.js`: `export function rows` with `no` and `none`, copied from
   `workers/lib/tombstone.js` as they are, nothing else.
2. A test in `test/` that evaluates it as `test/limits.js` does and checks that it gives what
   `require('capy-worker/lib/tombstone').rows` gives on the same entries (the cases of capy-worker's
   rows test), so a change on one side fails there.
3. `renderer/js/views/chat/messages.js`, `rows()`:
   - compute `threads` before the loop, then
     `const kept = rows(shown, { pointed, group: (m) => m.purge })`, with `pointed` as above;
   - loop over `kept` instead of `shown`. An `entry` or a `deleted` row is the message the loop
     draws today (`bubble()` already sends a deleted one to `goneBubble`). A `run` row is a line
     like the `left` divider (`li.joined-divider`, `role: 'separator'`), with
     `dataset: { id: entries[0].id }`, and it ends the bubble group (`group = null`);
   - where a `run` sits (the day, the call cards, "You joined") comes from `entries[0].at`, like
     any message; the time its line shows is `purgedAt`, when the purge was made, not when the
     messages were written;
   - "NEW MESSAGES" today waits for `message.id === room.newFrom`; when that message is one of the
     hidden ones it never shows. Put it before the first row whose id is `>= room.newFrom` (ids sort
     by time), once.
4. A jump to a message that is now hidden (an old notification, a search hit from before the
   purge) lands on nothing: fall back to the row that holds it (the run's line, by its entries) or
   the next one.
5. The thread panel (`views/chat/thread.js`) lists a thread's replies, deleted ones included: run
   the same `rows()` over them, the first message always shown.

## Phone (`capy-mobile`)

1. `src/screens/chat/lib/tombstones.ts`: the same function, typed, with no React Native imports
   (as `editRules.ts`), and `test/tombstones.test.ts` (`npm run test:unit`) checking it against
   `capy-worker/lib/tombstone`'s `rows` on the same cases.
2. `src/screens/chat/parts/MessageList.tsx`, `rowsOf(room, extra)`: the same steps as the desktop's.
   It needs `threadsOf(room)` (`src/store/rooms.ts`; the component computes it at `useMemo`, so call
   it in `rowsOf` or pass it in). A `run` is
   `items.push({ kind: 'line', key: 'purge-' + entries[0].id, text })` after `closeGroup()`; a
   `deleted` row is the `message` row it is today (`Bubble.tsx` draws "Message deleted"). The
   `room.newFrom` divider moves the same way.
3. `src/screens/chat/ThreadScreen.tsx` shows a thread's deleted replies too: the same `rows()` there.
4. The room list's preview (`src/store/rooms.ts` and `words.ts`, "Message deleted") is the newest
   message's; leave it, or let the design say what a room whose newest message was deleted shows.
