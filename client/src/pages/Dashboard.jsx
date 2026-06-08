import React, { useState, useEffect } from 'react';
import api from '../api/axios';

const Dashboard = () => {
  const [fetching, setFetching] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [tasks, setTasks] = useState([]);
  const [overallStats, setOverallStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  
  // Retrieve user details from localStorage
  const userString = localStorage.getItem('user');
  let user = { name: 'Guest', role: 'Employee' };
  
  try {
    if (userString) {
      user = JSON.parse(userString);
    }
  } catch (err) {
    console.error('Error parsing user data:', err);
  }

  const fetchDashboardData = async () => {
    setStatsLoading(true);
    try {
      if (user.role === 'Admin' || user.role === 'Head') {
        const statsRes = await api.get('/reports/overall');
        setOverallStats(statsRes.data);
      } else {
        const tasksRes = await api.get('/tasks');
        setTasks(tasksRes.data);
      }
    } catch (err) {
      console.error('Error loading dashboard stats:', err);
      triggerAlert('error', 'Failed to retrieve stats data.');
    } finally {
      setStatsLoading(false);
    }
  };

  // Check query parameter on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail') === 'connected') {
      triggerAlert('success', 'Gmail Connected Successfully!');
      window.history.replaceState({}, document.title, '/dashboard');
    }
    fetchDashboardData();
  }, []);

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4500);
  };

  const handleConnectGmail = async () => {
    try {
      const response = await api.get('/gmail/auth-url');
      if (response.data.authUrl) {
        window.location.href = response.data.authUrl;
      }
    } catch (err) {
      console.error('Error generating Gmail auth URL:', err);
      const message = err.response?.data?.message || 'Failed to start Google connection process.';
      triggerAlert('error', message);
    }
  };

  const handleFetchEmails = async () => {
    setFetching(true);
    try {
      const response = await api.post('/gmail/fetch');
      triggerAlert('success', `Fetch complete! Saved ${response.data.count} new emails.`);
      if (user.role === 'Admin' || user.role === 'Head') {
        const statsRes = await api.get('/reports/overall');
        setOverallStats(statsRes.data);
      }
    } catch (err) {
      console.error('Error fetching emails:', err);
      const message = err.response?.data?.message || 'Failed to fetch emails. Please ensure Gmail is connected.';
      triggerAlert('error', message);
    } finally {
      setFetching(false);
    }
  };

  const showWorkspaceCards = user.role !== 'Employee';

  return (
    <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-fade-in select-none">
      {/* Floating alerts */}
      {alert.message && (
        <div className={`fixed top-20 right-4 z-50 p-4 rounded-xl border flex items-start space-x-3 shadow-2xl transition-all duration-300 max-w-md animate-slide-in ${
          alert.type === 'success'
            ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
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

      {/* Title & Greeting Banner */}
      <div className="mb-8">
        <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full uppercase tracking-wider font-mono">
          Dashboard Overview
        </span>
        <h1 className="text-3xl font-extrabold text-slate-800 tracking-tight mt-3">
          Welcome back, {user.name}
        </h1>
        <p className="text-slate-500 mt-1 text-sm leading-relaxed">
          Monitor your emails, tasks, and system activities in one unified command center.
        </p>
      </div>

      <div className={`grid grid-cols-1 ${showWorkspaceCards ? 'lg:grid-cols-3' : ''} gap-6`}>
        {/* Left 2 Columns: Profile Details & Stats */}
        <div className={`${showWorkspaceCards ? 'lg:col-span-2' : 'lg:col-span-3'} space-y-6`}>
          {/* User profile card */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm">
            <h2 className="text-sm font-bold text-slate-800 mb-4 uppercase tracking-wide">Account Credentials</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100 flex flex-col justify-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Username</span>
                <span className="text-sm font-semibold text-slate-800 mt-1">{user.name}</span>
              </div>
              <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100 flex flex-col justify-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Email Address</span>
                <span className="text-sm font-semibold text-slate-850 mt-1 truncate">{user.email || 'N/A'}</span>
              </div>
              <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100 flex flex-col justify-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Role Scope</span>
                <span className="text-xs font-extrabold text-indigo-600 uppercase tracking-wider mt-1.5 font-mono">{user.role}</span>
              </div>
              <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100 flex flex-col justify-center">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Workspace Connection</span>
                <span className="text-xs font-bold text-emerald-600 flex items-center space-x-1.5 mt-1.5">
                  <span className="h-2 w-2 bg-emerald-500 rounded-full animate-pulse" />
                  <span>Secure Session</span>
                </span>
              </div>
            </div>
          </div>

          {/* Stats Cards Section */}
          <div className="space-y-4">
            <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">
              {user.role === 'Employee' ? 'My Task Statistics' : 'Workspace Metrics'}
            </h2>
            {statsLoading ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[...Array(user.role === 'Employee' ? 4 : 6)].map((_, i) => (
                  <div key={i} className="bg-white border border-slate-200/80 rounded-2xl p-5 h-28 skeleton-shimmer" />
                ))}
              </div>
            ) : user.role === 'Employee' ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {/* My Tasks */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned</span>
                    <div className="h-7 w-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs shrink-0">📋</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{tasks.length}</span>
                </div>

                {/* Pending */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Pending</span>
                    <div className="h-7 w-7 rounded-lg bg-amber-50 text-amber-500 flex items-center justify-center font-bold text-xs shrink-0">⏳</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">
                    {tasks.filter(t => t.status === 'Pending').length}
                  </span>
                </div>

                {/* Completed */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Completed</span>
                    <div className="h-7 w-7 rounded-lg bg-emerald-50 text-emerald-505 flex items-center justify-center font-bold text-xs shrink-0">✓</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">
                    {tasks.filter(t => t.status === 'Completed').length}
                  </span>
                </div>

                {/* Late */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Late</span>
                    <div className="h-7 w-7 rounded-lg bg-red-50 text-red-500 flex items-center justify-center font-bold text-xs shrink-0">⚠️</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">
                    {tasks.filter(t => t.status === 'Late').length}
                  </span>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {/* Total Users */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Users</span>
                    <div className="h-7 w-7 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center text-xs shrink-0">👥</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{overallStats?.totalUsers || 0}</span>
                </div>

                {/* Total Emails */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Emails</span>
                    <div className="h-7 w-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs shrink-0">✉️</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{overallStats?.totalEmails || 0}</span>
                </div>

                {/* Total Tasks */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Tasks</span>
                    <div className="h-7 w-7 rounded-lg bg-slate-50 text-slate-550 flex items-center justify-center text-xs shrink-0">📋</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{overallStats?.totalTasks || 0}</span>
                </div>

                {/* Pending */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Pending</span>
                    <div className="h-7 w-7 rounded-lg bg-amber-50 text-amber-500 flex items-center justify-center text-xs shrink-0">⏳</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{overallStats?.totalPending || 0}</span>
                </div>

                {/* Completed */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Completed</span>
                    <div className="h-7 w-7 rounded-lg bg-emerald-50 text-emerald-500 flex items-center justify-center text-xs shrink-0">✓</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{overallStats?.totalCompleted || 0}</span>
                </div>

                {/* Late */}
                <div className="bg-white border border-slate-200/80 p-5 rounded-2xl flex flex-col justify-between hover-glow-card shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Late</span>
                    <div className="h-7 w-7 rounded-lg bg-red-50 text-red-500 flex items-center justify-center text-xs shrink-0">⚠️</div>
                  </div>
                  <span className="text-2xl font-bold text-slate-800 mt-3">{overallStats?.totalLate || 0}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {showWorkspaceCards && (
          <div className="space-y-6">
            {/* Gmail Connection Card */}
            <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm flex flex-col space-y-4">
              <div className="flex items-start space-x-3.5">
                <div className="h-10 w-10 rounded-xl bg-red-50 border border-red-100 text-red-500 flex items-center justify-center shrink-0">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-800 tracking-tight">Gmail Connection</h3>
                  <p className="text-xs text-slate-450 mt-1 leading-relaxed">
                    Connect account to synchronise email streams into task cards.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 pt-2">
                <button
                  onClick={handleConnectGmail}
                  className="w-full flex justify-center items-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all duration-150 shadow-md active:scale-[0.98]"
                >
                  <span>Link Gmail Account</span>
                </button>

                <button
                  onClick={handleFetchEmails}
                  disabled={fetching}
                  className="w-full flex justify-center items-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-md active:scale-[0.98]"
                >
                  {fetching ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span>Synchronising...</span>
                    </span>
                  ) : (
                    <span>Synchronise Emails</span>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
};

export default Dashboard;
