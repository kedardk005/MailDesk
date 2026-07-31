import React, { useState, useEffect } from 'react';
import axios from '../api/axios';

const KeywordApprovalModal = ({ isOpen, onClose, onRuleUpdated }) => {
  const [activeTab, setActiveTab] = useState('approvals'); // 'approvals' | 'rules'
  const [rules, setRules] = useState([]);
  const [pendingEmails, setPendingEmails] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState({});
  const [error, setErrorState] = useState('');
  const [success, setSuccessState] = useState('');

  const setError = (msg) => {
    setErrorState(msg);
    if (msg) {
      setSuccessState('');
      setTimeout(() => setErrorState(''), 4000);
    }
  };

  const setSuccess = (msg) => {
    setSuccessState(msg);
    if (msg) {
      setErrorState('');
      setTimeout(() => setSuccessState(''), 4000);
    }
  };


  // New Rule form state
  const [newKeyword, setNewKeyword] = useState('');
  const [newAssignedTo, setNewAssignedTo] = useState('');
  const [newAutoApprove, setNewAutoApprove] = useState(false);
  const [creatingRule, setCreatingRule] = useState(false);

  // Selected reassignee map for individual email rows
  const [reassignMap, setReassignMap] = useState({});

  useEffect(() => {
    if (isOpen) {
      fetchData();
    }
  }, [isOpen]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [rulesRes, pendingRes, usersRes] = await Promise.all([
        axios.get('/keyword-rules'),
        axios.get('/keyword-rules/pending-approvals'),
        axios.get('/users')
      ]);

      setRules(rulesRes.data || []);
      setPendingEmails(pendingRes.data || []);

      // Filter employees / users available for assignment
      const allUsers = usersRes.data?.users || usersRes.data || [];
      const emps = Array.isArray(allUsers) 
        ? allUsers.filter(u => u.role === 'Employee' || u.role === 'Head') 
        : [];
      setEmployees(emps);
    } catch (err) {
      console.error('Error loading keyword data:', err);
      setError(err.response?.data?.message || 'Failed to load keyword rules and pending approvals.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRule = async (e) => {
    e.preventDefault();
    if (!newKeyword.trim() || !newAssignedTo) {
      setError('Please provide a keyword and select a target employee.');
      return;
    }

    setCreatingRule(true);
    setError('');
    setSuccess('');

    try {
      const res = await axios.post('/keyword-rules', {
        keyword: newKeyword.trim(),
        assignedTo: newAssignedTo,
        autoApprove: newAutoApprove
      });

      setSuccess(res.data?.message || 'Keyword rule created successfully!');
      setNewKeyword('');
      setNewAssignedTo('');
      setNewAutoApprove(false);
      fetchData();
      try {
        if (onRuleUpdated) onRuleUpdated();
      } catch (parentErr) {
        console.error('Error in onRuleUpdated callback:', parentErr);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create keyword rule.');
    } finally {
      setCreatingRule(false);
    }
  };

  const handleDeleteRule = async (ruleId) => {
    if (!window.confirm('Are you sure you want to delete this keyword rule?')) return;
    try {
      await axios.delete(`/keyword-rules/${ruleId}`);
      setSuccess('Keyword rule deleted successfully.');
      fetchData();
      try {
        if (onRuleUpdated) onRuleUpdated();
      } catch (parentErr) {
        console.error('Error in onRuleUpdated callback:', parentErr);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete keyword rule.');
    }
  };

  const handleApproveEmail = async (emailId, targetUserId) => {
    setActionLoading(prev => ({ ...prev, [emailId]: true }));
    setError('');
    setSuccess('');

    try {
      const res = await axios.post(`/keyword-rules/approve-email/${emailId}`, {
        targetUserId
      });

      setSuccess(res.data?.message || 'Email assignment approved successfully!');
      setPendingEmails(prev => prev.filter(e => e._id !== emailId));
      try {
        if (onRuleUpdated) onRuleUpdated();
      } catch (parentErr) {
        console.error('Error in onRuleUpdated callback:', parentErr);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to approve assignment.');
    } finally {
      setActionLoading(prev => ({ ...prev, [emailId]: false }));
    }
  };

  const handleBulkApprove = async (keyword = null) => {
    const confirmMsg = keyword 
      ? `Approve all pending emails for keyword "${keyword}"?`
      : 'Approve all pending keyword-matched emails?';

    if (!window.confirm(confirmMsg)) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await axios.post('/keyword-rules/bulk-approve', { keyword });
      setSuccess(res.data?.message || 'Bulk approval completed successfully!');
      fetchData();
      try {
        if (onRuleUpdated) onRuleUpdated();
      } catch (parentErr) {
        console.error('Error in onRuleUpdated callback:', parentErr);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed bulk approval.');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative w-full max-w-4xl bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 text-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-white/10 rounded-lg backdrop-blur-md">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold">Keyword Mail Rules & Approval Window</h2>
              <p className="text-xs text-indigo-100">Automatically map mails containing GST, TDS, etc. & approve assignments</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/20 text-white transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab Header & Quick Alerts */}
        <div className="px-6 pt-4 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div className="flex space-x-2">
            <button
              onClick={() => setActiveTab('approvals')}
              className={`px-4 py-2.5 rounded-t-xl font-medium text-sm transition-all flex items-center space-x-2 ${
                activeTab === 'approvals'
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-t-2 border-indigo-600 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span>Pending Approvals</span>
              {pendingEmails.length > 0 && (
                <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 font-bold rounded-full">
                  {pendingEmails.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('rules')}
              className={`px-4 py-2.5 rounded-t-xl font-medium text-sm transition-all flex items-center space-x-2 ${
                activeTab === 'rules'
                  ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-t-2 border-indigo-600 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
              </svg>
              <span>Manage Rules ({rules.length})</span>
            </button>
          </div>

          {activeTab === 'approvals' && pendingEmails.length > 0 && (
            <button
              onClick={() => handleBulkApprove()}
              className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-sm transition-all flex items-center space-x-1.5 mb-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              <span>Approve All ({pendingEmails.length})</span>
            </button>
          )}
        </div>

        {/* Alerts */}
        {error && (
          <div className="mx-6 mt-4 p-3 bg-rose-50 dark:bg-rose-900/30 border border-rose-200 dark:border-rose-800 rounded-xl text-rose-700 dark:text-rose-300 text-xs flex items-center space-x-2">
            <svg className="w-4 h-4 shrink-0 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="mx-6 mt-4 p-3 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 rounded-xl text-emerald-700 dark:text-emerald-300 text-xs flex items-center space-x-2">
            <svg className="w-4 h-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
            <span>{success}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {loading ? (
            <div className="py-12 text-center text-slate-500 text-sm">
              Loading keyword settings & approvals...
            </div>
          ) : activeTab === 'approvals' ? (
            /* Pending Approvals Tab */
            <div className="space-y-4">
              {pendingEmails.length === 0 ? (
                <div className="py-12 text-center border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-2xl">
                  <svg className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <p className="text-slate-600 dark:text-slate-300 font-medium">No pending keyword assignments!</p>
                  <p className="text-xs text-slate-400 mt-1">All incoming keyword-matched emails have been processed or auto-assigned.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingEmails.map((email) => {
                    const currentTargetId = reassignMap[email._id] || (typeof email.suggestedAssignedTo === 'object' ? email.suggestedAssignedTo?._id : email.suggestedAssignedTo) || '';

                    return (
                      <div 
                        key={email._id}
                        className="p-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:shadow-md transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                      >
                        <div className="space-y-1 flex-1">
                          <div className="flex items-center space-x-2">
                            <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300 text-xs font-bold rounded-md">
                              Keyword: {email.matchedKeyword || 'GST'}
                            </span>
                            <span className="text-xs text-slate-400">
                              From: {email.from}
                            </span>
                          </div>
                          <h4 className="font-semibold text-slate-900 dark:text-slate-100 text-sm">
                            {email.subject || '(No Subject)'}
                          </h4>
                          <p className="text-xs text-slate-500 line-clamp-1">
                            {email.body ? email.body.replace(/<[^>]*>/g, ' ').slice(0, 120) : '(No body)'}
                          </p>
                        </div>

                        {/* Approval Controls */}
                        <div className="flex items-center space-x-3 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-slate-700">
                          <div className="flex flex-col">
                            <label className="text-[10px] text-slate-400 font-medium mb-1">Assign to Employee:</label>
                            <select
                              value={currentTargetId || ''}
                              onChange={(e) => setReassignMap({ ...reassignMap, [email._id]: e.target.value })}
                              className="px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-indigo-500"
                            >
                              <option value="">Select Employee...</option>
                              {employees.map(emp => (
                                <option key={emp._id} value={emp._id}>
                                  {emp.name} ({emp.role})
                                </option>
                              ))}
                            </select>
                          </div>

                          <button
                            onClick={() => handleApproveEmail(email._id, currentTargetId)}
                            disabled={!currentTargetId || actionLoading[email._id]}
                            className="mt-4 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium shadow-sm transition-all flex items-center space-x-1"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                            </svg>
                            <span>{actionLoading[email._id] ? 'Saving...' : 'Approve'}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Manage Rules Tab */
            <div className="space-y-6">
              {/* Form to create rule */}
              <form onSubmit={handleCreateRule} className="p-4 bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-xl space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center space-x-1">
                  <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Add New Keyword Auto-Assignment Rule</span>
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Keyword (e.g. GST, TDS, Audit)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. GST"
                      value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-900 dark:text-slate-100 uppercase"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Target Employee
                    </label>
                    <select
                      value={newAssignedTo}
                      onChange={(e) => setNewAssignedTo(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-900 dark:text-slate-100"
                    >
                      <option value="">Select Employee...</option>
                      {employees.map(emp => (
                        <option key={emp._id} value={emp._id}>
                          {emp.name} ({emp.role})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col justify-end">
                    <label className="flex items-center space-x-2 cursor-pointer py-2">
                      <input
                        type="checkbox"
                        checked={newAutoApprove}
                        onChange={(e) => setNewAutoApprove(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-slate-700 dark:text-slate-300">
                        Auto-assign without approval
                      </span>
                    </label>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={creatingRule}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                    </svg>
                    <span>{creatingRule ? 'Creating...' : 'Save Keyword Rule'}</span>
                  </button>
                </div>
              </form>

              {/* Active Rules List */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  Configured Rules ({rules.length})
                </h4>

                {rules.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center">No keyword rules configured yet.</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-800">
                    {rules.map((rule) => (
                      <div key={rule._id} className="p-3.5 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                        <div className="flex items-center space-x-3">
                          <span className="px-2.5 py-1 bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200 text-xs font-bold rounded-lg uppercase">
                            {rule.keyword}
                          </span>
                          <div>
                            <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                              Assigned to: {rule.assignedTo?.name || 'Unassigned'} ({rule.assignedTo?.email || 'N/A'})
                            </p>
                            <p className="text-[11px] text-slate-400">
                              Mode: {rule.autoApprove ? 'Auto-Assign Direct' : 'Requires Head/Admin Approval Window'}
                            </p>
                          </div>
                        </div>

                        <button
                          onClick={() => handleDeleteRule(rule._id)}
                          className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg transition-colors"
                          title="Delete Rule"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-100 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-200 rounded-lg text-xs font-medium transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default KeywordApprovalModal;
