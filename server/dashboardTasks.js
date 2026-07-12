// Dashboard "This Week" task engine — turns signals already computed
// elsewhere in this app (Weekly Report's underperformers, Competitor
// Benchmarking's price comparisons) into a short, ranked list of real
// tasks, each with a genuine one-click action, instead of raw numbers
// to read. Explicit design choice, per direct instruction: only task
// types that can actually be completed with a single click belong
// here — no "go restock this" reminders with nothing to click, since
// this app has no way to execute that for you.
//
// Two task types in this first version:
// - price-test: instant, stays on the Dashboard — directly calls
//   Etsy's inventory-update endpoint (server/etsyListingInventory.js).
// - revamp: takes you to Listing Revamp with the pipeline already
//   running — NOT reimplemented here, because the real revamp pipeline
//   (title/description generation, the GEO description format, draft
//   creation) is substantial, already tested client-side logic; a
//   from-scratch server-side reimplementation risks silently drifting
//   from the exact format already tuned this session. One click still
//   gets the whole thing done — it just finishes on the next screen
//   instead of invisibly on the Dashboard.
import { generateWeeklyReport } from './weeklyReport.js'
import {
  listCompetitorShops,
  getRecentDashboardTaskActionKeys,
  recordDashboardTaskAction,
  updateListingLastRevampedAt,
  getShopListingById,
  checkAppPassword,
} from './db.js'
import { buildCompetitorShopView } from './competitorShops.js'
import { updateEtsyListingInventory } from './etsyListingInventory.js'
import { readJsonBody, RequestError } from './listingApi.js'

const MAX_TASKS = 5
// A dismissed or completed task drops out for a week — long enough to
// stop nagging about the same thing immediately, short enough that a
// still-real problem naturally resurfaces if it's still true next week
// (rather than being silenced forever off one click).
const TASK_MEMORY_DAYS = 7
// Below this fraction, a price gap isn't worth surfacing as a task —
// same threshold the price-comparison display itself already uses
// (server/competitorShops.js's NOTABLE_PRICE_DIFF_FRACTION).
const NOTABLE_PRICE_DIFF_FRACTION = 0.15
// A revamped listing isn't eligible again for this many days — direct
// instruction: listings should only be revamped every 30 days.
const REVAMP_COOLDOWN_DAYS = 30

function daysAgoIso(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString()
}

function isRevampEligible(shopListingRow) {
  if (!shopListingRow?.last_revamped_at) return true
  const lastRevamped = new Date(`${shopListingRow.last_revamped_at.replace(' ', 'T')}Z`)
  return Date.now() - lastRevamped.getTime() >= REVAMP_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
}

function buildRevampTasks(recentlyActionedKeys) {
  const report = generateWeeklyReport()
  if (!report.hasData) return []

  const tasks = []
  for (const row of report.underperformers) {
    const taskKey = `revamp-${row.listingId}`
    if (recentlyActionedKeys.has(taskKey)) continue

    const shopListing = getShopListingById(row.listingId)
    if (!shopListing || !isRevampEligible(shopListing)) continue

    tasks.push({
      taskKey,
      type: 'revamp',
      text: row.recommendation.startsWith(row.title)
        ? row.recommendation
        : `"${row.title}" — ${row.recommendation}`,
      actionLabel: 'Revamp Now',
      listingId: row.listingId,
      etsyListingId: shopListing.etsy_listing_id,
      listingTitle: row.title,
    })
  }
  return tasks
}

function buildPriceTestTasks(recentlyActionedKeys) {
  const tasks = []
  const shops = listCompetitorShops().map(buildCompetitorShopView)

  for (const shop of shops) {
    for (const link of shop.priceLinks) {
      if (typeof link.competitorPriceCents !== 'number' || typeof link.myPriceCents !== 'number') continue
      if (link.myPriceCents === 0) continue

      const taskKey = `price-test-${link.id}`
      if (recentlyActionedKeys.has(taskKey)) continue

      const diffPct = (link.competitorPriceCents - link.myPriceCents) / link.myPriceCents
      if (Math.abs(diffPct) < NOTABLE_PRICE_DIFF_FRACTION) continue

      const direction = diffPct < 0 ? 'lower' : 'raise'
      const newPriceCents = link.competitorPriceCents
      const newPriceDollars = (newPriceCents / 100).toFixed(2)
      const myPriceDollars = (link.myPriceCents / 100).toFixed(2)

      tasks.push({
        taskKey,
        type: 'price-test',
        text:
          direction === 'lower'
            ? `"${link.myListingTitle}" is priced $${myPriceDollars}, notably above ${shop.shopName}'s similar listing — lower to $${newPriceDollars} to compete.`
            : `"${link.myListingTitle}" is priced $${myPriceDollars}, notably below ${shop.shopName}'s similar listing — raise to $${newPriceDollars} to capture more margin.`,
        actionLabel: direction === 'lower' ? `Lower Price to $${newPriceDollars}` : `Raise Price to $${newPriceDollars}`,
        priceLinkId: link.id,
        myListingId: link.myListingId,
        newPriceCents,
      })
    }
  }
  return tasks
}

// Interleaves the two task types (rather than all of one type first)
// so a shop with many price-comparison links doesn't crowd out every
// revamp suggestion, or vice versa.
function interleave(listA, listB) {
  const result = []
  const max = Math.max(listA.length, listB.length)
  for (let i = 0; i < max; i++) {
    if (listA[i]) result.push(listA[i])
    if (listB[i]) result.push(listB[i])
  }
  return result
}

function buildDashboardTasks() {
  const recentlyActionedKeys = getRecentDashboardTaskActionKeys(daysAgoIso(TASK_MEMORY_DAYS))
  const revampTasks = buildRevampTasks(recentlyActionedKeys)
  const priceTestTasks = buildPriceTestTasks(recentlyActionedKeys)
  return interleave(revampTasks, priceTestTasks).slice(0, MAX_TASKS)
}

async function executePriceTestTask(env, task) {
  const shopListing = getShopListingById(task.myListingId)
  if (!shopListing) {
    throw new RequestError(404, 'That listing is no longer tracked.')
  }
  await updateEtsyListingInventory(env, Number(shopListing.etsy_listing_id), {
    price: task.newPriceCents / 100,
  })
}

// GET /api/dashboard-tasks.
function createDashboardTasksHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      res.end(JSON.stringify({ ok: true, tasks: buildDashboardTasks() }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/dashboard-tasks/dismiss, body { taskKey }.
function createDashboardTaskDismissHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { taskKey } = await readJsonBody(req)
      if (typeof taskKey !== 'string' || !taskKey) {
        throw new RequestError(400, 'A valid taskKey is required.')
      }
      recordDashboardTaskAction(taskKey, 'dismissed')
      res.end(JSON.stringify({ ok: true, tasks: buildDashboardTasks() }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/dashboard-tasks/complete, body { taskKey, type, ...task
// fields as originally returned by GET /api/dashboard-tasks }. Only
// price-test actually executes anything here — revamp is marked
// complete once its draft is confirmed created, from Listing Revamp
// itself (server/etsySections.js-style recording), not from this
// endpoint. Re-sends the exact task object rather than re-deriving it
// from taskKey alone, since the price/listing details it needs to act
// on are already known to the caller and re-parsing a key string back
// into structured data is unnecessary indirection.
function createDashboardTaskCompleteHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const task = await readJsonBody(req)
      if (typeof task?.taskKey !== 'string' || !task.taskKey) {
        throw new RequestError(400, 'A valid taskKey is required.')
      }

      if (task.type === 'price-test') {
        await executePriceTestTask(env, task)
      } else if (task.type === 'revamp') {
        throw new RequestError(400, 'Revamp tasks complete from the Listing Revamp page, not here.')
      } else {
        throw new RequestError(400, `Unknown task type: ${task.type}`)
      }

      recordDashboardTaskAction(task.taskKey, 'done')
      res.end(JSON.stringify({ ok: true, tasks: buildDashboardTasks() }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/dashboard-tasks/mark-revamp-done, body { taskKey, listingId }
// — called by Listing Revamp itself once a Dashboard-triggered auto
// revamp's draft is confirmed created. Records the same task-memory
// entry every other completed task gets, plus starts this listing's
// 30-day revamp cooldown.
function createMarkRevampDoneHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { taskKey, listingId } = await readJsonBody(req)
      if (typeof taskKey !== 'string' || !taskKey) {
        throw new RequestError(400, 'A valid taskKey is required.')
      }
      if (!Number.isInteger(listingId) || listingId <= 0) {
        throw new RequestError(400, 'A valid listingId is required.')
      }
      updateListingLastRevampedAt(listingId)
      recordDashboardTaskAction(taskKey, 'done')
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  buildDashboardTasks,
  createDashboardTasksHandler,
  createDashboardTaskDismissHandler,
  createDashboardTaskCompleteHandler,
  createMarkRevampDoneHandler,
}
