import { describe, expect, it } from "vitest"
import { computeLayout, MAX_MENU_ROWS, MAX_QUEUE_ROWS, MIN_COLUMNS, MIN_ROWS } from "./layout"

const base = {
  columns: 100,
  rows: 30,
  turn: 1,
  overlay: false,
  menuRows: 0,
  notice: false,
  hasRail: true,
}

describe("computeLayout", () => {
  it("shows the roster and the rail on a roomy terminal", () => {
    const layout = computeLayout(base)
    expect(layout.compact).toBe(false)
    expect(layout.showTeam).toBe(true)
    expect(layout.showRail).toBe(true)
    expect(layout.welcome).toBe(false)
  })

  it("reserves every chrome row out of the body", () => {
    const layout = computeLayout(base)
    // header + rule + rail (plus its gap) + gap + prompt + hint
    expect(layout.bodyHeight).toBe(30 - 7)
    // The stream spends one of the body's rows on its own header.
    expect(layout.logViewport).toBe(layout.bodyHeight - 1)
  })

  it("charges the palette and the notice line against the body", () => {
    const layout = computeLayout({ ...base, menuRows: 4, notice: true })
    expect(layout.menuRows).toBe(4)
    expect(layout.bodyHeight).toBe(30 - 7 - 4 - 1)
  })

  it("caps the palette so it cannot swallow the stream", () => {
    expect(computeLayout({ ...base, menuRows: 99 }).menuRows).toBe(MAX_MENU_ROWS)
  })

  it("charges the queued follow-ups against the body", () => {
    const layout = computeLayout({ ...base, queueRows: 2 })
    expect(layout.queueRows).toBe(2)
    expect(layout.bodyHeight).toBe(30 - 7 - 2)
  })

  it("caps the queue so it cannot swallow the stream", () => {
    expect(computeLayout({ ...base, queueRows: 99 }).queueRows).toBe(MAX_QUEUE_ROWS)
  })

  it("treats an absent queue as no rows at all", () => {
    expect(computeLayout(base).queueRows).toBe(0)
    expect(computeLayout(base).bodyHeight).toBe(computeLayout({ ...base, queueRows: 0 }).bodyHeight)
  })

  it("clamps a negative queue request to zero", () => {
    expect(computeLayout({ ...base, queueRows: -3 }).queueRows).toBe(0)
  })

  it("ignores a negative palette height", () => {
    expect(computeLayout({ ...base, menuRows: -3 }).menuRows).toBe(0)
  })

  it("drops the roster below the compact breakpoint", () => {
    const layout = computeLayout({ ...base, columns: 60 })
    expect(layout.compact).toBe(true)
    expect(layout.showTeam).toBe(false)
  })

  it("drops the rail when the terminal is too short for it", () => {
    expect(computeLayout({ ...base, rows: 14 }).showRail).toBe(false)
    expect(computeLayout({ ...base, rows: 16 }).showRail).toBe(true)
  })

  it("does not draw a rail when there is nothing to draw", () => {
    expect(computeLayout({ ...base, hasRail: false }).showRail).toBe(false)
  })

  it("swaps the body for the welcome screen on the first turn", () => {
    expect(computeLayout({ ...base, turn: 0 }).welcome).toBe(true)
  })

  it("does not repeat the roster in the rail on the welcome screen", () => {
    const layout = computeLayout({ ...base, turn: 0 })
    expect(layout.welcome).toBe(true)
    expect(layout.showRail).toBe(false)
    // Without the rail, its two rows go back to the body.
    expect(layout.bodyHeight).toBe(30 - 5)
  })

  it("does not show the welcome screen behind an overlay", () => {
    expect(computeLayout({ ...base, turn: 0, overlay: true }).welcome).toBe(false)
  })

  it("charges the review banner against the body", () => {
    const layout = computeLayout({ ...base, viewing: true })
    expect(layout.bodyHeight).toBe(30 - 7 - 1)
  })

  it("does not charge for a review banner that is not there", () => {
    expect(computeLayout(base).bodyHeight).toBe(
      computeLayout({ ...base, viewing: false }).bodyHeight
    )
  })

  // Help is modal. Without this the first screen would *gain* a rail the moment
  // the user pressed `?`, which reads as the overlay rearranging the page.
  it("suppresses the rail while help is open", () => {
    expect(computeLayout({ ...base, overlay: true }).showRail).toBe(false)
    expect(computeLayout({ ...base, overlay: true }).bodyHeight).toBe(30 - 5)
  })

  it("gives the rail's rows back to the body when help opens", () => {
    const withRail = computeLayout(base)
    const withHelp = computeLayout({ ...base, overlay: true })
    expect(withHelp.bodyHeight).toBeGreaterThan(withRail.bodyHeight)
  })

  it("clamps a tiny terminal to something usable", () => {
    const layout = computeLayout({ ...base, columns: 5, rows: 2 })
    expect(layout.columns).toBe(MIN_COLUMNS)
    expect(layout.rows).toBe(MIN_ROWS)
    expect(layout.bodyHeight).toBeGreaterThanOrEqual(3)
    expect(layout.logViewport).toBeGreaterThanOrEqual(1)
  })

  it("sizes the roster as a fraction of the width, within bounds", () => {
    expect(computeLayout({ ...base, columns: 200 }).teamWidth).toBe(30)
    expect(computeLayout({ ...base, columns: 120 }).teamWidth).toBe(28)
    expect(computeLayout({ ...base, columns: 72 }).teamWidth).toBe(18)
  })
})
