import { useCallback, useRef, useState } from 'react'
import { AlertTriangle, FileSpreadsheet, Upload } from 'lucide-react'
import api, { getErrorMessage } from '../api/axios'
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from './ui'

/* Sent per request. The server caps a batch at 500 and the body limit is 1mb;
 * 200 keeps a 1,000-client sheet comfortably inside both, gives real progress
 * instead of one long stall, and means a failure costs one batch rather than
 * the whole file. */
const BATCH_SIZE = 200

/* Header names we accept, lower-cased. The office's export writes "Name of
 * Assessee" rather than "Name", so matching only on exact "name" would reject
 * the very file this exists for. Each entry is matched as a substring, so
 * "Client Name" and "Name of Assessee" both land on `name`. */
const COLUMN_ALIASES = {
  code: ['code', 'client code', 'a/c code'],
  name: ['name of assessee', 'assessee', 'client name', 'name', 'party'],
  sourceStatus: ['status'],
  address: ['address', 'add'],
  phone: ['phone', 'mobile', 'contact no', 'contact'],
}

/**
 * Find the header row and map its columns onto our fields.
 *
 * The sheet does not start at row 1 — there is a title and a date above the
 * header — so a fixed row index would read "LIST OF CLIENTS(CODE WISE)" as the
 * column names. Scan the first 20 rows for the one that yields a `name`
 * column, which is the only field we cannot import without.
 *
 * @param {Array<Array>} rows raw sheet rows
 * @returns {{headerRow:number, map:Object}|null}
 */
function detectColumns(rows) {
  const limit = Math.min(rows.length, 20)
  for (let r = 0; r < limit; r += 1) {
    const cells = (rows[r] || []).map((c) => String(c || '').trim().toLowerCase())
    if (!cells.some(Boolean)) continue

    const map = {}
    Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => {
      const idx = cells.findIndex((cell) => cell && aliases.some((a) => cell === a || cell.includes(a)))
      if (idx !== -1 && map[field] === undefined) map[field] = idx
    })

    if (map.name !== undefined) return { headerRow: r, map }
  }
  return null
}

/** Turn sheet rows into the payload the API expects, dropping empty rows. */
function buildRows(rows, headerRow, map) {
  const out = []
  const problems = []
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r] || []
    const cell = (i) => (i === undefined ? '' : String(row[i] ?? '').trim())

    const name = cell(map.name)
    // A wholly empty line is just spreadsheet padding, not a problem worth
    // reporting; a line with data but no name genuinely cannot be imported.
    const hasAnything = row.some((c) => String(c ?? '').trim())
    if (!name) {
      if (hasAnything) problems.push({ row: r + 1, reason: 'No client name in this row' })
      continue
    }

    out.push({
      code: cell(map.code) || undefined,
      name,
      address: cell(map.address) || undefined,
      phone: cell(map.phone) || undefined,
      sourceStatus: cell(map.sourceStatus) || undefined,
    })
  }
  return { rows: out, problems }
}

/**
 * Import clients from a spreadsheet.
 *
 * The workbook is parsed in the browser and posted as plain rows, so the API
 * needs no multipart handling and never touches an uploaded file. The parser
 * is loaded on demand — it is a large library and nobody who is not importing
 * should pay for it.
 */
export function ImportClientsDialog({ open, onOpenChange, onImported }) {
  const [stage, setStage] = useState('choose') // choose | preview | running | done
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState({ rows: [], problems: [] })
  const [progress, setProgress] = useState(0)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  const reset = useCallback(() => {
    setStage('choose')
    setFileName('')
    setParsed({ rows: [], problems: [] })
    setProgress(0)
    setSummary(null)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }, [])

  const handleOpenChange = (next) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const onFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    setFileName(file.name)

    try {
      // Loaded here, not at module scope, so it is a separate chunk fetched
      // only when somebody actually imports.
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      if (!sheet) throw new Error('That workbook has no sheets.')

      const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
      const detected = detectColumns(raw)
      if (!detected) {
        throw new Error(
          'Could not find a column of client names. The sheet needs a header row with a Name column.'
        )
      }

      const built = buildRows(raw, detected.headerRow, detected.map)
      if (!built.rows.length) throw new Error('No client rows were found below the header.')

      setParsed(built)
      setStage('preview')
    } catch (err) {
      setError(err?.message || 'That file could not be read.')
      setStage('choose')
    }
  }

  const run = async () => {
    setStage('running')
    setProgress(0)
    const totals = { received: 0, created: 0, updated: 0, skipped: 0, errors: [] }

    try {
      for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
        const batch = parsed.rows.slice(i, i + BATCH_SIZE)
        const res = await api.post('/clients/import', { rows: batch })
        const d = res.data?.data || {}
        totals.received += d.received || 0
        totals.created += d.created || 0
        totals.updated += d.updated || 0
        totals.skipped += d.skipped || 0
        if (Array.isArray(d.errors)) totals.errors.push(...d.errors)
        setProgress(Math.round(Math.min(100, ((i + batch.length) / parsed.rows.length) * 100)))
      }

      setSummary(totals)
      setStage('done')
      toast.success(`Imported ${totals.created} new, updated ${totals.updated}`)
      onImported?.()
    } catch (err) {
      setError(getErrorMessage(err))
      setStage('preview')
    }
  }

  const sample = parsed.rows.slice(0, 5)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="lg"
        title="Import clients from a spreadsheet"
        description="Excel (.xls or .xlsx) or CSV. Existing clients are matched on their code and updated, not duplicated."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{stage === 'done' ? 'Close' : 'Cancel'}</Button>
            </DialogClose>
            {stage === 'preview' ? (
              <Button variant="primary" onClick={run}>
                Import {parsed.rows.length} clients
              </Button>
            ) : null}
          </>
        }
      >
        <div className="space-y-4">
          {error ? (
            <Alert variant="danger" title="That did not work">
              {error}
            </Alert>
          ) : null}

          {stage === 'choose' ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center">
              <FileSpreadsheet className="mx-auto h-8 w-8 text-fg-3" aria-hidden="true" />
              <p className="mt-3 text-sm text-fg-2">
                Choose the client list exported from your practice software.
              </p>
              <p className="mt-1 text-xs text-fg-3">
                It needs a header row with a name column. Code, Status, Address and Phone are picked
                up when present.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".xls,.xlsx,.csv"
                onChange={onFile}
                className="sr-only"
                id="client-import-file"
              />
              <Button
                variant="secondary"
                className="mt-4"
                leftIcon={<Upload className="h-4 w-4" />}
                onClick={() => inputRef.current?.click()}
              >
                Choose file
              </Button>
            </div>
          ) : null}

          {stage === 'preview' ? (
            <>
              <p className="text-sm text-fg-2">
                <span className="font-medium text-fg-1">{fileName}</span> — {parsed.rows.length}{' '}
                clients ready to import.
              </p>

              {parsed.problems.length ? (
                <Alert variant="warning" title={`${parsed.problems.length} rows will be skipped`}>
                  Rows without a client name cannot be imported. First few:{' '}
                  {parsed.problems.slice(0, 5).map((p) => `row ${p.row}`).join(', ')}
                  {parsed.problems.length > 5 ? '…' : ''}
                </Alert>
              ) : null}

              <div className="overflow-x-auto rounded-lg border border-line">
                <Table>
                  <THead>
                    <TR>
                      <TH>Code</TH>
                      <TH>Name</TH>
                      <TH>Phone</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {sample.map((r, i) => (
                      <TR key={`${r.code || r.name}-${i}`}>
                        <TD className="font-mono text-xs">{r.code || '—'}</TD>
                        <TD>{r.name}</TD>
                        <TD className="tabular">{r.phone || '—'}</TD>
                        <TD className="tabular">{r.sourceStatus || '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p className="text-xs text-fg-3">
                Showing the first {sample.length}. Everything imports as an Active client; the
                original status code is stored against each record.
              </p>
            </>
          ) : null}

          {stage === 'running' ? (
            <div className="space-y-3 py-4">
              <p className="text-sm text-fg-2">Importing {parsed.rows.length} clients…</p>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Import progress"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-fg-3">{progress}%</p>
            </div>
          ) : null}

          {stage === 'done' && summary ? (
            <div className="space-y-3">
              <Alert variant="success" title="Import complete">
                {summary.created} created, {summary.updated} updated
                {summary.skipped ? `, ${summary.skipped} skipped` : ''}.
              </Alert>
              {summary.errors?.length ? (
                <div className="rounded-lg border border-line p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-fg-1">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    {summary.errors.length} rows were not imported
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-fg-3">
                    {summary.errors.slice(0, 10).map((e, i) => (
                      <li key={`${e.code || e.name}-${i}`}>
                        {e.name} {e.code ? `(${e.code})` : ''} — {e.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ImportClientsDialog
