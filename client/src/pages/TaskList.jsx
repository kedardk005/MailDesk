import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/axios';

const TaskList = () => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [creatorFilter, setCreatorFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [expandedTaskId, setExpandedTaskId] = useState(null);

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
    notes: ''
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
    status: 'Pending'
  });

  // Client search suggestions states (Edit Task)
  const [editClientSearchQuery, setEditClientSearchQuery] = useState('');
  const [showEditClientSuggestions, setShowEditClientSuggestions] = useState(false);
  const editClientSuggestionsRef = useRef(null);

  // Current logged in user context
  const [currentUser, setCurrentUser] = useState({ name: 'Guest', role: 'Employee' });

  const navigate = useNavigate();

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

  // Check for linking parameters from Email Inbox page to pre-fill Create Task form
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
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
      // Clean up URL parameters
      window.history.replaceState({}, document.title, '/tasks');
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

          // 3. Fetch unassigned emails
          const emailsRes = await api.get('/gmail/emails');
          const unassigned = emailsRes.data.filter(e => e.status === 'unassigned');
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
        notes: newTask.notes
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
        notes: ''
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
        status: editForm.status
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
      status: task.status
    });
    setEditClientSearchQuery(task.clientName);
    setIsEditOpen(true);
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

  // Apply creator and status filters
  const filteredTasks = tasks.filter(task => {
    if (creatorFilter && task.createdBy?._id !== creatorFilter) {
      return false;
    }
    if (statusFilter !== 'All' && task.status !== statusFilter) {
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
                  onChange={(e) => setCreatorFilter(e.target.value)}
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
            {(currentUser?.role === 'Admin' || currentUser?.role === 'Head') && (
              <button
                onClick={() => setIsCreateOpen(true)}
                className="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white shadow-md transition-all duration-200 flex items-center space-x-2 active:scale-[0.98] select-none"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                <span>Create Task</span>
              </button>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {['All', 'Pending', 'Completed', 'Late'].map((filter) => (
            <button
              key={filter}
              onClick={() => setStatusFilter(filter)}
              className={`px-4 py-2 text-xs font-bold rounded-full border transition-all ${
                statusFilter === filter
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-600/10'
                  : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* Task List Cards */}
        {loading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-white border border-slate-200/80 rounded-2xl p-5 skeleton-shimmer" />
            ))}
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

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
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
                      </div>

                      {task.linkedEmail && (
                        <div className="bg-white p-4 border border-slate-200 rounded-xl space-y-2">
                          <h5 className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">🔗 Linked Email Payload</h5>
                          <p className="text-xs font-semibold text-slate-800">{task.linkedEmail.subject}</p>
                          <p className="text-[10px] text-slate-450">From: {task.linkedEmail.from}</p>
                          {task.linkedEmail.body && (
                            <div className="bg-slate-50 p-3 rounded-lg max-h-32 overflow-y-auto text-xs text-slate-650 font-sans whitespace-pre-wrap mt-1 select-text">
                              {task.linkedEmail.body}
                            </div>
                          )}
                        </div>
                      )}

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
                              className="px-4 py-2 border-2 border-indigo-650 text-indigo-650 rounded-xl text-xs font-bold hover:bg-indigo-50 transition-all duration-200 ease-in-out"
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
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMarkComplete(task._id);
                              }}
                              className="px-4 py-2 bg-emerald-500 text-white rounded-xl text-xs font-bold hover:bg-emerald-600 transition-all duration-200 ease-in-out"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px] p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 relative shadow-2xl animate-fade-in my-8 max-h-[90vh] overflow-y-auto select-none">
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
                  className="w-1/2 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 rounded-xl text-sm font-semibold transition-colors text-white disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px] p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 relative shadow-2xl animate-fade-in my-8 max-h-[90vh] overflow-y-auto select-none">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-800">
                  {currentUser.role === 'Admin' || currentUser.role === 'Head' ? 'Edit Task Records' : 'Task Details'}
                </h3>
                <p className="text-xs text-slate-505 mt-1">
                  {currentUser.role === 'Admin' || currentUser.role === 'Head'
                    ? 'Update parameters or assign status changes.'
                    : 'Review assignment details below.'}
                </p>
              </div>
              <button onClick={() => { setIsEditOpen(false); setSelectedTask(null); }} className="text-slate-400 hover:text-slate-655 transition-colors">
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
                    <div className="bg-white border border-slate-200 p-3 rounded-xl max-h-32 overflow-y-auto text-xs text-slate-650 font-sans whitespace-pre-wrap mt-2 select-text">
                      {selectedTask.linkedEmail.body}
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
                    className="w-1/2 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0"
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
