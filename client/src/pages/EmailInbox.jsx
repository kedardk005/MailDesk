import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/axios';

const renderEmailContent = (body) => {
  if (!body) return '<html><body><span style="font-family: sans-serif; font-size: 13px; color: #94a3b8; font-style: italic;">This email has no text content.</span></body></html>';
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  const styledBody = isHtml 
    ? body 
    : `<div style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #334155;">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
  return `<html><head><style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #334155; margin: 12px; word-break: break-word; } img { max-width: 100%; height: auto; display: block; margin: 8px 0; }</style></head><body>${styledBody}</body></html>`;
};

const EmailInbox = () => {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [expandedEmailId, setExpandedEmailId] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [gmailStatus, setGmailStatus] = useState({ connected: false, email: '', linkedAccounts: [] });
  const [activeTab, setActiveTab] = useState('inbox'); // 'inbox', 'promotions', 'social', 'updates', 'spam', 'accounts'
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [connectingExtra, setConnectingExtra] = useState(false);
  const [disconnectingAccount, setDisconnectingAccount] = useState(null);
  const [hasDownloaded, setHasDownloaded] = useState(localStorage.getItem('emailsDownloaded') === 'true');
  const [replyOpenId, setReplyOpenId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [summaryMap, setSummaryMap] = useState({}); // { emailId: { loading, text, error } }

  const navigate = useNavigate();

  // Get unique source accounts that have fetched emails in the list
  const uniqueAccounts = Array.from(
    new Set(
      emails
        .map(email => email.fetchedBy?.gmailEmail)
        .filter(gmail => !!gmail)
    )
  );

  const getFilteredEmails = () => {
    return emails.filter(email => {
      // 1. Account filter
      if (selectedAccount !== 'all') {
        const sourceEmail = email.fetchedBy?.gmailEmail;
        if (sourceEmail !== selectedAccount) {
          return false;
        }
      }

      // 2. Label/Category tab filter
      const labelIds = email.labelIds || [];
      const isSpam = labelIds.includes('SPAM');
      const isPromo = labelIds.includes('CATEGORY_PROMOTIONS');
      const isSocial = labelIds.includes('CATEGORY_SOCIAL');
      const isUpdates = labelIds.includes('CATEGORY_UPDATES');

      if (activeTab === 'spam') {
        return isSpam;
      }
      if (activeTab === 'promotions') {
        return isPromo;
      }
      if (activeTab === 'social') {
        return isSocial;
      }
      if (activeTab === 'updates') {
        return isUpdates;
      }
      return !isSpam && !isPromo && !isSocial && !isUpdates;
    });
  };

  const getTabCount = (tabName) => {
    return emails.filter(email => {
      if (selectedAccount !== 'all') {
        const sourceEmail = email.fetchedBy?.gmailEmail;
        if (sourceEmail !== selectedAccount) {
          return false;
        }
      }

      const labelIds = email.labelIds || [];
      const isSpam = labelIds.includes('SPAM');
      const isPromo = labelIds.includes('CATEGORY_PROMOTIONS');
      const isSocial = labelIds.includes('CATEGORY_SOCIAL');
      const isUpdates = labelIds.includes('CATEGORY_UPDATES');

      if (tabName === 'spam') {
        return isSpam;
      }
      if (tabName === 'promotions') {
        return isPromo;
      }
      if (tabName === 'social') {
        return isSocial;
      }
      if (tabName === 'updates') {
        return isUpdates;
      }
      return !isSpam && !isPromo && !isSocial && !isUpdates;
    }).length;
  };

  const filteredEmails = getFilteredEmails();

  useEffect(() => {
    const userString = localStorage.getItem('user');
    if (userString) {
      try {
        const parsedUser = JSON.parse(userString);
        setCurrentUser(parsedUser);
        setUserRole(parsedUser.role);
      } catch (err) {
        console.error('Error parsing current user:', err);
      }
    }

    // Handle redirect back from OAuth (for extra account connection)
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail') === 'connected') {
      triggerAlert('success', 'Gmail account connected successfully!');
      window.history.replaceState({}, document.title, '/inbox');
      setActiveTab('accounts');
    }

    loadEmails('');
    fetchGmailStatus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadEmails(searchQuery);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchGmailStatus = async () => {
    try {
      const res = await api.get('/gmail/status');
      setGmailStatus({
        connected: res.data.connected,
        gmailEmail: res.data.gmailEmail || '',
        linkedAccounts: res.data.linkedAccounts || []
      });
    } catch (err) {
      console.error('Error checking Gmail status in Inbox:', err);
    }
  };

  const handleConnectExtraAccount = async () => {
    setConnectingExtra(true);
    try {
      const response = await api.get('/gmail/auth-url?mode=extra');
      if (response.data.authUrl) {
        window.location.href = response.data.authUrl;
      }
    } catch (err) {
      console.error('Error generating extra Gmail auth URL:', err);
      const message = err.response?.data?.message || 'Failed to start Gmail connection.';
      triggerAlert('error', message);
    } finally {
      setConnectingExtra(false);
    }
  };

  const handleDisconnectLinkedAccount = async (gmailEmail, userId) => {
    if (!window.confirm(`Disconnect ${gmailEmail || 'this account'}? All emails fetched from this account will be deleted.`)) return;
    setDisconnectingAccount(gmailEmail || userId);
    try {
      await api.delete('/gmail/linked-account', { data: { gmailEmail, userId } });
      triggerAlert('success', `${gmailEmail || 'Blank account'} disconnected successfully.`);
      fetchGmailStatus();
      fetchEmails();
    } catch (err) {
      console.error('Failed to disconnect linked account:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to disconnect account.');
    } finally {
      setDisconnectingAccount(null);
    }
  };

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4500);
  };

  const loadEmails = async (query = '') => {
    try {
      setLoading(query === '' && emails.length === 0);
      setSearchLoading(query !== '');
      const params = query.trim() ? { q: query.trim() } : {};
      const res = await api.get('/gmail/emails', { params });
      setEmails(res.data);
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to load emails.' });
    } finally {
      setLoading(false);
      setSearchLoading(false);
    }
  };

  const fetchEmails = () => loadEmails(searchQuery);
  const handleDownloadEmails = () => {
    try {
      if (emails.length === 0) {
        triggerAlert('error', 'No emails available to download.');
        return;
      }

      // CSV Headers
      const headers = ['Subject', 'From', 'To Inbox', 'Status', 'Date', 'Body Preview'];
      
      const rows = emails.map(email => [
        email.subject || '(No Subject)',
        email.from || 'Unknown Sender',
        email.toEmail || email.fetchedBy?.gmailEmail || 'Unknown Inbox',
        email.status || 'unassigned',
        email.date ? new Date(email.date).toLocaleString() : 'N/A',
        email.body ? email.body.replace(/<[^>]*>/g, '').substring(0, 200).replace(/\s+/g, ' ').trim() : ''
      ]);

      // Convert to CSV format with proper cell escaping
      const csvContent = [
        headers.join(','),
        ...rows.map(row => 
          row.map(val => `"${val.replace(/"/g, '""')}"`).join(',')
        )
      ].join('\n');

      // Create download link
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `workspace_emails_backup_${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setHasDownloaded(true);
      localStorage.setItem('emailsDownloaded', 'true');
      triggerAlert('success', 'Emails downloaded successfully! Delete operations are now unlocked.');
    } catch (err) {
      console.error('Error exporting emails:', err);
      triggerAlert('error', 'Failed to export emails.');
    }
  };

  const handleSyncEmails = async () => {
    setSyncing(true);
    try {
      const response = await api.post('/gmail/fetch');
      triggerAlert('success', `Sync complete! Fetched ${response.data.count} new emails.`);
      
      // If we synced new emails, reset downloaded status to force backup
      if (response.data.count > 0) {
        setHasDownloaded(false);
        localStorage.removeItem('emailsDownloaded');
      }
      fetchEmails();
      setSummaryMap({});
    } catch (err) {
      console.error('Sync failed:', err);
      const message = err.response?.data?.message || 'Failed to synchronize with Gmail. Ensure Gmail is connected.';
      triggerAlert('error', message);
    } finally {
      setSyncing(false);
    }
  };

  const handleClearAllEmails = async () => {
    if (!hasDownloaded) {
      triggerAlert('error', 'Delete operation is locked. You must download the email list first before deleting.');
      return;
    }

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
    if (!hasDownloaded) {
      triggerAlert('error', 'Delete operation is locked. You must download the email list first before deleting.');
      return;
    }

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

  const handleSendReply = async (emailId) => {
    if (!replyText.trim()) return;
    setReplying(true);
    try {
      await api.post(`/gmail/emails/${emailId}/reply`, { replyBody: replyText });
      triggerAlert('success', 'Reply sent successfully.');
      setReplyOpenId(null);
      setReplyText('');
    } catch (err) {
      triggerAlert('error', err.response?.data?.message || 'Failed to send reply.');
    } finally {
      setReplying(false);
    }
  };

  const handleSummarize = async (email) => {
    const id = email._id;
    setSummaryMap(prev => ({ ...prev, [id]: { loading: true, text: '', error: '' } }));
    try {
      const res = await api.post('/ai/summarize-email', {
        subject: email.subject,
        from: email.from,
        body: email.body
      });
      setSummaryMap(prev => ({ ...prev, [id]: { loading: false, text: res.data.summary, error: '' } }));
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to summarize. Please try again.';
      setSummaryMap(prev => ({ ...prev, [id]: { loading: false, text: '', error: msg } }));
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
        
        <div className="flex items-center gap-3 w-full sm:w-auto justify-end flex-wrap">
          {(userRole === 'Admin' || userRole === 'Head') && (
            <button
              onClick={handleDownloadEmails}
              className={`px-5 py-3 rounded-xl text-xs font-bold transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm border ${
                hasDownloaded 
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-250 hover:bg-emerald-100' 
                  : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 animate-pulse'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>{hasDownloaded ? 'Emails Backup Downloaded' : 'Download Emails (Unlocks Delete)'}</span>
            </button>
          )}

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
              onClick={() => { setActiveTab(activeTab === 'accounts' ? 'inbox' : 'accounts'); setExpandedEmailId(null); }}
              className={`px-5 py-3 rounded-xl text-xs font-bold transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm border ${
                activeTab === 'accounts'
                  ? 'bg-indigo-650 text-white border-indigo-700 shadow-md shadow-indigo-600/25'
                  : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 00-2-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span>Manage Accounts</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-md font-extrabold ${
                activeTab === 'accounts' ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-500'
              }`}>
                {1 + (gmailStatus.linkedAccounts?.length || 0)}
              </span>
            </button>
          )}

          {userRole === 'Admin' && (
            <button
              onClick={handleClearAllEmails}
              disabled={!hasDownloaded}
              className={`px-5 py-3 rounded-xl text-xs font-bold transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm border ${
                hasDownloaded
                  ? 'bg-red-50 hover:bg-red-100 text-red-600 border-red-200/60'
                  : 'bg-slate-50 text-slate-400 border-slate-200 cursor-not-allowed opacity-60'
              }`}
              title={!hasDownloaded ? 'Download a backup of emails to unlock this operation' : 'Clear all emails'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              <span>Clear All Emails</span>
            </button>
          )}
        </div>
      </div>

      {!hasDownloaded && (userRole === 'Admin' || userRole === 'Head') && emails.length > 0 && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-250 text-amber-900 rounded-2xl text-xs flex items-start gap-3 animate-fade-in shadow-sm">
          <svg className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <span className="font-extrabold text-amber-950 block">Delete Protection Active</span>
            <span className="mt-0.5 block text-slate-655 leading-relaxed">
              Email deletion operations are locked for safety. You must export a CSV backup of the current emails by clicking <strong>"Download Emails"</strong> to unlock single email deletion and the clear-all option.
            </span>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <div style={{ padding: '12px 16px 0', borderBottom: '1px solid #e2e8f0' }}>
        <div style={{ position: 'relative', marginBottom: '12px' }}>
          <span style={{
            position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)',
            color: '#94a3b8', fontSize: '15px', pointerEvents: 'none'
          }}>🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by subject or sender..."
            style={{
              width: '100%', padding: '9px 12px 9px 36px', fontSize: '13px',
              borderRadius: '8px', border: '1px solid #e2e8f0', outline: 'none',
              boxSizing: 'border-box', background: '#f8fafc'
            }}
          />
          {searchLoading && (
            <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '12px', color: '#94a3b8' }}>
              Searching...
            </span>
          )}
          {searchQuery && !searchLoading && (
            <button
              onClick={() => setSearchQuery('')}
              style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: '#94a3b8', lineHeight: 1 }}
            >×</button>
          )}
        </div>
      </div>

      {/* Filters: Tab Bar + Account Selector */}
      {true && (
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6 border-b border-slate-100 pb-4">
          {/* Tab Selection */}
          <div className="flex items-center p-0.5 bg-slate-100/80 rounded-xl border border-slate-200/50 self-start shrink-0 flex-wrap gap-0.5">
            <button
              onClick={() => { setActiveTab('inbox'); setExpandedEmailId(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeTab === 'inbox'
                  ? 'bg-white text-indigo-650 shadow-sm border border-slate-200/40'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <span>Inbox</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-md font-extrabold ${
                activeTab === 'inbox' ? 'bg-indigo-50 text-indigo-650' : 'bg-slate-200 text-slate-600'
              }`}>
                {getTabCount('inbox')}
              </span>
            </button>
            
            <button
              onClick={() => { setActiveTab('promotions'); setExpandedEmailId(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeTab === 'promotions'
                  ? 'bg-white text-indigo-650 shadow-sm border border-slate-200/40'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <span>Promotions</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-md font-extrabold ${
                activeTab === 'promotions' ? 'bg-indigo-50 text-indigo-650' : 'bg-slate-200 text-slate-600'
              }`}>
                {getTabCount('promotions')}
              </span>
            </button>

            <button
              onClick={() => { setActiveTab('social'); setExpandedEmailId(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeTab === 'social'
                  ? 'bg-white text-indigo-650 shadow-sm border border-slate-200/40'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <span>Social</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-md font-extrabold ${
                activeTab === 'social' ? 'bg-indigo-50 text-indigo-650' : 'bg-slate-200 text-slate-600'
              }`}>
                {getTabCount('social')}
              </span>
            </button>

            <button
              onClick={() => { setActiveTab('updates'); setExpandedEmailId(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeTab === 'updates'
                  ? 'bg-white text-indigo-650 shadow-sm border border-slate-200/40'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <span>Updates</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-md font-extrabold ${
                activeTab === 'updates' ? 'bg-indigo-50 text-indigo-650' : 'bg-slate-200 text-slate-600'
              }`}>
                {getTabCount('updates')}
              </span>
            </button>

            <button
              onClick={() => { setActiveTab('spam'); setExpandedEmailId(null); }}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeTab === 'spam'
                  ? 'bg-white text-indigo-650 shadow-sm border border-slate-200/40'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <span>Spam</span>
              <span className={`px-1.5 py-0.5 text-[10px] rounded-md font-extrabold ${
                activeTab === 'spam' ? 'bg-indigo-50 text-indigo-650' : 'bg-slate-200 text-slate-600'
              }`}>
                {getTabCount('spam')}
              </span>
            </button>
          </div>

          {/* Source email account selector */}
          {uniqueAccounts.length > 1 && (
            <div className="flex items-center gap-2 self-start md:self-auto">
              <span className="text-xs font-semibold text-slate-500">Filter by Account:</span>
              <select
                value={selectedAccount}
                onChange={(e) => { setSelectedAccount(e.target.value); setExpandedEmailId(null); }}
                className="bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-550/20 focus:border-indigo-550 cursor-pointer shadow-sm min-w-[180px]"
              >
                <option value="all">All Accounts ({emails.length})</option>
                {uniqueAccounts.map((account) => (
                  <option key={account} value={account}>
                    {account}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}


      {/* Connected Accounts Manager Panel */}
      {activeTab === 'accounts' && userRole === 'Admin' && (
        <div className="space-y-5 mb-8 p-6 bg-indigo-50/15 border-2 border-indigo-500/20 rounded-3xl shadow-lg shadow-indigo-500/5 animate-fade-in relative overflow-hidden ring-4 ring-indigo-500/[0.02]">
          <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 rounded-full blur-2xl pointer-events-none" />
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200/60">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-extrabold text-slate-800">Connected Gmail Accounts</h2>
                <span className="px-2 py-0.5 text-[9px] font-bold bg-indigo-100 text-indigo-700 rounded-md uppercase tracking-wider">Manager Active</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">Emails from all connected accounts are merged into your workspace inbox.</p>
            </div>
            <button
              onClick={handleConnectExtraAccount}
              disabled={connectingExtra}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-xs font-bold text-white shadow-md shadow-indigo-600/10 hover:shadow-indigo-600/20 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center gap-2 self-start sm:self-auto"
            >
              {connectingExtra ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Connect Another Gmail</span>
                </>
              )}
            </button>
          </div>

          {/* Primary Account Card */}
          {gmailStatus.connected && gmailStatus.gmailEmail && (
            <div className="bg-white border border-emerald-200/80 rounded-2xl p-5 shadow-sm hover-glow-card transition-all duration-300">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-xl bg-emerald-50 border border-emerald-100 text-emerald-500 flex items-center justify-center shrink-0 font-extrabold text-sm">
                    {gmailStatus.gmailEmail.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-slate-800 truncate">{gmailStatus.gmailEmail}</span>
                      <span className="px-2 py-0.5 text-[10px] font-extrabold rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block animate-pulse" />
                        Primary · Active
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {emails.filter(e => e.toEmail === gmailStatus.gmailEmail || e.fetchedBy?.gmailEmail === gmailStatus.gmailEmail).length} emails in workspace
                    </p>
                  </div>
                </div>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-2 py-1 uppercase tracking-wider">Primary</span>
              </div>
            </div>
          )}

          {/* Linked Account Cards */}
          {(gmailStatus.linkedAccounts || []).map((acct) => (
            <div key={acct.gmailEmail} className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm hover-glow-card transition-all duration-300">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-500 flex items-center justify-center shrink-0 font-extrabold text-sm">
                    {acct.gmailEmail.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-slate-800 truncate">{acct.gmailEmail || "Invalid Account"}</span>
                      <span className={`px-2 py-0.5 text-[10px] font-extrabold rounded-full border flex items-center gap-1 ${
                        acct.connected
                          ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                          : 'bg-amber-50 text-amber-600 border-amber-100'
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full inline-block ${
                          acct.connected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                        }`} />
                        {acct.connected ? 'Linked · Active' : 'Token Expired'}
                      </span>
                      {acct.ownerName && acct.ownerName !== 'Me' && (
                        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-slate-150 text-slate-700 border border-slate-200">
                          Connected by: {acct.ownerName}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {emails.filter(e => e.toEmail === acct.gmailEmail).length} emails in workspace
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleDisconnectLinkedAccount(acct.gmailEmail, acct.userId)}
                  disabled={disconnectingAccount === (acct.gmailEmail || acct.userId)}
                  className="px-3.5 py-2 text-[10px] font-bold text-red-655 bg-red-50 hover:bg-red-100 border border-red-200/60 rounded-xl transition-all active:scale-[0.98] disabled:opacity-50 shrink-0 shadow-sm"
                >
                  {disconnectingAccount === (acct.gmailEmail || acct.userId) ? 'Removing...' : 'Disconnect'}
                </button>
              </div>
            </div>
          ))}

          {/* No linked accounts CTA */}
          {!gmailStatus.connected && (gmailStatus.linkedAccounts || []).length === 0 && (
            <div className="text-center py-10 bg-white border border-slate-200/80 rounded-2xl">
              <p className="text-sm text-slate-500">No Gmail accounts connected yet.</p>
              <p className="text-xs text-slate-400 mt-1">Connect a Gmail account via the Dashboard to start syncing emails.</p>
            </div>
          )}
        </div>
      )}

      {activeTab !== 'accounts' && (
        loading ? (
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
      ) : filteredEmails.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: '#94a3b8' }}>
          {searchQuery ? `No emails found for "${searchQuery}"` : 'No emails in this category.'}
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredEmails.map((email) => {
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-xs font-semibold text-slate-500 truncate max-w-[180px] sm:max-w-[260px]">
                          {email.from}
                        </p>
                        {(email.toEmail || email.fetchedBy?.gmailEmail) && (
                          <span className="flex items-center gap-1 shrink-0">
                            <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 7l5 5-5 5M6 12h12" />
                            </svg>
                            <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold border ${
                              (email.toEmail || email.fetchedBy?.gmailEmail) === gmailStatus.gmailEmail
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                                : 'bg-indigo-50 text-indigo-600 border-indigo-100'
                            }`}>
                              {email.toEmail || email.fetchedBy?.gmailEmail}
                            </span>
                          </span>
                        )}
                      </div>
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
                        className={`p-1.5 rounded-xl transition-all active:scale-95 ${
                          hasDownloaded
                            ? 'text-slate-400 hover:text-red-500 hover:bg-red-50'
                            : 'text-slate-350 cursor-not-allowed opacity-50'
                        }`}
                        title={hasDownloaded ? 'Delete email' : 'Download emails first to unlock delete'}
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

                    {/* AI Summary panel */}
                    {(userRole === 'Admin' || userRole === 'Head') && (
                      <div style={{ margin: '0 0 12px', padding: '12px 14px', borderRadius: '8px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: summaryMap[email._id]?.text ? '10px' : '0' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', display: 'flex', alignItems: 'center', gap: '5px' }}>
                            ✨ AI Summary
                          </span>
                          <button
                            onClick={() => handleSummarize(email)}
                            disabled={summaryMap[email._id]?.loading}
                            style={{
                              padding: '4px 12px', fontSize: '12px', borderRadius: '5px',
                              border: '1px solid #c7d2fe', background: summaryMap[email._id]?.loading ? '#e0e7ff' : '#eef2ff',
                              color: '#4338ca', cursor: summaryMap[email._id]?.loading ? 'not-allowed' : 'pointer'
                            }}
                          >
                            {summaryMap[email._id]?.loading ? 'Summarizing...' : summaryMap[email._id]?.text ? 'Re-summarize' : 'Summarize'}
                          </button>
                        </div>

                        {summaryMap[email._id]?.loading && (
                          <p style={{ fontSize: '13px', color: '#94a3b8', margin: '8px 0 0' }}>Generating summary...</p>
                        )}

                        {summaryMap[email._id]?.error && (
                          <p style={{ fontSize: '13px', color: '#dc2626', margin: '8px 0 0' }}>{summaryMap[email._id].error}</p>
                        )}

                        {summaryMap[email._id]?.text && (
                          <div style={{ fontSize: '13px', color: '#334155', lineHeight: '1.7', marginTop: '8px', whiteSpace: 'pre-line' }}>
                            {summaryMap[email._id].text}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Email Text Body container */}
                    {email.body ? (
                      <div className="email-body-rendered-container">
                        <iframe
                          srcDoc={renderEmailContent(email.body)}
                          title="Email Content"
                          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                          className="w-full border border-slate-200 rounded-xl bg-white shadow-inner"
                          style={{ minHeight: '200px', height: '300px', resize: 'vertical' }}
                        />
                      </div>
                    ) : (
                      <div className="bg-white border border-slate-200/85 rounded-xl p-4 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap break-words overflow-hidden max-w-full select-text">
                        <span className="italic text-slate-400">This email has no text content.</span>
                      </div>
                    )}

                    {/* Reply panel — shown only for Admin/Head */}
                    {(userRole === 'Admin' || userRole === 'Head') && (
                      <div style={{ borderTop: '1px solid #e2e8f0', padding: '12px 16px' }}>
                        {replyOpenId === email._id ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <textarea
                              value={replyText}
                              onChange={e => setReplyText(e.target.value)}
                              placeholder={`Reply to ${email.from}...`}
                              rows={5}
                              style={{
                                width: '100%', resize: 'vertical', padding: '10px 12px',
                                fontSize: '13px', borderRadius: '8px',
                                border: '1px solid #cbd5e1', outline: 'none',
                                fontFamily: 'inherit', lineHeight: '1.5', boxSizing: 'border-box'
                              }}
                            />
                            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                              <button
                                onClick={() => { setReplyOpenId(null); setReplyText(''); }}
                                style={{ padding: '7px 16px', fontSize: '13px', borderRadius: '6px', border: '1px solid #cbd5e1', background: 'white', cursor: 'pointer' }}
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => handleSendReply(email._id)}
                                disabled={replying || !replyText.trim()}
                                style={{
                                  padding: '7px 16px', fontSize: '13px', borderRadius: '6px',
                                  border: 'none', background: replying ? '#94a3b8' : '#4f46e5',
                                  color: 'white', cursor: replying ? 'not-allowed' : 'pointer'
                                }}
                              >
                                {replying ? 'Sending...' : 'Send Reply'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setReplyOpenId(email._id); setReplyText(''); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: '6px',
                              padding: '7px 14px', fontSize: '13px', borderRadius: '6px',
                              border: '1px solid #cbd5e1', background: 'white', cursor: 'pointer'
                            }}
                          >
                            ↩ Reply
                          </button>
                        )}
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
      )
      )}
    </main>
  );
};

export default EmailInbox;
