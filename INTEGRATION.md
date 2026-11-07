# Capy: drawing deleted messages with `rows()`

What the desktop (`capy`) and the phone (`capy-mobile`) call and read so that a deleted message
shows nothing unless something points at it, and a purge shows as one line at its time. The design comes
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

## The rule: `rows(entries, { pointed, group, time })`

Pure, no imports: `rows()` and its one-line defaults `no()`, `none()` and `atOf()` at the end of
capy-worker's `workers/lib/tombstone.js` (`// What a screen shows`). Its tests are in capy-worker's
`test/tombstone.js` (`rows: live entries, markers where something points, …`).

- `entries`: the messages the main chat shows, oldest first, after what it leaves out today
  (someone blocked, a thread's replies that weren't sent to the room).
- `pointed(message)`: something on screen still points at it. In Capy:
  - a reply: a message in `room.history` that isn't deleted and whose `reply` is its id;
  - a thread: `threadsOf(room).has(message.id)` (it counts only replies that aren't deleted);
  - a pin: `room.pins` has its id. The worker's `getPins` already leaves deleted messages out, so
    today this adds nothing; it stays in so a pin can never lose its place.
- `group(message)`: `message.purge ? { id: message.purge, at: message.purgedAt } : null`.
- `time`: leave the default, `message.at`, the time every message view has.

It returns, in the order to draw them:

| Row                                          | What the window draws                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ type: 'entry', entry }`                   | The message, as today.                                                                                                                                                                           |
| `{ type: 'deleted', entry }`                 | Today's small "Message deleted" (`bubble__gone`), so the reply's quote, the thread line or the pin still has its place.                                                                          |
| `{ type: 'purge', group, count, at, entry }` | One line for each purge, wherever its messages were: `nameOf(room, entry.deletedBy)` deleted `count` of `authorOf(room, entry)`'s messages · `timeOf(at)`. It stands at `at`, like "You joined". |

Every other deleted message is not drawn, a message someone deleted on their own included. `entry`
of a purge row is the first message it took in the list, there for whose messages they were and
who purged them. `count` is how many messages of the list the purge took, the ones that still show
as a marker included: the list is what the window has loaded, so the line says what it holds
("Ana deleted 3 of Bruno's messages"), never "all", and it grows as older pages load. A purge none
of whose messages are in the list has no row. The count needs plural forms (`{count}`, and
Arabic's six).

## Desktop (`capy`)

The renderer is ES modules with no bundler, so the function is copied, as `renderer/js/limits.js`
is:

1. `renderer/js/tombstones.js`: `export function rows` with `no`, `none` and `atOf`, copied from
   `workers/lib/tombstone.js` as they are, nothing else.
2. A test in `test/` that evaluates it as `test/limits.js` does and checks that it gives what
   `require('capy-worker/lib/tombstone').rows` gives on the same entries (the cases of capy-worker's
   rows test), so a change on one side fails there.
3. `renderer/js/views/chat/messages.js`, `rows()`:
   - compute `threads` before the loop, then `const kept = rows(shown, { pointed, group })`, with
     `pointed` and `group` as above;
   - loop over `kept` instead of `shown`. An `entry` or a `deleted` row is the message the loop
     draws today (`bubble()` already sends a deleted one to `goneBubble`). A `purge` row is a line
     like the `left` divider (`li.joined-divider`, `role: 'separator'`), with
     `dataset: { purge: group }`, and it ends the bubble group (`group = null`);
   - what the loop reads off a message for where a row sits (the day, the call cards, "You
     joined") is `at` for a `purge` row and `entry.at` for the others;
   - "NEW MESSAGES" today waits for `message.id === room.newFrom`; when that message is a hidden
     one it never shows. Put it before the first `entry` or `deleted` row whose id is
     `>= room.newFrom` (ids sort by time), once.
4. A jump to a message that is now hidden (an old notification, a search hit from before the
   purge) lands on nothing: go to its purge's line (the row whose `group` is its `purge`), or for
   a message deleted on its own, to the row after where it was.
5. The thread panel (`views/chat/thread.js`) lists a thread's replies, deleted ones included: run
   the same `rows()` over them, the first message always shown.

## Phone (`capy-mobile`)

1. `src/screens/chat/lib/tombstones.ts`: the same function, typed, with no React Native imports
   (as `editRules.ts`), and `test/tombstones.test.ts` (`npm run test:unit`) checking it against
   `capy-worker/lib/tombstone`'s `rows` on the same cases.
2. `src/screens/chat/parts/MessageList.tsx`, `rowsOf(room, extra)`: the same steps as the desktop's.
   It needs `threadsOf(room)` (`src/store/rooms.ts`; the component computes it at `useMemo`, so call
   it in `rowsOf` or pass it in). A `purge` row is
   `items.push({ kind: 'line', key: 'purge-' + group, text })` after `closeGroup()`, its day and
   call cards read from `at`; a `deleted` row is the `message` row it is today (`Bubble.tsx` draws
   "Message deleted"). The `room.newFrom` divider moves the same way.
3. `src/screens/chat/ThreadScreen.tsx` shows a thread's deleted replies too: the same `rows()` there.
4. The room list's preview (`src/store/rooms.ts` and `words.ts`, "Message deleted") is the newest
   message's; leave it, or let the design say what a room whose newest message was deleted shows.
