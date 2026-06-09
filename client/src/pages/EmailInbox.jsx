import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/axios';
import { jwtDecode } from 'jwt-decode';

const EmailInbox = () => {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [expandedEmailId, setExpandedEmailId] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [gmailStatus, setGmailStatus] = useState({ connected: false, email: '' });

  const navigate = useNavigate();

  useEffect(() => {
    const userString = localStorage.getItem('user');
    if (userString) {
      try {
        setCurrentUser(JSON.parse(userString));
      } catch (err) {
        console.error('Error parsing current user:', err);
      }
    }

    const token = localStorage.getItem('token');
    if (token) {
      try {
        const decoded = jwtDecode(token);
        setUserRole(decoded.role);
      } catch (err) {
        console.error('Error decoding token for role:', err);
      }
    }

    fetchEmails();
    fetchGmailStatus();
  }, []);

  const fetchGmailStatus = async () => {
    try {
      const res = await api.get('/gmail/status');
      setGmailStatus(res.data);
    } catch (err) {
      console.error('Error checking Gmail status in Inbox:', err);
    }
  };

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4500);
  };

  const fetchEmails = async () => {
    setLoading(true);
    try {
      const response = await api.get('/gmail/emails');
      setEmails(response.data);
    } catch (err) {
      console.error('Error fetching emails:', err);
      const message = err.response?.data?.message || 'Failed to load inbox emails. Please refresh the page.';
      triggerAlert('error', message);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncEmails = async () => {
    setSyncing(true);
    try {
      const response = await api.post('/gmail/fetch');
      triggerAlert('success', `Sync complete! Fetched ${response.data.count} new emails.`);
      fetchEmails();
    } catch (err) {
      console.error('Sync failed:', err);
      const message = err.response?.data?.message || 'Failed to synchronize with Gmail. Ensure Gmail is connected.';
      triggerAlert('error', message);
    } finally {
      setSyncing(false);
    }
  };

  const handleClearAllEmails = async () => {
    if (!window.confirm('Are you sure you want to clear all emails from the workspace? This will delete all emails and unlink them from tasks.')) {
      return;
    }

    try {
      const response = await api.delete('/gmail/emails');
      setEmails([]);
      triggerAlert('success', response.data.message || 'All emails cleared successfully.');
    } catch (err) {
      console.error('Failed to clear emails:', err);
      const message = err.response?.data?.message || 'Failed to clear all emails. Please try again.';
      triggerAlert('error', message);
    }
  };

  const handleDeleteEmail = async (id) => {
    if (!window.confirm('Are you sure you want to delete this email? This will unlink it from any associated task.')) {
      return;
    }

    try {
      await api.delete(`/gmail/emails/${id}`);
      setEmails((prev) => prev.filter((email) => email._id !== id));
      triggerAlert('success', 'Email deleted successfully.');
    } catch (err) {
      console.error('Failed to delete email:', err);
      const message = err.response?.data?.message || 'Failed to delete email. Please try again.';
      triggerAlert('error', message);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      const d = new Date(dateString);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return dateString;
    }
  };

  const toggleExpand = (id) => {
    setExpandedEmailId(expandedEmailId === id ? null : id);
  };

  return (
    <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-fade-in select-none">
      {/* Floating alert */}
      {alert.message && (
        <div className={`fixed top-20 right-4 z-50 p-4 rounded-xl border flex items-start space-x-3 shadow-2xl transition-all duration-300 max-w-md animate-slide-in ${
          alert.type === 'success'
            ? 'bg-emerald-55 border-emerald-100 text-emerald-600'
            : 'bg-red-50 border-red-100 text-red-500'
        }`}>
          <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {alert.type === 'success' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            )}
          </svg>
          <span className="text-xs font-semibold">{alert.message}</span>
        </div>
      )}

      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-extrabold text-slate-800 tracking-tight">Inbox</h1>
            {emails.length > 0 && (
              <span className="px-2.5 py-1 text-xs font-extrabold bg-indigo-50 text-indigo-600 rounded-full border border-indigo-100/85 shadow-sm shrink-0">
                {emails.length}
              </span>
            )}
          </div>
          <p className="text-slate-500 text-sm mt-1">
            {userRole === 'Employee'
              ? 'View emails assigned to you'
              : 'Review workspace email stream and convert messages to tasks'}
          </p>
        </div>
        
        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          <button
            onClick={handleSyncEmails}
            disabled={syncing}
            className="px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-xs font-bold text-white shadow-md shadow-indigo-600/10 hover:shadow-indigo-600/20 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {syncing ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Syncing Inbox...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.253 8H18" />
                </svg>
                <span>Sync New Emails</span>
              </>
            )}
          </button>

          {userRole === 'Admin' && (
            <button
              onClick={handleClearAllEmails}
              className="px-5 py-3 rounded-xl bg-red-50 hover:bg-red-100 text-xs font-bold text-red-600 border border-red-200/60 transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm"
            >
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span>Clear All Emails</span>
            </button>
          )}
        </div>
      </div>

      {/* Loading Shimmer State */}
      {loading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 bg-white border border-slate-200/80 rounded-2xl p-5 skeleton-shimmer" />
          ))}
        </div>
      ) : emails.length === 0 ? (
        <div className="text-center py-20 bg-white border border-slate-200/80 rounded-3xl shadow-sm">
          <div className="w-14 h-14 mx-auto bg-slate-50 rounded-2xl flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="text-md font-bold text-slate-800 mb-1">Your inbox is empty</h3>
          {!gmailStatus.connected ? (
            <div className="flex flex-col items-center">
              <p className="text-xs text-slate-500 max-w-xs mx-auto mb-5 leading-relaxed">
                No emails synced. Connect a Gmail account to get started.
              </p>
              <Link
                to="/dashboard"
                className="inline-flex justify-center items-center gap-2 py-2.5 px-5 rounded-xl text-xs font-bold text-white bg-indigo-650 hover:bg-indigo-700 transition-all duration-150 shadow-md shadow-indigo-650/10 active:scale-[0.98]"
              >
                <span>Connect Gmail</span>
              </Link>
            </div>
          ) : (
            <p className="text-xs text-slate-500 max-w-xs mx-auto">
              Click "Sync New Emails" to fetch new email streams from Gmail.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3.5">
          {emails.map((email) => {
            const isExpanded = expandedEmailId === email._id;
            const senderInitial = email.from ? email.from.charAt(0).toUpperCase() : '✉️';
            
            return (
              <div
                key={email._id}
                className={`bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm hover-glow-card transition-all duration-300 ${
                  email.status === 'unassigned' ? 'border-l-4 border-l-indigo-650' : 'border-l-4 border-l-transparent'
                }`}
              >
                {/* Header Summary click section */}
                <div
                  onClick={() => toggleExpand(email._id)}
                  className="p-5 flex items-center justify-between gap-4 cursor-pointer select-none"
                >
                  <div className="flex items-center space-x-3.5 min-w-0">
                    {/* Avatar circle */}
                    <div className="h-9 w-9 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 font-extrabold text-sm shrink-0">
                      {senderInitial}
                    </div>
                    {/* Info */}
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-500 truncate max-w-[200px] sm:max-w-[320px]">
                        From: {email.from}
                      </p>
                      <h4 className="text-sm font-bold text-slate-800 truncate max-w-[240px] sm:max-w-[480px] mt-0.5 leading-snug">
                        {email.subject}
                      </h4>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 shrink-0">
                    <span className="text-[10px] text-slate-450 font-medium hidden sm:inline">
                      {formatDate(email.date)}
                    </span>
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                      email.status === 'unassigned'
                        ? 'bg-slate-50 border-slate-200 text-slate-500'
                        : 'bg-indigo-50 border-indigo-100 text-indigo-600'
                    }`}>
                      {email.status}
                    </span>

                    {(userRole === 'Admin' || userRole === 'Head') && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteEmail(email._id);
                        }}
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all active:scale-95"
                        title="Delete email"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}

                    <svg
                      className={`h-4 w-4 text-slate-400 transform transition-transform duration-200 ${
                        isExpanded ? 'rotate-180 text-indigo-600' : ''
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expanded Accordion Area */}
                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-slate-100 bg-slate-50/20 pt-4 animate-fade-in space-y-4">
                    {/* Date on mobile */}
                    <div className="text-[10px] text-slate-400 sm:hidden">
                      Received: {formatDate(email.date)}
                    </div>

                    {/* Email Text Body container */}
                    {email.body ? (
                      <div
                        className="bg-white border border-slate-200/85 rounded-xl p-4 text-xs text-slate-700 leading-relaxed break-words overflow-hidden max-w-full select-text email-body-rendered"
                        dangerouslySetInnerHTML={{ __html: email.body }}
                      />
                    ) : (
                      <div className="bg-white border border-slate-200/85 rounded-xl p-4 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap break-words overflow-hidden max-w-full select-text">
                        <span className="italic text-slate-400">This email has no text content.</span>
                      </div>
                    )}

                    {/* Action footer */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2">
                      <div className="text-[10px] text-slate-450">
                        {email.assignedTo ? (
                          <span>Assigned to <strong className="text-slate-800">{email.assignedTo.name}</strong></span>
                        ) : (
                          <span className="italic">Unassigned email stream</span>
                        )}
                      </div>

                      <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
                        {/* Assign task link button for Admin and Head */}
                        {email.status === 'unassigned' && (currentUser?.role === 'Admin' || currentUser?.role === 'Head') && (
                          <Link
                            to={`/tasks?linkEmail=${email._id}&title=${encodeURIComponent(email.subject)}`}
                            className="px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-[10px] font-bold text-white rounded-xl transition-all shadow-md shadow-indigo-600/10 active:scale-95"
                          >
                            Assign Task
                          </Link>
                        )}
                        <button
                          onClick={() => setExpandedEmailId(null)}
                          className="px-3.5 py-2 border border-slate-200 rounded-xl text-[10px] font-bold text-slate-500 bg-white hover:bg-slate-50 transition-all active:scale-95"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
};

export default EmailInbox;
