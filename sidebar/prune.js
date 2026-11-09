// Finished jobs show small right away and go away by themselves after this long. Nothing about the job itself says when it ended,
// so this remembers when each one was first seen finished.
const FINISHED_HOURS = 12

function ago(ms) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

// groups: what collect.py sent. doneAt: { "Group/Job": when first seen finished }, from the last call. Returns both, updated.
function pruneFinished(groups, doneAt, now) {
  const next = {}
  const kept = []
  for (const group of groups) {
    const rows = []
    for (const row of group.rows) {
      if (row.state !== 'done') {
        rows.push(row) // started again, or never finished: forget any old finish time
        continue
      }
      const key = `${group.name}/${row.name}`
      const at = doneAt[key] ?? now
      next[key] = at // kept even once it's hidden, so it doesn't come back as newly finished
      if (now - at < FINISHED_HOURS * 3_600_000) rows.push({ ...row, doneAgo: ago(now - at), doneAt: at }) // doneAt: so one that ends after its chat closed still shows
    }
    if (rows.length > 0) kept.push({ ...group, rows })
  }
  return { groups: kept, doneAt: next }
}

module.exports = { FINISHED_HOURS, pruneFinished }
