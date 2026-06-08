import React, { useState, useEffect } from 'react';
import api from '../../api/axios';

const Reports = () => {
  // Stats & Timeline states
  const [overallStats, setOverallStats] = useState(null);
  const [timelineData, setTimelineData] = useState([]);
  const [statsLoading, setStatsLoading] = useState(true);

  // Performance Report states
  const [employees, setEmployees] = useState([]);
  const [filterType, setFilterType] = useState('monthly'); // 'weekly' or 'monthly'
  const [selectedUserId, setSelectedUserId] = useState('');
  const [reportData, setReportData] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState({}); // employeeId -> boolean

  // Interactive SVG chart state
  const [hoveredPoint, setHoveredPoint] = useState(null);

  // Error/Success alert state
  const [alert, setAlert] = useState({ type: '', message: '' });

  useEffect(() => {
    fetchOverallStats();
    fetchTimeline();
    fetchEmployeesList();
    generateReport('monthly', '');
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
    } catch (err) {
      console.error('Error fetching overall stats:', err);
      triggerAlert('error', 'Failed to retrieve system stats.');
    }
  };

  const fetchTimeline = async () => {
    try {
      const response = await api.get('/reports/timeline');
      setTimelineData(response.data);
    } catch (err) {
      console.error('Error fetching task timeline:', err);
      triggerAlert('error', 'Failed to load task timeline data.');
    } finally {
      setStatsLoading(false);
    }
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
      // Reset expanded rows on new query
      setExpandedRows({});
    } catch (err) {
      console.error('Error generating employee report:', err);
      triggerAlert('error', 'Failed to generate employee report.');
    } finally {
      setReportLoading(false);
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

  // Convert current report data to an Excel-readable file and trigger browser download
  const handleExportCSV = () => {
    if (reportData.length === 0) {
      triggerAlert('error', 'No report data available to export.');
      return;
    }

    try {
      const escapeHtml = (value) => {
        const stringValue = value === null || value === undefined ? '' : String(value);
        return stringValue
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      };

      const headers = ['Employee Name', 'Email', 'Role', 'Assigned Tasks', 'Completed', 'Pending', 'Late', 'Completion Rate'];
      const rows = reportData.map((emp) => [
        emp.employeeName,
        emp.employeeEmail,
        emp.employeeRole,
        emp.totalAssigned,
        emp.totalCompleted,
        emp.totalPending,
        emp.totalLate,
        `${emp.completionRate}%`
      ]);

      const tableRows = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      const htmlContent = `
        <html>
          <head>
            <meta charset="UTF-8" />
          </head>
          <body>
            <table border="1">
              <thead>
                <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </body>
        </html>
      `;
      const blob = new Blob([htmlContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `performance_report_${filterType}_${new Date().toISOString().slice(0, 10)}.xls`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      triggerAlert('success', 'Excel report successfully exported.');
    } catch (err) {
      console.error('Error exporting CSV:', err);
      triggerAlert('error', 'Excel export failed.');
    }
  };

  // SVG Chart layout helper variables
  const svgWidth = 800;
  const svgHeight = 260;
  const padding = { top: 20, right: 30, bottom: 40, left: 45 };
  const chartWidth = svgWidth - padding.left - padding.right;
  const chartHeight = svgHeight - padding.top - padding.bottom;

  // Find max count from timeline data
  const maxTimelineCount = timelineData.length > 0 ? Math.max(...timelineData.map((d) => d.count), 4) : 4;
  const roundedMaxY = Math.ceil(maxTimelineCount / 4) * 4; // Round up for 4 neat divisions

  // Compute points coordinate details
  const points = timelineData.map((d, index) => {
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

  const pathD = getBezierPath(points);
  const areaD = points.length > 0 ? `${pathD} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z` : '';

  // Calculate gridlines
  const yTicks = [0, roundedMaxY * 0.25, roundedMaxY * 0.5, roundedMaxY * 0.75, roundedMaxY];

  // Helper date formatter
  const formatHeaderDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <>
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative animate-fade-in select-none">
        {/* Floating alerts */}
        {alert.message && (
          <div
            className={`fixed top-20 right-4 z-50 p-4 rounded-xl border flex items-start space-x-3 shadow-2xl transition-all duration-300 max-w-md animate-slide-in ${
              alert.type === 'success'
                ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
                : 'bg-red-50 border-red-100 text-red-550'
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

        <div className="mb-8">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-800">Reports & Analytics</h1>
          <p className="mt-1 text-sm text-slate-500">
            System performance dashboard, employee completion logs, and task creation timelines.
          </p>
        </div>

        {/* Section 1: Overall Stats Cards */}
        {statsLoading && !overallStats ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6 mb-8">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-white border border-slate-200 p-6 rounded-2xl h-28 skeleton-shimmer" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6 mb-8">
            {/* Total Users */}
            <div className="bg-white border border-slate-200 p-6 rounded-2xl flex flex-col justify-between shadow-sm hover-glow-card transition-all duration-300">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Users</span>
              <span className="text-3xl font-extrabold text-slate-800 mt-2">{overallStats?.totalUsers || 0}</span>
            </div>

            {/* Total Emails */}
            <div className="bg-white border border-slate-200 p-6 rounded-2xl flex flex-col justify-between shadow-sm hover-glow-card transition-all duration-300">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Emails</span>
              <span className="text-3xl font-extrabold text-indigo-600 mt-2">{overallStats?.totalEmails || 0}</span>
            </div>

            {/* Total Tasks */}
            <div className="bg-white border border-slate-200 p-6 rounded-2xl flex flex-col justify-between shadow-sm hover-glow-card transition-all duration-300">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Tasks</span>
              <span className="text-3xl font-extrabold text-purple-600 mt-2">{overallStats?.totalTasks || 0}</span>
            </div>

            {/* Pending (Yellow) */}
            <div className="bg-white border border-slate-200 p-6 rounded-2xl flex flex-col justify-between shadow-sm hover-glow-card transition-all duration-300">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Pending</span>
              <span className="text-3xl font-extrabold text-amber-500 mt-2">{overallStats?.totalPending || 0}</span>
            </div>

            {/* Completed (Green) */}
            <div className="bg-white border border-slate-200 p-6 rounded-2xl flex flex-col justify-between shadow-sm hover-glow-card transition-all duration-300">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Completed</span>
              <span className="text-3xl font-extrabold text-emerald-500 mt-2">{overallStats?.totalCompleted || 0}</span>
            </div>

            {/* Late (Red) */}
            <div className="bg-white border border-slate-200 p-6 rounded-2xl flex flex-col justify-between shadow-sm hover-glow-card transition-all duration-300">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Late</span>
              <span className="text-3xl font-extrabold text-red-500 mt-2">{overallStats?.totalLate || 0}</span>
            </div>
          </div>
        )}

        {/* Section 2: Task Timeline Chart */}
        <div className="bg-white border border-slate-200 rounded-3xl p-6 mb-8 shadow-sm hover-glow-card transition-all duration-300 relative">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-slate-800">Tasks Created (Last 30 Days)</h2>
            <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Timeline Chart</span>
          </div>

          {statsLoading ? (
            <div className="flex flex-col items-center justify-center h-64 space-y-4">
              <svg className="animate-spin h-8 w-8 text-indigo-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-slate-400">Calculating coordinate metrics...</span>
            </div>
          ) : timelineData.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-slate-400 italic text-sm">
              No tasks created in the last 30 days.
            </div>
          ) : (
            <div className="relative">
              {/* Interactive Tooltip Overlay */}
              {hoveredPoint && (
                <div
                  className="absolute bg-white border border-slate-200 text-slate-800 text-[11px] font-semibold py-1.5 px-2.5 rounded-lg shadow-xl pointer-events-none z-10 transition-all duration-100 flex flex-col space-y-0.5"
                  style={{
                    left: `${(hoveredPoint.x / svgWidth) * 100}%`,
                    top: `${(hoveredPoint.y / svgHeight) * 100 - 18}%`,
                    transform: 'translate(-50%, -100%)'
                  }}
                >
                  <span className="text-slate-400 text-[10px] font-medium">{hoveredPoint.date}</span>
                  <span className="text-indigo-600 text-xs font-bold">{hoveredPoint.count} {hoveredPoint.count === 1 ? 'task' : 'tasks'}</span>
                </div>
              )}

              {/* Pure SVG Line Chart */}
              <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto text-slate-400 overflow-visible">
                <defs>
                  {/* Linear Gradient for Path Fill Area */}
                  <linearGradient id="chartAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366f1" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity="0.00" />
                  </linearGradient>
                </defs>

                {/* Y-Axis Gridlines & Labels */}
                {yTicks.map((tick, index) => {
                  const y = padding.top + chartHeight - (tick / roundedMaxY) * chartHeight;
                  return (
                    <g key={index} className="opacity-60">
                      <line
                        x1={padding.left}
                        y1={y}
                        x2={padding.left + chartWidth}
                        y2={y}
                        stroke="#F1F5F9"
                        strokeDasharray="4 4"
                        strokeWidth="1"
                      />
                      <text
                        x={padding.left - 10}
                        y={y + 4}
                        textAnchor="end"
                        className="fill-slate-400 text-[10px] font-semibold font-mono"
                      >
                        {tick}
                      </text>
                    </g>
                  );
                })}

                {/* X-Axis Date Ticks (every 5 days to avoid crowding) */}
                {points.map((p, index) => {
                  if (index % 5 !== 0 && index !== points.length - 1) return null;
                  return (
                    <g key={index} className="opacity-60">
                      <line
                        x1={p.x}
                        y1={padding.top}
                        x2={p.x}
                        y2={padding.top + chartHeight}
                        stroke="#F8FAFC"
                        strokeWidth="1"
                      />
                      <text
                        x={p.x}
                        y={padding.top + chartHeight + 18}
                        textAnchor="middle"
                        className="fill-slate-400 text-[9px] font-semibold"
                      >
                        {formatHeaderDate(p.date)}
                      </text>
                    </g>
                  );
                })}

                {/* Gradient Area Path */}
                {areaD && <path d={areaD} fill="url(#chartAreaGradient)" />}

                {/* Bold Line Path */}
                {pathD && (
                  <path
                    d={pathD}
                    fill="none"
                    stroke="#6366f1"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="svg-chart-path drop-shadow-[0_2px_8px_rgba(99,102,241,0.15)]"
                  />
                )}

                {/* Interactive Points Nodes */}
                {points.map((p, index) => (
                  <g key={index}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r="4"
                      className="fill-white stroke-indigo-500 stroke-[2] cursor-pointer hover:r-6 hover:stroke-[3] hover:fill-indigo-500 transition-all duration-100"
                      onMouseEnter={() => setHoveredPoint(p)}
                      onMouseLeave={() => setHoveredPoint(null)}
                    />
                  </g>
                ))}
              </svg>
            </div>
          )}
        </div>

        {/* Section 3 & 4: Performance Table with Filters & CSV Export */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm hover-glow-card transition-all duration-300">
          {/* Header & Filter Controls */}
          <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/50 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-805">Employee Performance</h2>
              <p className="text-xs text-slate-500 mt-0.5">Evaluate task throughput and completions.</p>
            </div>

            <form onSubmit={handleGenerate} className="flex flex-wrap items-center gap-3">
              {/* Range Filter */}
              <div className="flex flex-col">
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-705 focus:outline-none focus:ring-2 focus:ring-indigo-150 transition-all"
                >
                  <option value="weekly">Weekly Range (7 Days)</option>
                  <option value="monthly">Monthly Range (30 Days)</option>
                </select>
              </div>

              {/* Employee Filter */}
              <div className="flex flex-col">
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-705 focus:outline-none focus:ring-2 focus:ring-indigo-150 transition-all max-w-[180px]"
                >
                  <option value="">All Employees</option>
                  {employees.map((emp) => (
                    <option key={emp._id} value={emp._id}>
                      {emp.name} ({emp.role})
                    </option>
                  ))}
                </select>
              </div>

              {/* Generate Button */}
              <button
                type="submit"
                disabled={reportLoading}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-xl text-xs font-bold text-white shadow-md transition-all active:scale-95 flex items-center justify-center space-x-1"
              >
                <span>Generate</span>
              </button>

              {/* CSV Export Button */}
              <button
                type="button"
                onClick={handleExportCSV}
                className="px-4 py-2 bg-white border-2 border-indigo-600 rounded-xl text-xs font-bold text-indigo-650 hover:bg-indigo-50 transition-all active:scale-95 flex items-center justify-center space-x-1"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Export CSV</span>
              </button>
            </form>
          </div>

          {/* Table Container */}
          {reportLoading ? (
            <div className="flex flex-col items-center justify-center py-24 space-y-4">
              <svg className="animate-spin h-8 w-8 text-indigo-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-xs text-slate-400">Querying database reports...</span>
            </div>
          ) : reportData.length === 0 ? (
            <div className="text-center py-20">
              <span className="text-slate-400 italic text-sm">No report rows found for the selected filter.</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50/50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th scope="col" className="px-6 py-4">Employee</th>
                    <th scope="col" className="px-6 py-4">Role</th>
                    <th scope="col" className="px-6 py-4 text-center">Assigned</th>
                    <th scope="col" className="px-6 py-4 text-center">Completed</th>
                    <th scope="col" className="px-6 py-4 text-center">Pending</th>
                    <th scope="col" className="px-6 py-4 text-center">Late</th>
                    <th scope="col" className="px-6 py-4">Completion Rate</th>
                    <th scope="col" className="relative px-6 py-4">
                      <span className="sr-only">Toggle</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white text-sm">
                  {reportData.map((emp) => {
                    const isExpanded = !!expandedRows[emp.employeeId];
                    
                    // Completion rate color selection
                    let barColor = 'bg-red-500';
                    let textColor = 'text-red-500';
                    if (emp.completionRate >= 80) {
                      barColor = 'bg-emerald-500';
                      textColor = 'text-emerald-600';
                    } else if (emp.completionRate >= 50) {
                      barColor = 'bg-amber-500';
                      textColor = 'text-amber-600';
                    }
 
                    return (
                      <React.Fragment key={emp.employeeId}>
                        {/* Summary Employee Row */}
                        <tr
                          onClick={() => toggleRow(emp.employeeId)}
                          className="hover:bg-slate-50 cursor-pointer transition-colors duration-150"
                        >
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="font-bold text-slate-800">{emp.employeeName}</span>
                              <span className="text-xs text-slate-400 font-mono">{emp.employeeEmail}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-slate-600">
                            <span className="text-xs bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg font-medium">
                              {emp.employeeRole}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center font-mono font-bold text-slate-800">
                            {emp.totalAssigned}
                          </td>
                          <td className="px-6 py-4 text-center font-mono font-bold text-emerald-600">
                            {emp.totalCompleted}
                          </td>
                          <td className="px-6 py-4 text-center font-mono font-bold text-amber-500">
                            {emp.totalPending}
                          </td>
                          <td className="px-6 py-4 text-center font-mono font-bold text-red-500">
                            {emp.totalLate}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap min-w-[200px]">
                            <div className="flex items-center space-x-3">
                              {/* Colored Progress Bar */}
                              <div className="w-24 bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
                                  style={{ width: `${emp.completionRate}%` }}
                                />
                              </div>
                              <span className={`text-xs font-bold font-mono ${textColor}`}>
                                {emp.completionRate}%
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right whitespace-nowrap text-slate-400">
                            <svg
                              className={`h-5 w-5 transform transition-transform duration-200 ${isExpanded ? 'rotate-180 text-slate-600' : ''}`}
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                            </svg>
                          </td>
                        </tr>

                        {/* Expandable Task Detail Row */}
                        {isExpanded && (
                          <tr>
                            <td colSpan={8} className="bg-slate-50/50 px-8 py-5 border-y border-slate-200">
                              <div className="space-y-3">
                                <h4 className="text-xs font-bold text-indigo-650 uppercase tracking-wider">
                                  Task Assignments for {emp.employeeName} ({filterType})
                                </h4>

                                {emp.tasks.length === 0 ? (
                                  <div className="text-xs text-slate-400 italic py-2">
                                    No tasks registered in this date range.
                                  </div>
                                ) : (
                                  <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white shadow-sm">
                                    <table className="min-w-full text-xs">
                                      <thead className="bg-slate-50/80 border-b border-slate-200 text-slate-500 text-left">
                                        <tr>
                                          <th className="px-4 py-3 font-bold">Task Title</th>
                                          <th className="px-4 py-3 font-bold">Client</th>
                                          <th className="px-4 py-3 font-bold">Deadline</th>
                                          <th className="px-4 py-3 font-bold">Status</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100 text-slate-600">
                                        {emp.tasks.map((task) => (
                                          <tr key={task._id} className="hover:bg-slate-50/40">
                                            <td className="px-4 py-2.5 font-semibold text-slate-800">{task.title}</td>
                                            <td className="px-4 py-2.5">{task.clientName || 'N/A'}</td>
                                            <td className="px-4 py-2.5">
                                              {task.deadline ? new Date(task.deadline).toLocaleString() : 'N/A'}
                                            </td>
                                            <td className="px-4 py-2.5">
                                              <span className={`inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                                                task.status === 'Completed'
                                                  ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
                                                  : task.status === 'Late'
                                                  ? 'bg-red-50 border-red-100 text-red-500'
                                                  : 'bg-amber-50 border-amber-100 text-amber-600'
                                              }`}>
                                                {task.status}
                                              </span>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
};

export default Reports;
