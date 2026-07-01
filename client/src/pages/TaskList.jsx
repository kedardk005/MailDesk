import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import api from '../api/axios';

const getPriorityStyle = (priority) => {
  const styles = {
    Low:    { background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' },
    Medium: { background: '#fefce8', color: '#854d0e', border: '1px solid #fde68a' },
    High:   { background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' },
    Urgent: { background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' },
  };
  return styles[priority] || styles['Medium'];
};

const renderEmailContent = (body) => {
  if (!body) return '<html><body><span style="font-family: sans-serif; font-size: 13px; color: #94a3b8; font-style: italic;">This email has no text content.</span></body></html>';
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  const styledBody = isHtml 
    ? body 
    : `<div style="white-space: pre-wrap; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #334155;">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
  return `<html><head><style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #334155; margin: 12px; word-break: break-word; } img { max-width: 100%; height: auto; display: block; margin: 8px 0; }</style></head><body>${styledBody}</body></html>`;
};

const TaskList = () => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [creatorFilter, setCreatorFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [priorityFilter, setPriorityFilter] = useState('All');
  const [expandedTaskId, setExpandedTaskId] = useState(null);



  // Comment state variables
  const [commentMap, setCommentMap] = useState({}); // { taskId: Comment[] }
  const [commentLoadingId, setCommentLoadingId] = useState(null);
  const [commentInput, setCommentInput] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  // View mode & Calendar states
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'kanban' | 'calendar'
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);
  const [currentDate, setCurrentDate] = useState(new Date());

  // Dropdown options data
  const [clients, setClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [unassignedEmails, setUnassignedEmails] = useState([]);

  // Modals state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);

  // Form states for Create Task
  const [newTask, setNewTask] = useState({
    title: '',
    description: '',
    clientName: '',
    assignedTo: '',
    linkedEmail: '',
    deadline: '',
    notes: '',
    priority: 'Medium',
    isRecurring: false,
    recurrence: 'Weekly'
  });

  // Client search suggestions states (Create Task)
  const [clientSearchQuery, setClientSearchQuery] = useState('');
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const clientSuggestionsRef = useRef(null);

  // Form states for Edit Task
  const [selectedTask, setSelectedTask] = useState(null);
  const [editForm, setEditForm] = useState({
    id: '',
    title: '',
    description: '',
    clientName: '',
    assignedTo: '',
    deadline: '',
    notes: '',
    status: 'Pending',
    priority: 'Medium',
    isRecurring: false,
    recurrence: 'Weekly'
  });

  // Client search suggestions states (Edit Task)
  const [editClientSearchQuery, setEditClientSearchQuery] = useState('');
  const [showEditClientSuggestions, setShowEditClientSuggestions] = useState(false);
  const editClientSuggestionsRef = useRef(null);

  // Current logged in user context
  const [currentUser, setCurrentUser] = useState({ name: 'Guest', role: 'Employee' });

  const navigate = useNavigate();
  const location = useLocation();

  // Load current user and fetch tasks on mount
  useEffect(() => {
    const userString = localStorage.getItem('user');
    if (userString) {
      try {
        setCurrentUser(JSON.parse(userString));
      } catch (err) {
        console.error('Error parsing current user details:', err);
      }
    }
    fetchTasks();
    fetchDropdownData();
  }, []);

  // Check for notification redirect with expandTaskId to expand task and fetch comments
  useEffect(() => {
    if (loading || tasks.length === 0) return;
    const params = new URLSearchParams(location.search);
    const expandId = params.get('expandTaskId');
    if (expandId) {
      setExpandedTaskId(expandId);
      if (!commentMap[expandId]) {
        loadComments(expandId);
      }
      // Clear URL parameter using react-router navigation replace
      navigate('/tasks', { replace: true });
    }
  }, [location.search, tasks, loading]);

  // Check for linking parameters from Email Inbox page to pre-fill Create Task form
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const linkEmail = params.get('linkEmail');
    const title = params.get('title');
    const clientName = params.get('clientName');

    if (linkEmail) {
      setNewTask(prev => ({
        ...prev,
        linkedEmail: linkEmail,
        title: title || '',
        clientName: clientName || ''
      }));
      if (clientName) {
        setClientSearchQuery(clientName);
      }
      setIsCreateOpen(true);
      // Clean up URL parameters using react-router navigation replace
      navigate('/tasks', { replace: true });
    }
  }, [tasks]);

  // Handle outside clicks to close client dropdown suggestions
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (clientSuggestionsRef.current && !clientSuggestionsRef.current.contains(event.target)) {
        setShowClientSuggestions(false);
      }
      if (editClientSuggestionsRef.current && !editClientSuggestionsRef.current.contains(event.target)) {
        setShowEditClientSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4500);
  };

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const response = await api.get('/tasks');
      setTasks(response.data);
    } catch (err) {
      console.error('Error loading task list:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to retrieve task records.');
    } finally {
      setLoading(false);
    }
  };

  const fetchDropdownData = async () => {
    try {
      // 1. Fetch Clients
      const clientsRes = await api.get('/tasks/clients');
      setClients(clientsRes.data);

      // 2. Fetch Users (only if role is Admin or Head)
      const userString = localStorage.getItem('user');
      if (userString) {
        const parsed = JSON.parse(userString);
        if (parsed.role === 'Admin' || parsed.role === 'Head') {
          const usersRes = await api.get('/users');
          // Filter to show only Heads and Employees for assignment list
          const assignable = usersRes.data.filter(u => u.role === 'Head' || u.role === 'Employee');
          setUsers(assignable);

          // 3. Fetch unassigned emails (excluding spam)
          const emailsRes = await api.get('/gmail/emails');
          const unassigned = emailsRes.data.filter(e => e.status === 'unassigned' && !e.labelIds?.includes('SPAM'));
          setUnassignedEmails(unassigned);
        }
      }
    } catch (err) {
      console.error('Error fetching dropdown resource feeds:', err);
    }
  };

  const handleCreateTask = async (e) => {
    e.preventDefault();

    // Validate required fields
    if (!newTask.title || !newTask.clientName || !newTask.assignedTo || !newTask.deadline) {
      triggerAlert('error', 'Title, Client Name, Assignee, and Deadline are required fields.');
      return;
    }

    // Validate deadline is in the future
    const selectedDeadline = new Date(newTask.deadline);
    if (selectedDeadline <= new Date()) {
      triggerAlert('error', 'Deadline must be a date and time in the future.');
      return;
    }

    setActionLoading(true);
    try {
      await api.post('/tasks', {
        title: newTask.title,
        description: newTask.description,
        clientName: newTask.clientName,
        assignedTo: newTask.assignedTo,
        linkedEmail: newTask.linkedEmail || undefined,
        deadline: newTask.deadline,
        notes: newTask.notes,
        priority: newTask.priority,
        isRecurring: newTask.isRecurring,
        recurrence: newTask.recurrence
      });

      triggerAlert('success', `Task '${newTask.title}' successfully initialized.`);
      setIsCreateOpen(false);
      setNewTask({
        title: '',
        description: '',
        clientName: '',
        assignedTo: '',
        linkedEmail: '',
        deadline: '',
        notes: '',
        priority: 'Medium',
        isRecurring: false,
        recurrence: 'Weekly'
      });
      setClientSearchQuery('');
      fetchTasks();
      fetchDropdownData(); // Refresh unassigned email list
    } catch (err) {
      console.error('Error saving new task:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to register new task.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditTask = async (e) => {
    e.preventDefault();

    // Validate fields
    if (!editForm.title || !editForm.clientName || !editForm.assignedTo || !editForm.deadline) {
      triggerAlert('error', 'Title, Client, Assignee, and Deadline are required.');
      return;
    }

    // Validate deadline is in future
    const selectedDeadline = new Date(editForm.deadline);
    if (selectedDeadline <= new Date()) {
      triggerAlert('error', 'Deadline must be in the future.');
      return;
    }

    setActionLoading(true);
    try {
      await api.put(`/tasks/${editForm.id}`, {
        title: editForm.title,
        description: editForm.description,
        clientName: editForm.clientName,
        assignedTo: editForm.assignedTo,
        deadline: editForm.deadline,
        notes: editForm.notes,
        status: editForm.status,
        priority: editForm.priority,
        isRecurring: editForm.isRecurring,
        recurrence: editForm.recurrence
      });

      triggerAlert('success', 'Task records successfully updated.');
      setIsEditOpen(false);
      setSelectedTask(null);
      fetchTasks();
    } catch (err) {
      console.error('Error updating task:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to modify task.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleMarkComplete = async (taskId) => {
    setActionLoading(true);
    try {
      await api.put(`/tasks/${taskId}`, { status: 'Completed' });
      triggerAlert('success', 'Task marked as Completed.');
      fetchTasks();
    } catch (err) {
      console.error('Error setting task status to Completed:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to update task status.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteTask = async (taskId) => {
    if (!window.confirm('Are you sure you want to permanently delete this task?')) return;

    setActionLoading(true);
    try {
      const response = await api.delete(`/tasks/${taskId}`);
      setTasks((prev) => prev.filter((task) => task._id !== taskId));
      setExpandedTaskId((prev) => (prev === taskId ? null : prev));
      triggerAlert('success', response.data?.message || 'Task deleted successfully.');
      await fetchTasks();
      fetchDropdownData(); // Refresh unassigned email list
    } catch (err) {
      console.error('Error deleting task:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to delete task.');
    } finally {
      setActionLoading(false);
    }
  };



  const loadComments = async (taskId) => {
    setCommentLoadingId(taskId);
    try {
      const res = await api.get(`/tasks/${taskId}/comments`);
      setCommentMap(prev => ({ ...prev, [taskId]: res.data }));
    } catch (err) {
      console.error('Failed to load comments:', err);
    } finally {
      setCommentLoadingId(null);
    }
  };

  const handlePostComment = async (taskId) => {
    if (!commentInput.trim()) return;
    setCommentSubmitting(true);
    try {
      const res = await api.post(`/tasks/${taskId}/comments`, { message: commentInput.trim() });
      setCommentMap(prev => ({
        ...prev,
        [taskId]: [...(prev[taskId] || []), res.data]
      }));
      setCommentInput('');
    } catch (err) {
      triggerAlert('error', err.response?.data?.message || 'Failed to post comment.');
    } finally {
      setCommentSubmitting(false);
    }
  };

  const handleDeleteComment = async (taskId, commentId) => {
    try {
      await api.delete(`/tasks/${taskId}/comments/${commentId}`);
      setCommentMap(prev => ({
        ...prev,
        [taskId]: (prev[taskId] || []).filter(c => c._id !== commentId)
      }));
    } catch (err) {
      triggerAlert('error', 'Failed to delete comment.');
    }
  };

  const handleDownloadAttachment = async (emailId, attachmentId, filename) => {
    try {
      const response = await api.get(`/gmail/emails/${emailId}/attachments/${attachmentId}`, {
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
    } catch (err) {
      console.error('Failed to download attachment:', err);
      triggerAlert('error', 'Failed to download attachment.');
    }
  };

  const openEditModal = (task) => {
    setSelectedTask(task);
    setEditForm({
      id: task._id,
      title: task.title,
      description: task.description || '',
      clientName: task.clientName,
      assignedTo: task.assignedTo?._id || '',
      deadline: task.deadline ? new Date(task.deadline).toISOString().slice(0, 16) : '',
      notes: task.notes || '',
      status: task.status,
      priority: task.priority || 'Medium',
      isRecurring: task.isRecurring || false,
      recurrence: task.recurrence || 'Weekly'
    });
    setEditClientSearchQuery(task.clientName);
    setIsEditOpen(true);
  };

  // Calendar logic helpers
  const getDaysInMonth = (date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const prevMonthTotalDays = new Date(year, month, 0).getDate();
    
    const days = [];
    
    // Padding from previous month
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      days.push({
        day: prevMonthTotalDays - i,
        month: month === 0 ? 11 : month - 1,
        year: month === 0 ? year - 1 : year,
        isCurrentMonth: false
      });
    }
    
    // Current month days
    for (let i = 1; i <= totalDays; i++) {
      days.push({
        day: i,
        month,
        year,
        isCurrentMonth: true
      });
    }
    
    // Padding for next month to fill 42 cells (6 rows)
    const remainingCells = 42 - days.length;
    for (let i = 1; i <= remainingCells; i++) {
      days.push({
        day: i,
        month: month === 11 ? 0 : month + 1,
        year: month === 11 ? year + 1 : year,
        isCurrentMonth: false
      });
    }
    
    return days;
  };

  const isSameDay = (taskDateStr, year, month, day) => {
    if (!taskDateStr) return false;
    const taskDate = new Date(taskDateStr);
    return (
      taskDate.getFullYear() === year &&
      taskDate.getMonth() === month &&
      taskDate.getDate() === day
    );
  };

  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const handleGoToday = () => {
    setCurrentDate(new Date());
  };

  // Date formatter helper
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

  // Filter clients list according to search query input
  const filteredClients = clients.filter(c => 
    c.name.toLowerCase().includes(clientSearchQuery.toLowerCase())
  );

  const filteredEditClients = clients.filter(c => 
    c.name.toLowerCase().includes(editClientSearchQuery.toLowerCase())
  );

  // Get distinct list of creators for Admin/Head creator filter
  const taskCreators = Array.from(
    new Map(
      tasks
        .filter(t => t.createdBy)
        .map(t => [t.createdBy._id, t.createdBy])
    ).values()
  );

  // Apply creator, status, and priority filters
  const filteredTasks = tasks.filter(task => {
    if (creatorFilter && task.createdBy?._id !== creatorFilter) {
      return false;
    }
    if (statusFilter !== 'All' && task.status !== statusFilter) {
      return false;
    }
    if (priorityFilter !== 'All' && (task.priority || 'Medium') !== priorityFilter) {
      return false;
    }
    return true;
  });

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const getDeadlineInfo = (deadlineString) => {
    if (!deadlineString) return { text: 'No Deadline', badgeClass: 'bg-slate-100 text-slate-500 border border-slate-200' };
    const deadline = new Date(deadlineString);
    const now = new Date();
    const diffMs = deadline - now;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (diffMs < 0) {
      return { text: 'Overdue', badgeClass: 'bg-red-50 border border-red-150 text-red-650' };
    } else if (diffDays < 2) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const text = hours > 24 ? `1 day left` : `${hours}h left`;
      return { text, badgeClass: 'bg-amber-50 border border-amber-150 text-amber-600' };
    } else {
      const text = `${Math.floor(diffDays)} days left`;
      return { text, badgeClass: 'bg-emerald-50 border border-emerald-150 text-emerald-600' };
    }
  };

  const getStatusBorder = (status) => {
    switch (status) {
      case 'Completed': return 'border-l-4 border-l-emerald-500';
      case 'Late': return 'border-l-4 border-l-red-500';
      case 'Pending': return 'border-l-4 border-l-amber-500';
      default: return 'border-l-4 border-l-slate-400';
    }
  };

  const toggleExpand = (id) => {
    setExpandedTaskId(expandedTaskId === id ? null : id);
    if (id !== expandedTaskId && !commentMap[id]) {
      loadComments(id);
    }
  };

  const canDragTask = (task) => {
    if (currentUser.role === 'Admin' || currentUser.role === 'Head') return true;
    const assigneeId = task.assignedTo?._id || task.assignedTo;
    return assigneeId === currentUser._id;
  };

  const canDropInColumn = (task, targetStatus) => {
    if (currentUser.role === 'Admin' || currentUser.role === 'Head') return true;
    return targetStatus === 'Completed';
  };

  const handleDragStart = (e, task) => {
    if (!canDragTask(task)) { e.preventDefault(); return; }
    setDraggedTaskId(task._id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggedTaskId(null);
    setDragOverColumn(null);
  };

  const handleColumnDragOver = (e, columnStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverColumn !== columnStatus) setDragOverColumn(columnStatus);
  };

  const handleColumnDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDragOverColumn(null);
    const task = filteredTasks.find(t => t._id === draggedTaskId);
    setDraggedTaskId(null);
    if (!task || task.status === targetStatus) return;

    if (!canDropInColumn(task, targetStatus)) {
      triggerAlert ? triggerAlert('error', 'You can only move your own tasks to Completed.') : alert('You can only move your own tasks to Completed.');
      return;
    }

    const prevTasks = tasks;
    setTasks(prevTasks.map(t => t._id === task._id ? { ...t, status: targetStatus } : t));

    try {
      await api.put(`/tasks/${task._id}`, { status: targetStatus });
    } catch (err) {
      setTasks(prevTasks); // revert on failure
      triggerAlert ? triggerAlert('error', err.response?.data?.message || 'Failed to update status.') : alert('Failed to update status.');
    }
  };

  return (
    <>
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative animate-fade-in select-none">
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

        <div className="sm:flex sm:items-center sm:justify-between mb-8 gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-800">Tasks</h1>
            <p className="mt-1 text-sm text-slate-550">
              {currentUser?.role === 'Employee'
                ? 'Displaying task records assigned directly to you.'
                : 'Monitor, assign, update, and manage workspace operations tasks.'}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 mt-4 sm:mt-0 items-start sm:items-center">
            {currentUser.role !== 'Employee' && taskCreators.length > 0 && (
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Creator:</span>
                <select
                  value={creatorFilter}
                  onChange={(e) => {
                    setCreatorFilter(e.target.value);
                    setSelectedTaskIds(new Set());
                    setSelectAll(false);
                  }}
                  className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-550 transition-all cursor-pointer"
                >
                  <option value="">All Creators</option>
                  {taskCreators.map((creator) => (
                    <option key={creator._id} value={creator._id}>
                      {creator.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center space-x-2">
              <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Priority:</span>
              <select
                value={priorityFilter}
                onChange={e => {
                  setPriorityFilter(e.target.value);
                  setSelectedTaskIds(new Set());
                  setSelectAll(false);
                }}
                style={{ padding: '7px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer' }}
                className="text-xs font-semibold text-slate-700"
              >
                <option value="All">All priorities</option>
                <option value="Urgent">Urgent</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>
            {(currentUser?.role === 'Admin' || currentUser?.role === 'Head') && (
              <button
                onClick={() => setIsCreateOpen(true)}
                className="px-5 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-xs font-bold text-white shadow-md shadow-indigo-600/10 transition-all duration-200 flex items-center space-x-2 active:scale-[0.98] select-none"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                <span>Create Task</span>
              </button>
            )}
          </div>
        </div>

        {/* View mode toggle & Filter tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="flex flex-wrap gap-2">
            {['All', 'Pending', 'Completed', 'Late'].map((filter) => (
              <button
                key={filter}
                onClick={() => {
                  setStatusFilter(filter);
                  setSelectedTaskIds(new Set());
                  setSelectAll(false);
                }}
                className={`px-4 py-2 text-xs font-bold rounded-full border transition-all ${
                  statusFilter === filter
                    ? 'bg-gradient-to-r from-indigo-600 to-purple-600 border-transparent text-white shadow-md shadow-indigo-600/10'
                    : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-55 hover:text-slate-700'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>

          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200 self-start sm:self-auto">
            <button
              onClick={() => setViewMode('list')}
              className={`px-4 py-2 text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all ${
                viewMode === 'list'
                  ? 'bg-white text-slate-800 shadow-sm border border-slate-200/50'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
              <span>List View</span>
            </button>
            <button
              onClick={() => setViewMode('kanban')}
              className={`px-4 py-2 text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all ${
                viewMode === 'kanban'
                  ? 'bg-white text-slate-800 shadow-sm border border-slate-200/50'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              <span>Kanban</span>
            </button>
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-4 py-2 text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all ${
                viewMode === 'calendar'
                  ? 'bg-white text-slate-800 shadow-sm border border-slate-200/50'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>Calendar View</span>
            </button>
          </div>
        </div>

        {/* Task List Cards / Calendar View */}
        {loading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-white border border-slate-200/80 rounded-2xl p-5 skeleton-shimmer" />
            ))}
          </div>
        ) : viewMode === 'calendar' ? (
          <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm select-none animate-fade-in">
            {/* Calendar Header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-850">
                  {currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}
                </h3>
                <span className="text-xs text-slate-400 font-semibold px-2.5 py-1 bg-slate-50 rounded-full border border-slate-100/80">
                  {filteredTasks.length} {filteredTasks.length === 1 ? 'Task' : 'Tasks'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrevMonth}
                  className="p-2 border border-slate-200 rounded-xl hover:bg-slate-50 active:scale-95 transition-all text-slate-500"
                >
                  <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={handleGoToday}
                  className="px-3.5 py-1.5 border border-slate-200 rounded-xl hover:bg-slate-50 active:scale-95 transition-all text-xs font-bold text-slate-650"
                >
                  Today
                </button>
                <button
                  onClick={handleNextMonth}
                  className="p-2 border border-slate-200 rounded-xl hover:bg-slate-50 active:scale-95 transition-all text-slate-500"
                >
                  <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Week Headers */}
            <div className="grid grid-cols-7 gap-2 mb-2">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div key={day} className="text-center text-[10px] font-bold text-slate-400 uppercase tracking-wider py-2">
                  {day}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-2">
              {getDaysInMonth(currentDate).map(({ day, month, year, isCurrentMonth }, idx) => {
                const dayTasks = filteredTasks.filter((task) => isSameDay(task.deadline, year, month, day));
                const isToday = isSameDay(new Date().toISOString(), year, month, day);

                return (
                  <div
                    key={idx}
                    onClick={() => {
                      if (currentUser.role === 'Admin' || currentUser.role === 'Head') {
                        // Prefill deadline with selected date at 12:00 PM local
                        const pad = (n) => String(n).padStart(2, '0');
                        const dateStr = `${year}-${pad(month + 1)}-${pad(day)}T12:00`;
                        setNewTask({
                          title: '',
                          description: '',
                          clientName: '',
                          assignedTo: '',
                          linkedEmail: '',
                          deadline: dateStr,
                          notes: '',
                          priority: 'Medium'
                        });
                        setClientSearchQuery('');
                        setIsCreateOpen(true);
                      }
                    }}
                    className={`min-h-[110px] p-2 border rounded-2xl flex flex-col justify-between transition-all select-none relative ${
                      isCurrentMonth
                        ? 'bg-white border-slate-100 hover:shadow-md cursor-pointer'
                        : 'bg-slate-50/50 border-slate-100/60 text-slate-400'
                    } ${isToday ? 'ring-2 ring-indigo-650 bg-indigo-50/5 border-transparent' : ''}`}
                  >
                    {/* Day Number Header */}
                    <div className="flex items-center justify-between mb-1.5">
                      <span className={`text-xs font-extrabold ${isToday ? 'text-indigo-600' : isCurrentMonth ? 'text-slate-800' : 'text-slate-400'}`}>
                        {day}
                      </span>
                      {isToday && (
                        <span className="w-1.5 h-1.5 bg-indigo-600 rounded-full" />
                      )}
                    </div>

                    {/* Tasks container */}
                    <div className="flex-grow overflow-y-auto max-h-[70px] space-y-1 pr-1 custom-scrollbar">
                      {dayTasks.map((task) => {
                        let statusColor = 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100/80';
                        if (task.status === 'Completed') {
                          statusColor = 'bg-emerald-50 border-emerald-250 text-emerald-700 hover:bg-emerald-100/80';
                        } else if (task.status === 'Late' || new Date(task.deadline) < new Date()) {
                          statusColor = 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100/80';
                        }

                        return (
                          <div
                            key={task._id}
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(task);
                            }}
                            className={`text-[10px] px-2 py-1 rounded-lg font-bold border truncate hover:scale-[1.02] active:scale-[0.98] transition-all text-left block w-full select-none cursor-pointer ${statusColor}`}
                            title={`${task.title} - ${task.clientName}`}
                          >
                            {task.title}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : viewMode === 'kanban' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {['Pending', 'Completed', 'Late'].map((columnStatus) => {
              const columnTasks = filteredTasks.filter((t) => t.status === columnStatus);
              const columnStyles = {
                Pending:   { header: 'bg-amber-50 border-amber-200 text-amber-700', dot: 'bg-amber-500' },
                Completed: { header: 'bg-emerald-50 border-emerald-200 text-emerald-700', dot: 'bg-emerald-500' },
                Late:      { header: 'bg-red-50 border-red-200 text-red-700', dot: 'bg-red-500' },
              };
              const style = columnStyles[columnStatus];
              const isDragOver = dragOverColumn === columnStatus;

              return (
                <div
                  key={columnStatus}
                  onDragOver={(e) => handleColumnDragOver(e, columnStatus)}
                  onDragLeave={() => setDragOverColumn(null)}
                  onDrop={(e) => handleColumnDrop(e, columnStatus)}
                  className={`rounded-2xl border-2 border-dashed p-3 min-h-[480px] transition-colors ${
                    isDragOver ? 'border-indigo-400 bg-indigo-50/40' : 'border-slate-200 bg-slate-50/60'
                  }`}
                >
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border mb-3 ${style.header}`}>
                    <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                    <span className="text-xs font-bold uppercase tracking-wide">{columnStatus}</span>
                    <span className="ml-auto text-xs font-bold bg-white/70 px-2 py-0.5 rounded-full">
                      {columnTasks.length}
                    </span>
                  </div>

                  <div className="space-y-2.5 max-h-[700px] overflow-y-auto pr-1 custom-scrollbar">
                    {columnTasks.length === 0 && (
                      <p className="text-[11px] text-slate-400 text-center py-10">No tasks</p>
                    )}
                    {columnTasks.map((task) => {
                      const assigneeName = task.assignedTo?.name || 'Unassigned';
                      const draggable = canDragTask(task);

                      return (
                        <div
                          key={task._id}
                          draggable={draggable}
                          onDragStart={(e) => handleDragStart(e, task)}
                          onDragEnd={handleDragEnd}
                          onClick={() => {
                            if (currentUser.role === 'Admin' || currentUser.role === 'Head') {
                              openEditModal(task);
                            }
                          }}
                          className={`bg-white rounded-xl border border-slate-200 p-3 shadow-sm hover:shadow-md transition-all select-none ${
                            draggable
                              ? 'cursor-grab active:cursor-grabbing'
                              : (currentUser.role === 'Admin' || currentUser.role === 'Head')
                              ? 'cursor-pointer'
                              : 'cursor-default'
                          } ${draggedTaskId === task._id ? 'opacity-40' : 'opacity-100'}`}
                        >
                          <p className="text-xs font-bold text-slate-800 mb-1 line-clamp-2">{task.title}</p>
                          <p className="text-[11px] text-slate-500 mb-2">{task.clientName}</p>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                              {assigneeName}
                            </span>
                            <span className="text-[10px] text-slate-400">
                              {new Date(task.deadline).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="text-center py-20 bg-white border border-slate-200/80 rounded-3xl shadow-sm">
            <div className="w-14 h-14 mx-auto bg-slate-50 rounded-2xl flex items-center justify-center mb-4 border border-slate-100">
              <svg className="h-6 w-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2" />
              </svg>
            </div>
            <h3 className="text-md font-bold text-slate-800 mb-1">No Tasks Found</h3>
            <p className="text-xs text-slate-500 max-w-xs mx-auto">
              No active tasks meet your filter criteria. Try changing status or create a new record.
            </p>
          </div>
        ) : (
          <div className="space-y-3.5">


            {filteredTasks.map((task) => {
              const isExpanded = expandedTaskId === task._id;
              const assigneeName = task.assignedTo?.name || 'Unassigned';
              const assigneeInitials = getInitials(assigneeName);
              const deadlineInfo = getDeadlineInfo(task.deadline);
              
              return (
                <div
                  key={task._id}
                  className={`bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm hover-glow-card transition-all duration-300 ${getStatusBorder(task.status)}`}
                >
                  {/* Header Summary click section */}
                  <div
                    onClick={() => toggleExpand(task._id)}
                    className="p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 cursor-pointer select-none"
                  >
                    <div className="flex items-center space-x-3.5 min-w-0">
                      {/* Avatar circle */}
                      <div className="h-9 w-9 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 font-extrabold text-sm shrink-0" title={`Assigned to ${assigneeName}`}>
                        {assigneeInitials}
                      </div>
                      {/* Info */}
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-slate-800 truncate max-w-[240px] sm:max-w-[480px] leading-snug">
                          {task.title}
                        </h4>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-650 border border-indigo-100">
                            {task.clientName}
                          </span>
                          {task.linkedEmail && (
                            <span className="inline-flex items-center text-[10px] text-indigo-550 font-medium">
                              ✉️ Linked Email
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${deadlineInfo.badgeClass}`}>
                        {deadlineInfo.text}
                      </span>
                      <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
                        task.status === 'Completed'
                          ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
                          : task.status === 'Late'
                          ? 'bg-red-50 border-red-100 text-red-650'
                          : 'bg-amber-50 border-amber-100 text-amber-600'
                      }`}>
                        {task.status}
                      </span>
                      {task.isRecurring && task.recurrence && (
                        <span style={{
                          fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '20px',
                          background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0',
                          display: 'inline-flex', alignItems: 'center'
                        }}>
                          🔁 {task.recurrence}
                        </span>
                      )}
                      <span style={{
                        fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px',
                        ...getPriorityStyle(task.priority)
                      }}>
                        {task.priority || 'Medium'}
                      </span>
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
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                        <div className="space-y-2">
                          <p className="text-slate-500 font-semibold uppercase tracking-wider text-[10px]">Description</p>
                          <div className="bg-white border border-slate-200 rounded-xl p-4 text-slate-700 leading-relaxed whitespace-pre-wrap select-text">
                            {task.description ? task.description : <span className="italic text-slate-400">No description provided.</span>}
                          </div>
                        </div>
                        
                        <div className="space-y-2">
                          <p className="text-slate-500 font-semibold uppercase tracking-wider text-[10px]">Notes</p>
                          <div className="bg-white border border-slate-200 rounded-xl p-4 text-slate-700 leading-relaxed whitespace-pre-wrap select-text">
                            {task.notes ? task.notes : <span className="italic text-slate-400">No internal notes.</span>}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
                        <div>
                          <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Assigned To</span>
                          <span className="text-slate-750 font-medium">{task.assignedTo ? `${task.assignedTo.name} (${task.assignedTo.email})` : 'Unassigned'}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Created By</span>
                          <span className="text-slate-750 font-medium">{task.createdBy ? task.createdBy.name : 'System'}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Deadline</span>
                          <span className="text-slate-750 font-medium">{formatDate(task.deadline)}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Priority</span>
                          <span style={{
                            display: 'inline-block', fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', marginTop: '2px',
                            ...getPriorityStyle(task.priority)
                          }}>
                            {task.priority || 'Medium'}
                          </span>
                        </div>
                      </div>

                      {task.linkedEmail && (
                        <div className="bg-white p-4 border border-slate-200 rounded-xl space-y-2">
                          <h5 className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">🔗 Linked Email Payload</h5>
                          <p className="text-xs font-semibold text-slate-800">{task.linkedEmail.subject}</p>
                          <p className="text-[10px] text-slate-455">From: {task.linkedEmail.from}</p>
                          {task.linkedEmail.body && (
                            <div className="mt-1">
                              <iframe
                                srcDoc={renderEmailContent(task.linkedEmail.body)}
                                title="Email Body"
                                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                                className="w-full border border-slate-150 rounded-xl bg-slate-50/50"
                                style={{ minHeight: '120px', resize: 'vertical' }}
                                onLoad={(e) => {
                                  try {
                                    const doc = e.target.contentDocument || e.target.contentWindow.document;
                                    if (doc && doc.body) {
                                      e.target.style.height = `${doc.body.scrollHeight + 24}px`;
                                    }
                                  } catch (err) {
                                    console.error(err);
                                  }
                                }}
                              />
                            </div>
                          )}

                          {/* Attachments rendering inside Task list details */}
                          {task.linkedEmail.attachments && task.linkedEmail.attachments.length > 0 && (
                            <div className="pt-2 border-t border-slate-100 mt-2">
                              <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block mb-1">Attachments ({task.linkedEmail.attachments.length})</span>
                              <div className="flex flex-wrap gap-1.5">
                                {task.linkedEmail.attachments.map((att) => (
                                  <button
                                    key={att.attachmentId}
                                    onClick={() => handleDownloadAttachment(task.linkedEmail._id, att.attachmentId, att.filename)}
                                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 rounded-lg text-[11px] font-bold text-slate-700 hover:text-indigo-700 transition-colors"
                                  >
                                    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                    </svg>
                                    <span>{att.filename}</span>
                                    <span className="text-[9px] text-slate-400 font-semibold">({Math.round(att.size / 1024)} KB)</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Comments section */}
                      <div style={{ marginTop: '16px', borderTop: '1px solid #e2e8f0', paddingTop: '14px' }}>
                        <p style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '10px' }}>
                          COMMENTS {commentMap[task._id]?.length ? `(${commentMap[task._id].length})` : ''}
                        </p>

                        {commentLoadingId === task._id ? (
                          <p style={{ fontSize: '13px', color: '#94a3b8' }}>Loading comments...</p>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px', maxHeight: '220px', overflowY: 'auto' }}>
                            {(commentMap[task._id] || []).length === 0 && (
                              <p style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic' }}>No comments yet. Be the first to comment.</p>
                            )}
                            {(commentMap[task._id] || []).map(comment => (
                              <div key={comment._id} style={{ background: '#f8fafc', borderRadius: '8px', padding: '10px 12px', border: '1px solid #e2e8f0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#334155' }}>{comment.author?.name}</span>
                                    <span style={{ fontSize: '11px', color: '#94a3b8', padding: '1px 6px', background: '#f1f5f9', borderRadius: '10px' }}>{comment.author?.role}</span>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                                      {new Date(comment.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    {(currentUser.role === 'Admin' || currentUser.role === 'Head' || comment.author?._id === currentUser._id) && (
                                      <button
                                        onClick={() => handleDeleteComment(task._id, comment._id)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}
                                        title="Delete comment"
                                      >×</button>
                                    )}
                                  </div>
                                </div>
                                <p style={{ fontSize: '13px', color: '#475569', margin: 0, lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>{comment.message}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Comment input */}
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                          <textarea
                            value={commentInput}
                            onChange={e => setCommentInput(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePostComment(task._id); } }}
                            placeholder="Add a comment... (Enter to send, Shift+Enter for new line)"
                            rows={2}
                            style={{
                              flex: 1, resize: 'none', padding: '8px 12px', fontSize: '13px',
                              borderRadius: '8px', border: '1px solid #e2e8f0', outline: 'none',
                              fontFamily: 'inherit', lineHeight: '1.5'
                            }}
                          />
                          <button
                            onClick={() => handlePostComment(task._id)}
                            disabled={commentSubmitting || !commentInput.trim()}
                            style={{
                              padding: '8px 16px', fontSize: '13px', borderRadius: '8px',
                              border: 'none', background: commentSubmitting ? '#94a3b8' : '#4f46e5',
                              color: 'white', cursor: commentSubmitting ? 'not-allowed' : 'pointer',
                              whiteSpace: 'nowrap', alignSelf: 'flex-end'
                            }}
                          >
                            {commentSubmitting ? '...' : 'Post'}
                          </button>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
                        {currentUser.role === 'Admin' || currentUser.role === 'Head' ? (
                          <>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                openEditModal(task);
                              }}
                              className="px-4 py-2 border-2 border-indigo-600 text-indigo-600 rounded-xl text-xs font-bold hover:bg-indigo-50 transition-all duration-200 ease-in-out"
                            >
                              Edit Task
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteTask(task._id);
                              }}
                              className="px-4 py-2 bg-red-500 text-white rounded-xl text-xs font-bold hover:bg-red-600 transition-all duration-200 ease-in-out"
                            >
                              Delete Task
                            </button>
                          </>
                        ) : (
                          task.status === 'Pending' && (
                            <button
                              type="button"
                              disabled={actionLoading}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMarkComplete(task._id);
                              }}
                              className="px-4 py-2 bg-emerald-500 text-white rounded-xl text-xs font-bold hover:bg-emerald-600 transition-all duration-200 ease-in-out disabled:opacity-50"
                            >
                              Mark Complete
                            </button>
                          )
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpand(task._id);
                          }}
                          className="px-4 py-2 border border-slate-250 text-slate-500 bg-white rounded-xl text-xs font-bold hover:bg-slate-55 transition-all duration-200"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* MODAL: CREATE TASK */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4 overflow-y-auto">
          <div className="bg-white/95 backdrop-blur-2xl border border-indigo-100 rounded-3xl max-w-lg w-full p-6 relative shadow-[0_25px_80px_rgba(99,102,241,0.2)] animate-fade-in my-8 max-h-[90vh] overflow-y-auto select-none">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-800">Create New Task</h3>
                <p className="text-xs text-slate-500 mt-1">Create a task and link a Gmail record if available.</p>
              </div>
              <button onClick={() => setIsCreateOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreateTask} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Task Title <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Process Refund Request"
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Description</label>
                <textarea
                  placeholder="Details of the task assignment..."
                  rows={2}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm resize-none transition-all duration-200"
                  value={newTask.description}
                  onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                />
              </div>

              {/* SEARCHABLE CLIENT DROPDOWN */}
              <div className="relative" ref={clientSuggestionsRef}>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Client Name <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  required
                  placeholder="Search and select client..."
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={clientSearchQuery}
                  onFocus={() => setShowClientSuggestions(true)}
                  onChange={(e) => {
                    setClientSearchQuery(e.target.value);
                    setNewTask({ ...newTask, clientName: e.target.value });
                    setShowClientSuggestions(true);
                  }}
                />
                {showClientSuggestions && (
                  <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl max-h-40 overflow-y-auto z-50 shadow-lg">
                    {filteredClients.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-slate-500 italic">No matching clients found. Type to use this name.</div>
                    ) : (
                      filteredClients.map((client) => (
                        <div
                          key={client._id}
                          onClick={() => {
                            setClientSearchQuery(client.name);
                            setNewTask({ ...newTask, clientName: client.name });
                            setShowClientSuggestions(false);
                          }}
                          className="px-4 py-2 text-sm text-slate-755 hover:bg-indigo-50 cursor-pointer transition-colors"
                        >
                          {client.name}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Assign To <span className="text-red-500">*</span></label>
                  <select
                    required
                    className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                    value={newTask.assignedTo}
                    onChange={(e) => setNewTask({ ...newTask, assignedTo: e.target.value })}
                  >
                    <option value="">-- Choose User --</option>
                    {users.map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Link Email (Optional)</label>
                  <select
                    className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm truncate transition-all duration-200"
                    value={newTask.linkedEmail}
                    onChange={(e) => setNewTask({ ...newTask, linkedEmail: e.target.value })}
                  >
                    <option value="">-- No linked email --</option>
                    {unassignedEmails.map((email) => (
                      <option key={email._id} value={email._id}>
                        {email.subject} (from: {email.from})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Deadline <span className="text-red-500">*</span></label>
                <input
                  type="datetime-local"
                  required
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={newTask.deadline}
                  onChange={(e) => setNewTask({ ...newTask, deadline: e.target.value })}
                />
              </div>

              <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-150 space-y-2">
                <label className="inline-flex items-center text-xs font-semibold text-slate-600 uppercase tracking-wider cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newTask.isRecurring}
                    onChange={e => setNewTask(prev => ({ ...prev, isRecurring: e.target.checked }))}
                    className="mr-2 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                  />
                  Recurring Task
                </label>
                {newTask.isRecurring && (
                  <div>
                    <label className="block text-[10px] font-bold text-slate-450 uppercase mb-1">Recurrence Frequency</label>
                    <select
                      value={newTask.recurrence}
                      onChange={e => setNewTask(prev => ({ ...prev, recurrence: e.target.value }))}
                      className="block w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-xs transition-all duration-200"
                    >
                      <option value="Daily">Daily</option>
                      <option value="Weekly">Weekly</option>
                      <option value="Monthly">Monthly</option>
                    </select>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Priority</label>
                <select
                  value={newTask.priority}
                  onChange={e => setNewTask(prev => ({ ...prev, priority: e.target.value }))}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                  <option value="Urgent">Urgent</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Notes</label>
                <textarea
                  placeholder="Internal notes or pointers..."
                  rows={2}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-855 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm resize-none transition-all duration-200"
                  value={newTask.notes}
                  onChange={(e) => setNewTask({ ...newTask, notes: e.target.value })}
                />
              </div>

              <div className="flex space-x-3 pt-4 border-t border-slate-100 mt-6">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="w-1/2 py-3 px-4 border border-slate-200 hover:bg-slate-50 rounded-xl text-sm font-semibold text-slate-500 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-1/2 py-3 px-4 bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl text-sm font-semibold transition-all text-white disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0 active:scale-98"
                >
                  {actionLoading ? (
                    <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    'Create'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: EDIT TASK / DETAILS */}
      {isEditOpen && selectedTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md p-4 overflow-y-auto">
          <div className="bg-white/95 backdrop-blur-2xl border border-indigo-100 rounded-3xl max-w-lg w-full p-6 relative shadow-[0_25px_80px_rgba(99,102,241,0.2)] animate-fade-in my-8 max-h-[90vh] overflow-y-auto select-none">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-800">
                  {currentUser.role === 'Admin' || currentUser.role === 'Head' ? 'Edit Task Records' : 'Task Details'}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {currentUser.role === 'Admin' || currentUser.role === 'Head'
                    ? 'Update parameters or assign status changes.'
                    : 'Review assignment details below.'}
                </p>
                <div className="mt-2" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: '#64748b' }}>Priority:</span>
                  <span style={{ fontSize: '12px', fontWeight: 600, padding: '2px 10px', borderRadius: '20px', ...getPriorityStyle(selectedTask?.priority) }}>
                    {selectedTask?.priority || 'Medium'}
                  </span>
                </div>
              </div>
              <button onClick={() => { setIsEditOpen(false); setSelectedTask(null); }} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleEditTask} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Task Title</label>
                <input
                  type="text"
                  required
                  disabled={currentUser.role === 'Employee'}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm disabled:bg-slate-50 disabled:text-slate-500 transition-all duration-200"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Description</label>
                <textarea
                  disabled={currentUser.role === 'Employee'}
                  rows={2}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm resize-none disabled:bg-slate-50 disabled:text-slate-550 transition-all duration-200"
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                />
              </div>

              {/* SEARCHABLE CLIENT DROPDOWN (EDIT) */}
              <div className="relative" ref={editClientSuggestionsRef}>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Client Name</label>
                <input
                  type="text"
                  required
                  disabled={currentUser.role === 'Employee'}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm disabled:bg-slate-50 disabled:text-slate-500 transition-all duration-200"
                  value={editClientSearchQuery}
                  onFocus={() => currentUser.role !== 'Employee' && setShowEditClientSuggestions(true)}
                  onChange={(e) => {
                    setEditClientSearchQuery(e.target.value);
                    setEditForm({ ...editForm, clientName: e.target.value });
                    setShowEditClientSuggestions(true);
                  }}
                />
                {showEditClientSuggestions && currentUser.role !== 'Employee' && (
                  <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl max-h-40 overflow-y-auto z-50 shadow-lg">
                    {filteredEditClients.length === 0 ? (
                      <div className="px-4 py-3 text-xs text-slate-500 italic">No matching clients found. Type to use this name.</div>
                    ) : (
                      filteredEditClients.map((client) => (
                        <div
                          key={client._id}
                          onClick={() => {
                            setEditClientSearchQuery(client.name);
                            setEditForm({ ...editForm, clientName: client.name });
                            setShowEditClientSuggestions(false);
                          }}
                          className="px-4 py-2 text-sm text-slate-755 hover:bg-indigo-50 cursor-pointer transition-colors"
                        >
                          {client.name}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Assignee</label>
                  <select
                    disabled={currentUser.role === 'Employee'}
                    className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm disabled:bg-slate-50 disabled:text-slate-500 transition-all duration-200"
                    value={editForm.assignedTo}
                    onChange={(e) => setEditForm({ ...editForm, assignedTo: e.target.value })}
                  >
                    <option value="">-- Choose User --</option>
                    {users.map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Status</label>
                  <select
                    disabled={currentUser.role === 'Employee'}
                    className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm disabled:bg-slate-50 disabled:text-slate-500 transition-all duration-200"
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  >
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                    <option value="Late">Late</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Deadline</label>
                <input
                  type="datetime-local"
                  required
                  disabled={currentUser.role === 'Employee'}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm disabled:bg-slate-50 disabled:text-slate-500 transition-all duration-200"
                  value={editForm.deadline}
                  onChange={(e) => setEditForm({ ...editForm, deadline: e.target.value })}
                />
              </div>

              <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-150 space-y-2">
                <label className="inline-flex items-center text-xs font-semibold text-slate-600 uppercase tracking-wider cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={currentUser.role === 'Employee'}
                    checked={editForm.isRecurring}
                    onChange={e => setEditForm(prev => ({ ...prev, isRecurring: e.target.checked }))}
                    className="mr-2 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4 disabled:opacity-50"
                  />
                  Recurring Task
                </label>
                {editForm.isRecurring && (
                  <div>
                    <label className="block text-[10px] font-bold text-slate-450 uppercase mb-1">Recurrence Frequency</label>
                    <select
                      disabled={currentUser.role === 'Employee'}
                      value={editForm.recurrence}
                      onChange={e => setEditForm(prev => ({ ...prev, recurrence: e.target.value }))}
                      className="block w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-xs transition-all duration-200 disabled:opacity-50"
                    >
                      <option value="Daily">Daily</option>
                      <option value="Weekly">Weekly</option>
                      <option value="Monthly">Monthly</option>
                    </select>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Priority</label>
                <select
                  disabled={currentUser.role === 'Employee'}
                  value={editForm.priority}
                  onChange={e => setEditForm(prev => ({ ...prev, priority: e.target.value }))}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm disabled:bg-slate-50 disabled:text-slate-500 transition-all duration-200"
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                  <option value="Urgent">Urgent</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Notes</label>
                <textarea
                  disabled={currentUser.role === 'Employee'}
                  rows={2}
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm resize-none disabled:bg-slate-50 disabled:text-slate-550 transition-all duration-200"
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                />
              </div>

              {selectedTask.linkedEmail && (
                <div className="bg-slate-50 p-4 border border-slate-200 rounded-2xl space-y-2">
                  <h4 className="text-xs font-bold text-indigo-600 uppercase tracking-wider">🔗 Linked Email Payload</h4>
                  <p className="text-xs font-semibold text-slate-800">{selectedTask.linkedEmail.subject}</p>
                  <p className="text-[10px] text-slate-455">From: {selectedTask.linkedEmail.from}</p>
                  {selectedTask.linkedEmail.body && (
                    <div className="mt-2">
                      <iframe
                        srcDoc={renderEmailContent(selectedTask.linkedEmail.body)}
                        title="Linked Email Body"
                        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                        className="w-full border border-slate-250 rounded-xl bg-white shadow-inner"
                        style={{ minHeight: '150px', resize: 'vertical' }}
                        onLoad={(e) => {
                          try {
                            const doc = e.target.contentDocument || e.target.contentWindow.document;
                            if (doc && doc.body) {
                              e.target.style.height = `${doc.body.scrollHeight + 24}px`;
                            }
                          } catch (err) {
                            console.error(err);
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex space-x-3 pt-4 border-t border-slate-100 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditOpen(false);
                    setSelectedTask(null);
                  }}
                  className="w-1/2 py-3 px-4 border border-slate-200 hover:bg-slate-50 rounded-xl text-sm font-semibold text-slate-500 transition-colors"
                >
                  Close
                </button>
                {currentUser.role === 'Admin' || currentUser.role === 'Head' ? (
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="w-1/2 py-3 px-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0 active:scale-98"
                  >
                    {actionLoading ? (
                      <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      'Save Changes'
                    )}
                  </button>
                ) : (
                  selectedTask.status === 'Pending' && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={() => {
                        handleMarkComplete(selectedTask._id);
                        setIsEditOpen(false);
                        setSelectedTask(null);
                      }}
                      className="w-1/2 py-3 px-4 bg-emerald-500 hover:bg-emerald-600 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center space-x-2 text-white shadow-md hover:translate-y-[-2px] active:translate-y-0"
                    >
                      {actionLoading ? (
                        <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      ) : (
                        'Mark as Complete'
                      )}
                    </button>
                  )
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default TaskList;
