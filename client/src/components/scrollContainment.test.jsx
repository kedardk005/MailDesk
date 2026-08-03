/**
 * SCROLL CONTAINMENT — the regression no other test can see.
 *
 * What shipped: `TableContainer` was `overflow-auto` with no height
 * constraint. A box that is free to grow never overflows — it just gets
 * taller (measured 1040px of rows against a 720px viewport), so `<main>`
 * scrolled instead, dragging the page header, toolbar and pagination out of
 * view. On top of that, Chromium gave the *document* a scrollbar on some
 * pages (measured: /inbox docSH 1378, /profile 1648 vs a 720 client height),
 * so a wheel at the bottom of the list chained to the window and shoved the
 * whole app up into a blank page — the exact glitch the owner reported.
 *
 * jsdom does no layout, so these tests pin the two mechanisms instead of
 * pixel geometry:
 *
 *   1. ProtectedLayout locks `overflow: hidden` onto <html>/<body> while the
 *      app shell is mounted (and restores it for the public pages), so the
 *      document can never be a scroller inside the app.
 *   2. The `fill` chain — <main> flex column → `<PageBody fill>` → `<DataTable
 *      fill>` → TableContainer — carries `flex-1` + `min-h-0` at every link.
 *      `min-h-0` is load-bearing: a flex child without it refuses to shrink
 *      below its content height and the whole constraint silently no-ops,
 *      which is precisely the bug being pinned. The rows' container is the
 *      only `overflow-auto` element, the sticky header lives inside it, and
 *      pagination sits outside it so it cannot scroll away with the rows.
 */
import { render, screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders, seedSession } from '../test/utils'
import { DataTable } from './ui/DataTable'
import { PageBody } from './ui/PageHeader'
import { TableContainer } from './ui/Table'

vi.mock('./Navbar', () => ({ default: () => <div data-testid="navbar" /> }))
vi.mock('./Sidebar', () => ({ default: () => <div data-testid="sidebar" /> }))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../lib/socket', () => ({
  getSocket: () => null,
  isAuthHandshakeError: () => false,
}))

import ProtectedLayout from './ProtectedLayout'

const ROWS = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}` }))
const COLUMNS = [{ id: 'name', accessorKey: 'name', header: 'Name', meta: { primary: true } }]

const PAGINATION = {
  page: 1,
  pageSize: 25,
  total: 2000,
  itemLabel: 'rows',
  onPageChange: () => {},
  onPageSizeChange: () => {},
}

describe('ProtectedLayout — the document is never a scroller inside the app', () => {
  it('locks html/body overflow while mounted and restores it on unmount', async () => {
    seedSession()
    const { unmount } = renderWithProviders(
      <Routes>
        <Route element={<ProtectedLayout />}>
          <Route path="*" element={<div>page</div>} />
        </Route>
      </Routes>,
      { route: '/dashboard' }
    )

    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(document.body.style.overflow).toBe('hidden')

    unmount()

    /* Landing / Login are outside the shell and need normal document scroll. */
    expect(document.documentElement.style.overflow).toBe('')
    expect(document.body.style.overflow).toBe('')
  })

  it('<main> is a flex column so a page can hand its height down to the table', async () => {
    seedSession()
    renderWithProviders(
      <Routes>
        <Route element={<ProtectedLayout />}>
          <Route path="*" element={<div>page</div>} />
        </Route>
      </Routes>,
      { route: '/dashboard' }
    )

    const main = document.getElementById('main-content')
    expect(main).not.toBeNull()
    for (const cls of ['flex', 'flex-col', 'flex-1', 'overflow-y-auto']) {
      expect(main.classList.contains(cls), `<main> is missing ${cls}`).toBe(true)
    }
  })
})

describe('fill chain — the row container is the scroller, nothing above it', () => {
  it('carries flex-1 + min-h-0 through every link down to the overflow-auto container', () => {
    render(
      <PageBody fill>
        <DataTable fill data={ROWS} columns={COLUMNS} ariaLabel="Rows" pagination={PAGINATION} />
      </PageBody>
    )

    const table = screen.getByRole('table', { name: 'Rows' })
    const scroller = table.closest('.overflow-auto')
    expect(scroller, 'the table has no overflow-auto ancestor').not.toBeNull()

    /* The scroller itself takes the remaining height. */
    expect(scroller.classList.contains('flex-1')).toBe(true)
    expect(scroller.classList.contains('min-h-0')).toBe(true)

    /* Every wrapper between the scroller and the PageBody must pass the
     * constraint through — one missing min-h-0 silently breaks containment. */
    const pageBody = scroller.closest('.py-5')
    expect(pageBody, 'PageBody root not found above the scroller').not.toBeNull()
    /* md-and-up on purpose: below `md` the stacked chrome can eat the whole
     * viewport, so phones keep the plain scrolling page. */
    for (const cls of ['md:flex', 'md:flex-col', 'md:flex-1', 'md:min-h-0']) {
      expect(pageBody.classList.contains(cls), `PageBody fill is missing ${cls}`).toBe(true)
    }
    let node = scroller.parentElement
    while (node && node !== pageBody) {
      expect(node.classList.contains('min-h-0'), 'a wrapper in the chain lost min-h-0').toBe(true)
      expect(node.classList.contains('flex-1'), 'a wrapper in the chain lost flex-1').toBe(true)
      node = node.parentElement
    }
    expect(node, 'the scroller is not inside the PageBody').toBe(pageBody)

    /* The sticky header must live INSIDE the scroll container, or it detaches
     * the moment the scroller moves off <main>. */
    const thead = table.querySelector('thead')
    expect(scroller.contains(thead)).toBe(true)
    expect(thead.classList.contains('sticky')).toBe(true)
    expect(thead.classList.contains('top-0')).toBe(true)

    /* Pagination is OUTSIDE the scroller — pinned, it cannot scroll away. */
    const pagination = screen.getByLabelText('Next page').closest('div')
    expect(scroller.contains(pagination)).toBe(false)
    expect(
      scroller.compareDocumentPosition(pagination) & Node.DOCUMENT_POSITION_FOLLOWING,
      'pagination must come after the scroll container'
    ).toBeTruthy()
  })

  it('TableContainer fill opts a raw table into the same mechanism', () => {
    render(
      <TableContainer fill data-testid="tc">
        <table />
      </TableContainer>
    )
    const tc = screen.getByTestId('tc')
    for (const cls of ['overflow-auto', 'flex-1', 'min-h-0']) {
      expect(tc.classList.contains(cls)).toBe(true)
    }
  })

  it('without fill, PageBody and DataTable stay plain blocks (no behaviour change)', () => {
    render(
      <PageBody data-testid="pb">
        <DataTable data={ROWS} columns={COLUMNS} ariaLabel="Rows" />
      </PageBody>
    )
    const pb = screen.getByTestId('pb')
    expect(pb.classList.contains('flex-1')).toBe(false)
    expect(pb.classList.contains('flex')).toBe(false)
    const scroller = screen.getByRole('table', { name: 'Rows' }).closest('.overflow-auto')
    const dataTableRoot = scroller.parentElement
    expect(dataTableRoot.classList.contains('flex-1')).toBe(false)
  })
})
