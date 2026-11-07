// What a screen shows

// Entries in order. A live one shows; a deleted one only as a marker where something points at
// it; each group (the deletes one purge made) as one row at its own time, however many it took
function rows(entries, { pointed = no, group = none, time = atOf } = {}) {
  const shown = []
  const purges = new Map()
  for (const entry of entries) {
    if (!entry.deleted) {
      shown.push({ type: 'entry', entry })
      continue
    }
    const of = group(entry)
    if (of) {
      const purge = purges.get(of.id)
      if (purge) purge.count++
      else purges.set(of.id, { type: 'purge', group: of.id, count: 1, at: of.at, entry })
    }
    if (pointed(entry)) shown.push({ type: 'deleted', entry })
  }
  // each purge stands before the first row written after it
  const lines = [...purges.values()].sort((a, b) => a.at - b.at)
  const all = []
  for (const row of shown) {
    while (lines.length > 0 && lines[0].at < time(row.entry)) all.push(lines.shift())
    all.push(row)
  }
  return all.concat(lines)
}

function no() {
  return false
}

function none() {
  return null
}

function atOf(entry) {
  return entry.at
}

module.exports = rows
