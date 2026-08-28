import { useMemo, useState } from 'react'
import api, { getErrorMessage } from '../api/axios'
import { useCachedQuery } from '../lib/useCachedQuery'
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Select,
  SkeletonText,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from './ui'

const STATUS_OPTIONS = [
  { value: 'Active', label: 'Active' },
  { value: 'Inactive', label: 'Inactive' },
]

/**
 * Set Active/Inactive for every client carrying one imported status code.
 *
 * The spreadsheet's codes ("01", "05", …) mean something specific to the
 * practice, so the importer stores them verbatim and marks everything Active
 * rather than guessing which ones mean "closed". This is where that decision
 * gets made afterwards — once, by someone who knows — instead of opening 165
 * clients one at a time.
 *
 * Each row is applied on its own and is reversible: the code is never changed,
 * so running it again with the other status puts it back.
 */
export function ClientStatusCodesDialog({ open, onOpenChange, onChanged }) {
  const [applying, setApplying] = useState('')
  const [error, setError] = useState('')
  /* Only the DEVIATIONS from the default are stored. Seeding a full choice map
   * on load would mean setting state from an effect, which this codebase
   * forbids (react-hooks/set-state-in-effect) precisely because it causes the
   * double render this avoids. */
  const [choice, setChoice] = useState({})

  /* `enabled` parks the hook while the dialog is shut: no request until it is
   * actually opened, and the data refreshes on reopen. */
  const {
    data,
    loading,
    refetch: reload,
  } = useCachedQuery('/clients/status-codes', null, {
    enabled: open,
    failureMessage: 'Could not read the imported status codes.',
  })

  const rows = useMemo(() => data?.data || [], [data])

  /* Default each row to the status it does NOT mostly have, so the dropdown
   * offers the change you opened this dialog to make rather than a no-op. */
  const statusFor = (r) => choice[r.sourceStatus] ?? (r.active >= r.inactive ? 'Inactive' : 'Active')

  const apply = async (code, status) => {
    setApplying(code)
    setError('')
    try {
      const res = await api.put('/clients/bulk-status', {
        sourceStatus: code,
        status,
      })
      const d = res.data?.data
      toast.success(
        d?.modified
          ? `${d.modified} client${d.modified === 1 ? '' : 's'} set to ${d.status}`
          : `Nothing to change — all ${d?.matched ?? 0} were already ${d?.status}`
      )
      await reload()
      onChanged?.()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setApplying('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Set status by imported code"
        description="Codes come from the spreadsheet you imported. Everything was brought in as Active; use this once you know what each code means."
        footer={
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        }
      >
        <div className="space-y-4">
          {error ? (
            <Alert variant="danger" title="That did not work">
              {error}
            </Alert>
          ) : null}

          {loading ? <SkeletonText lines={4} /> : null}

          {!loading && rows.length === 0 ? (
            <Alert variant="info" title="No imported codes">
              None of your clients carry a status code from a spreadsheet import yet.
            </Alert>
          ) : null}

          {!loading && rows.length > 0 ? (
            <>
              <div className="overflow-x-auto rounded-lg border border-line">
                <Table>
                  <THead>
                    <TR>
                      <TH>Code</TH>
                      <TH>Clients</TH>
                      <TH>Active</TH>
                      <TH>Inactive</TH>
                      <TH>Set all to</TH>
                      <TH><span className="sr-only">Apply</span></TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((r) => (
                      <TR key={r.sourceStatus}>
                        <TD className="font-mono text-xs">{r.sourceStatus}</TD>
                        <TD className="tabular">{r.total}</TD>
                        <TD className="tabular">{r.active}</TD>
                        <TD className="tabular">{r.inactive}</TD>
                        <TD>
                          <Select
                            aria-label={`Status for code ${r.sourceStatus}`}
                            value={statusFor(r)}
                            onChange={(e) =>
                              setChoice((p) => ({ ...p, [r.sourceStatus]: e.target.value }))
                            }
                            options={STATUS_OPTIONS}
                          />
                        </TD>
                        <TD>
                          <Button
                            variant="secondary"
                            loading={applying === r.sourceStatus}
                            disabled={Boolean(applying)}
                            onClick={() => apply(r.sourceStatus, statusFor(r))}
                          >
                            Apply
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p className="text-xs text-fg-3">
                Applied one code at a time, and reversible — the code itself is never changed, so
                running it again with the other status puts those clients back.
              </p>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ClientStatusCodesDialog
