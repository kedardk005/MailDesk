import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import api from '../api/axios';

const NotificationBell = () => {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [bounce, setBounce] = useState(false);
  const dropdownRef = useRef(null);
  const socketRef = useRef(null);

  // Load user details
  const userString = localStorage.getItem('user');
  let user = null;
  try {
    if (userString) {
      user = JSON.parse(userString);
    }
  } catch (err) {
    console.error('Error parsing user details for socket connection:', err);
  }

  useEffect(() => {
    // 1. Fetch initial notifications
    if (user) {
      fetchNotifications();
    }

    // 2. Connect to Socket.io server (running on port 5015) with JWT token
    const socket = io('http://localhost:5015', {
      auth: {
        token: localStorage.getItem('token')
      }
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to Socket.io server. ID:', socket.id);
    });

    // Listen for new notifications in real-time
    socket.on('newNotification', (notification) => {
      console.log('Received real-time notification:', notification);
      setNotifications((prev) => [notification, ...prev]);
      setUnreadCount((prev) => prev + 1);
    });

    // Cleanup on unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Bounce animation trigger when unreadCount increases
  useEffect(() => {
    if (unreadCount > 0) {
      setBounce(true);
      const timer = setTimeout(() => setBounce(false), 600);
      return () => clearTimeout(timer);
    }
  }, [unreadCount]);

  // Handle clicks outside the dropdown to close it
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchNotifications = async () => {
    try {
      const response = await api.get('/notifications');
      setNotifications(response.data);
      const unread = response.data.filter((n) => !n.read).length;
      setUnreadCount(unread);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    }
  };

  const handleNotificationClick = async (n) => {
    await handleMarkAsRead(n._id, n.read);
    
    if (n.type === 'task_assigned' && n.taskId) {
      navigate('/tasks');
    } else if (n.type === 'task_comment' && n.taskId) {
      navigate(`/tasks?expandTaskId=${n.taskId}`);
    } else {
      if (n.taskId) {
        navigate(`/tasks?expandTaskId=${n.taskId}`);
      }
    }
    setIsOpen(false);
  };

  const handleMarkAsRead = async (id, isRead) => {
    if (isRead) return; // Already read

    try {
      await api.put(`/notifications/${id}/read`);
      setNotifications((prev) =>
        prev.map((n) => (n._id === id ? { ...n, read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to mark notification as read:', err);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (unreadCount === 0) return;

    try {
      await api.put('/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all as read:', err);
    }
  };

  const formatTimeAgo = (dateString) => {
    const now = new Date();
    const past = new Date(dateString);
    const diffMs = now - past;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHrs = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHrs / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return `${diffDays}d ago`;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Icon Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 rounded-xl text-blue-600 hover:text-blue-700 bg-blue-50/50 hover:bg-blue-50 border border-blue-100 transition-all duration-150 focus:outline-none ${
          bounce ? 'animate-bounce text-blue-700' : ''
        }`}
      >
        <svg className="h-5 w-5 text-blue-600" fill="none" stroke="#2563eb" strokeWidth="2.5" viewBox="0 0 24 24" aria-label="Notifications">
          <path stroke="#2563eb" strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 h-3.5 w-3.5 bg-red-500 rounded-full text-[9px] font-black text-white flex items-center justify-center animate-pulse shadow-md">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Container */}
      {isOpen && (
        <div className="absolute right-0 mt-3 w-80 bg-white/95 backdrop-blur-xl border border-slate-200/80 rounded-2xl shadow-xl overflow-hidden z-50 animate-fade-in origin-top-right transition-all">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <span className="font-bold text-xs text-slate-800">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="text-[10px] text-indigo-600 hover:text-indigo-700 font-bold transition-colors focus:outline-none"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* List - max 10 */}
          <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 bg-transparent">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-400 italic">
                No notifications yet.
              </div>
            ) : (
              notifications.slice(0, 10).map((n) => (
                <div
                  key={n._id}
                  onClick={() => handleNotificationClick(n)}
                  className={`px-4 py-3 cursor-pointer transition-colors duration-150 flex flex-col space-y-1 border-l-4 ${
                    !n.read
                      ? 'bg-indigo-50/40 border-l-indigo-600 hover:bg-indigo-50/60'
                      : 'border-l-transparent bg-white hover:bg-slate-50'
                  }`}
                >
                  <p className={`leading-relaxed text-xs ${!n.read ? 'font-semibold text-slate-850' : 'font-normal text-slate-500'}`}>
                    {n.message}
                  </p>
                  <span className="text-[9px] text-slate-400 font-mono">
                    {formatTimeAgo(n.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
