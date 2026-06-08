import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../api/axios';

const ActivityLog = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  
  // Alert messages state
  const [alert, setAlert] = useState({ type: '', message: '' });

  const navigate = useNavigate();

  // Fetch log list on mount
  useEffect(() => {
    fetchLogs();
  }, []);

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4000);
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const response = await api.get('/users/activity-logs');
      setLogs(response.data);
    } catch (err) {
      console.error('Failed to fetch activity logs:', err);
      const message = err.response?.data?.message || 'Failed to load activity logs. Please refresh.';
      triggerAlert('error', message);
    } finally {
      setLoading(false);
    }
  };

  // Helper to format dates cleanly
  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      const d = new Date(dateString);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (err) {
      return dateString;
    }
  };

  // Get distinct list of action types for filtering
  const actionTypes = Array.from(new Set(logs.map(log => log.action)));

  // Get distinct list of users who have log entries
  const activeUsers = Array.from(
    new Map(
      logs
        .filter(log => log.userId)
        .map(log => [log.userId._id, log.userId])
    ).values()
  );

  // Filter logs based on active selection
  const filteredLogs = logs.filter(log => {
    if (userFilter && log.userId?._id !== userFilter) {
      return false;
    }
    if (actionFilter && log.action !== actionFilter) {
      return false;
    }
    return true;
  });

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative animate-fade-in select-none">
      {/* Admin Submenu Tabs */}
      <div className="flex justify-start items-center space-x-6 mb-8 border-b border-slate-200 pb-4">
        <Link to="/admin/users" className="text-sm font-semibold text-slate-500 hover:text-slate-800 pb-4 -mb-[17px] transition-all">
          Manage Users
        </Link>
        <Link to="/admin/activities" className="text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 pb-4 -mb-[17px] transition-all">
          Activity Logs
        </Link>
      </div>

      {/* Floating Alert Messages */}
      {alert.message && (
        <div className={`fixed top-20 right-4 z-50 p-4 rounded-xl border flex items-start space-x-3 shadow-2xl transition-all duration-300 max-w-md animate-slide-in ${
          alert.type === 'success'
            ? 'bg-emerald-55 border-emerald-100 text-emerald-600'
            : 'bg-red-50 border-red-100 text-red-500'
        }`}>
          <svg className="h-5 w-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {alert.type === 'success' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            )}
          </svg>
          <span className="text-xs font-semibold">{alert.message}</span>
        </div>
      )}

      {/* Title Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-800">Activity Logs</h1>
          <p className="mt-1 text-sm text-slate-500">
            Audit trails tracking actions performed by workspace heads and administrators.
          </p>
        </div>
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="px-5 py-3 rounded-xl bg-white border-2 border-indigo-650 hover:bg-indigo-50 text-indigo-650 text-xs font-bold shadow-sm transition-all duration-200 flex items-center justify-center space-x-2 active:scale-95 disabled:opacity-50"
        >
          <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.253 8H18" />
          </svg>
          <span>Refresh Logs</span>
        </button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 bg-white border border-slate-200 p-5 rounded-2xl shadow-sm">
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Filter by User</label>
          <select
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-150 transition-all cursor-pointer"
          >
            <option value="">All Users</option>
            {activeUsers.map(user => (
              <option key={user._id} value={user._id}>
                {user.name} ({user.role})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Filter by Action</label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-150 transition-all cursor-pointer"
          >
            <option value="">All Actions</option>
            {actionTypes.map(type => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover-glow-card transition-all duration-300">
        {loading ? (
          <div className="space-y-4 p-6">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-16 bg-white border border-slate-200/80 rounded-xl p-4 skeleton-shimmer" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-14 h-14 mx-auto bg-slate-50 rounded-2xl flex items-center justify-center mb-4 border border-slate-100">
              <svg className="h-6 w-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2" />
              </svg>
            </div>
            <h3 className="text-md font-bold text-slate-800 mb-1">No activity logs found</h3>
            <p className="text-xs text-slate-500">Workspace log database is currently empty matching these filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50/50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <tr>
                  <th scope="col" className="px-6 py-4">User</th>
                  <th scope="col" className="px-6 py-4">Role</th>
                  <th scope="col" className="px-6 py-4">Action</th>
                  <th scope="col" className="px-6 py-4">Details</th>
                  <th scope="col" className="px-6 py-4">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm">
                {filteredLogs.map((log) => {
                  const initials = log.userId ? getInitials(log.userId.name) : '?';
                  
                  // Role color
                  let roleClass = 'bg-indigo-50 border-indigo-100 text-indigo-650';
                  if (log.userId?.role === 'Admin') {
                    roleClass = 'bg-red-50 border-red-100 text-red-600';
                  } else if (log.userId?.role === 'Head') {
                    roleClass = 'bg-purple-50 border-purple-100 text-purple-650';
                  }

                  // Action badge color
                  let actionClass = 'bg-slate-50 border-slate-200 text-slate-600';
                  if (log.action === 'Login') {
                    actionClass = 'bg-emerald-50 border-emerald-100 text-emerald-650 font-bold';
                  } else if (log.action.includes('Task') || log.action.includes('Create') || log.action.includes('Edit')) {
                    actionClass = 'bg-indigo-50 border-indigo-100 text-indigo-650 font-bold';
                  }

                  return (
                    <tr key={log._id} className="hover:bg-slate-50 transition-colors duration-150">
                      <td className="px-6 py-4 whitespace-nowrap">
                        {log.userId ? (
                          <div className="flex items-center">
                            <div className="h-9 w-9 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center font-extrabold text-xs text-indigo-600 shrink-0">
                              {initials}
                            </div>
                            <div className="ml-3">
                              <span className="font-bold text-slate-800 block">{log.userId.name}</span>
                              <span className="text-xs text-slate-400 font-mono block">{log.userId.email}</span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">Unknown User</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {log.userId ? (
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${roleClass}`}>
                            {log.userId.role}
                          </span>
                        ) : (
                          <span className="text-slate-400 font-mono">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs border ${actionClass}`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-700 max-w-md break-words font-medium">
                        {log.details}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-slate-500 font-mono text-xs">
                        {formatDate(log.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
};

export default ActivityLog;
