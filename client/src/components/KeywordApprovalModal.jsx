import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import api, { getErrorMessage } from '../api/axios'
import { emailSnippet } from './EmailBody'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  EmptyState,
  FormField,
  Input,
  Select,
  SkeletonTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  useConfirm,
} from './ui'

/**
 * Keyword rules + pending-approval workspace.
 *
 * Rebuilt on the shared Dialog: real focus trap, ESC, `aria-modal`, focus
 * restore. This was previously the ONLY file in the app using `dark:` classes,
 * which — with Tailwind defaulting to `darkMode: 'media'` — rendered it dark
 * inside an otherwise light application. Theme is now class-driven and every
 * colour here is a semantic token.
 *
 * @param {boolean} isOpen
 * @param {() => void} onClose
 * @param {() => void} [onRuleUpdated] - parent refresh hook
 */
export function KeywordApprovalModal({ isOpen, onClose, onRuleUpdated }) {
  const confirm = useConfirm()

  const [activeTab, setActiveTab] = useState('approvals')
  const [rules, setRules] = useState([])
  const [pendingEmails, setPendingEmails] = useState([])
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState({})

  const [newKeyword, setNewKeyword] = useState('')
  const [newAssignedTo, setNewAssignedTo] = useState('')
  const [newAutoApprove, setNewAutoApprove] = useState(false)
  const [creatingRule, setCreatingRule] = useState(false)
  const [formError, setFormError] = useState('')

  const [reassignMap, setReassignMap] = useState({})

  const notifyParent = useCallback(() => {
    try {
      onRuleUpdated?.()
    } catch (err) {
      console.error('[KeywordApprovalModal] onRuleUpdated threw:', err)
    }
  }, [onRuleUpdated])

  const fetchData = useCallback(async (signal) => {
    setLoading(true)
    try {
      const [rulesRes, pendingRes, usersRes] = await Promise.all([
        api.get('/keyword-rules', { signal }),
        api.get('/keyword-rules/pending-approvals', { signal }),
        api.get('/users', { signal }),
      ])
      setRules(rulesRes.data || [])
      setPendingEmails(pendingRes.data || [])
      const allUsers = usersRes.data?.users || usersRes.data || []
      setEmployees(
        Array.isArray(allUsers) ? allUsers.filter((u) => u.role === 'Employee' || u.role === 'Head') : []
      )
    } catch (err) {
      if (err?.code !== 'ERR_CANCELED') {
        toast.error('Could not load keyword rules', { description: getErrorMessage(err) })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return undefined
    const controller = new AbortController()
    // Fetch-on-open. `setLoading(true)` is the only synchronous write and it
    // runs once per open, not per render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData(controller.signal)
    return () => controller.abort()
  }, [isOpen, fetchData])

  const handleCreateRule = async (e) => {
    e.preventDefault()
    if (!newKeyword.trim() || !newAssignedTo) {
      setFormError('Enter a keyword and choose the employee it should route to.')
      return
    }
    setFormError('')
    setCreatingRule(true)
    try {
      const res = await api.post('/keyword-rules', {
        keyword: newKeyword.trim(),
        assignedTo: newAssignedTo,
        autoApprove: newAutoApprove,
      })
      toast.success(res.data?.message || 'Keyword rule created')
      setNewKeyword('')
      setNewAssignedTo('')
      setNewAutoApprove(false)
      fetchData()
      notifyParent()
    } catch (err) {
      setFormError(getErrorMessage(err, 'Failed to create keyword rule.'))
    } finally {
      setCreatingRule(false)
    }
  }

  const handleDeleteRule = async (rule) => {
    const ok = await confirm({
      title: `Delete the “${rule.keyword}” rule?`,
      description: 'New mail matching this keyword will stop being routed automatically.',
      confirmLabel: 'Delete rule',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.delete(`/keyword-rules/${rule._id}`)
      toast.success('Keyword rule deleted')
      fetchData()
      notifyParent()
    } catch (err) {
      toast.error('Could not delete the rule', { description: getErrorMessage(err) })
    }
  }

  const handleApproveEmail = async (emailId, targetUserId) => {
    setActionLoading((p) => ({ ...p, [emailId]: true }))
    try {
      const res = await api.post(`/keyword-rules/approve-email/${emailId}`, { targetUserId })
      toast.success(res.data?.message || 'Assignment approved')
      setPendingEmails((prev) => prev.filter((e) => e._id !== emailId))
      notifyParent()
    } catch (err) {
      toast.error('Could not approve the assignment', { description: getErrorMessage(err) })
    } finally {
      setActionLoading((p) => ({ ...p, [emailId]: false }))
    }
  }

  const handleBulkApprove = async () => {
    const ok = await confirm({
      title: `Approve all ${pendingEmails.length} pending assignments?`,
      description: 'Each email will be assigned to its suggested employee.',
      confirmLabel: 'Approve all',
      tone: 'warning',
    })
    if (!ok) return
    setLoading(true)
    try {
      const res = await api.post('/keyword-rules/bulk-approve', { keyword: null })
      toast.success(res.data?.message || 'Bulk approval complete')
      fetchData()
      notifyParent()
    } catch (err) {
      toast.error('Bulk approval failed', { description: getErrorMessage(err) })
    } finally {
      setLoading(false)
    }
  }

  const employeeOptions = employees.map((e) => ({ value: e._id, label: `${e.name} (${e.role})` }))

  return (
    <Dialog open={Boolean(isOpen)} onOpenChange={(next) => !next && onClose?.()}>
      <DialogContent
        size="xl"
        title="Keyword routing rules"
        description="Route incoming mail by keyword (GST, TDS, Audit…) and approve suggested assignments."
        bodyClassName="p-0"
      >
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-line px-5">
            <TabsList className="border-b-0">
              <TabsTrigger value="approvals" count={pendingEmails.length}>
                Pending approvals
              </TabsTrigger>
              <TabsTrigger value="rules" count={rules.length}>
                Rules
              </TabsTrigger>
            </TabsList>
            {activeTab === 'approvals' && pendingEmails.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={handleBulkApprove}>
                Approve all ({pendingEmails.length})
              </Button>
            ) : null}
          </div>

          <TabsContent value="approvals" className="p-5">
            {loading ? (
              <SkeletonTable rows={4} columns={3} />
            ) : pendingEmails.length === 0 ? (
              <EmptyState
                title="No pending assignments"
                description="Every keyword-matched email has been processed or auto-assigned."
              />
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {pendingEmails.map((email) => {
                  const suggested =
                    typeof email.suggestedAssignedTo === 'object'
                      ? email.suggestedAssignedTo?._id
                      : email.suggestedAssignedTo
                  const target = reassignMap[email._id] ?? suggested ?? ''
                  return (
                    <li
                      key={email._id}
                      className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="info">{email.matchedKeyword || 'Keyword'}</Badge>
                          <span className="truncate text-xs text-fg-3">From {email.from}</span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium text-fg">
                          {email.subject || '(No subject)'}
                        </p>
                        <p className="truncate text-xs text-fg-3">{emailSnippet(email.body, 120)}</p>
                      </div>

                      <div className="flex shrink-0 items-end gap-2">
                        <FormField label="Assign to" className="w-[220px]">
                          {(field) => (
                            <Select
                              {...field}
                              size="sm"
                              value={target}
                              placeholder="Select employee…"
                              options={employeeOptions}
                              onChange={(e) =>
                                setReassignMap((m) => ({ ...m, [email._id]: e.target.value }))
                              }
                            />
                          )}
                        </FormField>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!target}
                          loading={Boolean(actionLoading[email._id])}
                          onClick={() => handleApproveEmail(email._id, target)}
                        >
                          Approve
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="rules" className="space-y-5 p-5">
            <form
              onSubmit={handleCreateRule}
              className="space-y-3 rounded-lg border border-line bg-canvas p-4"
            >
              <h3 className="text-sm font-semibold text-fg">Add a routing rule</h3>

              <div className="grid gap-3 md:grid-cols-3">
                <FormField
                  label="Keyword"
                  required
                  hint="Matched against the subject and body."
                  error={formError && !newKeyword.trim() ? 'Required' : undefined}
                >
                  {(field) => (
                    <Input
                      {...field}
                      value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                      placeholder="e.g. GST"
                    />
                  )}
                </FormField>

                <FormField
                  label="Assign to"
                  required
                  error={formError && !newAssignedTo ? 'Required' : undefined}
                >
                  {(field) => (
                    <Select
                      {...field}
                      value={newAssignedTo}
                      onChange={(e) => setNewAssignedTo(e.target.value)}
                      placeholder="Select employee…"
                      options={employeeOptions}
                    />
                  )}
                </FormField>

                <div className="flex items-end pb-1">
                  <Checkbox
                    id="kw-auto-approve"
                    label="Assign without approval"
                    checked={newAutoApprove}
                    onCheckedChange={(v) => setNewAutoApprove(Boolean(v))}
                  />
                </div>
              </div>

              {formError ? (
                <p role="alert" className="text-xs text-danger-text">
                  {formError}
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  loading={creatingRule}
                  leftIcon={<Plus className="h-4 w-4" />}
                >
                  Save rule
                </Button>
              </div>
            </form>

            {loading ? (
              <SkeletonTable rows={3} columns={3} />
            ) : rules.length === 0 ? (
              <EmptyState
                title="No rules configured"
                description="Add a keyword above to start routing mail automatically."
              />
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {rules.map((rule) => (
                  <li key={rule._id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <Badge variant="primary">{rule.keyword}</Badge>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-fg">
                          {rule.assignedTo?.name || 'Unassigned'}
                          {rule.assignedTo?.email ? (
                            <span className="text-fg-3"> · {rule.assignedTo.email}</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-fg-3">
                          {rule.autoApprove ? 'Assigns automatically' : 'Requires approval'}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Delete the ${rule.keyword} rule`}
                      onClick={() => handleDeleteRule(rule)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

export default KeywordApprovalModal
