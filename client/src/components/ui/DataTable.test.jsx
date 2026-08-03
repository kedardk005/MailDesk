/**
 * DataTable — the behaviour the consolidation pass added and nothing exercised.
 *
 * The important one is CONTROLLED SORTING. Three pages used to hand-roll a sort
 * header because `DataTable` owned its sorting internally: a header click would
 * reorder only the 25 rows of the current page, which is a lie about the data.
 * `sorting` / `onSortingChange` fix that, and they only work if two things hold:
 *
 *   1. with `sorting` supplied the table must NOT re-order rows locally, and
 *   2. `onSortingChange` must hand the caller a resolved ARRAY. TanStack calls
 *      state setters with an updater function; a page that does
 *      `setSort(next)` and then `next[0].id` gets a function and crashes.
 *
 * Everything else here (keyboard activation, aria-sort, selection, duplicate
 * Pagination ids) guards a specific accessibility regression called out in the
 * audit.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DataTable } from './DataTable'

const ROWS = [
  { id: 'r1', name: 'Zenith Textiles', open: 3 },
  { id: 'r2', name: 'Acme Exports', open: 11 },
  { id: 'r3', name: 'Meridian Foods', open: 7 },
]

const COLUMNS = [
  { id: 'name', accessorKey: 'name', header: 'Client', meta: { primary: true } },
  { id: 'open', accessorKey: 'open', header: 'Open', meta: { numeric: true } },
]

const getRowNames = () =>
  screen
    .getAllByRole('row')
    .slice(1) // drop the header row
    .map((row) => within(row).getAllByRole('cell')[0].textContent)

const header = (name) => screen.getByRole('columnheader', { name: new RegExp(name, 'i') })

describe('DataTable — controlled (server-side) sorting', () => {
  it('does not reorder rows locally when `sorting` is supplied', async () => {
    /* The server said "Zenith, Acme, Meridian" while claiming to be sorted by
     * name ascending. A server-sorted table must render exactly that. */
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        sorting={[{ id: 'name', desc: false }]}
        onSortingChange={() => {}}
      />
    )

    expect(getRowNames()).toEqual(['Zenith Textiles', 'Acme Exports', 'Meridian Foods'])
  })

  it('hands onSortingChange a resolved array, never a TanStack updater', async () => {
    const user = userEvent.setup()
    const onSortingChange = vi.fn()

    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        sorting={[]}
        onSortingChange={onSortingChange}
      />
    )

    await user.click(within(header('Client')).getByRole('button'))

    expect(onSortingChange).toHaveBeenCalledTimes(1)
    const [next] = onSortingChange.mock.calls[0]
    expect(typeof next).not.toBe('function')
    expect(Array.isArray(next)).toBe(true)
    expect(next).toEqual([{ id: 'name', desc: false }])
  })

  it('keeps rendering the caller-supplied order after a header click', async () => {
    const user = userEvent.setup()

    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        sorting={[]}
        onSortingChange={() => {}}
      />
    )

    await user.click(within(header('Client')).getByRole('button'))

    // The caller ignored the event, so the rows must not move.
    expect(getRowNames()).toEqual(['Zenith Textiles', 'Acme Exports', 'Meridian Foods'])
  })

  it('announces aria-sort from the controlled state', () => {
    const { rerender } = render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        sorting={[{ id: 'name', desc: false }]}
        onSortingChange={() => {}}
      />
    )
    expect(header('Client')).toHaveAttribute('aria-sort', 'ascending')
    expect(header('Open')).toHaveAttribute('aria-sort', 'none')

    rerender(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        sorting={[{ id: 'open', desc: true }]}
        onSortingChange={() => {}}
      />
    )
    expect(header('Open')).toHaveAttribute('aria-sort', 'descending')
    expect(header('Client')).toHaveAttribute('aria-sort', 'none')
  })
})

describe('DataTable — uncontrolled sorting still works', () => {
  it('sorts rows locally when no `sorting` prop is given', async () => {
    const user = userEvent.setup()
    render(<DataTable data={ROWS} columns={COLUMNS} ariaLabel="Clients" />)

    expect(getRowNames()).toEqual(['Zenith Textiles', 'Acme Exports', 'Meridian Foods'])

    await user.click(within(header('Client')).getByRole('button'))
    expect(getRowNames()).toEqual(['Acme Exports', 'Meridian Foods', 'Zenith Textiles'])

    await user.click(within(header('Client')).getByRole('button'))
    expect(getRowNames()).toEqual(['Zenith Textiles', 'Meridian Foods', 'Acme Exports'])
  })

  it('updates aria-sort as the internal state changes', async () => {
    const user = userEvent.setup()
    render(<DataTable data={ROWS} columns={COLUMNS} ariaLabel="Clients" />)

    expect(header('Client')).toHaveAttribute('aria-sort', 'none')
    await user.click(within(header('Client')).getByRole('button'))
    expect(header('Client')).toHaveAttribute('aria-sort', 'ascending')
    await user.click(within(header('Client')).getByRole('button'))
    expect(header('Client')).toHaveAttribute('aria-sort', 'descending')
  })

  it('still notifies onSortingChange with an array while uncontrolled', async () => {
    const user = userEvent.setup()
    const onSortingChange = vi.fn()
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        onSortingChange={onSortingChange}
      />
    )

    await user.click(within(header('Client')).getByRole('button'))
    expect(Array.isArray(onSortingChange.mock.calls[0][0])).toBe(true)
  })

  it('seeds the internal state from initialSorting', () => {
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        initialSorting={[{ id: 'name', desc: true }]}
      />
    )
    expect(getRowNames()).toEqual(['Zenith Textiles', 'Meridian Foods', 'Acme Exports'])
    expect(header('Client')).toHaveAttribute('aria-sort', 'descending')
  })
})

describe('DataTable — keyboard row activation', () => {
  it('rowActivation="row" opens the row on Enter and on Space, exactly once', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
        rowActivation="row"
      />
    )

    const firstRow = screen.getAllByRole('row')[1]
    firstRow.focus()
    expect(firstRow).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledTimes(1)

    await user.keyboard(' ')
    expect(onRowClick).toHaveBeenCalledTimes(2)
    expect(onRowClick.mock.calls[1][0]).toEqual(ROWS[0])
  })

  const renderWithInnerButton = (onRowClick, onInner) =>
    render(
      <DataTable
        data={ROWS}
        columns={[
          ...COLUMNS,
          {
            id: 'actions',
            header: 'Actions',
            cell: ({ row }) => (
              <button type="button" onClick={onInner}>
                {`Open ${row.original.name}`}
              </button>
            ),
          },
        ]}
        ariaLabel="Clients"
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
        rowActivation="row"
      />
    )

  it("the row's own keydown handler ignores keys pressed inside a cell", () => {
    const onRowClick = vi.fn()
    renderWithInnerButton(onRowClick, () => {})

    /* Raw keydown, no synthesised click: this isolates the `e.target !==
     * e.currentTarget` guard, which is the part that works. */
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open Zenith Textiles' }), {
      key: 'Enter',
    })
    expect(onRowClick).not.toHaveBeenCalled()
  })

  /*
   * These two were originally written as `KNOWN DEFECT` cases pinning the buggy
   * behaviour: the row's onClick fired in addition to a nested control's own
   * handler. The row handler now ignores events originating on an interactive
   * descendant, so they assert the intended contract instead — a control inside
   * a cell activates exactly once.
   */
  it('a click on a control inside a cell does NOT also fire the row handler', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onInner = vi.fn()
    renderWithInnerButton(onRowClick, onInner)

    await user.click(screen.getByRole('button', { name: 'Open Zenith Textiles' }))

    expect(onInner).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('Enter on a button inside a cell activates only that button', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onInner = vi.fn()
    renderWithInnerButton(onRowClick, onInner)

    // Enter on a <button> synthesises a click that bubbles to the row; the
    // keydown guard alone never saw it, which is what made this a real defect.
    screen.getByRole('button', { name: 'Open Zenith Textiles' }).focus()
    await user.keyboard('{Enter}')

    expect(onInner).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('still activates the row when the click is on a plain cell', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const onInner = vi.fn()
    renderWithInnerButton(onRowClick, onInner)

    await user.click(screen.getByText('Zenith Textiles'))

    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onInner).not.toHaveBeenCalled()
  })

  it('the selection checkbox column does stop the click from reaching the row', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()

    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        enableSelection
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
      />
    )

    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('rowActivation="cell" turns the primary cell into a single focusable button', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()

    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        getRowId={(r) => r.id}
        onRowClick={onRowClick}
        rowActivation="cell"
      />
    )

    // The row itself must NOT be a tab stop — that is the double-stop bug.
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('tabindex')

    const opener = screen.getByRole('button', { name: 'Zenith Textiles' })
    opener.focus()

    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledTimes(1)

    await user.keyboard(' ')
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('rowActivation="none" leaves the row keyboard-inert', () => {
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        onRowClick={() => {}}
      />
    )
    expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('tabindex')
    expect(screen.queryByRole('button', { name: 'Zenith Textiles' })).toBeNull()
  })
})

describe('DataTable — row selection', () => {
  it('reports selection through onRowSelectionChange keyed by getRowId', async () => {
    const user = userEvent.setup()
    let selection = {}
    const onRowSelectionChange = vi.fn((updater) => {
      selection = typeof updater === 'function' ? updater(selection) : updater
    })

    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        enableSelection
        getRowId={(r) => r.id}
        rowSelection={selection}
        onRowSelectionChange={onRowSelectionChange}
      />
    )

    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }))

    expect(onRowSelectionChange).toHaveBeenCalled()
    expect(selection).toEqual({ r1: true })
  })

  it('select-all is indeterminate with a partial selection and checked when full', () => {
    const { rerender } = render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        enableSelection
        getRowId={(r) => r.id}
        rowSelection={{ r1: true }}
        onRowSelectionChange={() => {}}
      />
    )

    const all = () => screen.getByRole('checkbox', { name: 'Select all rows on this page' })
    expect(all()).toHaveAttribute('data-state', 'indeterminate')

    rerender(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        enableSelection
        getRowId={(r) => r.id}
        rowSelection={{ r1: true, r2: true, r3: true }}
        onRowSelectionChange={() => {}}
      />
    )
    expect(all()).toHaveAttribute('data-state', 'checked')
  })

  it('marks the selected row with aria-selected', () => {
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        enableSelection
        getRowId={(r) => r.id}
        rowSelection={{ r2: true }}
        onRowSelectionChange={() => {}}
      />
    )
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    expect(rows[0]).not.toHaveAttribute('aria-selected')
  })
})

describe('DataTable — pagination', () => {
  const serverPagination = {
    page: 1,
    pageSize: 25,
    total: 120,
    onPageChange: () => {},
    onPageSizeChange: () => {},
  }

  it('gives each table on the screen its own rows-per-page id', () => {
    /* The id used to be the literal string "rows-per-page". Two tables on one
     * screen produced two <label for="rows-per-page">, and BOTH labels then
     * pointed at the first select. */
    render(
      <>
        <DataTable data={ROWS} columns={COLUMNS} ariaLabel="Clients" pagination={serverPagination} />
        <DataTable data={ROWS} columns={COLUMNS} ariaLabel="Vendors" pagination={serverPagination} />
      </>
    )

    const selects = screen.getAllByLabelText('Rows per page')
    expect(selects).toHaveLength(2)

    const ids = selects.map((s) => s.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(2)

    // Each <label for> resolves to its OWN select, not to the first one.
    const labels = screen.getAllByText('Rows per page')
    expect(labels.map((l) => l.getAttribute('for'))).toEqual(ids)
  })

  it('reports the server total, not the length of the current page', () => {
    render(
      <DataTable data={ROWS} columns={COLUMNS} ariaLabel="Clients" pagination={serverPagination} />
    )
    expect(screen.getByText('Showing 1–25 of 120 items')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 5')).toBeInTheDocument()
  })

  it('disables the back controls on the first page and forward on the last', () => {
    const { rerender } = render(
      <DataTable data={ROWS} columns={COLUMNS} ariaLabel="Clients" pagination={serverPagination} />
    )
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()

    rerender(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        pagination={{ ...serverPagination, page: 5 }}
      />
    )
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled()
  })

  it('emits 1-based page numbers', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        ariaLabel="Clients"
        pagination={{ ...serverPagination, page: 2, onPageChange }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPageChange).toHaveBeenCalledWith(3)

    await user.click(screen.getByRole('button', { name: 'First page' }))
    expect(onPageChange).toHaveBeenCalledWith(1)
  })
})

describe('DataTable — empty and loading states', () => {
  it('renders the empty state instead of a bare table body', () => {
    render(
      <DataTable
        data={[]}
        columns={COLUMNS}
        ariaLabel="Clients"
        emptyState={{ title: 'No clients yet', description: 'Add one to get started.' }}
      />
    )
    expect(screen.getByText('No clients yet')).toBeInTheDocument()
    expect(screen.getByText('Add one to get started.')).toBeInTheDocument()
  })

  it('renders a row-shaped skeleton while loading, not the table', () => {
    render(<DataTable data={[]} columns={COLUMNS} ariaLabel="Clients" loading />)
    expect(screen.getByRole('status', { name: 'Loading rows' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
