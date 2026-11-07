const test = require('brittle')
const b4a = require('b4a')
const { replicateAndSync } = require('autobase-test-helpers')
const example = require('../examples/autobase.js')

const { createRoom, personIn, say, remove, purge, shred, entriesOf, linesOf } = example

async function room(t) {
  const removals = []
  const people = []
  for (const name of ['ana', 'bruno', 'cris']) people.push(await personIn(name, removals))
  const room = await createRoom(people)
  t.teardown(async () => {
    await room.close()
    for (const remove of removals) await remove()
  })
  return room
}

async function screens(room) {
  const all = []
  for (const person of room.people) all.push(await linesOf(room, person))
  return all
}

async function entryOn(person, id) {
  return (await person.base.view.get('entries/' + id))?.value || null
}

test('the example: a refused delete, a delete, a purge, and what the screen keeps', async (t) => {
  const lines = []
  const { screens, cleared, freed, reclaimed, left } = await example.main((line) =>
    lines.push(line)
  )
  const output = lines.join('\n')
  t.ok(output.includes("cris deletes ana's message: refused, it is still on 3 of 3 peers"))
  t.ok(output.includes('the same on 3 of 3 peers'))
  t.alike(screens[0], [
    'cris: Hello!',
    'Message deleted',
    'cris: is this a bot? (replying to a deleted message)',
    "ana deleted 4 of bruno's messages"
  ])
  t.alike(screens[1], screens[0])
  t.alike(screens[2], screens[0])
  t.is(left, 0, 'no peer keeps a deleted message’s secret')
  t.alike(cleared, [0, 2 * 1024 * 1024 + 32 * 28, 0], "only bruno's device held the file")
  t.ok(freed[0].complete, 'its bytes left the disk')
  t.ok(reclaimed > 2 * 1024 * 1024, 'all of them, measured')
})

test('the same screen on every peer, whatever order the writers replicate in', async (t) => {
  // a is ana, b bruno, c cris: 'ab bc' syncs ana with bruno, then bruno with cris
  const results = []
  for (const order of ['abc', 'ab bc ac', 'cb ac', 'bc ab']) {
    const at = await room(t)
    const [ana, bruno, cris] = at.people
    const pairs = { a: ana, b: bruno, c: cris }
    const merge = async () => {
      for (const group of order.split(' ')) {
        await replicateAndSync([...group].map((letter) => pairs[letter].base))
      }
      await at.sync()
    }

    // Each writes without seeing the others; ids are known before their entries arrive
    const hi = await say(at, ana, 'Hi')
    const spam = await say(at, bruno, 'spam')
    const more = await say(at, bruno, 'more spam')
    await say(at, cris, 'is this a bot?', { reply: more })
    await remove(ana, spam) // the moderator, before seeing it
    await remove(cris, hi) // not allowed
    await merge()
    await purge(ana, bruno)
    await at.sync()

    const all = await screens(at)
    t.alike(all[1], all[0], `${order}: bruno sees what ana sees`)
    t.alike(all[2], all[0], `${order}: cris sees what ana sees`)
    for (const person of at.people) {
      t.is((await person.base.view.get('count/waiting'))?.value || 0, 0, 'nothing left waiting')
    }
    results.push(all[0])
  }
  for (const result of results) {
    t.alike(result, [
      'ana: Hi',
      'Message deleted',
      'cris: is this a bot? (replying to a deleted message)',
      "ana deleted 1 of bruno's messages"
    ])
  }
})

test('a tombstone that comes before its entry waits, and counts only if allowed', async (t) => {
  const at = await room(t)
  const [ana, bruno, cris] = at.people
  const early = String(at.sent + 1).padStart(4, '0') + '-bruno'
  const later = String(at.sent + 2).padStart(4, '0') + '-bruno'
  await remove(cris, early) // not allowed
  await remove(ana, later) // the moderator
  await remove(ana, later) // twice
  await at.sync()
  t.is((await ana.base.view.get('count/waiting')).value, 3, 'three wait')
  t.is(await say(at, bruno, 'one'), early)
  t.is(await say(at, bruno, 'two'), later)
  await at.sync()
  for (const person of at.people) {
    t.is((await entryOn(person, early)).deleted, null, "cris's never counts")
    t.alike((await entryOn(person, later)).deleted, {
      by: b4a.toString(ana.base.local.key, 'hex'),
      group: null,
      at: null
    })
    t.is((await person.base.view.get('count/waiting')).value, 0)
    t.absent(await person.base.view.get('waiting/' + later))
  }
})

test('the first copy of an id wins, and a late copy never brings a deleted entry back', async (t) => {
  const at = await room(t)
  const [ana, bruno, cris] = at.people
  const hi = await say(at, ana, 'Hi')
  await at.sync()
  const first = await entryOn(cris, hi)
  await cris.base.append({ type: 'message', id: hi, at: 1, box: 'ab'.repeat(40) }) // cris reuses it
  await at.sync()
  t.alike(await entryOn(bruno, hi), first, 'the first copy stays')

  await remove(ana, hi)
  await at.sync()
  await bruno.base.append({ type: 'message', id: hi, at: first.at, box: first.box }) // again
  await remove(ana, hi) // a second tombstone
  await at.sync()
  for (const person of at.people) {
    t.alike((await entryOn(person, hi)).deleted, {
      by: b4a.toString(ana.base.local.key, 'hex'),
      group: null,
      at: null
    })
  }
  for (const person of at.people) await shred(person)
  t.absent(cris.keys.has(hi), 'its secret goes')
  t.ok(cris.keys.isShredded(hi))
  t.is(await shred(cris), 0, 'and is done once')
})

test('only the moderator purges, and only the target’s entries', async (t) => {
  const at = await room(t)
  const [ana, bruno, cris] = at.people
  const own = await say(at, cris, 'mine')
  const theirs = await say(at, bruno, 'spam')
  await at.sync()
  await purge(bruno, cris) // not the moderator
  await purge(ana, bruno)
  await at.sync()
  for (const person of at.people) {
    t.is((await entryOn(person, own)).deleted, null)
    t.ok((await entryOn(person, theirs)).deleted.group, 'one group for the purge')
  }
  t.alike(await linesOf(at, cris), ['cris: mine', "ana deleted 1 of bruno's messages"])
})

test('what apply skips', async (t) => {
  const at = await room(t)
  const [ana, bruno] = at.people
  await bruno.base.append({ type: 'writer', key: 'ab'.repeat(32), name: 'eve' }) // not the creator
  await ana.base.append({ type: 'writer', key: 'nope', name: 'eve' })
  const box = 'ab'.repeat(40)
  for (const value of [
    null,
    'text',
    { type: 'message', id: 'Not An Id', at: 1, box },
    { type: 'message', id: 'x', box },
    { type: 'message', id: 'x', at: -1, box },
    { type: 'message', id: 'x', at: 1, box: 'zz' },
    { type: 'message', id: 'x', at: 1, box, reply: 'Not An Id' },
    { type: 'message', id: 'x', at: 1, box, file: 'nope' },
    { type: 'delete', id: 'Not An Id' },
    { type: 'purge', target: 'ab'.repeat(32), at: 1 }, // not the moderator
    { type: 'unknown' }
  ]) {
    await bruno.base.append(value)
  }
  await ana.base.append({ type: 'purge', target: 'nope', at: 1 })
  await ana.base.append({ type: 'purge', target: 'ab'.repeat(32) }) // no time
  await at.sync()
  t.alike(await entriesOf(ana.base.view), [])
  t.absent(await ana.base.view.get('writers/' + 'ab'.repeat(32)))
})
