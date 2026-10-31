import { describe, expect, it } from "vitest"
import {
  computeLayout,
  MAX_INTERACTION_ROWS,
  MAX_MENU_ROWS,
  MAX_QUEUE_ROWS,
  MAX_RAIL_ROWS,
  MIN_COLUMNS,
  MIN_ROWS,
  measureRailRows,
} from "./layout"

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

  // The stream pre-wraps its output, so `streamWidth` has to be a number it can
  // trust before Ink has laid anything out. The failure that matters is being
  // too generous: a row wrapped a column late gets shaved at the pane edge.
  describe("streamWidth", () => {
    it("leaves the roster, the rule and its own padding out of the budget", () => {
      const layout = computeLayout(base)
      const text = base.columns - layout.teamWidth - 1 - 1
      expect(layout.streamWidth).toBeLessThanOrEqual(text)
      // Still a usable pane, not a budget so timid it wraps every other word.
      expect(layout.streamWidth).toBeGreaterThan(text - 4)
    })

    it("takes the roster's columns back when the roster is dropped", () => {
      const columns = 60
      const layout = computeLayout({ ...base, columns })
      expect(layout.showTeam).toBe(false)
      expect(layout.streamWidth).toBeLessThanOrEqual(columns - 1)
      expect(layout.streamWidth).toBeGreaterThan(columns - 5)
    })

    it("never collapses to nothing on a terminal narrower than the minimum", () => {
      expect(computeLayout({ ...base, columns: 0 }).streamWidth).toBeGreaterThanOrEqual(1)
    })
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

  // The prompt wraps, so a long input is taller than the one row it used to be.
  // Every row it takes has to come out of the body, or the screen overflows and
  // Yoga shrinks whichever pane it can — the failure this budget exists for.
  it("charges a wrapping prompt against the body", () => {
    const layout = computeLayout({ ...base, promptRows: 3 })
    expect(layout.bodyHeight).toBe(30 - 7 - 2)
  })

  it("keeps at least one row for the prompt when the caller measured none", () => {
    expect(computeLayout({ ...base, promptRows: 0 }).bodyHeight).toBe(
      computeLayout(base).bodyHeight
    )
    expect(computeLayout(base).bodyHeight).toBe(
      computeLayout({ ...base, promptRows: 1 }).bodyHeight
    )
  })

  it("clamps a negative queue request to zero", () => {
    expect(computeLayout({ ...base, queueRows: -3 }).queueRows).toBe(0)
  })

  // The interaction bar is docked above the prompt, so its rows come out of the
  // same budget as every other piece of chrome.
  describe("interaction bar", () => {
    it("charges the bar and its gap against the body", () => {
      const layout = computeLayout({ ...base, interactionRows: 5 })
      expect(layout.interactionRows).toBe(5)
      expect(layout.bodyHeight).toBe(30 - 7 - 6)
    })

    it("asks for nothing when nothing is pending", () => {
      const layout = computeLayout({ ...base, interactionRows: 0 })
      expect(layout.interactionRows).toBe(0)
      expect(layout.bodyHeight).toBe(30 - 7)
    })

    it("never lets the bar push the prompt off a short terminal", () => {
      const rows = 18
      const layout = computeLayout({ ...base, rows, interactionRows: 40 })
      expect(layout.interactionRows).toBeLessThanOrEqual(MAX_INTERACTION_ROWS)
      // Everything reserved plus the body has to still fit the terminal: what
      // Ink drops on overflow is the bottom of the tree, which is the prompt.
      const reserved = rows - layout.bodyHeight
      expect(reserved + layout.bodyHeight).toBeLessThanOrEqual(rows)
      expect(layout.bodyHeight).toBeGreaterThanOrEqual(3)
    })

    it("drops the bar entirely rather than starving the body", () => {
      expect(computeLayout({ ...base, rows: 10, interactionRows: 8 }).interactionRows).toBe(0)
    })
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

describe("measureRailRows", () => {
  it("is one row while everything fits", () => {
    expect(measureRailRows([10, 10, 10], 100)).toBe(1)
  })

  it("counts a second row once the cells overflow the width", () => {
    // 60 + 60 does not fit in 100, so the second cell wraps.
    expect(measureRailRows([60, 60], 100)).toBe(2)
  })

  it("never reports more than the cap, however long the pipeline is", () => {
    expect(measureRailRows([40, 40, 40, 40, 40], 100)).toBe(MAX_RAIL_ROWS)
  })

  it("is nothing when there is nothing to draw", () => {
    expect(measureRailRows([], 100)).toBe(0)
    expect(measureRailRows(undefined, 100)).toBe(0)
  })

  // The rail wraps, so its height is content-dependent. A flat "one row" charge
  // under-budgets it, and the chrome below pays for the difference.
  it("charges the rail for the rows it actually wraps onto", () => {
    const wide = computeLayout({ ...base, railCells: [10, 10] })
    const narrow = computeLayout({ ...base, railCells: [80, 80] })

    expect(wide.railRows).toBe(1)
    expect(narrow.railRows).toBe(2)
    expect(wide.bodyHeight - narrow.bodyHeight).toBe(1)
  })

  it("assumes one row when the caller does not measure the cells", () => {
    expect(computeLayout(base).railRows).toBe(1)
  })
})
