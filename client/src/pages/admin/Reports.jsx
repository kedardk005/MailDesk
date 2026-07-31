import React, { useState, useEffect } from 'react';
import api from '../../api/axios';

const Reports = () => {
  // Stats & Timeline states
  const [overallStats, setOverallStats] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_reports_overall');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [timelineData, setTimelineData] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_reports_timeline');
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });
  const [statsLoading, setStatsLoading] = useState(() => {
    try {
      return !localStorage.getItem('cached_reports_overall');
    } catch {
      return true;
    }
  });

  // Email Day-wise Timeline states
  const [emailDaysFilter, setEmailDaysFilter] = useState(14); // 7, 14, 30
  const [emailTimeline, setEmailTimeline] = useState([]);
  const [emailTimelineLoading, setEmailTimelineLoading] = useState(false);
  const [hoveredEmailPoint, setHoveredEmailPoint] = useState(null);

  // Performance Report states
  const [employees, setEmployees] = useState([]);
  const [filterType, setFilterType] = useState('monthly'); // 'weekly' or 'monthly'
  const [selectedUserId, setSelectedUserId] = useState('');
  const [reportData, setReportData] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState({}); // employeeId -> boolean

  // Interactive SVG task chart state
  const [hoveredPoint, setHoveredPoint] = useState(null);

  // Error/Success alert state
  const [alert, setAlert] = useState({ type: '', message: '' });

  // Client stats states
  const [clientStats, setClientStats] = useState([]);
  const [clientStatsLoading, setClientStatsLoading] = useState(false);

  useEffect(() => {
    fetchOverallStats();
    fetchTimeline();
    fetchEmailTimeline(14);
    fetchEmployeesList();
    generateReport('monthly', '');
    fetchClientStats();
  }, []);

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4500);
  };

  const fetchOverallStats = async () => {
    try {
      const response = await api.get('/reports/overall');
      setOverallStats(response.data);
      try {
        localStorage.setItem('cached_reports_overall', JSON.stringify(response.data));
      } catch (e) {}
    } catch (err) {
      console.error('Error fetching overall stats:', err);
      triggerAlert('error', 'Failed to retrieve system stats.');
    }
  };

  const fetchTimeline = async () => {
    try {
      const response = await api.get('/reports/timeline');
      setTimelineData(response.data);
      try {
        localStorage.setItem('cached_reports_timeline', JSON.stringify(response.data));
      } catch (e) {}
    } catch (err) {
      console.error('Error fetching task timeline:', err);
      triggerAlert('error', 'Failed to load task timeline data.');
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchEmailTimeline = async (days = emailDaysFilter) => {
    setEmailTimelineLoading(true);
    try {
      const response = await api.get('/reports/email-timeline', { params: { days } });
      setEmailTimeline(response.data);
    } catch (err) {
      console.error('Error fetching email timeline:', err);
      triggerAlert('error', 'Failed to load email day-wise report.');
    } finally {
      setEmailTimelineLoading(false);
    }
  };

  const handleDaysFilterChange = (days) => {
    setEmailDaysFilter(days);
    fetchEmailTimeline(days);
  };

  const fetchEmployeesList = async () => {
    try {
      const response = await api.get('/users');
      // Filter out admins from assigning report scope
      const workers = response.data.filter((u) => u.role !== 'Admin');
      setEmployees(workers);
    } catch (err) {
      console.error('Error fetching employee list:', err);
    }
  };

  const generateReport = async (filter = filterType, userId = selectedUserId) => {
    setReportLoading(true);
    try {
      const response = await api.get(`/reports/employee`, {
        params: { filter, userId: userId || undefined }
      });
      setReportData(response.data);
      setExpandedRows({});
    } catch (err) {
      console.error('Error generating employee report:', err);
      triggerAlert('error', 'Failed to generate employee report.');
    } finally {
      setReportLoading(false);
    }
  };

  const fetchClientStats = async () => {
    setClientStatsLoading(true);
    try {
      const response = await api.get('/reports/client-stats');
      setClientStats(response.data);
    } catch (err) {
      console.error('Error fetching client stats report:', err);
      triggerAlert('error', 'Failed to retrieve client-wise stats report.');
    } finally {
      setClientStatsLoading(false);
    }
  };

  const handleGenerate = (e) => {
    e.preventDefault();
    generateReport(filterType, selectedUserId);
  };

  const toggleRow = (employeeId) => {
    setExpandedRows((prev) => ({
      ...prev,
      [employeeId]: !prev[employeeId]
    }));
  };

  const handleExportCSV = () => {
    if (reportData.length === 0) {
      triggerAlert('error', 'No report data available to export.');
      return;
    }

    const headers = ['Employee Name', 'Email', 'Role', 'Assigned Tasks', 'Completed Tasks', 'Pending Tasks', 'Late Tasks', 'Completion Rate (%)'];
    const rows = reportData.map((row) => [
      `"${row.employeeName.replace(/"/g, '""')}"`,
      `"${row.employeeEmail.replace(/"/g, '""')}"`,
      `"${row.employeeRole}"`,
      row.totalAssigned,
      row.totalCompleted,
      row.totalPending,
      row.totalLate,
      `${row.completionRate}%`
    ]);

    const csvContent = [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Performance_Report_${filterType}_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    triggerAlert('success', 'Performance report exported successfully.');
  };

  // --- Task Timeline SVG Helper Calculations ---
  const svgWidth = 800;
  const svgHeight = 220;
  const padding = { top: 20, right: 30, bottom: 40, left: 45 };
  const chartWidth = svgWidth - padding.left - padding.right;
  const chartHeight = svgHeight - padding.top - padding.bottom;

  const maxTimelineCount = timelineData.length > 0 ? Math.max(...timelineData.map((d) => d.count), 4) : 4;
  const roundedMaxY = Math.ceil(maxTimelineCount / 4) * 4;

  const taskPoints = timelineData.map((d, index) => {
    const x = padding.left + (index / Math.max(1, timelineData.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - (d.count / roundedMaxY) * chartHeight;
    return { x, y, date: d.date, count: d.count };
  });

  const getBezierPath = (pts) => {
    if (pts.length === 0) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const cp1x = p0.x + (p1.x - p0.x) / 2;
      const cp1y = p0.y;
      const cp2x = p1.x - (p1.x - p0.x) / 2;
      const cp2y = p1.y;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p1.x} ${p1.y}`;
    }
    return d;
  };

  const taskPathD = getBezierPath(taskPoints);
  const taskAreaD = taskPoints.length > 0 ? `${taskPathD} L ${taskPoints[taskPoints.length - 1].x} ${padding.top + chartHeight} L ${taskPoints[0].x} ${padding.top + chartHeight} Z` : '';
  const yTicks = [0, roundedMaxY * 0.25, roundedMaxY * 0.5, roundedMaxY * 0.75, roundedMaxY];

  // --- Email Timeline SVG Helper Calculations ---
  const emailMaxCount = emailTimeline.length > 0 ? Math.max(...emailTimeline.map((d) => d.count), 4) : 4;
  const emailRoundedMaxY = Math.ceil(emailMaxCount / 4) * 4;

  const emailPoints = emailTimeline.map((d, index) => {
    const x = padding.left + (index / Math.max(1, emailTimeline.length - 1)) * chartWidth;
    const y = padding.top + chartHeight - (d.count / emailRoundedMaxY) * chartHeight;
    return { x, y, date: d.date, label: d.label, count: d.count, assignedCount: d.assignedCount };
  });

  const emailPathD = getBezierPath(emailPoints);
  const emailAreaD = emailPoints.length > 0 ? `${emailPathD} L ${emailPoints[emailPoints.length - 1].x} ${padding.top + chartHeight} L ${emailPoints[0].x} ${padding.top + chartHeight} Z` : '';
  const emailYTicks = [0, emailRoundedMaxY * 0.25, emailRoundedMaxY * 0.5, emailRoundedMaxY * 0.75, emailRoundedMaxY];

  // Stats calculation for Email Day-Wise summary
  const totalEmailsReceivedInRange = emailTimeline.reduce((acc, curr) => acc + curr.count, 0);
  const totalEmailsAssignedInRange = emailTimeline.reduce((acc, curr) => acc + curr.assignedCount, 0);
  const avgEmailsPerDay = emailTimeline.length > 0 ? (totalEmailsReceivedInRange / emailTimeline.length).toFixed(1) : 0;
  const peakEmailDay = emailTimeline.length > 0 ? Math.max(...emailTimeline.map(d => d.count)) : 0;

  return (
    <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative animate-fade-in select-none">
      {/* Floating alert */}
      {alert.message && (
        <div
          className={`fixed top-20 right-4 z-50 p-4 rounded-xl border flex items-start space-x-3 shadow-2xl transition-all duration-300 max-w-md animate-slide-in ${
            alert.type === 'success'
              ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
              : 'bg-red-50 border-red-100 text-red-500'
          }`}
        >
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

      {/* Title */}
      <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-800 flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z" />
              </svg>
            </div>
            Reports & Analytics
          </h1>
          <p className="mt-1 text-xs text-slate-500 font-medium">
            System metrics, email volume timelines, employee performance logs, and client analytics.
          </p>
        </div>
      </div>

      {/* Overall KPI Stats Cards */}
      {statsLoading && !overallStats ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-white border border-slate-200 p-5 rounded-2xl h-24 skeleton-shimmer" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-slate-400">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Total Users</span>
            <span className="text-2xl font-black text-slate-800 mt-1 block">{overallStats?.totalUsers || 0}</span>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-indigo-500">
            <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider block">Total Emails</span>
            <span className="text-2xl font-black text-indigo-600 mt-1 block">{overallStats?.totalEmails || 0}</span>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-purple-500">
            <span className="text-[10px] font-bold text-purple-500 uppercase tracking-wider block">Total Tasks</span>
            <span className="text-2xl font-black text-purple-600 mt-1 block">{overallStats?.totalTasks || 0}</span>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-amber-400">
            <span className="text-[10px] font-bold text-amber-500 uppercase tracking-wider block">Pending Tasks</span>
            <span className="text-2xl font-black text-amber-500 mt-1 block">{overallStats?.totalPending || 0}</span>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-emerald-500">
            <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider block">Completed</span>
            <span className="text-2xl font-black text-emerald-600 mt-1 block">{overallStats?.totalCompleted || 0}</span>
          </div>

          <div className="bg-white border border-slate-200/80 p-4 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-red-500">
            <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider block">Overdue / Late</span>
            <span className="text-2xl font-black text-red-500 mt-1 block">{overallStats?.totalLate || 0}</span>
          </div>
        </div>
      )}

      {/* NEW SECTION: Email Received Day-Wise Analytics */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              Emails Received (Day-Wise Report)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Daily volume breakdown of incoming emails and conversion into assigned tasks.
            </p>
          </div>

          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 self-start sm:self-auto">
            {[7, 14, 30].map((days) => (
              <button
                key={days}
                onClick={() => handleDaysFilterChange(days)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  emailDaysFilter === days
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                Last {days} Days
              </button>
            ))}
          </div>
        </div>

        {/* Email Summary Metrics Banner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-slate-50/70 border border-slate-100 rounded-2xl p-4 text-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Total Received</span>
            <span className="text-xl font-black text-slate-800 mt-1 block">{totalEmailsReceivedInRange}</span>
            <span className="text-[10px] text-slate-400 block">in {emailDaysFilter} days</span>
          </div>

          <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-4 text-center">
            <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider block">Daily Average</span>
            <span className="text-xl font-black text-indigo-900 mt-1 block">{avgEmailsPerDay}</span>
            <span className="text-[10px] text-indigo-500 block">emails / day</span>
          </div>

          <div className="bg-purple-50/70 border border-purple-100 rounded-2xl p-4 text-center">
            <span className="text-[10px] font-bold text-purple-500 uppercase tracking-wider block">Peak Daily Volume</span>
            <span className="text-xl font-black text-purple-900 mt-1 block">{peakEmailDay}</span>
            <span className="text-[10px] text-purple-500 block">max in single day</span>
          </div>

          <div className="bg-emerald-50/70 border border-emerald-100 rounded-2xl p-4 text-center">
            <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider block">Assigned to Tasks</span>
            <span className="text-xl font-black text-emerald-900 mt-1 block">{totalEmailsAssignedInRange}</span>
            <span className="text-[10px] text-emerald-600 block">converted to tasks</span>
          </div>
        </div>

        {/* Interactive SVG Chart for Email Timeline */}
        {emailTimelineLoading ? (
          <div className="h-56 bg-slate-50/50 border border-slate-100 rounded-2xl flex items-center justify-center skeleton-shimmer">
            <span className="text-xs text-slate-400 font-medium">Loading email timeline chart...</span>
          </div>
        ) : (
          <div className="relative overflow-x-auto">
            <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto overflow-visible select-none">
              <defs>
                <linearGradient id="emailGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Gridlines */}
              {emailYTicks.map((tick, i) => {
                const y = padding.top + chartHeight - (tick / emailRoundedMaxY) * chartHeight;
                return (
                  <g key={i}>
                    <line x1={padding.left} y1={y} x2={svgWidth - padding.right} y2={y} stroke="#f1f5f9" strokeWidth="1" strokeDasharray="3 3" />
                    <text x={padding.left - 10} y={y + 4} textAnchor="end" className="text-[10px] fill-slate-400 font-mono">
                      {Math.round(tick)}
                    </text>
                  </g>
                );
              })}

              {/* Gradient Area Fill */}
              {emailAreaD && <path d={emailAreaD} fill="url(#emailGradient)" />}

              {/* Curved Line */}
              {emailPathD && <path d={emailPathD} fill="none" stroke="#4f46e5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}

              {/* Interactive Data Points */}
              {emailPoints.map((pt, i) => (
                <g key={i} className="cursor-pointer group" onMouseEnter={() => setHoveredEmailPoint(pt)} onMouseLeave={() => setHoveredEmailPoint(null)}>
                  <circle cx={pt.x} cy={pt.y} r="5" fill="#4f46e5" stroke="#ffffff" strokeWidth="2.5" className="transition-all duration-150 group-hover:r-7" />
                  <text x={pt.x} y={svgHeight - 10} textAnchor="middle" className="text-[9px] fill-slate-400 font-semibold">
                    {pt.label}
                  </text>
                </g>
              ))}
            </svg>

            {/* Hover Tooltip overlay */}
            {hoveredEmailPoint && (
              <div
                className="absolute bg-slate-900/90 backdrop-blur-md text-white text-xs p-3 rounded-xl shadow-xl pointer-events-none transition-all z-20"
                style={{
                  left: `${(hoveredEmailPoint.x / svgWidth) * 100}%`,
                  top: `${(hoveredEmailPoint.y / svgHeight) * 100 - 15}%`,
                  transform: 'translate(-50%, -100%)'
                }}
              >
                <div className="font-bold text-indigo-300">{hoveredEmailPoint.label} ({hoveredEmailPoint.date})</div>
                <div className="mt-1 flex items-center justify-between gap-3 text-[11px]">
                  <span>Total Emails Received:</span>
                  <span className="font-bold text-white">{hoveredEmailPoint.count}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[11px] text-emerald-400">
                  <span>Converted to Tasks:</span>
                  <span className="font-bold">{hoveredEmailPoint.assignedCount}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Section: Task Creation Timeline (Last 30 Days) */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm mb-8">
        <div className="mb-6">
          <h2 className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            Task Creation Timeline (Last 30 Days)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Daily frequency log of new tasks initialized across the organization.
          </p>
        </div>

        {statsLoading ? (
          <div className="h-56 bg-slate-50 border border-slate-100 rounded-2xl flex items-center justify-center skeleton-shimmer">
            <span className="text-xs text-slate-400 font-medium">Loading task timeline chart...</span>
          </div>
        ) : (
          <div className="relative overflow-x-auto">
            <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto overflow-visible select-none">
              <defs>
                <linearGradient id="taskGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a855f7" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {yTicks.map((tick, i) => {
                const y = padding.top + chartHeight - (tick / roundedMaxY) * chartHeight;
                return (
                  <g key={i}>
                    <line x1={padding.left} y1={y} x2={svgWidth - padding.right} y2={y} stroke="#f1f5f9" strokeWidth="1" strokeDasharray="3 3" />
                    <text x={padding.left - 10} y={y + 4} textAnchor="end" className="text-[10px] fill-slate-400 font-mono">
                      {Math.round(tick)}
                    </text>
                  </g>
                );
              })}

              {taskAreaD && <path d={taskAreaD} fill="url(#taskGradient)" />}
              {taskPathD && <path d={taskPathD} fill="none" stroke="#9333ea" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}

              {taskPoints.map((pt, i) => (
                <g key={i} className="cursor-pointer group" onMouseEnter={() => setHoveredPoint(pt)} onMouseLeave={() => setHoveredPoint(null)}>
                  <circle cx={pt.x} cy={pt.y} r="5" fill="#9333ea" stroke="#ffffff" strokeWidth="2.5" className="transition-all duration-150 group-hover:r-7" />
                  {i % 5 === 0 && (
                    <text x={pt.x} y={svgHeight - 10} textAnchor="middle" className="text-[9px] fill-slate-400 font-semibold">
                      {pt.date.slice(5)}
                    </text>
                  )}
                </g>
              ))}
            </svg>

            {hoveredPoint && (
              <div
                className="absolute bg-slate-900/90 text-white text-xs p-3 rounded-xl shadow-xl pointer-events-none transition-all z-20"
                style={{
                  left: `${(hoveredPoint.x / svgWidth) * 100}%`,
                  top: `${(hoveredPoint.y / svgHeight) * 100 - 15}%`,
                  transform: 'translate(-50%, -100%)'
                }}
              >
                <div className="font-bold text-purple-300">{hoveredPoint.date}</div>
                <div className="mt-1 text-[11px]">Tasks Created: <span className="font-bold text-white">{hoveredPoint.count}</span></div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Section: Employee Performance Log Table */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm mb-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-lg font-extrabold text-slate-800">Employee Performance Logs</h2>
            <p className="text-xs text-slate-500 mt-0.5">Filter by date scope and employee to generate completion analytics.</p>
          </div>

          <form onSubmit={handleGenerate} className="flex flex-wrap items-center gap-3">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 font-semibold focus:ring-2 focus:ring-indigo-500/20 outline-none"
            >
              <option value="weekly">Last 7 Days (Weekly)</option>
              <option value="monthly">Last 30 Days (Monthly)</option>
            </select>

            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 font-semibold focus:ring-2 focus:ring-indigo-500/20 outline-none"
            >
              <option value="">All Workers</option>
              {employees.map((emp) => (
                <option key={emp._id} value={emp._id}>
                  {emp.name} ({emp.role})
                </option>
              ))}
            </select>

            <button
              type="submit"
              disabled={reportLoading}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-indigo-600/20 disabled:opacity-50"
            >
              {reportLoading ? 'Generating...' : 'Apply Filters'}
            </button>

            <button
              type="button"
              onClick={handleExportCSV}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-emerald-600/20 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </form>
        </div>

        {/* Employee Report Table */}
        <div className="overflow-x-auto border border-slate-100 rounded-2xl">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-slate-500 text-[11px] font-bold uppercase tracking-wider border-b border-slate-200/80">
                <th className="py-3.5 px-5">Employee</th>
                <th className="py-3.5 px-5 text-center">Assigned</th>
                <th className="py-3.5 px-5 text-center">Completed</th>
                <th className="py-3.5 px-5 text-center">Pending</th>
                <th className="py-3.5 px-5 text-center">Late</th>
                <th className="py-3.5 px-5 text-center">Completion Rate</th>
                <th className="py-3.5 px-5 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {reportData.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-slate-400 font-medium">
                    No performance logs found for the selected scope.
                  </td>
                </tr>
              ) : (
                reportData.map((row) => (
                  <React.Fragment key={row.employeeId}>
                    <tr className="hover:bg-slate-50/60 transition-colors">
                      <td className="py-4 px-5">
                        <div className="font-bold text-slate-800">{row.employeeName}</div>
                        <div className="text-[10px] text-slate-400">{row.employeeEmail} ({row.employeeRole})</div>
                      </td>
                      <td className="py-4 px-5 text-center font-bold text-slate-700">{row.totalAssigned}</td>
                      <td className="py-4 px-5 text-center font-bold text-emerald-600">{row.totalCompleted}</td>
                      <td className="py-4 px-5 text-center font-bold text-amber-500">{row.totalPending}</td>
                      <td className="py-4 px-5 text-center font-bold text-red-500">{row.totalLate}</td>
                      <td className="py-4 px-5 text-center">
                        <div className="inline-flex items-center gap-2">
                          <div className="w-16 bg-slate-100 rounded-full h-2 overflow-hidden">
                            <div className="bg-emerald-500 h-2 rounded-full" style={{ width: `${row.completionRate}%` }} />
                          </div>
                          <span className="font-extrabold text-slate-700">{row.completionRate}%</span>
                        </div>
                      </td>
                      <td className="py-4 px-5 text-right">
                        <button
                          onClick={() => toggleRow(row.employeeId)}
                          className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold transition-all"
                        >
                          {expandedRows[row.employeeId] ? 'Hide Tasks' : `View Tasks (${row.tasks.length})`}
                        </button>
                      </td>
                    </tr>

                    {expandedRows[row.employeeId] && (
                      <tr>
                        <td colSpan="7" className="bg-slate-50/50 p-4 border-t border-b border-slate-100">
                          <div className="space-y-2 max-w-4xl mx-auto">
                            <h5 className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                              Task Breakdown for {row.employeeName}
                            </h5>
                            {row.tasks.length === 0 ? (
                              <p className="text-xs text-slate-400 italic">No tasks assigned in this timeframe.</p>
                            ) : (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {row.tasks.map((task) => (
                                  <div key={task._id} className="p-3 bg-white border border-slate-200/80 rounded-xl flex items-center justify-between text-xs shadow-2xs">
                                    <div className="min-w-0 pr-2">
                                      <span className="font-bold text-slate-800 block truncate">{task.title}</span>
                                      <span className="text-[10px] text-slate-400 block truncate">Client: {task.clientName || 'N/A'}</span>
                                    </div>
                                    <span
                                      className={`text-[9px] font-extrabold uppercase px-2 py-0.5 rounded-full shrink-0 border ${
                                        task.status === 'Completed'
                                          ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                                          : task.status === 'Late'
                                          ? 'bg-red-50 text-red-600 border-red-200'
                                          : 'bg-amber-50 text-amber-600 border-amber-200'
                                      }`}
                                    >
                                      {task.status}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section: Client Analytics Summary */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
        <div className="mb-6">
          <h2 className="text-lg font-extrabold text-slate-800">Client Analytics Summary</h2>
          <p className="text-xs text-slate-500 mt-0.5">Overview of emails received vs tasks generated per client.</p>
        </div>

        {clientStatsLoading ? (
          <div className="h-32 bg-slate-50 border border-slate-100 rounded-2xl flex items-center justify-center skeleton-shimmer">
            <span className="text-xs text-slate-400 font-medium">Loading client statistics...</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {clientStats.map((client) => (
              <div key={client._id} className="p-4 bg-slate-50/50 border border-slate-200/80 rounded-2xl space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 text-sm">{client.name}</h4>
                  <span className="text-[10px] font-extrabold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full border border-indigo-100">
                    {client.emailCount} Mails
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-white p-2.5 rounded-xl border border-slate-100 text-center">
                    <span className="text-[10px] text-slate-400 block font-semibold uppercase">Total Tasks</span>
                    <span className="font-black text-slate-800 text-base">{client.taskCount}</span>
                  </div>
                  <div className="bg-white p-2.5 rounded-xl border border-slate-100 text-center">
                    <span className="text-[10px] text-emerald-500 block font-semibold uppercase">Completed</span>
                    <span className="font-black text-emerald-600 text-base">{client.completedTaskCount}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
};

export default Reports;
